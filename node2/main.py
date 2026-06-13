# Node 2 — change SERVER_IP, SSID, PASSWORD before flashing
"""
main.py  —  MicroPython firmware for ESP32 "node_2"

Captures 16 kHz / 16-bit mono audio from an INMP441 I2S microphone
and streams 1-second PCM chunks (base64-encoded) to a Flask-SocketIO
server for server-side acoustic event detection.

Hardware wiring (INMP441 → ESP32):
    SCK  → GPIO 14
    WS   → GPIO 15
    SD   → GPIO 32
    VDD  → 3.3V
    GND  → GND
    L/R  → GND  (left channel / mono)

Protocol flow:
    1. Connect WiFi
    2. Open WebSocket to /socket.io/?EIO=4&transport=websocket
    3. Complete Engine.IO / Socket.IO v4 handshake
    4. Every ~1 s: read 16 000 samples → base64 → emit "audio_stream"
    5. Respond to Engine.IO pings to keep the connection alive
    6. On any error: close, wait 5 s, reconnect
"""

import gc
import network
import time
import ubinascii
import ujson
import uos
import usocket
import ustruct
from machine import I2S, Pin


# ═══════════════════════════════════════════════════════════════
#  Configuration — edit these values for your setup
# ═══════════════════════════════════════════════════════════════

SSID        = "YOUR_WIFI_SSID"
PASSWORD    = "YOUR_WIFI_PASSWORD"
SERVER_IP   = "192.168.1.100"
SERVER_PORT = 5000
NODE_ID     = "node_2"

# INMP441 I2S microphone pins
I2S_SCK_PIN = 14    # Serial Clock  (BCLK)
I2S_WS_PIN  = 15    # Word Select   (LRCLK)
I2S_SD_PIN  = 32    # Serial Data   (DOUT)

# Audio parameters
SAMPLE_RATE       = 16000                                   # Hz
BITS_PER_SAMPLE   = 16
SAMPLES_PER_CHUNK = 16000                                   # 1 second
BYTES_PER_CHUNK   = SAMPLES_PER_CHUNK * (BITS_PER_SAMPLE // 8)  # 32 000

RECONNECT_DELAY   = 5   # seconds before reconnect attempt


# ═══════════════════════════════════════════════════════════════
#  WiFi helpers
# ═══════════════════════════════════════════════════════════════

def wifi_connect():
    """Connect to WiFi.  Blocks until connected or times out."""
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)

    if wlan.isconnected():
        print("[WiFi] Already connected:", wlan.ifconfig()[0])
        return

    print("[WiFi] Connecting to", SSID, "...")
    wlan.connect(SSID, PASSWORD)

    retries = 0
    while not wlan.isconnected():
        time.sleep(0.5)
        retries += 1
        if retries > 40:            # 20 s timeout
            raise OSError("[WiFi] Connection timeout")

    print("[WiFi] Connected:", wlan.ifconfig()[0])


def wifi_ensure():
    """Re-connect if WiFi dropped."""
    wlan = network.WLAN(network.STA_IF)
    if not wlan.isconnected():
        print("[WiFi] Disconnected — reconnecting ...")
        wifi_connect()


# ═══════════════════════════════════════════════════════════════
#  Minimal WebSocket client (RFC 6455, client-masked frames)
# ═══════════════════════════════════════════════════════════════

