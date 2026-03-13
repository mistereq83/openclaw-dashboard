// Daily analysis engine — runs analysis for a specific date, saves to JSON files
const fs = require('fs');
const path = require('path');
const { listSessions, getSessionMessages, getAgentDisplayName } = require('./parser');
const { analyzeSession, synthesizeAgentDay, OLLAMA_MODEL } = require('./ollama');

const DATA_DIR = path.resolve(process.env.ANALYSIS_DATA_DIR || '/data/analysis');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getReportPath(dateStr) {
  return path.join(DATA_DIR, `${dateStr}.json`);
}

function loadReport(dateStr) {
  const filePath = getReportPath(dateStr);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function saveReport(dateStr, report) {
  ensureDataDir();
  fs.writeFileSync(getReportPath(dateStr), JSON.stringify(report, null, 2));
}

function listAvailableDays() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
    .sort()
    .reverse();
}

function getSessionsForDate(stateDir, agentId, dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dateStr + 'T23:59:59');

  const sessions = listSessions(stateDir, agentId);
  return sessions.filter(s => {
    const last = new Date(s.lastMessage);
    const first = new Date(s.firstMessage);
    // Session overlaps with the target day
    return last >= dayStart && first <= dayEnd;
  });
}

// Run analysis for a date — returns report and optionally streams progress via callback
async function runDailyAnalysis(stateDir, agentIds, dateStr, onProgress) {
  ensureDataDir();

  const report = {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    model: OLLAMA_MODEL,
    agents: [],
    totals: {
      sessions: 0,
      avgQuality: null,
      avgSentiment: null,
      issues: 0,
      escalations: 0,
      flaggedIssuesByCategory: { FIRMA: 0, PRYWATNE: 0, BEZPIECZENSTWO: 0 },
    },
  };

  let totalQuality = 0, totalSentiment = 0, validCount = 0;

  for (let ai = 0; ai < agentIds.length; ai++) {
    const agentId = agentIds[ai];
    const agentName = getAgentDisplayName(agentId);
    const sessions = getSessionsForDate(stateDir, agentId, dateStr);

    if (onProgress) {
      onProgress('agent-start', {
        agentId, agentName,
        agentIndex: ai + 1, totalAgents: agentIds.length,
        sessionsCount: sessions.length,
      });
    }

    const agentResults = [];

    for (let si = 0; si < sessions.length; si++) {
      const session = sessions[si];
      const allMessages = getSessionMessages(stateDir, agentId, session.id);
      // Filter messages to only the target date (sessions can span multiple days)
      const messages = allMessages.filter(m => {
        if (!m.timestamp) return false;
        const msgDate = new Date(m.timestamp).toISOString().slice(0, 10);
        return msgDate === dateStr;
      });
      if (messages.length === 0) continue;

      if (onProgress) {
        onProgress('session-start', {
          agentId, agentName,
          sessionId: session.id,
          sessionIndex: si + 1, sessionsCount: sessions.length,
          messageCount: messages.length,
        });
      }

      const analysis = await analyzeSession(messages);
      const result = { sessionId: session.id, date: dateStr, ...analysis };
      agentResults.push(result);

      if (onProgress) {
        onProgress('session-done', result);
      }
    }

    const validResults = agentResults.filter(r => !r.error);
    const avgQ = validResults.length > 0
      ? Math.round((validResults.reduce((s, r) => s + (r.agentQuality || 0), 0) / validResults.length) * 10) / 10
      : null;
    const avgS = validResults.length > 0
      ? Math.round((validResults.reduce((s, r) => s + (r.sentimentScore || 0), 0) / validResults.length) * 100) / 100
      : null;

    if (avgQ !== null) { totalQuality += avgQ * validResults.length; totalSentiment += avgS * validResults.length; validCount += validResults.length; }

    const synthesisRaw = await synthesizeAgentDay(validResults, agentName);
    const synthesis = synthesisRaw && !synthesisRaw.error ? synthesisRaw : null;
    const flaggedIssues = synthesis && Array.isArray(synthesis.flaggedIssues) ? synthesis.flaggedIssues : [];

    const agentReport = {
      agentId, agentName,
      synthesis,
      sessionsAnalyzed: agentResults.length,
      avgAgentQuality: avgQ,
      avgSentimentScore: avgS,
      issues: validResults.flatMap(r => (r.issues || []).map(i => ({ session: r.sessionId, issue: i }))),
      escalationsNeeded: validResults.filter(r => r.escalationNeeded).length,
      topTopics: getTopTopics(validResults),
      sessions: agentResults,
    };

    report.agents.push(agentReport);
    report.totals.sessions += agentResults.length;
    report.totals.issues += flaggedIssues.length;
    for (const issue of flaggedIssues) {
      if (issue && report.totals.flaggedIssuesByCategory[issue.category] !== undefined) {
        report.totals.flaggedIssuesByCategory[issue.category] += 1;
      }
    }
    report.totals.escalations += agentReport.escalationsNeeded;

    if (onProgress) {
      onProgress('agent-done', agentReport);
    }
  }

  report.totals.avgQuality = validCount > 0 ? Math.round((totalQuality / validCount) * 10) / 10 : null;
  report.totals.avgSentiment = validCount > 0 ? Math.round((totalSentiment / validCount) * 100) / 100 : null;

  saveReport(dateStr, report);
  return report;
}

function getTopTopics(analyses) {
  const counts = {};
  for (const a of analyses) {
    for (const topic of (a.topics || [])) {
      counts[topic] = (counts[topic] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));
}

// Get trend data across multiple days
function getTrend(days = 30) {
  const available = listAvailableDays();
  const trend = [];

  for (const day of available.slice(0, days)) {
    const report = loadReport(day);
    if (!report) continue;
    trend.push({
      date: day,
      avgQuality: report.totals.avgQuality,
      avgSentiment: report.totals.avgSentiment,
      sessions: report.totals.sessions,
      issues: report.totals.issues,
      escalations: report.totals.escalations,
      agents: report.agents.map(a => ({
        agentId: a.agentId,
        agentName: a.agentName,
        avgQuality: a.avgAgentQuality,
        sessions: a.sessionsAnalyzed,
      })),
    });
  }

  return trend.reverse(); // chronological order
}

module.exports = {
  runDailyAnalysis,
  loadReport,
  saveReport,
  listAvailableDays,
  getTrend,
  DATA_DIR,
};
