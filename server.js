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
const pricingModule = require('./lib/pricing');
const { generateCsvExport, getAgentActivityVisuals } = require('./lib/stats');
const { analyzeSession, analyzeBatch, checkOllamaStatus, OLLAMA_MODEL } = require('./lib/ollama');
const { runDailyAnalysis, loadReport, listAvailableDays, getTrend } = require('./lib/daily-analysis');
const scheduler = require('./lib/scheduler');
const db = require('./lib/db');
const { backfillStats, computeRecent, computeToday } = require('./lib/stats-worker');
const archiveWorker = require('./lib/archive-worker');
const reconciliation = require('./lib/reconciliation');
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

function getTodayDateStr() {
  return new Date().toISOString().split('T')[0];
}

function getWeekStartDateStr(today) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

function roundCost(value) {
  // Hard guard: NEVER return negative costs (OpenClaw openrouter bug writes token counts as cost)
  // Also cap at $10000 — anything higher is certainly a bug (token count, not dollars)
  const v = Math.round((value || 0) * 10000) / 10000;
  if (v < 0 || v > 10000) return 0;
  return v;
}

// GET /api/agents/:name — detailed stats (supports ?month=2026-03)
app.get('/api/agents/:name', (req, res) => {
  const agentId = req.params.name;
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const cacheKey = `agent-stats-${agentId}-${month || 'all'}`;
  let data = cache.get(cacheKey);
  if (!data) {
    const detail = db.getAgentMonthlyDetail(month, agentId);
    const monthStats = detail.month || {};
    const todayStats = detail.today || {};
    const weekStats = detail.week || {};
    const visuals = getAgentActivityVisuals(STATE_DIR, agentId, month);
    const allTimeCost = db.getAllTimeCost(agentId) || 0;
    const avgPerDay = monthStats.active_days
      ? Math.round((monthStats.user_messages / monthStats.active_days) * 10) / 10
      : 0;
    const lastActivity = monthStats.last_active ? `${monthStats.last_active}T23:59:59` : null;

    data = {
      id: agentId,
      name: getAgentDisplayName(agentId),
      sessionsTotal: monthStats.sessions || 0,
      sessionsWeek: weekStats.sessions || 0,
      sessionsToday: todayStats.sessions || 0,
      messagesTotal: monthStats.messages || 0,
      userMessagesTotal: monthStats.user_messages || 0,
      messagesToday: todayStats.messages || 0,
      messagesWeek: weekStats.messages || 0,
      avgPerDay,
      lastActivity,
      heatmap: visuals.heatmap,
      timeline: visuals.timeline,
      month: month || null,
      totalCost: roundCost(monthStats.cost || 0),
      totalCostPLN: Math.round((monthStats.cost || 0) * 4 * 100) / 100,
      todayCost: roundCost(todayStats.cost || 0),
      allTimeCost: roundCost(allTimeCost),
      allTimeCostPLN: Math.round(allTimeCost * 4 * 100) / 100,
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

// GET /api/stats/overview — SQLite-based (single source of truth)
app.get('/api/stats/overview', (req, res) => {
  const cacheKey = 'overview';
  let data = cache.get(cacheKey);
  if (!data) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const totals = db.getOverviewTotals(currentMonth, AGENT_IDS) || { agents: 0, sessions: 0, messages: 0, user_messages: 0, cost: 0 };
    const todayCostAll = db.getTodayCostAll(AGENT_IDS);
    const totalTodayCost = db.getTotalTodayCost(AGENT_IDS);

    // Build agents array for nav (with basic stats from SQLite)
    const agents = AGENT_IDS.map(agentId => {
      const detail = db.getAgentMonthlyDetail(currentMonth, agentId);
      const m = detail.month || {};
      return {
        agentId,
        lastActivity: m.last_active ? `${m.last_active}T23:59:59` : null,
        sessionsTotal: m.sessions || 0,
        userMessagesTotal: m.user_messages || 0,
        totalCost: roundCost(m.cost || 0),
      };
    });

    const todayCostPerAgent = todayCostAll.map(r => ({
      agentId: r.agent_id,
      name: r.agent_name || getAgentDisplayName(r.agent_id),
      todayCost: roundCost(r.cost),
    }));

    data = {
      agents,
      totalCost: roundCost(totals.cost || 0),
      totalTodayCost: roundCost(totalTodayCost),
      todayCostPerAgent,
    };
    cache.set(cacheKey, data);
  }
  res.json(data);
});

// GET /api/stats/monthly?month=2026-03 — SQLite-backed monthly overview
app.get('/api/stats/monthly', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const agentFilter = req.query.agent;

  const activeIds = agentFilter ? [agentFilter] : AGENT_IDS;
  const totals = db.getOverviewTotals(month, activeIds);
  const agents = agentFilter
    ? [db.getMonthlyStats(month, agentFilter)].filter(Boolean)
    : db.getMonthlyStats(month);
  // Filter agents to only those in AGENT_IDS
  const filteredAgents = (agents || []).filter(a => AGENT_IDS.includes(a.agent_id));
  const timeline = db.getDailyTimelineByAgent(month);
  const months = db.getAvailableMonths();

  // Group timeline by date for chart
  const dailyTotals = db.getDailyTimeline(month, activeIds);

  // All costs come from SQLite (single source of truth)
  const fixedTotals = totals || { agents: 0, sessions: 0, messages: 0, user_messages: 0, cost: 0 };

  // Add today cost data
  const todayCostAll = db.getTodayCostAll(AGENT_IDS);
  const totalTodayCost = db.getTotalTodayCost(AGENT_IDS);
  const todayCostPerAgent = todayCostAll.map(r => ({
    agentId: r.agent_id,
    name: r.agent_name || getAgentDisplayName(r.agent_id),
    todayCost: roundCost(r.cost),
  }));

  res.json({
    month,
    totals: fixedTotals,
    agents: filteredAgents,
    dailyTotals,
    timeline,
    availableMonths: months,
    totalTodayCost: roundCost(totalTodayCost),
    todayCostPerAgent,
  });
});

// GET /api/debug/cost-test — test cost calculation for a single JSONL line
app.get('/api/debug/cost-test', (req, res) => {
  const { estimateCostFromTokens } = require('./lib/parser');
  const pricingModule = require('./lib/pricing');
  
  const testUsage = { input: 2342111, output: 29955, cacheRead: 2898349 };
  const models = ['openrouter/auto', 'auto', 'unknown'];
  const results = {};
  
  for (const m of models) {
    results[m] = estimateCostFromTokens(testUsage, m);
  }
  
  results._pricingSource = pricingModule.getPricingTable().source;
  results._defaultAutoModel = pricingModule.getPricingTable().defaultAutoModel;
  results._autoDefaultPricing = pricingModule.getAutoDefaultPricing();
  
  res.json(results);
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

// GET /api/tokens?agent=X&from=YYYY-MM-DD&to=YYYY-MM-DD — tokeny per agent per dzień
app.get('/api/tokens', (req, res) => {
  const agentId = req.query.agent;
  const dateFrom = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]; // 30 dni wstecz
  const dateTo = req.query.to || new Date().toISOString().split('T')[0];
  
  if (!agentId) {
    return res.status(400).json({ error: 'Agent ID required' });
  }
  
  if (!AGENT_IDS.includes(agentId)) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const stats = db.getTokenStatsByAgent(agentId, dateFrom, dateTo);
    res.json({
      agent_id: agentId,
      agent_name: getAgentDisplayName(agentId),
      date_from: dateFrom,
      date_to: dateTo,
      stats
    });
  } catch (error) {
    console.error('[API] /api/tokens error:', error);
    res.status(500).json({ error: 'Failed to get token stats' });
  }
});

// GET /api/tokens/summary?month=2026-03&agent=X&from=2026-03-18&to=2026-03-18 — podsumowanie per agent
// If from/to are provided, they take priority over month (enables today/week/custom filtering)
app.get('/api/tokens/summary', (req, res) => {
  const agentId = req.query.agent;
  const dateFrom = req.query.from;
  const dateTo = req.query.to;
  
  try {
    let stats;
    let meta;
    
    if (dateFrom && dateTo) {
      // Date range mode (today, week, custom)
      stats = db.getTokenStatsSummaryRange(dateFrom, dateTo, agentId);
      meta = { from: dateFrom, to: dateTo };
    } else {
      // Monthly mode (backward compatible)
      const month = req.query.month || new Date().toISOString().slice(0, 7);
      stats = db.getTokenStatsSummary(month, agentId);
      meta = { month };
    }
    
    res.json({
      ...meta,
      agent_id: agentId || 'all',
      stats
    });
  } catch (error) {
    console.error('[API] /api/tokens/summary error:', error);
    res.status(500).json({ error: 'Failed to get token summary' });
  }
});

// GET /api/reconciliation/status — reconciliation status
app.get('/api/reconciliation/status', (req, res) => {
  res.json(reconciliation.getStatus());
});

// POST /api/reconciliation/run — trigger reconciliation (last 30 days or specific date)
app.post('/api/reconciliation/run', async (req, res) => {
  try {
    if (!reconciliation.isEnabled()) {
      return res.status(400).json({ error: 'OPENROUTER_MGMT_KEY not configured' });
    }
    const date = req.query.date;
    if (date) {
      const result = await reconciliation.reconcileDate(date);
      res.json(result);
    } else {
      const results = await reconciliation.reconcileRange(30);
      res.json({ days: results.length, reconciled: results.filter(r => r.status === 'ok').length, results });
    }
  } catch (error) {
    console.error('[API] /api/reconciliation/run error:', error);
    res.status(500).json({ error: 'Reconciliation failed' });
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

// GET /api/archive/status — archive stats + last run info
app.get('/api/archive/status', (req, res) => {
  try {
    const status = archiveWorker.getStatus(STATE_DIR, AGENT_IDS);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/archive/run — manual trigger
app.post('/api/archive/run', (req, res) => {
  try {
    const stats = archiveWorker.runArchive(STATE_DIR, AGENT_IDS);
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/analysis/reset — clear all AI analysis reports + JSON files
app.delete("/api/analysis/reset", (req, res) => {
  try {
    // 1. Clear SQLite
    const deleted = db.getDb().prepare("DELETE FROM analysis_reports").run();
    
    // 2. Clear JSON report files from disk
    const { DATA_DIR } = require("./lib/daily-analysis");
    let filesDeleted = 0;
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
      for (const file of files) {
        fs.unlinkSync(path.join(DATA_DIR, file));
        filesDeleted++;
      }
    }
    
    // 3. Clear cache
    cache.clear();
    
    res.json({ ok: true, deleted: deleted.changes, filesDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pricing — current pricing table and OpenRouter auto models
app.get('/api/pricing', (req, res) => {
  res.json(pricingModule.getPricingTable());
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Dashboard running on http://localhost:${PORT}`);
  console.log(`Agents: ${AGENT_IDS.map(id => `${id} (${getAgentDisplayName(id)})`).join(', ')}`);
  console.log(`State dir: ${STATE_DIR}`);

  // Init live pricing from OpenRouter (caches 24h, async)
  pricingModule.init();

  // One-time migration: wipe poisoned cost data from openrouter bug
  try {
    db.migrateFixBrokenCosts();
  } catch (err) {
    console.error('migrateFixBrokenCosts error:', err.message);
  }

  // Backfill historical stats into SQLite (runs once, fast on subsequent starts)
  try {
    backfillStats(STATE_DIR, AGENT_IDS, 90);
    console.log('Historical stats backfilled into SQLite');
  } catch (err) {
    console.error('Backfill error:', err.message);
  }

  // Compute fresh stats for today on startup
  try {
    computeRecent(STATE_DIR, AGENT_IDS);
    console.log('Recent stats computed (today + yesterday)');
  } catch (err) {
    console.error('computeRecent error:', err.message);
  }

  // Refresh today stats every 60 seconds
  setInterval(() => {
    try { computeToday(STATE_DIR, AGENT_IDS); } catch (e) { /* silent */ }
  }, 60000);

  // Start message archival worker (run now + every 5 min)
  try {
    archiveWorker.start(STATE_DIR, AGENT_IDS);
    console.log('Archive worker started');
  } catch (err) {
    console.error('Archive worker error:', err.message);
  }

  // Start nightly analysis scheduler
  scheduler.start(STATE_DIR, AGENT_IDS);

  // OpenRouter cost reconciliation (if Management Key configured)
  // Always cleanup bad data first (regardless of key)
  try { reconciliation.cleanupBadReconciliation(); } catch (e) { /* ignore */ }

  if (reconciliation.isEnabled()) {
    console.log('[Reconciliation] Management key detected — starting cost reconciliation');
    // Backfill last 30 days on startup (one-time catch-up)
    reconciliation.reconcileRange(30).then(results => {
      const ok = results.filter(r => r.status === 'ok').length;
      console.log(`[Reconciliation] Backfill complete: ${ok}/${results.length} days reconciled`);
    }).catch(err => console.error('[Reconciliation] Backfill error:', err.message));

    // Reconcile today + yesterday every 15 minutes
    setInterval(() => {
      reconciliation.reconcileRecent().catch(e => console.error('[Reconciliation] Periodic error:', e.message));
    }, 15 * 60 * 1000);
  } else {
    console.log('[Reconciliation] No OPENROUTER_MGMT_KEY — costs will be estimated only');
  }
});
