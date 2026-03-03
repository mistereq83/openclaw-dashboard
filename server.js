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

// GET /api/stats/overview
app.get('/api/stats/overview', (req, res) => {
  const cacheKey = 'overview';
  let data = cache.get(cacheKey);
  if (!data) {
    data = getOverviewStats(STATE_DIR, AGENT_IDS);
    cache.set(cacheKey, data);
  }
  res.json(data);
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`OpenClaw Dashboard running on http://localhost:${PORT}`);
  console.log(`Agents: ${AGENT_IDS.map(id => `${id} (${getAgentDisplayName(id)})`).join(', ')}`);
  console.log(`State dir: ${STATE_DIR}`);
});
