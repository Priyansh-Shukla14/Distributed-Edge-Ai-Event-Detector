// ───────────────────────────────────────────────────────────
//  MQTT Service — Subscribes to ESP32 acoustic events,
//  persists to Supabase, upserts node health.
//  Supabase Realtime handles live broadcast to the dashboard.
// ───────────────────────────────────────────────────────────

const mqtt = require('mqtt');
const supabase = require('../config/supabase');

// ── Backoff Config ───────────────────────────────────────
const MAX_RETRIES = 5;
const BACKOFF_CAP_MS = 30_000;
const BASE_DELAY_MS = 1_000;

let client = null;
let retryCount = 0;

// ── Valid values (must match 001_init.sql CHECK constraints) ──
const VALID_EVENT_TYPES = new Set([
  'glass_break',
  'explosion',
  'vehicle_crash',
  'abnormal_industrial',
  'background_noise',
]);

// ── Helpers ──────────────────────────────────────────────

/**
 * Returns an exponential backoff delay capped at BACKOFF_CAP_MS.
 *   delay = min(BASE * 2^attempt, CAP)
 */
function backoffDelay(attempt) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), BACKOFF_CAP_MS);
}

/**
 * Validates the required fields on an incoming ESP32 payload.
 * Returns { valid: true, reason?: string }.
 */
function validatePayload(data) {
  if (!data.node_id || typeof data.node_id !== 'string') {
    return { valid: false, reason: 'missing or invalid "node_id"' };
  }
  if (!data.event || typeof data.event !== 'string') {
    return { valid: false, reason: 'missing or invalid "event"' };
  }
  if (!VALID_EVENT_TYPES.has(data.event)) {
    return { valid: false, reason: `unknown event type "${data.event}"` };
  }
  if (data.confidence === undefined || typeof data.confidence !== 'number') {
    return { valid: false, reason: 'missing or non-numeric "confidence"' };
  }
  if (data.confidence < 0 || data.confidence > 1) {
    return { valid: false, reason: `confidence ${data.confidence} out of range [0, 1]` };
  }
  return { valid: true };
}

// ── Supabase Persistence ─────────────────────────────────

/**
 * Inserts a validated event into the `events` table.
 * Supabase Realtime will automatically broadcast this row
 * to any frontend channel subscribers — no manual push needed.
 */
async function insertEvent(data) {
  const record = {
    node_id: data.node_id,
    event_type: data.event,
    confidence: data.confidence,
    device_timestamp: data.timestamp || null,
    route_path: data.route_path || null,
  };

  const { error } = await supabase.from('events').insert(record);

  if (error) {
    console.error(`[MQTT → Supabase] ✖  Event insert failed: ${error.message}`);
  } else {
    console.log(
      `[MQTT → Supabase] ✔  Event stored: ${record.event_type} ` +
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
        node_id: nodeId,
        status: 'online',
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'node_id' }
    );

  if (error) {
    console.error(`[MQTT → Supabase] ✖  Node status upsert failed: ${error.message}`);
  } else {
    console.log(`[MQTT → Supabase] ✔  Node "${nodeId}" status → online`);
  }
}

// ── MQTT Connection ──────────────────────────────────────

/**
 * Initialises the MQTT client, subscribes to the configured
 * topic, and wires up message / error / reconnect handlers.
 *
 * Call once from server.js during the boot sequence.
 */
function init() {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  const topic = process.env.MQTT_TOPIC;

  if (!brokerUrl || !topic) {
    console.error('[MQTT] ✖  Missing MQTT_BROKER_URL or MQTT_TOPIC in .env — skipping');
    return;
  }

  // Disable the mqtt.js built-in reconnect so we can manage
  // retries with our own exponential backoff logic.
  client = mqtt.connect(brokerUrl, {
    reconnectPeriod: 0,
  });

  // ── Connected ────────────────────────────────────────
  client.on('connect', () => {
    retryCount = 0; // reset on successful connection
    console.log(`[MQTT] ✔  Connected to broker: ${brokerUrl}`);

    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] ✖  Subscribe failed for "${topic}": ${err.message}`);
      } else {
        console.log(`[MQTT] ✔  Subscribed to topic: ${topic}`);
      }
    });
  });

  // ── Incoming Message ─────────────────────────────────
  client.on('message', async (receivedTopic, payload) => {
    // 1. Parse JSON
    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch (err) {
      console.error('[MQTT] ✖  Non-JSON payload — discarding:', err.message);
      return;
    }

    console.log(`[MQTT] ← Message on "${receivedTopic}":`, JSON.stringify(data));

    // 2. Validate required fields
    const { valid, reason } = validatePayload(data);
    if (!valid) {
      console.warn(`[MQTT] ⚠  Payload rejected — ${reason}`);
      return;
    }

    // 3. Persist event + upsert node status (in parallel)
    try {
      await Promise.all([
        insertEvent(data),
        upsertNodeStatus(data.node_id),
      ]);
    } catch (err) {
      console.error('[MQTT] ✖  Supabase write error:', err.message);
    }
  });

  // ── Error ────────────────────────────────────────────
  client.on('error', (err) => {
    console.error('[MQTT] ✖  Client error:', err.message);
    // Do NOT crash — reconnect logic below handles recovery
  });

  // ── Connection Lost ──────────────────────────────────
  client.on('close', () => {
    if (retryCount >= MAX_RETRIES) {
      console.error(
        `[MQTT] ✖  Exhausted ${MAX_RETRIES} reconnect attempts — giving up. ` +
        'Restart the server or check broker availability.'
      );
      return;
    }

    const delay = backoffDelay(retryCount);
    retryCount++;
    console.warn(
      `[MQTT] ↻  Disconnected — retry ${retryCount}/${MAX_RETRIES} in ${delay}ms`
    );

    setTimeout(() => {
      client.reconnect();
    }, delay);
  });

  // ── Offline ──────────────────────────────────────────
  client.on('offline', () => {
    console.warn('[MQTT] ⚠  Client went offline');
  });
}

module.exports = { init };
