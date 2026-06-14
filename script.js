// ───────────────────────────────────────────────────────────
//  script.js — Shared page logic + Supabase Realtime
//  + Flask SocketIO integration for the Edge-AI dashboard
// ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════
//  CONFIG — loaded from config.js (gitignored)
//  Copy config.example.js → config.js and fill in your values.
// ═══════════════════════════════════════════════════════════
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
const API_BASE_URL = CONFIG.API_BASE_URL;

// Flask server URL for Socket.IO — defaults to same-origin port 5000
const FLASK_URL = CONFIG.FLASK_SERVER_URL || 'http://localhost:5000';


// ═══════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Returns an emoji icon for the given event type.
 */
function getEventIcon(type) {
  const icons = {
    glass_break:         '🪟',
    gunshots:            '💥',
    scream:              '😱',
    siren:               '🚨',
    dog:                 '🐕',
    background:          '🔇',
    // Legacy types (MQTT pipeline)
    explosion:           '💥',
    vehicle_crash:       '🚗',
    abnormal_industrial: '⚙️',
    background_noise:    '🔇',
  };
  return icons[type] || '❓';
}

/**
 * Returns a human-friendly label for the event type.
 * "background" is shown as "Ambient" in the UI.
 */
function getEventLabel(type) {
  const labels = {
    glass_break:         'Glass Break',
    gunshots:            'Gunshots',
    scream:              'Scream',
    siren:               'Siren',
    dog:                 'Dog',
    background:          'Ambient',
    // Legacy types
    explosion:           'Explosion',
    vehicle_crash:       'Vehicle Crash',
    abnormal_industrial: 'Abnormal Industrial',
    background_noise:    'Background Noise',
  };
  return labels[type] || type;
}

/**
 * Returns a CSS class name for the node status.
 */
function getStatusClass(status) {
  if (status === 'online')  return 'online';
  if (status === 'warning') return 'warning';
  return 'offline';
}

/**
 * Returns the neon CSS colour variable name for a node status.
 */
function getStatusColor(status) {
  if (status === 'online')  return 'var(--neon-green)';
  if (status === 'warning') return 'var(--neon-orange)';
  return 'var(--neon-red)';
}

/**
 * Returns the CSS class for confidence colouring.
 */
function getConfidenceClass(conf) {
  if (conf >= 0.85) return 'conf-high';
  if (conf >= 0.5)  return 'conf-mid';
  return 'conf-low';
}

/**
 * Returns the priority badge CSS class.
 */
function getPriorityClass(priority) {
  const map = {
    critical: 'priority-critical',
    high:     'priority-high',
    medium:   'priority-medium',
    low:      'priority-low',
    none:     'priority-none',
  };
  return map[priority] || 'priority-none';
}

/**
 * Formats a timestamptz string into a short local time.
 */
function formatTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return ts;
  }
}

/**
 * Returns a human-readable relative time string.
 */
function formatLastSeen(ts, status) {
  if (!ts) return 'Never connected';
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 0)    return 'Just now';
  if (diffSec < 60)   return status === 'online' ? `Active ${diffSec}s ago` : `Last seen ${diffSec}s ago`;
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `Last seen ${mins} min${mins > 1 ? 's' : ''} ago`;
  }
  const hours = Math.floor(diffSec / 3600);
  return `Last seen ${hours} hr${hours > 1 ? 's' : ''} ago`;
}

function getStatusLabel(status) {
  if (status === 'online')  return '● Online';
  if (status === 'warning') return '● Unstable';
  return '● Disconnected';
}


// ── Flask live-feed row builder ──────────────────────────

/**
 * Builds a table <tr> for a Flask detection_event payload.
 */
