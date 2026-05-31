// ───────────────────────────────────────────────────────────
//  Events Controller — CRUD operations against Supabase
// ───────────────────────────────────────────────────────────

const supabase = require('../config/supabase');

/**
 * GET /api/events
 * Paginated, filterable list of acoustic events.
 *
 * Query params:
 *   limit      – rows per page  (default 50, max 200)
 *   page       – 1-based page   (default 1)
 *   node_id    – filter by node
 *   event_type – filter by type
 */
async function getEvents(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from('events')
      .select('*', { count: 'exact' })
      .order('received_at', { ascending: false })
      .range(from, to);

    // Optional filters
    if (req.query.node_id) {
      query = query.eq('node_id', req.query.node_id);
    }
    if (req.query.event_type) {
      query = query.eq('event_type', req.query.event_type);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('[Events] ✖  getEvents:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      page,
      limit,
      totalCount: count,
      totalPages: Math.ceil(count / limit),
      events: data,
    });
  } catch (err) {
    console.error('[Events] ✖  getEvents unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/events/:id
 * Single event by UUID.
 */
async function getEventById(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Event not found' });
      }
      console.error('[Events] ✖  getEventById:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data);
  } catch (err) {
    console.error('[Events] ✖  getEventById unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/events/:id/resolve
 * Marks an event as resolved.
 */
async function resolveEvent(req, res) {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('events')
      .update({ resolved: true })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Event not found' });
      }
      console.error('[Events] ✖  resolveEvent:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: 'Event resolved', event: data });
  } catch (err) {
    console.error('[Events] ✖  resolveEvent unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/nodes/:node_id/events
 * Last 20 events for a specific node.
 */
async function getEventsByNode(req, res) {
  try {
    const { node_id } = req.params;

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('node_id', node_id)
      .order('received_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[Events] ✖  getEventsByNode:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ node_id, count: data.length, events: data });
  } catch (err) {
    console.error('[Events] ✖  getEventsByNode unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/events
 * Purges events older than 7 days.
 * Protected by x-api-key header — checked in the route middleware.
 */
async function deleteOldEvents(req, res) {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('events')
      .delete()
      .lt('received_at', sevenDaysAgo)
      .select('id');

    if (error) {
      console.error('[Events] ✖  deleteOldEvents:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const deletedCount = data ? data.length : 0;
    console.log(`[Events] 🗑  Purged ${deletedCount} events older than 7 days`);

    return res.json({
      message: `Deleted ${deletedCount} events older than 7 days`,
      cutoff: sevenDaysAgo,
      deletedCount,
    });
  } catch (err) {
    console.error('[Events] ✖  deleteOldEvents unexpected:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handles an incoming acoustic event from MQTT (called by mqttService).
 * Not an HTTP handler — fire-and-forget from the MQTT message callback.
 */
async function handleIncomingEvent(data) {
  try {
    const record = {
      node_id: data.node_id || 'unknown',
      event_type: data.event_type || 'background_noise',
      confidence: data.confidence ?? 0,
      device_timestamp: data.timestamp || null,
      route_path: data.route_path || null,
    };

    const { error } = await supabase.from('events').insert(record);

    if (error) {
      console.error('[Events] ✖  Supabase insert failed:', error.message);
    } else {
      console.log(`[Events] ✔  Stored event: ${record.event_type} from ${record.node_id}`);
    }
  } catch (err) {
    console.error('[Events] ✖  Unexpected error:', err.message);
  }
}

module.exports = {
  getEvents,
  getEventById,
  resolveEvent,
  getEventsByNode,
  deleteOldEvents,
  handleIncomingEvent,
};
