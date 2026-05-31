// ───────────────────────────────────────────────────────────
//  simulateNodes.js — MQTT publisher simulating two ESP32
//  edge nodes for local testing without physical hardware.
//
//  Usage:  node scripts/simulateNodes.js
// ───────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL;
const TOPIC = process.env.MQTT_TOPIC;

if (!BROKER_URL || !TOPIC) {
  console.error('✖  Missing MQTT_BROKER_URL or MQTT_TOPIC in backend/.env');
  process.exit(1);
}

// ── Config ───────────────────────────────────────────────

const NODE_IDS = ['node_1', 'node_2'];

// Weighted event distribution (must sum to 1.0)
const EVENT_WEIGHTS = [
  { type: 'background_noise',    weight: 0.50 },
  { type: 'glass_break',         weight: 0.20 },
  { type: 'vehicle_crash',       weight: 0.15 },
  { type: 'abnormal_industrial', weight: 0.10 },
  { type: 'explosion',           weight: 0.05 },
];

// Simulated Dijkstra routing paths per node
const ROUTE_PATHS = {
  node_1: [
    ['node_1', 'gateway'],
    ['node_1', 'relay_a', 'gateway'],
    ['node_1', 'relay_b', 'relay_a', 'gateway'],
  ],
  node_2: [
    ['node_2', 'gateway'],
    ['node_2', 'relay_a', 'gateway'],
    ['node_2', 'relay_c', 'gateway'],
  ],
};

const MIN_INTERVAL_MS = 3000;
const MAX_INTERVAL_MS = 8000;

// ── Helpers ──────────────────────────────────────────────

/**
 * Picks a random element from an array.
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns a random float between min and max (inclusive), rounded to 2 decimals.
 */
function randFloat(min, max) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

/**
 * Returns a random integer between min and max (inclusive).
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Selects an event type using weighted random distribution.
 */
function weightedEventType() {
  const r = Math.random();
  let cumulative = 0;
  for (const entry of EVENT_WEIGHTS) {
    cumulative += entry.weight;
    if (r <= cumulative) return entry.type;
  }
  return EVENT_WEIGHTS[0].type; // fallback
}

/**
 * Returns the current local time as HH:MM:SS.
 */
function currentTimestamp() {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
}

// ── Event Generator ──────────────────────────────────────

function generateEvent() {
  const nodeId = pick(NODE_IDS);
  const eventType = weightedEventType();

  // Background noise gets lower confidence
  const confidence = eventType === 'background_noise'
    ? randFloat(0.30, 0.60)
    : randFloat(0.65, 0.99);

  const routePath = pick(ROUTE_PATHS[nodeId]);

  return {
    node_id: nodeId,
    event: eventType,
    confidence,
    timestamp: currentTimestamp(),
    route_path: routePath,
  };
}

// ── MQTT Connection & Publish Loop ───────────────────────

const client = mqtt.connect(BROKER_URL);

let eventCount = 0;

client.on('connect', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   ESP32 Node Simulator — MQTT Publisher          ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Broker : ${BROKER_URL}`);
  console.log(`  Topic  : ${TOPIC}`);
  console.log(`  Nodes  : ${NODE_IDS.join(', ')}`);
  console.log(`  Rate   : 1 event every ${MIN_INTERVAL_MS / 1000}–${MAX_INTERVAL_MS / 1000}s`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('─'.repeat(54));
  console.log('');

  scheduleNext();
});

function scheduleNext() {
  const delay = randInt(MIN_INTERVAL_MS, MAX_INTERVAL_MS);

  setTimeout(() => {
    const event = generateEvent();
    const payload = JSON.stringify(event);

    client.publish(TOPIC, payload, { qos: 1 }, (err) => {
      eventCount++;

      if (err) {
        console.error(`  ✖ #${eventCount} Publish failed:`, err.message);
      } else {
        const icon = {
          glass_break: '🪟', explosion: '💥', vehicle_crash: '🚗',
          abnormal_industrial: '⚙️', background_noise: '🔇',
        }[event.event] || '❓';

        const confColor = event.confidence >= 0.8 ? '\x1b[32m' : '\x1b[33m';
        const reset = '\x1b[0m';

        console.log(
          `  ${icon}  #${String(eventCount).padStart(4)} │ ` +
          `${event.node_id.padEnd(7)} │ ` +
          `${event.event.padEnd(21)} │ ` +
          `${confColor}${(event.confidence * 100).toFixed(0)}%${reset} │ ` +
          `${event.route_path.join(' → ')} │ ` +
          `${event.timestamp}`
        );
      }

      scheduleNext();
    });
  }, delay);
}

client.on('error', (err) => {
  console.error('✖  MQTT error:', err.message);
});

client.on('close', () => {
  console.log('\n⚠  Disconnected from broker.');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\n  ✔ Simulation stopped. ${eventCount} events published.\n`);
  client.end();
  process.exit(0);
});
