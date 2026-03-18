// Stats worker — computes daily stats from JSONL files and stores in SQLite
const { listSessions, getSessionMessages, getAgentDisplayName, parseJsonlFile, getSessionsDir } = require('./parser');
const db = require('./db');
const path = require('path');
const fs = require('fs');

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

      // Count only messages from this specific date + sum their individual costs
      for (const msg of messages) {
        if (!msg.timestamp) continue;
        const msgDate = new Date(msg.timestamp);
        if (msgDate >= dayStart && msgDate <= dayEnd) {
          totalMessages++;
          if (msg.role === 'user') totalUserMessages++;
          // Add per-message cost (already calculated in parser.js)
          if (msg.cost && msg.cost > 0) {
            totalCost += msg.cost;
          }
        }
      }
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

// Compute stats only for today (fast refresh)
function computeToday(stateDir, agentIds) {
  const today = new Date().toISOString().split('T')[0];
  computeAndStoreDailyStats(stateDir, agentIds, today);
  console.log(`[StatsWorker] Updated stats for ${today}`);
}

// Compute token stats for a specific date
function computeAndStoreDailyTokenStats(stateDir, agentIds, dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dateStr + 'T23:59:59');
  
  let totalStored = 0;

  for (const agentId of agentIds) {
    const agentName = getAgentDisplayName(agentId);
    const sessionsDir = getSessionsDir(stateDir, agentId);
    
    // Track tokens per model for this agent on this date
    const modelStats = new Map();

    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      
      for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          
          try {
            const obj = JSON.parse(line);
            
            // Support both OpenClaw formats:
            // Format A (wrapped): { type: "message", message: { role, content, model, usage }, timestamp, usage }
            // Format B (flat): { role, content, timestamp, tokens }
            const usage = obj.usage || (obj.message && obj.message.usage);
            const timestamp = obj.timestamp || (obj.message && obj.message.timestamp);
            const isMessage = obj.type === 'message' || obj.role === 'assistant';
            
            // Skip if not a message or no timestamp
            if (!isMessage || !timestamp) continue;
            
            const msgDate = new Date(timestamp);
            if (isNaN(msgDate.getTime()) || msgDate < dayStart || msgDate > dayEnd) continue;
            
            // For flat format without usage object, construct from tokens field
            const effectiveUsage = usage || (obj.tokens ? { output: obj.tokens } : null);
            if (!effectiveUsage) continue;
            
            const model = (obj.message && obj.message.model) || obj.model || 'unknown';
            const normalizedModel = model.includes('/') ? model.split('/').pop() : model;
            
            // Get or create stats for this model
            const key = normalizedModel;
            if (!modelStats.has(key)) {
              modelStats.set(key, {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 0,
                messageCount: 0,
                estimatedCost: 0
              });
            }
            
            const stats = modelStats.get(key);
            stats.inputTokens += effectiveUsage.input || 0;
            stats.outputTokens += effectiveUsage.output || 0;
            stats.cacheReadTokens += effectiveUsage.cacheRead || 0;
            stats.cacheWriteTokens += effectiveUsage.cacheWrite || 0;
            stats.totalTokens += (effectiveUsage.input || 0) + (effectiveUsage.output || 0) + (effectiveUsage.cacheRead || 0) + (effectiveUsage.cacheWrite || 0);
            stats.messageCount += 1;
            
            // Use existing cost if available, or estimate from tokens
            // Guard: cost.total must be positive AND under $10/msg (anything else is token count bug)
            const costObj = effectiveUsage.cost;
            const rawCost = (costObj && typeof costObj === 'object' && typeof costObj.total === 'number')
              ? costObj.total : null;
            
            if (rawCost !== null && rawCost > 0 && rawCost < 10) {
              stats.estimatedCost += rawCost;
            } else {
              // Strip poisoned cost before passing to estimator (it uses usage.input/output, not cost)
              const cleanUsage = { 
                input: effectiveUsage.input || 0, 
                output: effectiveUsage.output || 0, 
                cacheRead: effectiveUsage.cacheRead || 0,
                cacheWrite: effectiveUsage.cacheWrite || 0
              };
              const { estimateCostFromTokens } = require('./parser');
              const est = estimateCostFromTokens(cleanUsage, model);
              // Debug: log first auto model cost calculation per agent
              if (normalizedModel === 'auto' && stats.messageCount <= 1) {
                console.log(`[TokenStats DEBUG] agent=${agentId} model=${model} normalized=${normalizedModel} input=${cleanUsage.input} est=$${est} rawCostType=${typeof costObj} rawCost=${JSON.stringify(costObj)}`);
              }
              if (est > 0 && est < 50) {
                stats.estimatedCost += est;
              }
            }
            
          } catch (err) {
            // Skip malformed lines
            continue;
          }
        }
      }
    }
    
    // Store stats for each model used by this agent on this date
    for (const [model, stats] of modelStats) {
      db.upsertDailyTokenStats(dateStr, agentId, agentName, model, stats);
      totalStored++;
    }
  }

  return totalStored;
}

// Enhanced compute functions that also compute token stats
function computeRecent(stateDir, agentIds) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  computeAndStoreDailyStats(stateDir, agentIds, yesterday);
  computeAndStoreDailyStats(stateDir, agentIds, today);
  
  // Also compute token stats
  computeAndStoreDailyTokenStats(stateDir, agentIds, yesterday);
  computeAndStoreDailyTokenStats(stateDir, agentIds, today);

  console.log(`[StatsWorker] Updated stats + token stats for ${yesterday} and ${today}`);
}

function computeToday(stateDir, agentIds) {
  const today = new Date().toISOString().split('T')[0];
  computeAndStoreDailyStats(stateDir, agentIds, today);
  computeAndStoreDailyTokenStats(stateDir, agentIds, today);
  console.log(`[StatsWorker] Updated stats + token stats for ${today}`);
}

function backfillStats(stateDir, agentIds, daysBack = 90) {
  const now = new Date();
  let filled = 0;

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    computeAndStoreDailyStats(stateDir, agentIds, dateStr);
    computeAndStoreDailyTokenStats(stateDir, agentIds, dateStr);
    filled++;
  }

  console.log(`[StatsWorker] Backfilled ${filled} days (including token stats) for ${agentIds.length} agents`);
  return filled;
}

module.exports = { 
  computeAndStoreDailyStats, 
  computeAndStoreDailyTokenStats,
  backfillStats, 
  computeRecent, 
  computeToday 
};
