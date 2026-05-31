// ───────────────────────────────────────────────────────────
//  Stats Controller — aggregated dashboard metrics
// ───────────────────────────────────────────────────────────

const supabase = require('../config/supabase');

const EVENT_TYPES = [
  'glass_break',
  'explosion',
  'vehicle_crash',
  'abnormal_industrial',
  'background_noise',
];

/**
 * GET /api/stats
 * Returns aggregated metrics for the dashboard overview.
 *
 * Response shape:
 * {
 *   totalEvents:   123,
 *   eventsByType:  { glass_break: 40, explosion: 12, ... },
 *   activeNodes:   2,
 *   last24hEvents: 17
 * }
 *
 * Supabase JS doesn't expose SQL GROUP BY directly, so we
 * run parallel count queries — one per event type — which is
 * still efficient because each hits the idx_events_node_id index.
 */
async function getStats(req, res) {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Run all queries in parallel for speed
    const [
      totalResult,
      last24hResult,
      activeNodesResult,
      ...typeResults
    ] = await Promise.all([
      // Total events (all time)
      supabase
        .from('events')
        .select('*', { count: 'exact', head: true }),

      // Events in the last 24 hours
      supabase
        .from('events')
        .select('*', { count: 'exact', head: true })
        .gte('received_at', twentyFourHoursAgo),

      // Active nodes (status = 'online')
      supabase
        .from('node_status')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'online'),

      // Per-type counts
      ...EVENT_TYPES.map((type) =>
        supabase
          .from('events')
          .select('*', { count: 'exact', head: true })
          .eq('event_type', type)
      ),
    ]);

    // Check for any Supabase errors
    const allResults = [totalResult, last24hResult, activeNodesResult, ...typeResults];
    const firstError = allResults.find((r) => r.error);
    if (firstError) {
      console.error('[Stats] ✖  Query failed:', firstError.error.message);
      return res.status(500).json({ error: firstError.error.message });
    }

    // Build eventsByType map
    const eventsByType = {};
    EVENT_TYPES.forEach((type, i) => {
      eventsByType[type] = typeResults[i].count ?? 0;
    });

    return res.json({
      totalEvents: totalResult.count ?? 0,
      eventsByType,
      activeNodes: activeNodesResult.count ?? 0,
      last24hEvents: last24hResult.count ?? 0,
    });
  } catch (err) {
    console.error('[Stats] ✖  getStats unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getStats };
