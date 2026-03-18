// OpenRouter live pricing module — fetches real prices, caches 24h
// Supplements the hardcoded MODEL_PRICING in parser.js with live data
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', '.pricing-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// OpenRouter auto models — specific pricing for the 5 models in rotation
// These take priority over parser.js MODEL_PRICING for openrouter/auto estimation
const OPENROUTER_AUTO_MODELS = {
  'anthropic/claude-sonnet-4.6':   { input: 3.0,  output: 15.0, cacheRead: 0.3 },
  'anthropic/claude-haiku-4.5':    { input: 1.0,  output: 5.0,  cacheRead: 0.1 },
  'google/gemini-3-flash-preview': { input: 0.5,  output: 3.0,  cacheRead: 0.05 },
  'google/gemini-3.1-pro-preview': { input: 2.0,  output: 12.0, cacheRead: 0.2 },
  'perplexity/sonar':              { input: 1.0,  output: 1.0,  cacheRead: 0 },
  // Moonshot variants seen in logs
  'moonshot-v1-128k':              { input: 0.6,  output: 0.6,  cacheRead: 0 },
};

// Default model for openrouter/auto (configurable via env)
const DEFAULT_AUTO_MODEL = process.env.OPENROUTER_DEFAULT_MODEL || 'google/gemini-3-flash-preview';

let livePricing = null;
let lastFetch = 0;

// Fetch pricing from OpenRouter API
async function fetchLivePricing() {
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const pricing = {};
    for (const model of (data.data || [])) {
      if (model.pricing) {
        const promptPrice = parseFloat(model.pricing.prompt || '0');
        const completionPrice = parseFloat(model.pricing.completion || '0');
        // Skip models with -1 pricing (variable/unknown, e.g. openrouter/auto)
        if (promptPrice < 0 || completionPrice < 0) continue;
        pricing[model.id] = {
          input: promptPrice * 1e6,   // convert $/token → $/1M tokens
          output: completionPrice * 1e6,
          cacheRead: parseFloat(model.pricing.input_cache_read || '0') * 1e6,
        };
      }
    }

    // Write cache
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), pricing }), 'utf-8');
    } catch { /* non-critical */ }

    livePricing = pricing;
    lastFetch = Date.now();
    console.log(`[Pricing] Fetched ${Object.keys(pricing).length} models from OpenRouter`);
    return pricing;
  } catch (err) {
    console.error(`[Pricing] Failed to fetch live pricing: ${err.message}`);
    return null;
  }
}

// Load from disk cache
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (Date.now() - raw.ts < CACHE_TTL_MS) {
      livePricing = raw.pricing;
      lastFetch = raw.ts;
      console.log(`[Pricing] Loaded ${Object.keys(raw.pricing).length} models from cache`);
      return raw.pricing;
    }
  } catch { /* ignore corrupt cache */ }
  return null;
}

// Lookup pricing for a model: live > auto-models > null (fall through to parser.js)
function lookupLivePricing(modelId) {
  if (!modelId) return null;

  // Live pricing (full model ID with provider prefix)
  if (livePricing && livePricing[modelId]) {
    return livePricing[modelId];
  }

  // OpenRouter auto models
  if (OPENROUTER_AUTO_MODELS[modelId]) {
    return OPENROUTER_AUTO_MODELS[modelId];
  }

  return null;
}

// Get pricing for openrouter/auto default model
function getAutoDefaultPricing() {
  return lookupLivePricing(DEFAULT_AUTO_MODEL) || OPENROUTER_AUTO_MODELS[DEFAULT_AUTO_MODEL];
}

// Check if cost is broken (negative values = OpenClaw bug with openrouter)
function isCostBroken(cost) {
  if (!cost) return true;
  if (typeof cost.total !== 'number') return true;
  if (cost.total <= 0) return true;
  if (cost.input < 0 || cost.output < 0) return true;
  return false;
}

// Init: load cache, schedule refresh
function init() {
  loadCache();
  fetchLivePricing().catch(() => {});
  setInterval(() => {
    fetchLivePricing().catch(() => {});
  }, CACHE_TTL_MS);
}

// Get full pricing table (for /api/pricing endpoint)
function getPricingTable() {
  const source = livePricing ? 'openrouter-live' : 'fallback';
  return {
    source,
    defaultAutoModel: DEFAULT_AUTO_MODEL,
    lastFetch: lastFetch ? new Date(lastFetch).toISOString() : null,
    modelCount: livePricing ? Object.keys(livePricing).length : 0,
    autoModels: Object.keys(OPENROUTER_AUTO_MODELS).map(id => ({
      id,
      ...OPENROUTER_AUTO_MODELS[id],
      isDefault: id === DEFAULT_AUTO_MODEL,
      livePrice: livePricing ? livePricing[id] || null : null,
    })),
  };
}

module.exports = {
  init,
  lookupLivePricing,
  getAutoDefaultPricing,
  isCostBroken,
  getPricingTable,
  fetchLivePricing,
  OPENROUTER_AUTO_MODELS,
  DEFAULT_AUTO_MODEL,
};
