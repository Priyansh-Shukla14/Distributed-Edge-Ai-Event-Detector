"""
app.py — Flask + SocketIO server for Edge-AI acoustic event detection.

Accepts base64-encoded 16-bit mono PCM audio from ESP32 nodes via
a WebSocket event ("audio_stream"), stores it in per-node circular
buffers, and runs two-stage ML inference (YAMNet → TFLite classifier)
on a rolling 3-second window once the buffer is full.

After inference, every detection is:
  1. Broadcast to all dashboard clients via "detection_event" WebSocket
  2. Stored in an in-memory deque (last 50 detections)
  3. Conditionally inserted into Supabase (confidence ≥ 0.85, non-background)

Run:
    python app.py
"""

import base64
import logging
from collections import deque
from datetime import datetime, timezone

import numpy as np
from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit

from audio_buffer import AudioBuffer, BUFFER_SIZE, SAMPLE_RATE
from model_inference import load_models, predict
from supabase_client import insert_event, upsert_node_status

# ── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("edge-ai")

# ── Flask + SocketIO ──────────────────────────────────────────
app = Flask(__name__)
app.config["SECRET_KEY"] = "edge-ai-dev-secret"

socketio = SocketIO(
    app,
    async_mode="eventlet",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)

# ── Per-node audio buffers ────────────────────────────────────
KNOWN_NODES = ("node_1", "node_2")

buffers: dict[str, AudioBuffer] = {
    nid: AudioBuffer(nid) for nid in KNOWN_NODES
}

# Slide forward by 1 second after each inference so inference
# runs on a rolling 3-second window every ~1 second of new audio.
SLIDE_SAMPLES = SAMPLE_RATE  # 16 000 samples = 1 second

# ── Alert priority mapping ────────────────────────────────────
ALERT_PRIORITY = {
    "gunshots":    "critical",
    "scream":      "high",
    "glass_break": "medium",
    "siren":       "medium",
    "dog":         "low",
    "background":  "none",
}

# ── Confidence gate for Supabase persistence ──────────────────
STORE_CONFIDENCE_THRESHOLD = 0.85

# ── In-memory ring of recent detections (all, regardless of
#    confidence) so the REST API can serve them instantly ───────
recent_detections: deque[dict] = deque(maxlen=50)

# ── Counters for throttled audio-reception logging ────────────
_audio_chunk_count: dict[str, int] = {nid: 0 for nid in KNOWN_NODES}

# ── Sensor alert thresholds ───────────────────────────────────
WATER_LEVEL_FLOOD_THRESHOLD = 1500     # water_raw >= 1500 → flood
EARTHQUAKE_ACCEL_THRESHOLD  = 1.3      # accel_g  >= 1.3  → earthquake

# ── Cooldown tracking for sensor alerts (prevent DB spam) ─────
#    key = (node_id, alert_type), value = last insert timestamp
import time
_sensor_alert_cooldowns: dict[tuple, float] = {}
SENSOR_ALERT_COOLDOWN_SEC = 30  # one insert per 30 seconds per alert type


def _sensor_alert_on_cooldown(node_id: str, alert_type: str) -> bool:
    """Return True if this (node, alert_type) was inserted recently."""
    key = (node_id, alert_type)
    last = _sensor_alert_cooldowns.get(key, 0)
    return (time.time() - last) < SENSOR_ALERT_COOLDOWN_SEC


def _mark_sensor_alert(node_id: str, alert_type: str):
    """Record that we just inserted a sensor alert."""
    _sensor_alert_cooldowns[(node_id, alert_type)] = time.time()