function formatFlaskEventRow(ev, isNew = false) {
  const icon  = getEventIcon(ev.event_type);
  const label = getEventLabel(ev.event_type);
  const confPercent = Math.round((ev.confidence || 0) * 100);
  const confClass   = getConfidenceClass(ev.confidence || 0);
  const priority    = ev.alert_priority || 'none';
  const prioClass   = getPriorityClass(priority);
  const time = formatTime(ev.device_timestamp || new Date().toISOString());
  const stored = ev.stored === true;
  const isBackground = ev.event_type === 'background';

  // Row class for stored/unstored/ambient styling
  let rowClass = isNew ? 'new-row ' : '';
  if (isBackground) {
    rowClass += 'row-ambient';
  } else if (stored) {
    rowClass += 'row-stored';
  } else {
    rowClass += 'row-unstored';
  }

  // Status column
  let statusHtml;
  if (isBackground) {
    statusHtml = '<span class="low-conf-badge">ambient</span>';
  } else if (stored) {
    statusHtml = `<span class="priority-badge ${prioClass}" style="font-size:0.6rem;">● Stored</span>`;
  } else {
    statusHtml = '<span class="low-conf-badge">low conf</span>';
  }

  return `<tr class="${rowClass}">
    <td class="event-icon">${icon}</td>
    <td class="event-type-label">${label}</td>
    <td>${ev.node_id || '—'}</td>
    <td class="${confClass}">${confPercent}%</td>
    <td><span class="priority-badge ${prioClass}">${priority}</span></td>
    <td>${time}</td>
    <td>${statusHtml}</td>
  </tr>`;
}

/**
 * Builds a table <tr> for a Supabase event (existing format).
 */
function formatEventRow(event, isNew = false) {
  const icon = getEventIcon(event.event_type);
  const label = getEventLabel(event.event_type);
  const confPercent = Math.round((event.confidence || 0) * 100);
  const confClass = getConfidenceClass(event.confidence || 0);
  const routePath = event.route_path
    ? event.route_path.join(' → ')
    : '—';
  const time = formatTime(event.received_at);
  const resolvedClass = event.resolved ? 'resolved-yes' : 'resolved-no';
  const resolvedText = event.resolved ? '✔ Resolved' : '● Active';
  const rowClass = isNew ? 'new-row row-stored' : 'row-stored';

  return `<tr class="${rowClass}" data-event-id="${event.id}">
    <td class="event-icon">${icon}</td>
    <td class="event-type-label">${label}</td>
    <td>${event.node_id || '—'}</td>
    <td class="${confClass}">${confPercent}%</td>
    <td>—</td>
    <td>${time}</td>
    <td><span class="priority-badge priority-none" style="font-size:0.6rem;">${resolvedText}</span></td>
  </tr>`;
}


// ═══════════════════════════════════════════════════════════
//  ALERT SOUND  (Web Audio API — no external file needed)
// ═══════════════════════════════════════════════════════════

let audioCtx = null;

function playAlertSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) { /* autoplay restrictions */ }
}


