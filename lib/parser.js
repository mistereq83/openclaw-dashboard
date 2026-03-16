const fs = require('fs');
const path = require('path');
const livePricing = require('./pricing');

const AGENT_DISPLAY_NAMES = {
  patryk: 'Patryk Gocek',
  patrykg: 'Patryk Gocek',
  anna: 'Anna Gnatowska',
  annag: 'Anna Gnatowska',
  paulina: 'Paulina Grunau',
  paulinag: 'Paulina Grunau',
  katarzynag: 'Katarzyna Goll',
  katarzynac: 'Katarzyna Chrzanowska',
  krzysztofc: 'Krzysztof Ciarkowski',
  dominikag: 'Dominika Gacoń',
  pavlo: 'Pavlo Borysovets',
};

function getAgentDisplayName(agentId) {
  return AGENT_DISPLAY_NAMES[agentId] || agentId;
}
// Fallback model pricing ($ per 1M tokens) — used when usage.cost.total is 0 but tokens exist
const MODEL_PRICING = {
  // Anthropic
  'claude-opus-4-6':            { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-5':            { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514':   { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5':          { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5':           { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Moonshot / Kimi
  'kimi-k2-5':                  { input: 0.6, output: 2.5, cacheRead: 0.18, cacheWrite: 0.6 },
  'kimi-k2.5':                  { input: 0.6, output: 2.5, cacheRead: 0.18, cacheWrite: 0.6 },
  'kimi-k2-thinking':           { input: 0.6, output: 2.5, cacheRead: 0.18, cacheWrite: 0.6 },
  // OpenAI
  'gpt-4o':                     { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  'gpt-4o-mini':                { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  'o3-mini':                    { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
  // DeepSeek
  'deepseek-chat':              { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner':          { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  // Gemini
  'gemini-2.5-flash':           { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 },
  'gemini-2.5-pro':             { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 },
};

// Fuzzy model family matching — catches unknown variants like claude-sonnet-4-xyz
const MODEL_FAMILY_PATTERNS = [
  { pattern: /claude-opus-4/,    ref: 'claude-opus-4-6' },
  { pattern: /claude-sonnet-4/,  ref: 'claude-sonnet-4-6' },
  { pattern: /claude-haiku-4/,   ref: 'claude-haiku-4-5' },
  { pattern: /kimi-k2/,          ref: 'kimi-k2.5' },
  { pattern: /gpt-4o-mini/,      ref: 'gpt-4o-mini' },
  { pattern: /gpt-4o/,           ref: 'gpt-4o' },
  { pattern: /o3-mini/,          ref: 'o3-mini' },
  { pattern: /deepseek-chat/,    ref: 'deepseek-chat' },
  { pattern: /deepseek-reasoner/,ref: 'deepseek-reasoner' },
  { pattern: /gemini.*flash/,    ref: 'gemini-2.5-flash' },
  { pattern: /gemini.*pro/,      ref: 'gemini-2.5-pro' },
];

// Default pricing for openrouter/auto or unknown models (uses Sonnet pricing as reasonable middle)
const DEFAULT_PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function normalizeModel(model) {
  if (!model) return model;
  return model.includes('/') ? model.split('/').pop() : model;
}

function lookupPricing(model) {
  if (!model) return null;
  const normalized = normalizeModel(model);

  // Exact match first
  if (MODEL_PRICING[normalized]) return MODEL_PRICING[normalized];

  // Fuzzy family match
  for (const { pattern, ref } of MODEL_FAMILY_PATTERNS) {
    if (pattern.test(normalized)) return MODEL_PRICING[ref];
  }

  // For 'auto' (openrouter/auto) or truly unknown — use default
  if (normalized === 'auto') return DEFAULT_PRICING;

  return null;
}

function estimateCostFromTokens(usage, model) {
  if (!usage) return 0;

  // Try live OpenRouter pricing first (exact model match with provider prefix)
  let pricing = model ? livePricing.lookupLivePricing(model) : null;

  // For openrouter/auto — use configured default model
  if (!pricing && model && (model === 'openrouter/auto' || normalizeModel(model) === 'auto')) {
    pricing = livePricing.getAutoDefaultPricing();
  }

  // Fall back to hardcoded MODEL_PRICING
  if (!pricing) {
    pricing = lookupPricing(model);
  }

  if (!pricing) return 0;

  // Use Math.abs to handle OpenClaw bug where tokens are stored as negative
  const input = Math.abs(usage.input || 0) / 1e6 * pricing.input;
  const output = Math.abs(usage.output || 0) / 1e6 * pricing.output;
  const cacheRead = Math.abs(usage.cacheRead || 0) / 1e6 * (pricing.cacheRead || 0);
  const cacheWrite = Math.abs(usage.cacheWrite || 0) / 1e6 * (pricing.cacheWrite || 0);
  return input + output + cacheRead + cacheWrite;
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
            cost: (() => {
              const u = msg.usage || obj.usage;
              const rawCost = u && u.cost ? u.cost.total : 0;
              if (rawCost > 0) return rawCost;
              // Fallback: estimate from tokens + model (use full model ID with provider prefix)
              return estimateCostFromTokens(u, msg.model || obj.model);
            })(),
            model: msg.model || obj.model || null,
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
      if (obj.type === 'message' && usage) {
        const rawCost = usage.cost ? usage.cost.total || 0 : 0;
        if (rawCost > 0) {
          total += rawCost;
        } else {
          // Fallback: estimate from tokens + model (use full model ID with provider prefix)
          const model = (obj.message && obj.message.model) || obj.model || '';
          total += estimateCostFromTokens(usage, model);
        }
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

  // --- Merge archive metadata into live sessions + add archive-only sessions ---
  try {
    const db = require('./db');
    const archivedSessions = db.getArchivedSessions(agentId);
    const liveById = {};
    for (const s of sessions) liveById[s.id] = s;

    for (const s of archivedSessions) {
      if (seenIds.has(s.session_id)) {
        // Live session exists — extend date range from archive
        // (covers messages lost to compaction)
        const live = liveById[s.session_id];
        if (live) {
          const archFirst = s.first_message ? new Date(s.first_message) : null;
          const archLast = s.last_message ? new Date(s.last_message) : null;
          if (archFirst && (!live.firstMessage || archFirst < live.firstMessage)) {
            live.firstMessage = archFirst;
          }
          if (archLast && (!live.lastMessage || archLast > live.lastMessage)) {
            live.lastMessage = archLast;
          }
          // Use higher message count (archive may have more than compacted JSONL)
          if (s.message_count > live.messageCount) {
            live.messageCount = s.message_count;
          }
          if (s.user_message_count > live.userMessageCount) {
            live.userMessageCount = s.user_message_count;
          }
        }
        continue;
      }

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
        // Guard: reject archive costs that look like token counts (> $100/session is suspicious)
        cost: (s.total_cost && s.total_cost > 0 && s.total_cost < 1000) ? s.total_cost : 0,
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
  const liveMessages = fs.existsSync(filePath) ? parseJsonlFile(filePath) : [];

  // Merge with SQLite archive — covers messages lost to session compaction.
  // After compaction the JSONL file still exists but old messages are gone.
  // The archive worker (running every 5 min) stores copies before compaction.
  try {
    const db = require('./db');
    const archived = db.getArchivedMessages(agentId, sessionId);

    if (archived.length > liveMessages.length) {
      // Deduplicate: keep live version when timestamps+roles collide
      const seen = new Set(
        liveMessages.map(m => `${m.timestamp}|${m.role}`)
      );
      const merged = [...liveMessages];
      for (const msg of archived) {
        const key = `${msg.timestamp}|${msg.role}`;
        if (!seen.has(key)) {
          merged.push(msg);
          seen.add(key);
        }
      }
      return merged.sort((a, b) =>
        new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
      );
    }
  } catch {
    // DB not ready — fall through to live-only
  }

  return liveMessages;
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

// Parsuje WSZYSTKIE linie JSONL i zwraca koszty per-timestamp
// (nie tylko type:"message" z contentem text — WSZYSTKIE linie z usage.cost)
function getSessionCostByDate(stateDir, agentId, sessionId) {
  const filePath = path.join(getSessionsDir(stateDir, agentId), `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const costs = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const usage = obj.usage || (obj.message && obj.message.usage);
      if (obj.type === 'message' && usage) {
        const rawCost = usage.cost ? usage.cost.total || 0 : 0;
        const model = (obj.message && obj.message.model) || '';
        const finalCost = rawCost > 0 ? rawCost : estimateCostFromTokens(usage, model);
        if (finalCost > 0) {
          costs.push({
            timestamp: obj.timestamp || (obj.message && obj.message.timestamp) || null,
            cost: finalCost
          });
        }
      }
    } catch {} // skip malformed lines
  }
  return costs;
}

module.exports = {
  MODEL_PRICING,
  estimateCostFromTokens,
  AGENT_DISPLAY_NAMES,
  getAgentDisplayName,
  parseJsonlFile,
  listSessions,
  getSessionMessages,
  searchSessions,
  getSessionsDir,
  getSessionCostByDate,
};
