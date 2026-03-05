const fs = require('fs');
const path = require('path');

const AGENT_DISPLAY_NAMES = {
  patryk: 'Patryk Gocek',
  patrykg: 'Patryk Gocek',
  anna: 'Anna Gnatowska',
  annag: 'Anna Gnatowska',
  paulina: 'Paulina Grunau',
  paulinag: 'Paulina Grunau',
  katarzynag: 'Katarzyna Goll',
  katarzynac: 'Katarzyna Chrzanowska',
};

function getAgentDisplayName(agentId) {
  return AGENT_DISPLAY_NAMES[agentId] || agentId;
}

function parseJsonlFile(filePath) {
  const messages = [];
  if (!fs.existsSync(filePath)) return messages;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // OpenClaw JSONL format: { type: "message", message: { role, content: [{type,text}] } }
      if (obj.type === 'message' && obj.message) {
        const msg = obj.message;
        const role = msg.role || 'unknown';
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extract text from content blocks, filter out metadata blocks
          const textParts = msg.content
            .filter(b => b.type === 'text')
            .map(b => b.text || '');
          content = textParts.join('\n');
          // Strip OpenClaw metadata wrapper (Conversation info, Sender metadata)
          content = content.replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\n/g, '')
                           .replace(/Sender \(untrusted metadata\):[\s\S]*?```\n/g, '')
                           .trim();
        }
        if (content) {
          messages.push({
            role,
            content,
            timestamp: obj.timestamp || msg.timestamp || null,
            tokens: (obj.usage || msg.usage) ? (obj.usage || msg.usage).totalTokens : null,
            cost: msg.usage && msg.usage.cost ? msg.usage.cost.total : (obj.usage && obj.usage.cost ? obj.usage.cost.total : 0),
            usage: msg.usage || obj.usage || null,
          });
        }
      }
    } catch {
      // Skip malformed lines — defensive parsing per brief
    }
  }
  return messages;
}

function calcSessionCost(stateDir, agentId, sessionId) {
  const filePath = path.join(getSessionsDir(stateDir, agentId), `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  let total = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // usage can be at top level OR nested inside obj.message
      const usage = obj.usage || (obj.message && obj.message.usage);
      if (obj.type === 'message' && usage && usage.cost) {
        total += usage.cost.total || 0;
      }
    } catch { /* skip */ }
  }
  return total;
}

function getSessionsDir(stateDir, agentId) {
  return path.join(stateDir, agentId, 'sessions');
}

function listSessions(stateDir, agentId) {
  const sessionsDir = getSessionsDir(stateDir, agentId);
  const sessions = [];
  const seenIds = new Set();

  // --- Live JSONL sessions ---
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(sessionsDir, file);
      const sessionId = path.basename(file, '.jsonl');
      seenIds.add(sessionId);
      const stat = fs.statSync(filePath);
      const messages = parseJsonlFile(filePath);

      const userMessages = messages.filter(m => m.role === 'user');
      const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp));
      const firstMessage = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : stat.birthtime;
      const lastMessage = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : stat.mtime;

      const sessionCost = calcSessionCost(stateDir, agentId, sessionId);
      sessions.push({
        id: sessionId,
        file,
        messageCount: messages.length,
        userMessageCount: userMessages.length,
        firstMessage,
        lastMessage,
        preview: messages.length > 0 ? messages[0].content.substring(0, 120) : '',
        sizeBytes: stat.size,
        cost: sessionCost,
        fromArchive: false,
      });
    }
  }

  // --- Archived-only sessions (JSONL deleted/compacted) ---
  try {
    const db = require('./db');
    const archivedSessions = db.getArchivedSessions(agentId);

    for (const s of archivedSessions) {
      if (seenIds.has(s.session_id)) continue; // already covered by live file

      const filePath = path.join(sessionsDir, `${s.session_id}.jsonl`);
      if (fs.existsSync(filePath)) continue; // live file appeared

      sessions.push({
        id: s.session_id,
        file: `${s.session_id}.jsonl`,
        messageCount: s.message_count,
        userMessageCount: s.user_message_count,
        firstMessage: s.first_message ? new Date(s.first_message) : null,
        lastMessage: s.last_message ? new Date(s.last_message) : null,
        preview: '',
        sizeBytes: 0,
        cost: s.total_cost || 0,
        fromArchive: true,
      });
    }
  } catch (err) {
    // DB not ready yet — silently skip archive merge
  }

  sessions.sort((a, b) => {
    const ta = b.lastMessage ? new Date(b.lastMessage).getTime() : 0;
    const tb = a.lastMessage ? new Date(a.lastMessage).getTime() : 0;
    return ta - tb;
  });
  return sessions;
}

function getSessionMessages(stateDir, agentId, sessionId) {
  const filePath = path.join(getSessionsDir(stateDir, agentId), `${sessionId}.jsonl`);
  if (fs.existsSync(filePath)) {
    return parseJsonlFile(filePath);
  }
  // Fallback: read from SQLite archive (JSONL was deleted/compacted)
  try {
    const db = require('./db');
    return db.getArchivedMessages(agentId, sessionId);
  } catch (err) {
    return [];
  }
}

function searchSessions(stateDir, agentId, query, options = {}) {
  const sessions = listSessions(stateDir, agentId);
  const results = [];
  const lowerQuery = query.toLowerCase();
  const { dateFrom, dateTo, minMessages } = options;

  for (const session of sessions) {
    if (minMessages && session.messageCount < minMessages) continue;
    if (dateFrom && session.lastMessage < new Date(dateFrom)) continue;
    if (dateTo && session.firstMessage > new Date(dateTo)) continue;

    const messages = getSessionMessages(stateDir, agentId, session.id);
    const matches = messages.filter(m => m.content.toLowerCase().includes(lowerQuery));

    if (matches.length > 0) {
      results.push({
        sessionId: session.id,
        matchCount: matches.length,
        preview: matches[0].content.substring(0, 200),
        sessionDate: session.lastMessage,
      });
    }
  }

  return results;
}

module.exports = {
  AGENT_DISPLAY_NAMES,
  getAgentDisplayName,
  parseJsonlFile,
  listSessions,
  getSessionMessages,
  searchSessions,
  getSessionsDir,
};
