// OpenRouter Activity API reconciliation
// Fetches real costs from OpenRouter and updates daily_token_stats.reconciled_cost
const db = require('./db');

const MGMT_KEY = process.env.OPENROUTER_MGMT_KEY || '';
const ACTIVITY_URL = 'https://openrouter.ai/api/v1/activity';

function isEnabled() {
  return !!MGMT_KEY;
}

// Fetch activity for a specific date (YYYY-MM-DD) or all last 30 days
async function fetchActivity(date) {
  if (!MGMT_KEY) {
    console.log('[Reconciliation] No OPENROUTER_MGMT_KEY configured — skipping');
    return null;
  }

  try {
    const url = date ? `${ACTIVITY_URL}?date=${date}` : ACTIVITY_URL;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${MGMT_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (resp.status === 403) {
      console.error('[Reconciliation] 403 Forbidden — is this a Management key? (not inference key)');
      return null;
    }

    if (!resp.ok) {
      console.error(`[Reconciliation] HTTP ${resp.status}: ${resp.statusText}`);
      return null;
    }

    const data = await resp.json();
    return data.data || [];
  } catch (err) {
    console.error(`[Reconciliation] Fetch error: ${err.message}`);
    return null;
  }
}

// Normalize model name to match what's in daily_token_stats
function normalizeModel(model) {
  if (!model) return 'unknown';
  return model.includes('/') ? model.split('/').pop() : model;
}

// Reconcile a specific date: distribute OpenRouter costs across agents proportionally
async function reconcileDate(dateStr) {
  if (!MGMT_KEY) return { date: dateStr, status: 'skipped', reason: 'no_mgmt_key' };

  const activity = await fetchActivity(dateStr);
  if (!activity || activity.length === 0) {
    return { date: dateStr, status: 'no_data', modelsReconciled: 0 };
  }

  const d = db.getDb();
  let modelsReconciled = 0;
  let totalRealCost = 0;

  // Group activity by normalized model
  const activityByModel = {};
  for (const item of activity) {
    const model = normalizeModel(item.model);
    if (!activityByModel[model]) {
      activityByModel[model] = {
        realCost: 0,
        promptTokens: 0,
        completionTokens: 0,
        requests: 0,
      };
    }
    // item.usage = total cost in USD from OpenRouter
    // Guard: must be positive and reasonable (max $1000/day/model is very generous)
    const itemCost = (typeof item.usage === 'number' && item.usage > 0 && item.usage < 1000) ? item.usage : 0;
    activityByModel[model].realCost += itemCost;
    activityByModel[model].promptTokens += item.prompt_tokens || 0;
    activityByModel[model].completionTokens += item.completion_tokens || 0;
    activityByModel[model].requests += item.requests || 0;
  }

  // For each model in activity, find matching rows in daily_token_stats and distribute cost
  for (const [model, actData] of Object.entries(activityByModel)) {
    if (actData.realCost <= 0) continue;

    // Get all agent rows for this date + model
    const rows = d.prepare(`
      SELECT agent_id, total_tokens, estimated_cost 
      FROM daily_token_stats 
      WHERE date = ? AND model = ?
    `).all(dateStr, model);

    if (rows.length === 0) {
      // Try fuzzy match — activity model might be full slug, our DB has short name
      // e.g. activity: "claude-sonnet-4-6-20250514" vs DB: "claude-sonnet-4-6"
      const fuzzyRows = d.prepare(`
        SELECT agent_id, model, total_tokens, estimated_cost 
        FROM daily_token_stats 
        WHERE date = ? AND model LIKE ?
      `).all(dateStr, model.split('-').slice(0, 3).join('-') + '%');

      if (fuzzyRows.length === 0) continue;

      // Distribute proportionally by tokens
      const totalTokens = fuzzyRows.reduce((sum, r) => sum + (r.total_tokens || 1), 0);
      for (const row of fuzzyRows) {
        const proportion = (row.total_tokens || 1) / totalTokens;
        const reconciledCost = actData.realCost * proportion;
        // Sanity: reconciled cost must be positive and < $100 per agent per day per model
        if (reconciledCost <= 0 || reconciledCost > 100) continue;
        d.prepare(`
          UPDATE daily_token_stats SET reconciled_cost = ? 
          WHERE date = ? AND agent_id = ? AND model = ?
        `).run(reconciledCost, dateStr, row.agent_id, row.model);
      }
      modelsReconciled++;
      totalRealCost += actData.realCost;
      continue;
    }

    // Distribute proportionally by total_tokens
    const totalTokens = rows.reduce((sum, r) => sum + (r.total_tokens || 1), 0);
    for (const row of rows) {
      const proportion = (row.total_tokens || 1) / totalTokens;
      const reconciledCost = actData.realCost * proportion;
      // Sanity: reconciled cost must be positive and < $100 per agent per day per model
      if (reconciledCost <= 0 || reconciledCost > 100) continue;
      d.prepare(`
        UPDATE daily_token_stats SET reconciled_cost = ? 
        WHERE date = ? AND agent_id = ? AND model = ?
      `).run(reconciledCost, dateStr, row.agent_id, model);
    }
    modelsReconciled++;
    totalRealCost += actData.realCost;
  }

  console.log(`[Reconciliation] ${dateStr}: ${modelsReconciled} models reconciled, $${totalRealCost.toFixed(4)} real cost`);
  return { date: dateStr, status: 'ok', modelsReconciled, totalRealCost };
}

// Reconcile last N days (max 30 — Activity API limit)
async function reconcileRange(daysBack = 30) {
  if (!MGMT_KEY) {
    console.log('[Reconciliation] No OPENROUTER_MGMT_KEY — skipping range reconciliation');
    return [];
  }

  const results = [];
  const now = new Date();

  for (let i = 1; i <= Math.min(daysBack, 30); i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const result = await reconcileDate(dateStr);
    results.push(result);

    // Rate limit: 200ms between requests
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`[Reconciliation] Range reconciliation complete: ${results.filter(r => r.status === 'ok').length}/${results.length} days`);
  return results;
}

// Reconcile today + yesterday (for scheduler)
async function reconcileRecent() {
  if (!MGMT_KEY) return;

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  await reconcileDate(yesterday);
  await reconcileDate(today);
}

// Get reconciliation status
function getStatus() {
  if (!MGMT_KEY) {
    return { enabled: false, reason: 'OPENROUTER_MGMT_KEY not configured' };
  }

  const d = db.getDb();
  const reconciled = d.prepare(`
    SELECT COUNT(DISTINCT date) as days, 
           SUM(reconciled_cost) as total_cost
    FROM daily_token_stats 
    WHERE reconciled_cost IS NOT NULL
  `).get();

  const unreconciled = d.prepare(`
    SELECT COUNT(DISTINCT date) as days 
    FROM daily_token_stats 
    WHERE reconciled_cost IS NULL AND total_tokens > 0
  `).get();

  return {
    enabled: true,
    reconciledDays: reconciled?.days || 0,
    unreconciledDays: unreconciled?.days || 0,
    totalReconciledCost: reconciled?.total_cost || 0,
  };
}

// Wipe bad reconciled costs (negative, absurdly large, etc.)
function cleanupBadReconciliation() {
  const d = db.getDb();
  const result = d.prepare(`
    UPDATE daily_token_stats SET reconciled_cost = NULL
    WHERE reconciled_cost IS NOT NULL AND (reconciled_cost < 0 OR reconciled_cost > 100)
  `).run();
  if (result.changes > 0) {
    console.log(`[Reconciliation] Cleaned up ${result.changes} rows with bad reconciled_cost`);
  }
  return result.changes;
}

module.exports = {
  isEnabled,
  fetchActivity,
  reconcileDate,
  reconcileRange,
  reconcileRecent,
  getStatus,
  cleanupBadReconciliation,
};
