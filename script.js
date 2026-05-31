// ───────────────────────────────────────────────────────────
//  script.js — Shared page logic + Supabase Realtime
//  for the Edge-AI Acoustic Event Detection dashboard
// ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════
//  CONFIG — loaded from config.js (gitignored)
//  Copy config.example.js → config.js and fill in your values.
// ═══════════════════════════════════════════════════════════
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
const API_BASE_URL = CONFIG.API_BASE_URL;

// ═══════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Returns an emoji icon for the given event type.
 */
function getEventIcon(type) {
  const icons = {
    glass_break:         '🪟',
    explosion:           '💥',
    vehicle_crash:       '🚗',
    abnormal_industrial: '⚙️',
    background_noise:    '🔇',
  };
  return icons[type] || '❓';
}

/**
 * Returns a human-friendly label for the event type.
 */
function getEventLabel(type) {
  const labels = {
    glass_break:         'Glass Break',
    explosion:           'Explosion',
    vehicle_crash:       'Vehicle Crash',
    abnormal_industrial: 'Abnormal Industrial',
    background_noise:    'Background Noise',
  };
  return labels[type] || type;
}

/**
 * Returns a CSS class name for the node status.
 * Maps to .status-indicator.online / .offline / .warning in style.css
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
  if (conf >= 0.8) return 'conf-high';
  if (conf >= 0.5) return 'conf-mid';
  return 'conf-low';
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
 *   e.g. "Active 5s ago", "Last seen 3 mins ago", "Never connected"
 */
function formatLastSeen(ts, status) {
  if (!ts) return 'Never connected';

  const diffMs = Date.now() - new Date(ts).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 0)   return 'Just now';
  if (diffSec < 60)  return status === 'online' ? `Active ${diffSec}s ago` : `Last seen ${diffSec}s ago`;
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return `Last seen ${mins} min${mins > 1 ? 's' : ''} ago`;
  }
  const hours = Math.floor(diffSec / 3600);
  return `Last seen ${hours} hr${hours > 1 ? 's' : ''} ago`;
}

/**
 * Returns a human-readable status label.
 */
function getStatusLabel(status) {
  if (status === 'online')  return '● Online';
  if (status === 'warning') return '● Unstable';
  return '● Disconnected';
}

/**
 * Builds a table <tr> HTML string for a single event row.
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
  const rowClass = isNew ? 'new-row' : '';

  return `<tr class="${rowClass}" data-event-id="${event.id}">
    <td class="event-icon">${icon}</td>
    <td class="event-type-label">${label}</td>
    <td>${event.node_id || '—'}</td>
    <td class="${confClass}">${confPercent}%</td>
    <td class="route-path">${routePath}</td>
    <td>${time}</td>
    <td><span class="resolved-badge ${resolvedClass}">${resolvedText}</span></td>
  </tr>`;
}

/**
 * Renders a node card HTML string from a node_status row.
 * Uses three clear states: Online / Disconnected / Unstable.
 */
function renderNodeCard(node) {
  const statusClass = getStatusClass(node.status);
  const statusColor = getStatusColor(node.status);
  const statusLabel = getStatusLabel(node.status);
  const lastSeenText = formatLastSeen(node.last_seen, node.status);
  const battery = node.battery_level !== null && node.battery_level !== undefined
    ? `${node.battery_level}%`
    : '—';
  const location = node.location_label || '—';

  return `<div class="glass-card node-card" id="node-card-${node.node_id}" data-node-id="${node.node_id}" data-node-status="${node.status}">
    <div class="node-header">
      <h3>${node.node_id}</h3>
      <div class="status-indicator ${statusClass}"></div>
    </div>
    <div class="node-stats">
      <p>Status: <span style="color:${statusColor}; text-shadow: 0 0 5px ${statusColor};">${statusLabel}</span></p>
      <p class="node-subtitle">${lastSeenText}</p>
      <p>Battery: <span style="color: var(--neon-blue);">${battery}</span></p>
      <p>Location: <span style="color: var(--text-muted);">${location}</span></p>
    </div>
    <div class="waveform-mini"></div>
  </div>`;
}

/**
 * Renders a placeholder node card for when the API fails.
 */
function renderOfflineNodeCard(nodeId) {
  return renderNodeCard({
    node_id: nodeId,
    status: 'offline',
    last_seen: null,
    battery_level: null,
    location_label: 'Could not reach server',
  });
}


