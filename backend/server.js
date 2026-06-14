// ───────────────────────────────────────────────────────────
//  Edge-AI Acoustic Event Detection — Backend Entry Point
// ───────────────────────────────────────────────────────────

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const supabase = require('./config/supabase');
const mqttService = require('./services/mqttService');
const flaskBridgeService = require('./services/flaskBridgeService');
const nodeHealthService = require('./services/nodeHealthService');
const eventsRouter = require('./routes/events');
const nodesRouter = require('./routes/nodes');
const statsRouter = require('./routes/stats');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Static frontend ───────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── Routes ───────────────────────────────────────────────
app.use('/api/events', eventsRouter);
app.use('/api/nodes', nodesRouter);
app.use('/api/stats', statsRouter);

// Health-check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Boot Sequence ────────────────────────────────────────
async function boot() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   Edge-AI Acoustic Event Detection — Backend     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Verify Supabase connectivity
  try {
    const { error: evErr } = await supabase.from('events').select('id').limit(1);
    const { error: nsErr } = await supabase.from('node_status').select('node_id').limit(1);

    if (evErr || nsErr) {
      console.warn(`[Supabase] ⚠  Connected but table query issue:`);
      if (evErr) console.warn(`             events      → ${evErr.message}`);
      if (nsErr) console.warn(`             node_status → ${nsErr.message}`);
      console.warn('[Supabase]    Run supabase/migrations/001_init.sql to create tables.');
    } else {
      console.log('[Supabase] ✔  Connected — events & node_status tables accessible');
    }
  } catch (err) {
    console.error('[Supabase] ✖  Connection failed:', err.message);
    console.error('[Supabase]    Server will continue — DB writes will fail until resolved.');
  }

  // 2. Seed known nodes + start health monitor
  await nodeHealthService.init();

  // 3. Start MQTT subscription
  mqttService.init();

  // 4. Connect to Flask inference server
  flaskBridgeService.init();

  // 5. Start Express
  app.listen(PORT, () => {
    console.log(`[Express] ✔  Server listening on http://localhost:${PORT}`);
    console.log('');
  });
}

boot();
