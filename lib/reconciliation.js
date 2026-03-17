// OpenRouter Activity API reconciliation
// Fetches real total cost per day and distributes proportionally across agents by token usage
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

// Reconcile a specific date:
// Strategy: get total real cost for the day from Activity API,
// then distribute proportionally across ALL agents by their total_tokens.
// This works correctly even when all agents use openrouter/auto (model unknown).
async function reconcileDate(dateStr) {
  if (!MGMT_KEY) return { date: dateStr, status: 'skipped', reason: 'no_mgmt_key' };

  const activity = await fetchActivity(dateStr);
  if (!activity || activity.length === 0) {
    return { date: dateStr, status: 'no_data', modelsReconciled: 0 };
  }

  // Sum total real cost for this day across ALL models/providers
  let totalRealCostForDay = 0;
  for (const item of activity) {
    const cost = (typeof item.usage === 'number' && item.usage > 0 && item.usage < 10000) ? item.usage : 0;
    totalRealCostForDay += cost;
  }

  if (totalRealCostForDay <= 0) {
    return { date: dateStr, status: 'no_cost', totalRealCost: 0 };
  }

  const d = db.getDb();

  // Get ALL agent token stats for this date (any model)
  const rows = d.prepare(`
    SELECT agent_id, model, total_tokens
    FROM daily_token_stats
    WHERE date = ? AND total_tokens > 0
  `).all(dateStr);

  if (rows.length === 0) {
    console.log(`[Reconciliation] ${dateStr}: no token stats found — run backfill first`);
    return { date: dateStr, status: 'no_agents', totalRealCost: totalRealCostForDay };
  }

  // Calculate total tokens across ALL agents for this day
  const grandTotal = rows.reduce((sum, r) => sum + r.total_tokens, 0);
  if (grandTotal === 0) {
    return { date: dateStr, status: 'no_tokens', totalRealCost: totalRealCostForDay };
  }

  // Distribute cost proportionally by tokens per agent+model row
  const update = d.prepare(`
    UPDATE daily_token_stats SET reconciled_cost = ?
    WHERE date = ? AND agent_id = ? AND model = ?
  `);

  const updateMany = d.transaction((rowsToUpdate) => {
    for (const { agent_id, model, total_tokens } of rowsToUpdate) {
      const proportion = total_tokens / grandTotal;
      const reconciledCost = totalRealCostForDay * proportion;
      // Guard: per-row cost must be reasonable (< $500/agent/day)
      if (reconciledCost > 0 && reconciledCost < 500) {
        update.run(reconciledCost, dateStr, agent_id, model);
      }
    }
  });

  updateMany(rows);

  console.log(`[Reconciliation] ${dateStr}: $${totalRealCostForDay.toFixed(4)} distributed across ${rows.length} rows (${[...new Set(rows.map(r => r.agent_id))].length} agents)`);
  return {
    date: dateStr,
    status: 'ok',
    totalRealCost: totalRealCostForDay,
    agentCount: [...new Set(rows.map(r => r.agent_id))].length,
    rowCount: rows.length,
  };
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

    // Rate limit: 300ms between requests
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  const ok = results.filter(r => r.status === 'ok').length;
  const totalCost = results.filter(r => r.status === 'ok').reduce((s, r) => s + (r.totalRealCost || 0), 0);
  console.log(`[Reconciliation] Range complete: ${ok}/${results.length} days, $${totalCost.toFixed(4)} total`);
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

// Wipe bad reconciled costs (negative, absurdly large, etc.)
function cleanupBadReconciliation() {
  const d = db.getDb();
  const result = d.prepare(`
    UPDATE daily_token_stats SET reconciled_cost = NULL
    WHERE reconciled_cost IS NOT NULL AND (reconciled_cost <= 0 OR reconciled_cost > 500)
  `).run();
  if (result.changes > 0) {
    console.log(`[Reconciliation] Cleaned up ${result.changes} rows with bad reconciled_cost`);
  }
  return result.changes;
}

// Get reconciliation status
function getStatus() {
  if (!MGMT_KEY) {
    return { enabled: false, reason: 'OPENROUTER_MGMT_KEY not configured' };
  }

  const d = db.getDb();
  const reconciled = d.prepare(`
    SELECT COUNT(DISTINCT date) as days, SUM(reconciled_cost) as total_cost
    FROM daily_token_stats
    WHERE reconciled_cost IS NOT NULL AND reconciled_cost > 0
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

module.exports = {
  isEnabled,
  fetchActivity,
  reconcileDate,
  reconcileRange,
  reconcileRecent,
  getStatus,
  cleanupBadReconciliation,
};