// ═══════════════════════════════════════════════════════════
//  ALERT SOUND  (Web Audio API — no external file needed)
// ═══════════════════════════════════════════════════════════

let audioCtx = null;

/**
 * Plays a short rising-tone alert for high-confidence events.
 */
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
  } catch (e) {
    // Audio playback can fail silently (e.g. autoplay restrictions)
  }
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

  // ── Initialize Mini Waveforms ────────────────
  function initWaveforms() {
    const waveforms = document.querySelectorAll('.waveform-mini');
    waveforms.forEach(container => {
      if (container.children.length > 0) return; // already initialized
      for (let i = 0; i < 7; i++) {
        const bar = document.createElement('div');
        bar.className = 'wave-bar';
        bar.style.animationDuration = (0.6 + Math.random() * 0.6) + 's';
        bar.style.animationDelay = (i * 0.1) + 's';
        container.appendChild(bar);
      }
    });
  }
  initWaveforms();


  // ═══════════════════════════════════════════════
  //  MONITORING PAGE — Supabase Realtime + REST
  //  Only runs if we're on monitoring.html
  // ═══════════════════════════════════════════════

  const eventsTbody = document.getElementById('events-tbody');
  if (!eventsTbody) return; // Not on monitoring page — stop here

  const eventsEmptyState = document.getElementById('events-empty-state');
  const nodesGrid = document.getElementById('nodes-grid');
  const realtimeStatusEl = document.getElementById('realtime-status');
  const realtimeLabel = document.getElementById('realtime-label');
  const syncCounterEl = document.getElementById('sync-counter');

  // Stat counters
  let totalEventCount = 0;
  let highConfAlertCount = 0;

  function updateStatEl(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }


  // ── Sync Counter ─────────────────────────────
  let lastSyncTime = null;
  let syncTimerId = null;

  /**
   * Resets the sync counter to "0s ago" — called whenever
   * any Realtime event arrives.
   */
  function resetSyncCounter() {
    lastSyncTime = Date.now();
  }

  /**
   * Updates the sync counter display every second.
   */
  function tickSyncCounter() {
    if (!syncCounterEl) return;
    if (!lastSyncTime) {
      syncCounterEl.textContent = 'Last sync: —';
      syncCounterEl.className = 'sync-counter';
      return;
    }

    const elapsed = Math.floor((Date.now() - lastSyncTime) / 1000);

    if (elapsed > 60) {
      syncCounterEl.textContent = `✕ Dashboard disconnected`;
      syncCounterEl.className = 'sync-counter sync-error';
    } else if (elapsed > 30) {
      syncCounterEl.textContent = `⚠ Connection slow (${elapsed}s)`;
      syncCounterEl.className = 'sync-counter sync-warn';
    } else {
      syncCounterEl.textContent = `Last sync: ${elapsed}s ago`;
      syncCounterEl.className = 'sync-counter';
    }
  }

  // Start the 1-second ticker
  syncTimerId = setInterval(tickSyncCounter, 1000);


  // ── 1. Initialise Supabase Client ───────────
  const { createClient } = supabase; // from the CDN global
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


  // ── 2. Fetch Initial Data ───────────────────

  /**
   * Loads recent events from the REST API and populates the table.
   */
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

      // Count high-confidence alerts
      highConfAlertCount = events.filter(
        e => e.confidence > 0.8 && e.event_type !== 'background_noise'
      ).length;

      updateStatEl('stat-total-events', totalEventCount);
      updateStatEl('stat-alerts', highConfAlertCount);
    } catch (err) {
      console.error('[Dashboard] Failed to load events:', err.message);
    }
  }

  /**
   * Loads node statuses from the REST API and renders cards.
   * On failure, shows fallback "Disconnected" cards instead of
   * a raw error message.
   */
  async function loadInitialNodes() {
    try {
      const resp = await fetch(`${API_BASE_URL}/nodes`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const nodes = json.nodes || [];

      if (nodes.length === 0) {
        // No nodes in DB yet — show known fallbacks
        nodesGrid.innerHTML = [
          renderOfflineNodeCard('node_1'),
          renderOfflineNodeCard('node_2'),
        ].join('');
        initWaveforms();
        updateStatEl('stat-active-nodes', 0);
        return;
      }

      nodesGrid.innerHTML = nodes.map(renderNodeCard).join('');
      initWaveforms(); // init waveform bars on newly created cards

      const activeCount = nodes.filter(n => n.status === 'online').length;
      updateStatEl('stat-active-nodes', activeCount);
    } catch (err) {
      console.error('[Dashboard] Failed to load nodes:', err.message);
      // Show fallback cards instead of a raw error
      nodesGrid.innerHTML = [
        renderOfflineNodeCard('node_1'),
        renderOfflineNodeCard('node_2'),
      ].join('');
      initWaveforms();
      updateStatEl('stat-active-nodes', 0);
    }
  }

  /**
   * Loads the 24h event count from the stats endpoint.
   */
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


  // ── 3. Handle New Realtime Event (INSERT) ────

  function handleNewEvent(payload) {
    const event = payload.new;
    if (!event) return;

    console.log('[Realtime] New event:', event);

    // Reset sync counter
    resetSyncCounter();

    // Hide empty state
    if (eventsEmptyState) eventsEmptyState.style.display = 'none';

    // Prepend row to table
    eventsTbody.insertAdjacentHTML('afterbegin', formatEventRow(event, true));

    // Increment counters
    totalEventCount++;
    updateStatEl('stat-total-events', totalEventCount);

    // Alert logic: high confidence + not background noise
    if (event.confidence > 0.8 && event.event_type !== 'background_noise') {
      highConfAlertCount++;
      updateStatEl('stat-alerts', highConfAlertCount);
      playAlertSound();
    }

    // Flash the relevant node card
    flashNodeCard(event.node_id, event.confidence > 0.8 && event.event_type !== 'background_noise');

    // Cap table at 100 rows to avoid DOM bloat
    const rows = eventsTbody.querySelectorAll('tr');
    if (rows.length > 100) {
      rows[rows.length - 1].remove();
    }
  }


  // ── 4. Handle Node Status Update ─────────────

  function handleNodeStatusUpdate(payload) {
    const node = payload.new;
    if (!node) return;

    console.log('[Realtime] Node status update:', node);

    // Reset sync counter
    resetSyncCounter();

    const existingCard = document.getElementById(`node-card-${node.node_id}`);

    if (existingCard) {
      // Detect if status actually changed for the pulse animation
      const oldStatus = existingCard.getAttribute('data-node-status');
      const statusChanged = oldStatus !== node.status;

      // Replace the card content in-place
      const temp = document.createElement('div');
      temp.innerHTML = renderNodeCard(node);
      const newCard = temp.firstElementChild;

      existingCard.replaceWith(newCard);
      initWaveforms();

      // Add pulse animation if status changed
      if (statusChanged) {
        newCard.classList.add('status-pulse');
        setTimeout(() => newCard.classList.remove('status-pulse'), 900);
      }
    } else {
      // New node — append card
      nodesGrid.insertAdjacentHTML('beforeend', renderNodeCard(node));
      initWaveforms();
    }

    // Recount active nodes
    const allCards = nodesGrid.querySelectorAll('.node-card');
    let activeCount = 0;
    allCards.forEach(card => {
      if (card.getAttribute('data-node-status') === 'online') activeCount++;
    });
    updateStatEl('stat-active-nodes', activeCount);
  }


  // ── 5. Flash Node Card ───────────────────────

  function flashNodeCard(nodeId, isAlert) {
    const card = document.getElementById(`node-card-${nodeId}`);
    if (!card) return;

    const flashClass = isAlert ? 'flash-alert' : 'flash-event';
    card.classList.remove('flash-alert', 'flash-event');
    // Force reflow so re-adding the class restarts the animation
    void card.offsetWidth;
    card.classList.add(flashClass);

    setTimeout(() => card.classList.remove(flashClass), 900);
  }


  // ── 6. Supabase Realtime Subscriptions ───────

  function setRealtimeStatus(connected) {
    if (!realtimeStatusEl) return;
    if (connected) {
      realtimeStatusEl.classList.remove('disconnected');
      realtimeStatusEl.classList.add('connected');
      if (realtimeLabel) realtimeLabel.textContent = 'Realtime Connected';
    } else {
      realtimeStatusEl.classList.remove('connected');
      realtimeStatusEl.classList.add('disconnected');
      if (realtimeLabel) realtimeLabel.textContent = 'Disconnected';
    }
  }

  // Subscribe to events INSERT
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

  // Subscribe to node_status UPDATE + INSERT
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


  // ── 7. Boot ──────────────────────────────────

  loadInitialEvents();
  loadInitialNodes();
  loadStats();
});
