// SQLite database layer for historical stats
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(process.env.DB_PATH || '/data/dashboard.db');

let db = null;

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  init();
  return db;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      sessions INTEGER DEFAULT 0,
      messages INTEGER DEFAULT 0,
      user_messages INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      PRIMARY KEY (date, agent_id)
    );

    CREATE TABLE IF NOT EXISTS analysis_reports (
      date TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      analysis_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (date, agent_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_stats(date);
    CREATE INDEX IF NOT EXISTS idx_daily_agent ON daily_stats(agent_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_date ON analysis_reports(date);
  `);
}

// --- Daily Stats ---

function upsertDailyStats(date, agentId, agentName, stats) {
  const stmt = getDb().prepare(`
    INSERT INTO daily_stats (date, agent_id, agent_name, sessions, messages, user_messages, cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, agent_id) DO UPDATE SET
      agent_name=excluded.agent_name,
      sessions=excluded.sessions,
      messages=excluded.messages,
      user_messages=excluded.user_messages,
      cost=excluded.cost
  `);
  stmt.run(date, agentId, agentName, stats.sessions, stats.messages, stats.userMessages, stats.cost);
}

function getDailyStats(date, agentId) {
  const d = getDb();
  if (agentId) {
    return d.prepare('SELECT * FROM daily_stats WHERE date = ? AND agent_id = ?').get(date, agentId);
  }
  return d.prepare('SELECT * FROM daily_stats WHERE date = ?').all(date);
}

function getMonthlyStats(yearMonth, agentId) {
  const d = getDb();
  const like = yearMonth + '%'; // e.g. '2026-03%'
  if (agentId) {
    return d.prepare(`
      SELECT agent_id, agent_name,
        SUM(sessions) as sessions, SUM(messages) as messages,
        SUM(user_messages) as user_messages, SUM(cost) as cost,
        COUNT(*) as active_days,
        MIN(date) as first_active, MAX(date) as last_active
      FROM daily_stats WHERE date LIKE ? AND agent_id = ?
      GROUP BY agent_id
    `).get(like, agentId);
  }
  return d.prepare(`
    SELECT agent_id, agent_name,
      SUM(sessions) as sessions, SUM(messages) as messages,
      SUM(user_messages) as user_messages, SUM(cost) as cost,
      COUNT(*) as active_days,
      MIN(date) as first_active, MAX(date) as last_active
    FROM daily_stats WHERE date LIKE ?
    GROUP BY agent_id
    ORDER BY user_messages DESC
  `).all(like);
}

function getRangeStats(dateFrom, dateTo, agentId) {
  const d = getDb();
  if (agentId) {
    return d.prepare(`
      SELECT agent_id, agent_name,
        SUM(sessions) as sessions, SUM(messages) as messages,
        SUM(user_messages) as user_messages, SUM(cost) as cost,
        COUNT(*) as active_days
      FROM daily_stats WHERE date >= ? AND date <= ? AND agent_id = ?
      GROUP BY agent_id
    `).get(dateFrom, dateTo, agentId);
  }
  return d.prepare(`
    SELECT agent_id, agent_name,
      SUM(sessions) as sessions, SUM(messages) as messages,
      SUM(user_messages) as user_messages, SUM(cost) as cost,
      COUNT(*) as active_days
    FROM daily_stats WHERE date >= ? AND date <= ?
    GROUP BY agent_id
    ORDER BY user_messages DESC
  `).all(dateFrom, dateTo);
}

function getDailyTimeline(yearMonth) {
  const like = yearMonth + '%';
  return getDb().prepare(`
    SELECT date, SUM(sessions) as sessions, SUM(messages) as messages,
      SUM(user_messages) as user_messages, SUM(cost) as cost
    FROM daily_stats WHERE date LIKE ?
    GROUP BY date ORDER BY date
  `).all(like);
}

function getDailyTimelineByAgent(yearMonth) {
  const like = yearMonth + '%';
  return getDb().prepare(`
    SELECT date, agent_id, agent_name, sessions, messages, user_messages, cost
    FROM daily_stats WHERE date LIKE ?
    ORDER BY date, agent_id
  `).all(like);
}

function getOverviewTotals(yearMonth) {
  const like = yearMonth + '%';
  return getDb().prepare(`
    SELECT
      COUNT(DISTINCT agent_id) as agents,
      SUM(sessions) as sessions,
      SUM(messages) as messages,
      SUM(user_messages) as user_messages,
      ROUND(SUM(cost), 4) as cost
    FROM daily_stats WHERE date LIKE ?
  `).get(like);
}

function getAvailableMonths() {
  return getDb().prepare(`
    SELECT DISTINCT substr(date, 1, 7) as month
    FROM daily_stats ORDER BY month DESC
  `).all().map(r => r.month);
}

// --- Analysis Reports ---

function saveAnalysisResult(date, agentId, sessionId, analysisJson) {
  getDb().prepare(`
    INSERT INTO analysis_reports (date, agent_id, session_id, analysis_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, agent_id, session_id) DO UPDATE SET
      analysis_json=excluded.analysis_json,
      created_at=datetime('now')
  `).run(date, agentId, sessionId, JSON.stringify(analysisJson));
}

function getAnalysisForDate(date, agentId) {
  const d = getDb();
  const rows = agentId
    ? d.prepare('SELECT * FROM analysis_reports WHERE date = ? AND agent_id = ?').all(date, agentId)
    : d.prepare('SELECT * FROM analysis_reports WHERE date = ?').all(date);
  return rows.map(r => ({ ...r, analysis: JSON.parse(r.analysis_json || '{}') }));
}

module.exports = {
  getDb,
  upsertDailyStats,
  getDailyStats,
  getMonthlyStats,
  getRangeStats,
  getDailyTimeline,
  getDailyTimelineByAgent,
  getOverviewTotals,
  getAvailableMonths,
  saveAnalysisResult,
  getAnalysisForDate,
};
