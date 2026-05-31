// ───────────────────────────────────────────────────────────
//  Node Health Service — Pre-populates known nodes on boot
//  and periodically marks stale nodes as "offline".
// ───────────────────────────────────────────────────────────

const supabase = require('../config/supabase');

// ── Config ───────────────────────────────────────────────
const HEALTH_CHECK_INTERVAL_MS = 30_000;   // every 30 seconds
const OFFLINE_THRESHOLD_MS     = 60_000;   // 60 seconds since last_seen

// Known node IDs to pre-populate
const KNOWN_NODES = [
  { node_id: 'node_1', status: 'offline', location_label: 'Sensor Node 1' },
  { node_id: 'node_2', status: 'offline', location_label: 'Sensor Node 2' },
];

let healthInterval = null;

// ── Pre-populate known nodes ─────────────────────────────

/**
 * Inserts known nodes into `node_status` as "offline" if they
 * don't already exist.  Uses upsert with ignoreDuplicates so
 * existing rows (with a real status / last_seen) are untouched.
 */
async function seedNodes() {
  try {
    const { error } = await supabase
      .from('node_status')
      .upsert(KNOWN_NODES, { onConflict: 'node_id', ignoreDuplicates: true });

    if (error) {
      console.error('[NodeHealth] ✖  Seed failed:', error.message);
    } else {
      console.log('[NodeHealth] ✔  Known nodes seeded (node_1, node_2)');
    }
  } catch (err) {
    console.error('[NodeHealth] ✖  Seed error:', err.message);
  }
}

// ── Periodic health check ────────────────────────────────

/**
 * Marks any node whose `last_seen` is older than
 * OFFLINE_THRESHOLD_MS ago as "offline".
 * Skips nodes already marked offline to avoid redundant writes.
 */
async function checkNodeHealth() {
  try {
    const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS).toISOString();

    const { data, error } = await supabase
      .from('node_status')
      .update({ status: 'offline', updated_at: new Date().toISOString() })
      .lt('last_seen', cutoff)
      .neq('status', 'offline')
      .select('node_id');

    if (error) {
      console.error('[NodeHealth] ✖  Health check failed:', error.message);
    } else if (data && data.length > 0) {
      const ids = data.map(n => n.node_id).join(', ');
      console.log(`[NodeHealth] ↻  Marked offline: ${ids}`);
    }
    // If no rows updated → all nodes are either online or already offline. Silent.
  } catch (err) {
    console.error('[NodeHealth] ✖  Health check error:', err.message);
  }
}

// ── Public API ───────────────────────────────────────────

/**
 * Called once from server.js during boot.
 * 1. Seeds known nodes.
 * 2. Runs an immediate health check.
 * 3. Starts a 30-second recurring interval.
 */
async function init() {
  await seedNodes();
  await checkNodeHealth(); // immediate first pass

  healthInterval = setInterval(checkNodeHealth, HEALTH_CHECK_INTERVAL_MS);
  console.log(`[NodeHealth] ✔  Health monitor started (every ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}

module.exports = { init };
