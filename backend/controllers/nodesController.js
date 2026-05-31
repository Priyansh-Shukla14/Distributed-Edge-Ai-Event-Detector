// ───────────────────────────────────────────────────────────
//  Nodes Controller — node_status table operations
// ───────────────────────────────────────────────────────────

const supabase = require('../config/supabase');

/**
 * GET /api/nodes
 * Returns all rows from node_status, most recently seen first.
 */
async function getNodes(req, res) {
  try {
    const { data, error } = await supabase
      .from('node_status')
      .select('*')
      .order('last_seen', { ascending: false });

    if (error) {
      console.error('[Nodes] ✖  getNodes:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ count: data.length, nodes: data });
  } catch (err) {
    console.error('[Nodes] ✖  getNodes unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { getNodes };