class WebSocket:
    """Bare-bones WebSocket client for MicroPython."""

    def __init__(self, host, port, path):
        self._host = host
        self._port = port
        self._path = path
        self._sock = None

    # ── Connect (TCP + HTTP Upgrade) ──────────────────────────

    def connect(self):
        addr = usocket.getaddrinfo(self._host, self._port)[0][-1]
        self._sock = usocket.socket()
        self._sock.connect(addr)

        ws_key = ubinascii.b2a_base64(uos.urandom(16)).strip().decode()

        req = (
            "GET {} HTTP/1.1\r\n"
            "Host: {}:{}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: {}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).format(self._path, self._host, self._port, ws_key)

        self._sock.send(req.encode())

        # Read HTTP response until blank line
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self._sock.recv(1)
            if not chunk:
                raise OSError("Connection closed during WS handshake")
            resp += chunk

        if b"101" not in resp:
            self.close()
            raise OSError("WebSocket upgrade failed")

    # ── Send a small text frame (masked) ──────────────────────

    def send(self, text):
        """Send a short masked text frame (< 64 KB)."""
        payload = text.encode() if isinstance(text, str) else text
        self._send_frame(0x81, payload)

    # ── Send a large text frame from multiple parts ───────────
    #    Masks in 512-byte blocks so peak RAM stays low.

    def send_parts(self, parts, total_len):
        """Send a masked text frame assembled from *parts*."""
        mask = uos.urandom(4)

        # Frame header
        hdr = bytearray()
        hdr.append(0x81)                        # FIN | TEXT
        if total_len < 126:
            hdr.append(0x80 | total_len)
        elif total_len < 65536:
            hdr.append(0x80 | 126)
            hdr.extend(ustruct.pack(">H", total_len))
        else:
            hdr.append(0x80 | 127)
            hdr.extend(ustruct.pack(">Q", total_len))
        hdr.extend(mask)
        self._sock.send(hdr)

        # Stream each part, masking in small blocks
        pos = 0
        BLK = 512
        for part in parts:
            if isinstance(part, str):
                part = part.encode()
            mv = part if isinstance(part, memoryview) else memoryview(part)
            n = len(mv)
            i = 0
            while i < n:
                end = min(i + BLK, n)
                blk = bytearray(mv[i:end])
                for j in range(len(blk)):
                    blk[j] ^= mask[(pos + j) & 3]
                self._sock.send(blk)
                pos += end - i
                i = end

    # ── Receive one frame ─────────────────────────────────────

    def recv(self, timeout_s=0.1):
        """Return decoded text, None on close, or "" on timeout."""
        self._sock.settimeout(timeout_s)
        try:
            # Read first byte (this is where the timeout applies)
            b0 = self._sock.recv(1)
            if not b0:
                return None

            # First byte arrived → rest of the frame should follow quickly
            self._sock.settimeout(5)
            b1 = self._sock.recv(1)
            if not b1:
                return None

            opcode = b0[0] & 0x0F
            mask_bit = b1[0] & 0x80
            length = b1[0] & 0x7F

            if length == 126:
                length = ustruct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = ustruct.unpack(">Q", self._recv_exact(8))[0]

            mask_key = self._recv_exact(4) if mask_bit else None
            payload = self._recv_exact(length) if length else b""

            if mask_key:
                payload = bytearray(payload)
                for i in range(len(payload)):
                    payload[i] ^= mask_key[i & 3]

            # Close frame
            if opcode == 0x08:
                return None
            # WS Ping → auto-pong, then keep reading
            if opcode == 0x09:
                self._send_frame(0x8A, payload)
                return self.recv(timeout_s)
            # WS Pong → ignore, keep reading
            if opcode == 0x0A:
                return self.recv(timeout_s)

            return bytes(payload).decode()

        except OSError as e:
            if e.args[0] in (11, 110):      # EAGAIN / ETIMEDOUT
                return ""
            raise

    # ── Internals ─────────────────────────────────────────────

    def _send_frame(self, opcode_byte, payload):
        mask = uos.urandom(4)
        n = len(payload)

        hdr = bytearray()
        hdr.append(opcode_byte)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr.extend(ustruct.pack(">H", n))
        else:
            hdr.append(0x80 | 127)
            hdr.extend(ustruct.pack(">Q", n))
        hdr.extend(mask)
        self._sock.send(hdr)

        masked = bytearray(n)
        for i in range(n):
            masked[i] = payload[i] ^ mask[i & 3]
        self._sock.send(masked)

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise OSError("Connection lost")
            buf += chunk
        return buf

    def close(self):
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None


# ═══════════════════════════════════════════════════════════════
#  Socket.IO client  (Engine.IO v4 / Socket.IO v4 over WebSocket)
# ═══════════════════════════════════════════════════════════════
#
#  Engine.IO packet types:  0=OPEN  2=PING  3=PONG  4=MESSAGE
#  Socket.IO packet types:  0=CONNECT  2=EVENT
#
#  Emit format:   42["event_name", {payload}]
#  Ping/pong:     server sends "2", client replies "3"
# ═══════════════════════════════════════════════════════════════

class SocketIOClient:
    """Minimal Socket.IO v4 client (direct WebSocket, no polling)."""

    def __init__(self, host, port):
        path = "/socket.io/?EIO=4&transport=websocket"
        self._ws = WebSocket(host, port, path)
        self.connected = False

    def connect(self):
        """WebSocket connect → Engine.IO open → Socket.IO connect."""
        self._ws.connect()

        # 1) Engine.IO OPEN  —  "0{sid, pingInterval, ...}"
        msg = self._ws.recv(timeout_s=10)
        if not msg or not msg.startswith("0"):
            raise OSError("Expected EIO OPEN, got: " + repr(msg)[:50])
        try:
            info = ujson.loads(msg[1:])
            print("[SIO] Engine.IO sid:", info.get("sid", "?"))
        except Exception:
            pass

        # 2) Socket.IO CONNECT to default namespace  —  send "40"
        self._ws.send("40")

        # 3) Socket.IO CONNECT ack  —  "40{sid}"
        msg = self._ws.recv(timeout_s=10)
        if not msg or not msg.startswith("40"):
            raise OSError("Expected SIO CONNECT ack, got: " + repr(msg)[:50])

        self.connected = True
        print("[SIO] Connected to server")

    def emit_audio(self, node_id, audio_b64):
        """Emit "audio_stream" event with base64 audio payload.

        Builds the Socket.IO frame in three parts to avoid
        allocating the full ~45 KB message as a single string.
        """
        # 42["audio_stream",{"node_id":"node_2","audio":"<b64>"}]
        prefix = '42["audio_stream",{"node_id":"' + node_id + '","audio":"'
        suffix = '"}]'

        if isinstance(audio_b64, str):
            audio_b64 = audio_b64.encode()

        total = len(prefix) + len(audio_b64) + len(suffix)
        self._ws.send_parts(
            [prefix.encode(), audio_b64, suffix.encode()],
            total,
        )

    def handle_incoming(self):
        """Non-blocking check for Engine.IO pings and other messages."""
        msg = self._ws.recv(timeout_s=0.05)

        if msg is None:                     # Server closed connection
            self.connected = False
            raise OSError("Server closed connection")

        if msg == "":                       # Timeout — nothing pending
            return

        if msg == "2":                      # Engine.IO PING
            self._ws.send("3")             # Engine.IO PONG
            return

        if msg.startswith("41"):            # Socket.IO DISCONNECT
            self.connected = False
            raise OSError("Server sent disconnect")

        # Anything else (acks, events) → silently ignore

    def close(self):
        self.connected = False
        self._ws.close()


# ═══════════════════════════════════════════════════════════════
#  I2S Microphone
# ═══════════════════════════════════════════════════════════════

def setup_i2s():
    """Initialise the INMP441 I2S microphone in receive mode."""
    mic = I2S(
        0,                                  # I2S peripheral ID
        sck=Pin(I2S_SCK_PIN),               # Bit clock
        ws=Pin(I2S_WS_PIN),                 # Word select
        sd=Pin(I2S_SD_PIN),                 # Serial data in
        mode=I2S.RX,
        bits=BITS_PER_SAMPLE,
        format=I2S.MONO,
        rate=SAMPLE_RATE,
        ibuf=40000,                         # DMA buffer (> 1 chunk)
    )
    print("[I2S] Microphone ready  (16 kHz, 16-bit, mono)")
    return mic


# ═══════════════════════════════════════════════════════════════
#  Main loop
# ═══════════════════════════════════════════════════════════════

def main():
    print("=" * 50)
    print("  Edge-AI Audio Node:", NODE_ID)
    print("  Server: {}:{}".format(SERVER_IP, SERVER_PORT))
    print("=" * 50)

    wifi_connect()
    mic = setup_i2s()

    # Pre-allocate the audio capture buffer (32 000 bytes = 1 s)
    audio_buf = bytearray(BYTES_PER_CHUNK)

    while True:
        sio = None
        try:
            wifi_ensure()
            gc.collect()

            sio = SocketIOClient(SERVER_IP, SERVER_PORT)
            sio.connect()

            while sio.connected:
                # ── 1. Capture 1 second of audio (blocking) ───
                mic.readinto(audio_buf)

                # ── 2. Base64 encode ──────────────────────────
                b64_raw = ubinascii.b2a_base64(audio_buf)
                # Trim trailing newline via memoryview (no copy)
                b64 = memoryview(b64_raw)[:-1]

                # ── 3. Emit to server ─────────────────────────
                sio.emit_audio(NODE_ID, b64)
                print("Sent 1s chunk")

                # ── 4. Respond to pings / server messages ─────
                sio.handle_incoming()

                # ── 5. Free the base64 buffer ─────────────────
                del b64, b64_raw
                gc.collect()

        except KeyboardInterrupt:
            print("\n[Main] Stopped by user")
            mic.deinit()
            if sio:
                sio.close()
            return

        except Exception as e:
            print("[Error]", e)

        finally:
            if sio:
                sio.close()

        print("Reconnecting in {}s...".format(RECONNECT_DELAY))
        time.sleep(RECONNECT_DELAY)


# ── Boot ──────────────────────────────────────────────────────
main()