def _insert_sensor_alert(node_id: str, event_type: str, confidence: float):
    """
    Build and persist a sensor-triggered event (flood / earthquake)
    to Supabase + broadcast to dashboards via detection_event.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "node_id":          node_id,
        "event_type":       event_type,
        "confidence":       confidence,
        "alert_priority":   "critical",
        "device_timestamp": now_iso,
        "route_path":       [node_id, "gateway"],
        "stored":           True,
        "_flask_persisted":  True,   # tells Node.js bridge to skip re-inserting
    }

    # Broadcast to all dashboard clients
    socketio.emit("detection_event", payload)

    # Save to in-memory ring
    recent_detections.append(payload)

    # Persist to Supabase
    insert_event(payload)
    upsert_node_status(node_id)

    log.info("[SENSOR → SUPABASE] ✔  %s event stored for %s (confidence %.2f)",
             event_type.upper(), node_id, confidence)



# ═══════════════════════════════════════════════════════════════
#  REST endpoints
# ═══════════════════════════════════════════════════════════════

@app.route("/health", methods=["GET"])
def health():
    """Simple liveness probe."""
    return jsonify({"status": "ok"})


@app.route("/api/detections", methods=["GET"])
def get_detections():
    """Return the last 50 detections (all, including low-confidence)."""
    return jsonify(list(recent_detections))


# ═══════════════════════════════════════════════════════════════
#  WebSocket events
# ═══════════════════════════════════════════════════════════════

@socketio.on("connect")
def on_connect():
    node_id = request.args.get("node_id")
    log.info("Client connected — args: %s  sid: %s", dict(request.args), request.sid)
    if node_id and node_id in buffers:
        upsert_node_status(node_id)
        log.info("[NODE ONLINE] %s connected", node_id)


@socketio.on("disconnect")
def on_disconnect():
    log.info("Client disconnected")


@socketio.on("node_online")
def on_node_online(data: dict):
    node_id = data.get("node_id")
    if node_id and node_id in buffers:
        upsert_node_status(node_id)
        log.info("[NODE ONLINE] %s marked active", node_id)


@socketio.on("ping_test")
def on_ping_test(data):
    log.info("[PING TEST] Received from ESP32! data=%s", data)


@socketio.on("sensor_data")
def on_sensor_data(data: dict):
    """
    Receives non-audio sensor telemetry from an ESP32 node and
    re-broadcasts it to all dashboard clients as "sensor_update".

    Also checks sensor thresholds and inserts events into Supabase:
      - water_raw >= 1500  → 'flood' event
      - accel_g   >= 1.3   → 'earthquake' event

    Expected payload (all fields optional except node_id):
        {
            "node_id":     "node_1",
            "audio_peak":  742,
            "accel_g":     1.87,
            "accel_delta": 1.62,
            "quake":       true,
            "water_raw":   0,
            "water_alert": false,
            "smoke_raw":   310,
            "smoke_alert": false
        }
    """
    node_id = data.get("node_id")
    if not node_id or node_id not in buffers:
        log.warning("Rejected sensor_data — unknown node_id: %s", node_id)
        return {"status": "error", "reason": "unknown node_id"}

    # Mark node online on every telemetry frame
    upsert_node_status(node_id)

    # Re-broadcast to dashboards
    socketio.emit("sensor_update", data)

    # ── Threshold checks → insert events into Supabase ────────
    # Flood: water_raw >= 1500
    water_raw = data.get("water_raw")
    if water_raw is not None and float(water_raw) >= WATER_LEVEL_FLOOD_THRESHOLD:
        if not _sensor_alert_on_cooldown(node_id, "flood"):
            _mark_sensor_alert(node_id, "flood")
            _insert_sensor_alert(node_id, "flood", 1.0)
            log.info("[FLOOD ALERT] %s water_raw=%s (threshold %d)",
                     node_id, water_raw, WATER_LEVEL_FLOOD_THRESHOLD)

    # Earthquake: accel_g >= 1.3
    accel_g = data.get("accel_g")
    if accel_g is not None and float(accel_g) >= EARTHQUAKE_ACCEL_THRESHOLD:
        if not _sensor_alert_on_cooldown(node_id, "earthquake"):
            _mark_sensor_alert(node_id, "earthquake")
            _insert_sensor_alert(node_id, "earthquake", min(float(accel_g) / 2.0, 1.0))
            log.info("[EARTHQUAKE ALERT] %s accel_g=%.2f (threshold %.1f)",
                     node_id, float(accel_g), EARTHQUAKE_ACCEL_THRESHOLD)

    # Log alerts prominently
    alerts = []
    if data.get("quake"):       alerts.append("EARTHQUAKE")
    if data.get("water_alert"): alerts.append("WATER")
    if data.get("smoke_alert"): alerts.append("SMOKE")
    if alerts:
        log.info("[SENSOR ALERT] %s → %s  (accel %.2fg, water %s, smoke %s)",
                 node_id, "+".join(alerts),
                 float(data.get("accel_g", 0) or 0),
                 data.get("water_raw", "—"), data.get("smoke_raw", "—"))
    else:
        log.debug("[SENSOR] %s telemetry ok", node_id)

    return {"status": "received", "node_id": node_id}


@socketio.on("*")
def catch_all(event, *args):
    log.info("[CATCH-ALL] event=%s  data_preview=%s", event, str(args)[:200])


@socketio.on("audio_stream")
def on_audio_stream(data: dict):
    """
    Accepts:
        {
            "node_id": "node_1",
            "audio":   "<base64-encoded 16-bit mono PCM bytes>"
        }

    Returns (ack):
        { "status": "received", "node_id": "node_1" }
    """
    # ── 1. Validate payload ───────────────────────────────────
    node_id = data.get("node_id")
    audio_b64 = data.get("audio")

    if not node_id or not audio_b64:
        log.warning("Rejected payload — missing node_id or audio field")
        return {"status": "error", "reason": "missing node_id or audio"}

    if node_id not in buffers:
        log.warning("Rejected payload — unknown node_id: %s", node_id)
        return {"status": "error", "reason": f"unknown node_id: {node_id}"}

    # ── 2. Decode base64 → raw PCM bytes → int16 ndarray ─────
    try:
        raw_bytes = base64.b64decode(audio_b64)
    except Exception:
        log.warning("Rejected payload — invalid base64 from %s", node_id)
        return {"status": "error", "reason": "invalid base64"}

    if len(raw_bytes) % 2 != 0:
        log.warning("Rejected payload — odd byte count from %s", node_id)
        return {"status": "error", "reason": "byte count must be even (16-bit samples)"}

    samples = np.frombuffer(raw_bytes, dtype=np.int16)

    # ── Throttled INFO log: confirm audio is arriving ─────────
    _audio_chunk_count[node_id] = _audio_chunk_count.get(node_id, 0) + 1
    if _audio_chunk_count[node_id] % 8 == 1:   # ~every 2s of audio
        peak = int(np.abs(samples.astype(np.int32)).max()) if samples.size else 0
        log.info("[AUDIO] %s  chunk #%d  (%d samples, peak %d)",
                 node_id, _audio_chunk_count[node_id], samples.size, peak)

    # ── 3. Write into ring buffer ─────────────────────────────
    buf = buffers[node_id]
    buf.write(samples)
    upsert_node_status(node_id)   # mark node online on every audio chunk

    log.info(
        "%s: wrote %d samples  %s",
        node_id,
        len(samples),
        buf,
    )

    # ── 4. Run inference when buffer is full ──────────────────
    if buf.ready:
        try:
            pcm_snapshot = buf.read()           # int16 ndarray, 48 000 samples
            result = predict(pcm_snapshot)

            event_type = result["class"]
            confidence = result["confidence"]
            alert_priority = ALERT_PRIORITY.get(event_type, "none")

            # Decide whether to persist to Supabase
            stored = (
                confidence >= STORE_CONFIDENCE_THRESHOLD
                and event_type != "background"
            )

            # ── Build full event payload ──────────────────────
            payload = {
                "node_id":          node_id,
                "event_type":       event_type,
                "confidence":       confidence,
                "alert_priority":   alert_priority,
                "device_timestamp": datetime.now(timezone.utc).isoformat(),
                "route_path":       [node_id, "gateway"],
                "stored":           stored,
            }

            # ── 4a. Always: broadcast to all dashboard clients ─
            socketio.emit("detection_event", payload)

            # ── 4b. Always: save to in-memory ring ────────────
            recent_detections.append(payload)

            # ── 4c. Conditionally: persist to Supabase ────────
            if stored:
                insert_event(payload)
                upsert_node_status(node_id)
                log.info(
                    "[STORED]    %s → %-16s (%.2f) [%s]",
                    node_id,
                    event_type,
                    confidence,
                    alert_priority.upper(),
                )
            else:
                log.info(
                    "[LIVE-ONLY] %s → %-16s (%.2f) [%s]",
                    node_id,
                    event_type,
                    confidence,
                    alert_priority.upper(),
                )

            # Slide the window forward by 1 second so the next
            # inference triggers after ~1 s of fresh audio.
            buf.slide(SLIDE_SAMPLES)

        except Exception as exc:
            log.error("[Inference] %s  error: %s", node_id, exc)

    # ── 5. Ack back to the sender ─────────────────────────────
    return {"status": "received", "node_id": node_id}


# ═══════════════════════════════════════════════════════════════
#  Entry point
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    log.info("Loading ML models (this may take a moment) …")
    load_models()      # YAMNet + TFLite — load once, reuse forever
    log.info("Starting Edge-AI Flask server on http://0.0.0.0:5000")
    socketio.run(app, host="0.0.0.0", port=5000)
