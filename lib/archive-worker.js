// Archive Worker — incremental JSONL → SQLite archival
// Runs at startup + every 5 minutes via setInterval
// No new npm dependencies — uses only better-sqlite3 (already in project)

const fs = require('fs');
const path = require('path');
const { parseJsonlFile, getSessionsDir } = require('./parser');
const db = require('./db');

// In-memory cache: "agentId:sessionId" → archived count
// Avoids repeated SQLite COUNT queries per interval
const countCache = {};

let lastRunAt = null;
let lastRunStats = { sessionsScanned: 0, messagesArchived: 0, errors: 0 };
let isRunning = false;

/**
 * Archive all JSONL sessions for all agents.
 * @param {string} stateDir - path to agents state dir
 * @param {string[]} agentIds - list of agent IDs
 * @returns {{ sessionsScanned, messagesArchived, errors }}
 */
function runArchive(stateDir, agentIds) {
  if (isRunning) {
    console.log('[archive-worker] Already running, skipping');
    return lastRunStats;
  }
  isRunning = true;

  let sessionsScanned = 0;
  let messagesArchived = 0;
  let errors = 0;

  try {
    for (const agentId of agentIds) {
      const sessionsDir = getSessionsDir(stateDir, agentId);
      if (!fs.existsSync(sessionsDir)) continue;

      let files;
      try {
        files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      } catch (err) {
        console.error(`[archive-worker] Cannot read dir for ${agentId}:`, err.message);
        errors++;
        continue;
      }

      for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        const filePath = path.join(sessionsDir, file);
        sessionsScanned++;

        try {
          const messages = parseJsonlFile(filePath);
          if (messages.length === 0) continue;

          const cacheKey = `${agentId}:${sessionId}`;
          const cachedCount = countCache[cacheKey];

          // Check if we need to archive more messages
          let archivedCount;
          if (cachedCount !== undefined && cachedCount >= messages.length) {
            // Cache says we already have all messages — skip DB query
            continue;
          }

          // Either cache miss or file has grown — check actual DB count
          archivedCount = db.getArchivedMessageCount(agentId, sessionId);
          countCache[cacheKey] = archivedCount;

          if (archivedCount >= messages.length) continue;

          // Archive new messages (ON CONFLICT IGNORE handles dedupe)
          // Archive ALL messages — the UNIQUE constraint will dedupe safely
          const newCount = db.archiveMessages(agentId, sessionId, messages);
          messagesArchived += newCount;

          // Update cache with new total
          countCache[cacheKey] = archivedCount + newCount;

          if (newCount > 0) {
            console.log(`[archive-worker] ${agentId}/${sessionId}: +${newCount} messages archived`);
          }
        } catch (err) {
          console.error(`[archive-worker] Error archiving ${agentId}/${sessionId}:`, err.message);
          errors++;
        }
      }
    }
  } finally {
    isRunning = false;
    lastRunAt = new Date().toISOString();
    lastRunStats = { sessionsScanned, messagesArchived, errors };
    console.log(`[archive-worker] Done: ${sessionsScanned} sessions scanned, ${messagesArchived} messages archived, ${errors} errors`);
  }

  return lastRunStats;
}

/**
 * Start the archive worker: run immediately + every 5 minutes.
 * @param {string} stateDir
 * @param {string[]} agentIds
 */
function start(stateDir, agentIds) {
  console.log('[archive-worker] Starting (initial run + 5min interval)');

  // Initial run
  try {
    runArchive(stateDir, agentIds);
  } catch (err) {
    console.error('[archive-worker] Initial run error:', err.message);
  }

  // Schedule every 5 minutes
  setInterval(() => {
    try {
      runArchive(stateDir, agentIds);
    } catch (err) {
      console.error('[archive-worker] Interval run error:', err.message);
    }
  }, 5 * 60 * 1000);
}

/**
 * Get current status for /api/archive/status
 */
function getStatus(stateDir, agentIds) {
  const archiveStats = db.getArchiveStats();

  // Count sessions known ONLY from archive (JSONL deleted)
  let archiveOnlySessions = 0;
  for (const agentId of agentIds) {
    const archivedSessions = db.getArchivedSessions(agentId);
    const sessionsDir = getSessionsDir(stateDir, agentId);

    for (const s of archivedSessions) {
      const filePath = path.join(sessionsDir, `${s.session_id}.jsonl`);
      if (!fs.existsSync(filePath)) {
        archiveOnlySessions++;
      }
    }
  }

  return {
    lastRunAt,
    isRunning,
    lastRunStats,
    archiveStats: {
      ...archiveStats,
      archiveOnlySessions,
    },
  };
}

module.exports = { start, runArchive, getStatus };