// ═══════════════════════════════════════════════════════════
//  DOM READY — shared page logic (all pages)
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // ── Logout Logic ─────────────────────────────
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      sessionStorage.removeItem('isAuthenticated');
      window.location.href = 'index.html';
    });
  }

  // ── Mobile Navbar Toggle ─────────────────────
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.querySelector('.nav-links');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      navLinks.classList.toggle('active');
      hamburger.classList.toggle('active');
    });
  }


  // ═══════════════════════════════════════════════
  //  MONITORING PAGE — Flask + Supabase Realtime
  //  Only runs if we're on monitoring.html
  // ═══════════════════════════════════════════════

  const eventsTbody = document.getElementById('events-tbody');
  if (!eventsTbody) return; // Not on monitoring page

  const eventsEmptyState    = document.getElementById('events-empty-state');
  const nodesGrid           = document.getElementById('nodes-grid');
  const flaskStatusEl       = document.getElementById('flask-status');
  const flaskLabel          = document.getElementById('flask-label');
  const realtimeStatusEl    = document.getElementById('realtime-status');
  const realtimeLabel       = document.getElementById('realtime-label');
  const syncCounterEl       = document.getElementById('sync-counter');
  const toggleLowConfBtn    = document.getElementById('toggle-low-conf');
  const eventsTableWrapper  = document.getElementById('events-table-wrapper');

  // Stat counters
  let totalEventCount = 0;
  let highConfAlertCount = 0;

  function updateStatEl(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }


  // ── Sync Counter ─────────────────────────────
  let lastSyncTime = null;

  function resetSyncCounter() {
    lastSyncTime = Date.now();
  }

  function tickSyncCounter() {
    if (!syncCounterEl) return;
    if (!lastSyncTime) {
      syncCounterEl.textContent = 'Last sync: —';
      syncCounterEl.className = 'sync-counter';
      return;
    }
    const elapsed = Math.floor((Date.now() - lastSyncTime) / 1000);
    if (elapsed > 60) {
      syncCounterEl.textContent = '✕ Dashboard disconnected';
      syncCounterEl.className = 'sync-counter sync-error';
    } else if (elapsed > 30) {
      syncCounterEl.textContent = `⚠ Connection slow (${elapsed}s)`;
      syncCounterEl.className = 'sync-counter sync-warn';
    } else {
      syncCounterEl.textContent = `Last sync: ${elapsed}s ago`;
      syncCounterEl.className = 'sync-counter';
    }
  }
  setInterval(tickSyncCounter, 1000);


  // ── Low-confidence toggle ────────────────────
  let showLowConf = true;

  if (toggleLowConfBtn) {
    toggleLowConfBtn.addEventListener('click', () => {
      showLowConf = !showLowConf;
      if (showLowConf) {
        toggleLowConfBtn.classList.remove('off');
        if (eventsTableWrapper) eventsTableWrapper.classList.remove('hide-low-conf');
      } else {
        toggleLowConfBtn.classList.add('off');
        if (eventsTableWrapper) eventsTableWrapper.classList.add('hide-low-conf');
      }
    });
  }


  // ═══════════════════════════════════════════════
  //  NODE CARD — live status management
  // ═══════════════════════════════════════════════

  // Track per-node idle timers (5s without audio → idle)
  const nodeIdleTimers = {};

  /**
   * Updates a node card with the latest detection event.
   */
  function updateNodeCard(ev) {
    const nid = ev.node_id;
    const dot      = document.getElementById(`dot-${nid}`);
    const badge    = document.getElementById(`badge-${nid}`);
    const evLabel  = document.getElementById(`event-label-${nid}`);
    const confEl   = document.getElementById(`conf-${nid}`);
    const waveform = document.getElementById(`waveform-${nid}`);

    if (!dot) return; // unknown node

    // ── Status dot → streaming
    dot.classList.remove('idle');
    dot.classList.add('streaming');

    // ── Waveform → active
    if (waveform) {
      waveform.classList.remove('idle');
      waveform.classList.add('active');
    }

    // ── Event label
    const label = getEventLabel(ev.event_type);
    if (evLabel) {
      evLabel.textContent = label;
      if (ev.stored) {
        evLabel.classList.remove('unstored');
        evLabel.classList.add('stored');
      } else {
        evLabel.classList.remove('stored');
        evLabel.classList.add('unstored');
      }
    }

    // ── Confidence
    if (confEl) {
      const pct = Math.round((ev.confidence || 0) * 100);
      const confClass = getConfidenceClass(ev.confidence || 0);
      confEl.innerHTML = `Confidence: <span class="${confClass}">${pct}%</span>`;
    }

    // ── Priority badge
    if (badge) {
      const priority = ev.alert_priority || 'none';
      badge.className = `priority-badge ${getPriorityClass(priority)}`;
      badge.textContent = priority;
    }

    // ── Flash card
    flashNodeCard(nid, ev.stored);

    // ── Reset idle timer (5s)
    if (nodeIdleTimers[nid]) clearTimeout(nodeIdleTimers[nid]);
    nodeIdleTimers[nid] = setTimeout(() => {
      // Mark node as idle
      dot.classList.remove('streaming');
      dot.classList.add('idle');
      if (waveform) {
        waveform.classList.remove('active');
        waveform.classList.add('idle');
      }
    }, 5000);
  }


  // ── Flash Node Card ───────────────────────────

  function flashNodeCard(nodeId, isAlert) {
    const card = document.getElementById(`node-card-${nodeId}`);
    if (!card) return;
    const flashClass = isAlert ? 'flash-alert' : 'flash-event';
    card.classList.remove('flash-alert', 'flash-event');
    void card.offsetWidth; // force reflow
    card.classList.add(flashClass);
    setTimeout(() => card.classList.remove(flashClass), 900);
  }


  // ═══════════════════════════════════════════════
  //  SENSOR TELEMETRY — earthquake / water / smoke
  // ═══════════════════════════════════════════════

  const alertBanner       = document.getElementById('sensor-alert-banner');
  const alertBannerIcon   = document.getElementById('alert-banner-icon');
  const alertBannerText   = document.getElementById('alert-banner-text');
  const alertBannerHideEl = document.getElementById('alert-banner-dismiss');
  let alertBannerTimer = null;

  if (alertBannerHideEl) {
    alertBannerHideEl.addEventListener('click', () => {
      if (alertBanner) alertBanner.classList.remove('active');
    });
  }

  /** Show the big banner. type: 'quake' | 'water' | 'smoke' */
  function showAlertBanner(type, nodeId) {
    if (!alertBanner) return;
    const cfg = {
      quake: { icon: '⚠️', text: `EARTHQUAKE DETECTED — ${nodeId}`, cls: '' },
      water: { icon: '💧', text: `WATER LEVEL CRITICAL — ${nodeId}`, cls: 'alert-water' },
      smoke: { icon: '🔥', text: `SMOKE DETECTED — ${nodeId}`, cls: 'alert-smoke' },
    }[type];
    if (!cfg) return;

    alertBanner.className = 'sensor-alert-banner active ' + cfg.cls;
    if (alertBannerIcon) alertBannerIcon.textContent = cfg.icon;
    if (alertBannerText) alertBannerText.textContent = cfg.text;

    // Auto-hide after 10s of no repeat
    if (alertBannerTimer) clearTimeout(alertBannerTimer);
    alertBannerTimer = setTimeout(() => alertBanner.classList.remove('active'), 10000);

    playAlertSound();
  }

  /** Update the per-node sensor tiles from a sensor_update payload. */
  function updateSensorTiles(s) {
    const nid = s.node_id;
    if (!nid) return;

    const set = (id, txt) => {
      const el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    const setAlert = (tileId, on, waterStyle) => {
      const tile = document.getElementById(tileId);
      if (!tile) return;
      tile.classList.remove('alert', 'alert-water');
      if (on) tile.classList.add(waterStyle ? 'alert-water' : 'alert');
    };

    // ── Audio peak ──
    if (s.audio_peak !== undefined) set(`audio-val-${nid}`, s.audio_peak);

    // ── Seismic (accelerometer) ──
    if (s.accel_g !== undefined) {
      const d = (s.accel_delta !== undefined) ? ` (Δ${Number(s.accel_delta).toFixed(2)})` : '';
      set(`quake-val-${nid}`, `${Number(s.accel_g).toFixed(2)}g${d}`);
    }
    setAlert(`sensor-quake-${nid}`, !!s.quake, false);
    if (s.quake) showAlertBanner('quake', nid);

    // ── Water level ──
    if (s.water_raw !== undefined) {
      set(`water-val-${nid}`, s.water_alert ? `${s.water_raw} ⚠` : s.water_raw);
    }
    setAlert(`sensor-water-${nid}`, !!s.water_alert, true);
    if (s.water_alert) showAlertBanner('water', nid);

    // ── Smoke ──
    if (s.smoke_raw !== undefined) {
      set(`smoke-val-${nid}`, s.smoke_alert ? `${s.smoke_raw} ⚠` : s.smoke_raw);
    }
    setAlert(`sensor-smoke-${nid}`, !!s.smoke_alert, false);
    if (s.smoke_alert) showAlertBanner('smoke', nid);
  }


  // ═══════════════════════════════════════════════
  //  FLASK SOCKET.IO — live detection events
  // ═══════════════════════════════════════════════

  function setFlaskStatus(connected) {
    if (!flaskStatusEl) return;
    if (connected) {
      flaskStatusEl.classList.remove('disconnected');
      flaskStatusEl.classList.add('connected');
      if (flaskLabel) flaskLabel.textContent = 'Flask: Connected';
    } else {
      flaskStatusEl.classList.remove('connected');
      flaskStatusEl.classList.add('disconnected');
      if (flaskLabel) flaskLabel.textContent = 'Flask: Disconnected';
    }
  }

  // Connect to Flask inference server
  if (typeof io !== 'undefined') {
    const flaskSocket = io(FLASK_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    flaskSocket.on('connect', () => {
      console.log('[Flask] ✔ Connected');
      setFlaskStatus(true);
      resetSyncCounter();
    });

    flaskSocket.on('disconnect', (reason) => {
      console.warn('[Flask] ↻ Disconnected:', reason);
      setFlaskStatus(false);
    });

    flaskSocket.on('connect_error', (err) => {
      console.error('[Flask] ✖ Connection error:', err.message);
      setFlaskStatus(false);
    });

    // ── Main event handler ──────────────────────
    flaskSocket.on('detection_event', (payload) => {
      console.log('[Flask] detection_event:', payload);
      resetSyncCounter();

      // Hide empty state
      if (eventsEmptyState) eventsEmptyState.style.display = 'none';

      // 1. Update the node card
      updateNodeCard(payload);

      // 2. Add row to live feed
      eventsTbody.insertAdjacentHTML('afterbegin', formatFlaskEventRow(payload, true));

      // 3. Update counters
      totalEventCount++;
      updateStatEl('stat-total-events', totalEventCount);

      if (payload.stored) {
        highConfAlertCount++;
        updateStatEl('stat-alerts', highConfAlertCount);

        // Play alert sound for critical/high priority stored events
        const p = payload.alert_priority;
        if (p === 'critical' || p === 'high') {
          playAlertSound();
        }
      }

      // 4. Count streaming nodes
      const streamingDots = document.querySelectorAll('.node-status-dot.streaming');
      updateStatEl('stat-active-nodes', streamingDots.length);

      // 5. Cap table at 150 rows
      const rows = eventsTbody.querySelectorAll('tr');
      while (rows.length > 150) {
        rows[rows.length - 1].remove();
      }
    });

    // ── Sensor telemetry (earthquake / water / smoke / audio) ──
    flaskSocket.on('sensor_update', (payload) => {
      console.log('[Flask] sensor_update:', payload);
      resetSyncCounter();
      updateSensorTiles(payload);
    });
  } else {
    console.warn('[Flask] socket.io client not loaded — Flask bridge disabled');
    setFlaskStatus(false);
  }


  // ═══════════════════════════════════════════════
  //  SUPABASE REALTIME — stored events from DB
  // ═══════════════════════════════════════════════

  const { createClient } = supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  function setRealtimeStatus(connected) {
    if (!realtimeStatusEl) return;
    if (connected) {
      realtimeStatusEl.classList.remove('disconnected');
      realtimeStatusEl.classList.add('connected');
      if (realtimeLabel) realtimeLabel.textContent = 'Supabase: Connected';
    } else {
      realtimeStatusEl.classList.remove('connected');
      realtimeStatusEl.classList.add('disconnected');
      if (realtimeLabel) realtimeLabel.textContent = 'Supabase: Disconnected';
    }
  }


  // ── Initial data load from REST API ──────────

  async function loadInitialEvents() {
    try {
      const resp = await fetch(`${API_BASE_URL}/events?limit=20`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const events = json.events || [];

      totalEventCount = json.totalCount || events.length;

      if (events.length > 0 && eventsEmptyState) {
        eventsEmptyState.style.display = 'none';
      }

      events.forEach(ev => {
        eventsTbody.insertAdjacentHTML('beforeend', formatEventRow(ev, false));
      });

      highConfAlertCount = events.filter(
        e => e.confidence > 0.85 && e.event_type !== 'background_noise' && e.event_type !== 'background'
      ).length;

      updateStatEl('stat-total-events', totalEventCount);
      updateStatEl('stat-alerts', highConfAlertCount);
    } catch (err) {
      console.error('[Dashboard] Failed to load events:', err.message);
    }
  }

  async function loadInitialNodes() {
    try {
      const resp = await fetch(`${API_BASE_URL}/nodes`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const nodes = json.nodes || [];

      const activeCount = nodes.filter(n => n.status === 'online').length;
      updateStatEl('stat-active-nodes', activeCount);
    } catch (err) {
      console.error('[Dashboard] Failed to load nodes:', err.message);
      updateStatEl('stat-active-nodes', 0);
    }
  }

  async function loadStats() {
    try {
      const resp = await fetch(`${API_BASE_URL}/stats`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const stats = await resp.json();
      updateStatEl('stat-24h-events', stats.last24hEvents || 0);
    } catch (err) {
      console.error('[Dashboard] Failed to load stats:', err.message);
    }
  }


  // ── Handle Supabase Realtime INSERT ──────────

  function handleNewEvent(payload) {
    const event = payload.new;
    if (!event) return;
    console.log('[Realtime] New event:', event);
    resetSyncCounter();
    if (eventsEmptyState) eventsEmptyState.style.display = 'none';
    eventsTbody.insertAdjacentHTML('afterbegin', formatEventRow(event, true));
    totalEventCount++;
    updateStatEl('stat-total-events', totalEventCount);

    if (event.confidence > 0.85 && event.event_type !== 'background_noise' && event.event_type !== 'background') {
      highConfAlertCount++;
      updateStatEl('stat-alerts', highConfAlertCount);
      playAlertSound();
    }

    flashNodeCard(event.node_id, event.confidence > 0.85);

    const rows = eventsTbody.querySelectorAll('tr');
    if (rows.length > 150) rows[rows.length - 1].remove();
  }

  function handleNodeStatusUpdate(payload) {
    const node = payload.new;
    if (!node) return;
    console.log('[Realtime] Node status update:', node);
    resetSyncCounter();

    // Update the streaming dot if the node status comes from Supabase
    const dot = document.getElementById(`dot-${node.node_id}`);
    if (dot && node.status === 'online') {
      dot.classList.remove('idle');
      dot.classList.add('streaming');
    }

    const allCards = nodesGrid.querySelectorAll('.node-card');
    let activeCount = 0;
    allCards.forEach(card => {
      const cardDot = card.querySelector('.node-status-dot');
      if (cardDot && cardDot.classList.contains('streaming')) activeCount++;
    });
    updateStatEl('stat-active-nodes', activeCount);
  }


  // ── Supabase Realtime subscriptions ──────────

  const eventsChannel = sb
    .channel('realtime-events')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'events' },
      handleNewEvent
    )
    .subscribe((status) => {
      console.log('[Realtime] Events channel:', status);
      setRealtimeStatus(status === 'SUBSCRIBED');
      if (status === 'SUBSCRIBED') resetSyncCounter();
    });

  const nodesChannel = sb
    .channel('realtime-nodes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'node_status' },
      handleNodeStatusUpdate
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'node_status' },
      handleNodeStatusUpdate
    )
    .subscribe((status) => {
      console.log('[Realtime] Nodes channel:', status);
    });


  // ── Boot ─────────────────────────────────────
  loadInitialEvents();
  loadInitialNodes();
  loadStats();
});
