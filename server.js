const express = require('express');
const path = require('path');
const fs = require('fs');

// Load .env manually (no dotenv dependency)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const { getAgentDisplayName, AGENT_DISPLAY_NAMES, listSessions, getSessionMessages, searchSessions } = require('./lib/parser');
const { getAgentStats, getOverviewStats, generateCsvExport } = require('./lib/stats');
const { analyzeSession, analyzeBatch, checkOllamaStatus, OLLAMA_MODEL } = require('./lib/ollama');
const { runDailyAnalysis, loadReport, listAvailableDays, getTrend } = require('./lib/daily-analysis');
const scheduler = require('./lib/scheduler');
const db = require('./lib/db');
const { backfillStats, computeRecent } = require('./lib/stats-worker');
const cache = require('./lib/cache');

const app = express();
const PORT = parseInt(process.env.PORT || '3333', 10);
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const STATE_DIR = path.resolve(process.env.OPENCLAW_STATE_DIR || '/home/openclaw/.openclaw/agents');
const AGENT_IDS = (process.env.AGENT_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);

// Auth middleware
function auth(req, res, next) {
  if (!TOKEN) return next(); // No token configured = no auth
  const bearer = (req.headers['authorization'] || '').startsWith('Bearer ')
    ? req.headers['authorization'].slice(7) : '';
  const provided = req.query.token || req.headers['x-dashboard-token'] || bearer || '';
  if (provided === TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized. Provide ?token= or X-Dashboard-Token header.' });
}

// Static files — no auth required (CSS, JS etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Auth required only for API
app.use('/api', auth);

// --- API Routes ---

// GET /api/agents — list agents with basic stats
app.get('/api/agents', (req, res) => {
  const cacheKey = 'agents-list';
  let data = cache.get(cacheKey);
  if (!data) {
    data = AGENT_IDS.map(id => {
      const sessions = listSessions(STATE_DIR, id);
      const lastSession = sessions[0];
      return {
        id,
        name: getAgentDisplayName(id),
        sessionsCount: sessions.length,
        lastActivity: lastSession ? lastSession.lastMessage : null,
      };
    });
    cache.set(cacheKey, data);
  }
  res.json(data);
});

// GET /api/agents/:name — detailed stats
app.get('/api/agents/:name', (req, res) => {
  const agentId = req.params.name;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const cacheKey = `agent-stats-${agentId}`;
  let data = cache.get(cacheKey);
  if (!data) {
    data = {
      id: agentId,
      name: getAgentDisplayName(agentId),
      ...getAgentStats(STATE_DIR, agentId),
    };
    cache.set(cacheKey, data);
  }
  res.json(data);
});

// GET /api/agents/:name/sessions — list sessions
app.get('/api/agents/:name/sessions', (req, res) => {
  const agentId = req.params.name;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  let sessions = listSessions(STATE_DIR, agentId);

  // Filters
  const { dateFrom, dateTo, minMessages } = req.query;
  if (dateFrom) sessions = sessions.filter(s => s.lastMessage >= new Date(dateFrom));
  if (dateTo) sessions = sessions.filter(s => s.firstMessage <= new Date(dateTo));
  if (minMessages) sessions = sessions.filter(s => s.messageCount >= parseInt(minMessages, 10));

  res.json(sessions);
});

// GET /api/agents/:name/sessions/:id — session messages
app.get('/api/agents/:name/sessions/:id', (req, res) => {
  const agentId = req.params.name;
  const sessionId = req.params.id;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const messages = getSessionMessages(STATE_DIR, agentId, sessionId);
  res.json({ sessionId, agentId, agentName: getAgentDisplayName(agentId), messages });
});

// GET /api/agents/:name/search?q=...
app.get('/api/agents/:name/search', (req, res) => {
  const agentId = req.params.name;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const query = req.query.q || '';
  if (!query) return res.json([]);
  const results = searchSessions(STATE_DIR, agentId, query, {
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    minMessages: req.query.minMessages ? parseInt(req.query.minMessages, 10) : undefined,
  });
  res.json(results);
});

// GET /api/stats/overview — original (kept for backward compat)
app.get('/api/stats/overview', (req, res) => {
  const cacheKey = 'overview';
  let data = cache.get(cacheKey);
  if (!data) {
    data = getOverviewStats(STATE_DIR, AGENT_IDS);
    cache.set(cacheKey, data);
  }
  res.json(data);
});

// GET /api/stats/monthly?month=2026-03 — SQLite-backed monthly overview
app.get('/api/stats/monthly', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const agentFilter = req.query.agent;

  const totals = db.getOverviewTotals(month);
  const agents = agentFilter
    ? [db.getMonthlyStats(month, agentFilter)].filter(Boolean)
    : db.getMonthlyStats(month);
  const timeline = db.getDailyTimelineByAgent(month);
  const months = db.getAvailableMonths();

  // Group timeline by date for chart
  const dailyTotals = db.getDailyTimeline(month);

  res.json({
    month,
    totals: totals || { agents: 0, sessions: 0, messages: 0, user_messages: 0, cost: 0 },
    agents,
    dailyTotals,
    timeline,
    availableMonths: months,
  });
});

