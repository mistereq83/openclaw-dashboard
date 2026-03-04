// Stats worker — computes daily stats from JSONL files and stores in SQLite
const { listSessions, getSessionMessages, getAgentDisplayName } = require('./parser');
const db = require('./db');

function computeAndStoreDailyStats(stateDir, agentIds, dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dateStr + 'T23:59:59');

  let totalStored = 0;

  for (const agentId of agentIds) {
    const agentName = getAgentDisplayName(agentId);
    const sessions = listSessions(stateDir, agentId);

    // Filter sessions active on this date
    const daySessions = sessions.filter(s => {
      const last = new Date(s.lastMessage);
      const first = new Date(s.firstMessage);
      return last >= dayStart && first <= dayEnd;
    });

    let totalMessages = 0;
    let totalUserMessages = 0;
    let totalCost = 0;

    for (const session of daySessions) {
      const messages = getSessionMessages(stateDir, agentId, session.id);

      // Count only messages from this specific date
      for (const msg of messages) {
        if (!msg.timestamp) continue;
        const msgDate = new Date(msg.timestamp);
        if (msgDate >= dayStart && msgDate <= dayEnd) {
          totalMessages++;
          if (msg.role === 'user') totalUserMessages++;
        }
      }

      totalCost += session.cost || 0;
    }

    db.upsertDailyStats(dateStr, agentId, agentName, {
      sessions: daySessions.length,
      messages: totalMessages,
      userMessages: totalUserMessages,
      cost: totalCost,
    });

    totalStored++;
  }

  return totalStored;
}

// Backfill: compute stats for all historical dates
function backfillStats(stateDir, agentIds, daysBack = 90) {
  const now = new Date();
  let filled = 0;

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    computeAndStoreDailyStats(stateDir, agentIds, dateStr);
    filled++;
  }

  console.log(`[StatsWorker] Backfilled ${filled} days for ${agentIds.length} agents`);
  return filled;
}

// Compute stats for yesterday + today (called by scheduler)
function computeRecent(stateDir, agentIds) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  computeAndStoreDailyStats(stateDir, agentIds, yesterday);
  computeAndStoreDailyStats(stateDir, agentIds, today);

  console.log(`[StatsWorker] Updated stats for ${yesterday} and ${today}`);
}

module.exports = { computeAndStoreDailyStats, backfillStats, computeRecent };
