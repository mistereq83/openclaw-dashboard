// Built-in scheduler for nightly analysis
const { runDailyAnalysis } = require('./daily-analysis');
const { computeRecent, backfillStats } = require('./stats-worker');

const CRON_HOUR = parseInt(process.env.ANALYSIS_CRON_HOUR || '3', 10);
const CRON_MINUTE = parseInt(process.env.ANALYSIS_CRON_MINUTE || '0', 10);
const CRON_ENABLED = process.env.ANALYSIS_CRON_ENABLED !== 'false';

let timer = null;
let lastRun = null;
let isRunning = false;

function getNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(CRON_HOUR, CRON_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function start(stateDir, agentIds) {
  if (!CRON_ENABLED) {
    console.log('[Scheduler] Disabled (ANALYSIS_CRON_ENABLED=false)');
    return;
  }

  function scheduleNext() {
    const next = getNextRun();
    const delay = next.getTime() - Date.now();
    console.log(`[Scheduler] Next analysis at ${next.toISOString()} (in ${Math.round(delay / 60000)}min)`);

    timer = setTimeout(async () => {
      const dateStr = getYesterday();
      console.log(`[Scheduler] Starting nightly tasks for ${dateStr}`);
      isRunning = true;

      try {
        // 1. Compute daily stats
        computeRecent(stateDir, agentIds);

        // 2. Run AI analysis
        const report = await runDailyAnalysis(stateDir, agentIds, dateStr);
        lastRun = { date: dateStr, at: new Date().toISOString(), success: true, sessions: report.totals.sessions };
        console.log(`[Scheduler] Nightly tasks complete for ${dateStr}: ${report.totals.sessions} sessions`);
      } catch (err) {
        lastRun = { date: dateStr, at: new Date().toISOString(), success: false, error: err.message };
        console.error(`[Scheduler] Nightly tasks failed for ${dateStr}:`, err.message);
      }

      isRunning = false;
      scheduleNext();
    }, delay);
  }

  scheduleNext();
  console.log(`[Scheduler] Started — nightly analysis at ${CRON_HOUR}:${String(CRON_MINUTE).padStart(2, '0')}`);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function status() {
  return {
    enabled: CRON_ENABLED,
    cronTime: `${CRON_HOUR}:${String(CRON_MINUTE).padStart(2, '0')}`,
    nextRun: CRON_ENABLED ? getNextRun().toISOString() : null,
    lastRun,
    isRunning,
  };
}

module.exports = { start, stop, status, getYesterday };
