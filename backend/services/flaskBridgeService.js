// ───────────────────────────────────────────────────────────
//  Flask Bridge Service — Connects to the Flask-SocketIO
//  inference server and forwards detection events to Supabase.
//
//  The Flask server runs the ML pipeline (YAMNet + TFLite) and
//  emits "detection_event" for every inference result.  This
//  service listens for those events and conditionally persists
//  them based on the confidence gate (stored = true/false).
// ───────────────────────────────────────────────────────────

const { io } = require('socket.io-client');
const supabase = require('../config/supabase');

let socket = null;

// ── Supabase Persistence ─────────────────────────────────

/**
 * Inserts a high-confidence detection into the `events` table.
 * Supabase Realtime broadcasts the new row to dashboard clients.
 */
async function insertEvent(payload) {
  const record = {
    node_id:          payload.node_id,
    event_type:       payload.event_type,
    confidence:       payload.confidence,
    device_timestamp: payload.device_timestamp || null,
    route_path:       payload.route_path || null,
  };

  const { error } = await supabase.from('events').insert(record);

  if (error) {
    console.error(`[Flask → Supabase] ✖  Event insert failed: ${error.message}`);
  } else {
    console.log(
      `[Flask → Supabase] ✔  Event stored: ${record.event_type} ` +
      `from ${record.node_id} (confidence ${record.confidence})`
    );
  }
}

/**
 * Upserts the sending node's row in `node_status` so the
 * dashboard always has the latest heartbeat.
 */
async function upsertNodeStatus(nodeId) {
  const { error } = await supabase
    .from('node_status')
    .upsert(
      {
        node_id:    nodeId,
        status:     'online',
        last_seen:  new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'node_id' }
    );

  if (error) {
    console.error(`[Flask → Supabase] ✖  Node status upsert failed: ${error.message}`);
  } else {
    console.log(`[Flask → Supabase] ✔  Node "${nodeId}" status → online`);
  }
}

// ── Socket.IO Connection ─────────────────────────────────

/**
 * Initialises the socket.io-client connection to the Flask
 * inference server and wires up event handlers.
 *
 * Call once from server.js during the boot sequence.
 */
function init() {
  const flaskUrl = process.env.FLASK_SERVER_URL;

  if (!flaskUrl) {
    console.error('[Flask Bridge] ✖  Missing FLASK_SERVER_URL in .env — skipping');
    return;
  }

  socket = io(flaskUrl, {
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    2000,
    reconnectionDelayMax: 10000,
    transports:           ['websocket'],
  });

  // ── Connected ────────────────────────────────────────
  socket.on('connect', () => {
    console.log(`[Flask Bridge] ✔  Connected to Flask server: ${flaskUrl}`);
  });

  // ── Detection Event ─────────────────────────────────
  socket.on('detection_event', async (payload) => {
    const {
      node_id,
      event_type,
      confidence,
      alert_priority,
      stored,
    } = payload;

    if (stored) {
      // High-confidence, non-background → persist to Supabase
      console.log(
        `[STORED]    ${node_id} → ${event_type.padEnd(16)} ` +
        `(${confidence.toFixed(2)}) [${(alert_priority || 'none').toUpperCase()}]`
      );

      try {
        await Promise.all([
          insertEvent(payload),
          upsertNodeStatus(node_id),
        ]);
      } catch (err) {
        console.error('[Flask Bridge] ✖  Supabase write error:', err.message);
      }
    } else {
      // Low confidence or background → live feed only
      console.log(
        `[LIVE-ONLY] ${node_id} → ${event_type.padEnd(16)} ` +
        `(${confidence.toFixed(2)})`
      );
    }
  });

  // ── Error ────────────────────────────────────────────
  socket.on('connect_error', (err) => {
    console.error(`[Flask Bridge] ✖  Connection error: ${err.message}`);
  });

  // ── Disconnected ─────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.warn(`[Flask Bridge] ↻  Disconnected — ${reason}`);
  });

  // ── Reconnected ──────────────────────────────────────
  socket.on('reconnect', (attempt) => {
    console.log(`[Flask Bridge] ✔  Reconnected after ${attempt} attempt(s)`);
  });
}

module.exports = { init };
