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
      messages.push({
        role: obj.role || 'unknown',
        content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content || ''),
        timestamp: obj.timestamp || null,
        tokens: obj.tokens || null,
      });
    } catch {
      // Skip malformed lines — defensive parsing per brief
    }
  }
  return messages;
}

function getSessionsDir(stateDir, agentId) {
  return path.join(stateDir, agentId, 'sessions');
}

function listSessions(stateDir, agentId) {
  const sessionsDir = getSessionsDir(stateDir, agentId);
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
  const sessions = [];

  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    const sessionId = path.basename(file, '.jsonl');
    const stat = fs.statSync(filePath);
    const messages = parseJsonlFile(filePath);

    const userMessages = messages.filter(m => m.role === 'user');
    const timestamps = messages.filter(m => m.timestamp).map(m => new Date(m.timestamp));
    const firstMessage = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : stat.birthtime;
    const lastMessage = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : stat.mtime;

    sessions.push({
      id: sessionId,
      file,
      messageCount: messages.length,
      userMessageCount: userMessages.length,
      firstMessage,
      lastMessage,
      preview: messages.length > 0 ? messages[0].content.substring(0, 120) : '',
      sizeBytes: stat.size,
    });
  }

  sessions.sort((a, b) => b.lastMessage - a.lastMessage);
  return sessions;
}

function getSessionMessages(stateDir, agentId, sessionId) {
  const filePath = path.join(getSessionsDir(stateDir, agentId), `${sessionId}.jsonl`);
  return parseJsonlFile(filePath);
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