// POST /api/stats/backfill — trigger backfill (one-time setup)
app.post('/api/stats/backfill', async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '90', 10), 365);
  try {
    const filled = backfillStats(STATE_DIR, AGENT_IDS, days);
    res.json({ success: true, daysFilled: filled, agents: AGENT_IDS.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/export?agent=...&from=...&to=...
app.get('/api/stats/export', (req, res) => {
  const agentId = req.query.agent;
  if (!agentId || !AGENT_IDS.includes(agentId)) {
    return res.status(400).json({ error: 'Provide valid ?agent= parameter' });
  }
  const csv = generateCsvExport(STATE_DIR, agentId, req.query.from, req.query.to);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${agentId}-stats.csv"`);
  res.send(csv);
});

// --- AI Analysis Routes ---

// GET /api/analysis/status — check Ollama connectivity + scheduler
app.get('/api/analysis/status', async (req, res) => {
  const ollamaStatus = await checkOllamaStatus();
  const schedulerStatus = scheduler.status();
  res.json({ ...ollamaStatus, scheduler: schedulerStatus });
});

// GET /api/analysis/days — list available analysis days
app.get('/api/analysis/days', (req, res) => {
  res.json(listAvailableDays());
});

// GET /api/analysis/trend — quality trend over time
app.get('/api/analysis/trend', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  res.json(getTrend(days));
});

// GET /api/analysis/day/:date — get report for specific date
app.get('/api/analysis/day/:date', (req, res) => {
  const dateStr = req.params.date;
  const agentFilter = req.query.agent;
  const report = loadReport(dateStr);
  if (!report) return res.status(404).json({ error: 'Brak raportu dla tego dnia' });

  if (agentFilter) {
    report.agents = report.agents.filter(a => a.agentId === agentFilter);
  }
  res.json(report);
});

// POST /api/agents/:name/sessions/:id/analyze — analyze single session
app.post('/api/agents/:name/sessions/:id/analyze', async (req, res) => {
  const agentId = req.params.name;
  const sessionId = req.params.id;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const cacheKey = `analysis-${agentId}-${sessionId}`;
  const cached = cache.get(cacheKey);
  if (cached && !req.query.force) return res.json({ ...cached, cached: true });

  const messages = getSessionMessages(STATE_DIR, agentId, sessionId);
  if (messages.length === 0) return res.json({ error: 'Brak wiadomości w sesji' });

  const analysis = await analyzeSession(messages);
  if (!analysis.error) cache.set(cacheKey, analysis);
  res.json(analysis);
});

// GET /api/analysis/stream — SSE streaming analysis for a specific date
app.get('/api/analysis/stream', (req, res) => {
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  send('init', { date: dateStr, totalAgents: AGENT_IDS.length, model: OLLAMA_MODEL });

  runDailyAnalysis(STATE_DIR, AGENT_IDS, dateStr, (event, data) => {
    if (!closed) send(event, data);
  }).then(report => {
    if (!closed) {
      send('complete', report);
      res.end();
    }
  }).catch(err => {
    if (!closed) {
      send('error', { message: err.message });
      res.end();
    }
  });
});


// Debug: raw cost check
app.get('/api/debug/cost/:agentId/:sessionId', (req, res) => {
  const { agentId, sessionId } = req.params;
  const path2 = require('path');
  const sessionsDir = path2.join(STATE_DIR, agentId, 'sessions');
  const filePath = path2.join(sessionsDir, `${sessionId}.jsonl`);
  const fs2 = require('fs');
  if (!fs2.existsSync(filePath)) return res.json({ error: 'File not found', filePath });
  const lines = fs2.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
  const results = [];
  let total = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.usage) {
        results.push({ type: obj.type, hasUsage: true, hasCost: !!(obj.usage.cost), cost: obj.usage.cost });
        if (obj.usage.cost) total += obj.usage.cost.total || 0;
      }
    } catch {}
  }
  res.json({ filePath, linesTotal: lines.length, costLines: results, total });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Dashboard running on http://localhost:${PORT}`);
  console.log(`Agents: ${AGENT_IDS.map(id => `${id} (${getAgentDisplayName(id)})`).join(', ')}`);
  console.log(`State dir: ${STATE_DIR}`);

  // Backfill historical stats into SQLite (runs once, fast on subsequent starts)
  try {
    backfillStats(STATE_DIR, AGENT_IDS, 90);
    console.log('Historical stats backfilled into SQLite');
  } catch (err) {
    console.error('Backfill error:', err.message);
  }

  // Start nightly analysis scheduler
  scheduler.start(STATE_DIR, AGENT_IDS);
});
