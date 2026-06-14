/*
 * ============================================================================
 *  Node1_Master.ino — MASTER Node with WiFi + Dashboard Integration
 * ============================================================================
 *  ESP32 #1 (MASTER) — Multi-Sensor Alert Controller + Audio Streamer
 *
 *  Streams I2S audio to Flask-SocketIO backend for ML classification
 *  (YAMNet + TFLite). Receives detection events and triggers buzzer.
 *  Also monitors local sensors (accel, water) and slave data (UART).
 *
 *  Required Libraries (install via Arduino Library Manager):
 *    1. "WebSockets" by Markus Sattler (Links2004)
 *    2. "ArduinoJson" by Benoit Blanchon (v6.x)
 *
 *  Protocol:
 *    ESP32 → Server:  emit "audio_stream" { node_id, audio(base64) }
 *    Server → ESP32:  emit "detection_event" { event_type, confidence,
 *                     alert_priority, node_id }
 * ============================================================================
 */

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
#include <Wire.h>
#include <math.h>
#include "mbedtls/base64.h"

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                    WIFI & SERVER CONFIGURATION                          ║
// ║            *** EDIT THESE FOR YOUR SETUP ***                            ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

const char* WIFI_SSID     = "Sehore";
const char* WIFI_PASSWORD = "sanidhya";
const char* SERVER_HOST   = "10.239.84.37";
const int   SERVER_PORT   = 5000;
const char* NODE_ID       = "node_1";

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                         PIN DEFINITIONS                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// --- I2S Microphone (INMP441) ---
#define I2S_WS   25
#define I2S_SCK  26
#define I2S_SD   34

// --- MPU-6050 Accelerometer (I2C) ---
#define MPU_SDA  21
#define MPU_SCL  22
#define MPU_ADDR 0x68

// --- Water Level Sensor (Analog) ---
#define WATER_PIN 32

// --- Buzzer ---
#define BUZZER_PIN 27

// --- Status LED ---
#define LED_PIN 2

// --- UART2 Cross-Link to SLAVE ---
#define UART2_RX   5
#define UART2_TX   4
#define UART2_BAUD 115200

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                      TUNABLE THRESHOLDS                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define SOUND_THRESHOLD  8000   // Raw int16 amplitude (0 – 32767), local fast-path
#define SMOKE_THRESHOLD  2000   // ADC (0 – 4095), for SLAVE data via UART
#define WATER_THRESHOLD  2000   // ADC (0 – 4095)
#define QUAKE_THRESHOLD  1.5f   // g-force delta from rolling baseline

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        I2S CONFIGURATION                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define I2S_PORT           I2S_NUM_0
#define I2S_SAMPLE_RATE    16000
#define I2S_DMA_BUF_COUNT  16    // More DMA buffers for streaming headroom
#define I2S_DMA_BUF_LEN    128   // Larger buffers for less overhead

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                     AUDIO STREAMING CONFIG                              ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Server needs 3 seconds (48000 samples) to run ML inference.
// We send 1-second chunks split into 4 sub-chunks of 0.25s each
// to stay under the WebSocket library's frame size limit.

#define STREAM_TOTAL_SAMPLES   16000                        // 1 second
#define STREAM_CHUNK_SAMPLES   4000                         // 0.25 seconds
#define STREAM_CHUNK_BYTES     (STREAM_CHUNK_SAMPLES * 2)   // 8000 bytes
#define BASE64_BUF_SIZE        (((STREAM_CHUNK_BYTES + 2) / 3) * 4 + 1)
#define I2S_READ_SAMPLES       512                          // Per i2s_read call

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                       TIMING CONSTANTS                                  ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define SENSOR_CHECK_MS   500   // Sensor polling interval
#define ALERT_ON_MS       300
#define ALERT_OFF_MS      200
#define EMA_DECAY         0.95f
#define WIFI_TIMEOUT_S    20
#define SIO_RECONNECT_MS  5000
#define STARTUP_GRACE_MS  15000  // No local buzzer for 15s — let SocketIO connect first

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        GLOBAL VARIABLES                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// --- WebSocket (raw Socket.IO v4 protocol) ---
WebSocketsClient webSocket;
bool serverConnected = false;

// --- Audio streaming buffers (static to avoid stack/heap fragmentation) ---
static int16_t streamBuf[STREAM_TOTAL_SAMPLES];   // 32 KB — 1 second accumulator
static int16_t i2sReadBuf[I2S_READ_SAMPLES];      // 1 KB — per-read scratch
static char    base64Buf[BASE64_BUF_SIZE];         // ~10.5 KB — base64 output
int streamPos = 0;                                 // Current write position

// --- Accelerometer ---
float accelBaseline = 1.0f;
bool  baselineInit  = false;

// --- Timing ---
unsigned long lastSensorCheck = 0;
unsigned long startupTime     = 0;
unsigned long lastPing        = 0;  // For debug ping test

// --- Latest sensor readings (for telemetry to dashboard) ---
int lastAudioPeak = 0;   // Latest 1s audio peak amplitude
int lastSmokeVal  = 0;   // Latest smoke reading from SLAVE (via UART)

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                          WiFi CONNECTION                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    retries++;
    if (retries > WIFI_TIMEOUT_S * 2) {
      Serial.println("\n[WiFi] Timeout — restarting ESP32");
      ESP.restart();
    }
  }
  Serial.printf("\n[WiFi] Connected — IP: %s\n", WiFi.localIP().toString().c_str());
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                     I2S MICROPHONE SETUP                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void setupMic() {
  const i2s_config_t i2s_config = {
    .mode                 = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate          = I2S_SAMPLE_RATE,
    .bits_per_sample      = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format       = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags     = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count        = I2S_DMA_BUF_COUNT,
    .dma_buf_len          = I2S_DMA_BUF_LEN,
    .use_apll             = false,
    .tx_desc_auto_clear   = false,
    .fixed_mclk           = 0
  };

  const i2s_pin_config_t pin_config = {
    .bck_io_num   = I2S_SCK,
    .ws_io_num    = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num  = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
  i2s_zero_dma_buffer(I2S_PORT);
  delay(500);
  Serial.println("[MIC] INMP441 I2S configured — 16kHz, 16-bit, mono");
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                     MPU-6050 ACCELEROMETER                              ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void setupMPU() {
  Wire.begin(MPU_SDA, MPU_SCL);
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  uint8_t result = Wire.endTransmission(true);
  Serial.printf("[MPU] MPU-6050 init %s\n", result == 0 ? "OK" : "FAILED");
}

float getAccel() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (uint8_t)true);

  if (Wire.available() < 6) return 1.0f;

  uint8_t xh = Wire.read(), xl = Wire.read();
  uint8_t yh = Wire.read(), yl = Wire.read();
  uint8_t zh = Wire.read(), zl = Wire.read();
  int16_t rawX = (int16_t)((xh << 8) | xl);
  int16_t rawY = (int16_t)((yh << 8) | yl);
  int16_t rawZ = (int16_t)((zh << 8) | zl);

  float ax = rawX / 16384.0f;
  float ay = rawY / 16384.0f;
  float az = rawZ / 16384.0f;
  return sqrtf(ax * ax + ay * ay + az * az);
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        ALERT SYSTEM                                     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Pulse buzzer + LED with SocketIO keepalive between pulses
void buzzAlert(const char* msg, int pulses) {
  Serial.printf("\n!!! ALERT: %s !!!\n\n", msg);
  for (int i = 0; i < pulses; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(LED_PIN, HIGH);
    delay(ALERT_ON_MS);
    webSocket.loop();   // Keep WebSocket alive during alert

    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    delay(ALERT_OFF_MS);
    webSocket.loop();
  }
}

// Local sensor alert — 5 pulses
void alert(const char* msg) {
  buzzAlert(msg, 5);
}

// ML detection alert — pulse count based on priority
void alertForDetection(const char* eventType, const char* priority, float confidence) {
  int pulses = 0;
  if      (strcmp(priority, "critical") == 0) pulses = 5;
  else if (strcmp(priority, "high")     == 0) pulses = 4;
  else if (strcmp(priority, "medium")   == 0) pulses = 3;
  else if (strcmp(priority, "low")      == 0) pulses = 1;

  if (pulses == 0) return;  // "none" priority — no buzzer

  char msg[100];
  snprintf(msg, sizeof(msg), "ML: %s (%.0f%%) [%s]", eventType, confidence * 100, priority);
  buzzAlert(msg, pulses);
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                    SLAVE UART MESSAGE PARSING                           ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void parseSlaveMessage(String line) {
  line.trim();
  if (line.length() == 0) return;

  int colonIdx = line.indexOf(':');
  if (colonIdx < 0) return;

  String key  = line.substring(0, colonIdx);
  int    value = line.substring(colonIdx + 1).toInt();

  if (key == "AUDIO") {
    Serial.printf("[SLAVE] Audio: %d\n", value);
    if (value > SOUND_THRESHOLD) alert("LOUD SOUND - Slave Mic");
  } else if (key == "SMOKE") {
    lastSmokeVal = value;   // remember for sensor telemetry
    Serial.printf("[SLAVE] Smoke: %d\n", value);
    if (value > SMOKE_THRESHOLD) alert("SMOKE DETECTED - Slave");
  }
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                   SOCKETIO EVENT HANDLER                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Handle raw WebSocket messages and implement Socket.IO v4 protocol manually
void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {

    case WStype_CONNECTED:
      Serial.println("[WS] WebSocket connected — waiting for SIO handshake");
      break;

    case WStype_DISCONNECTED:
      Serial.println("[SIO] Disconnected from server");
      serverConnected = false;
      break;

    case WStype_TEXT: {
      String msg = String((char*)payload);

      // Engine.IO open packet: 0{"sid":"...","upgrades":[],...}
      if (msg.startsWith("0{")) {
        Serial.println("[EIO] Open packet received — sending SIO connect");
        webSocket.sendTXT("40");  // Connect to default namespace
      }
      // Socket.IO connect confirmed: 40{"sid":"..."}
      else if (msg.startsWith("40")) {
        Serial.printf("[SIO] Connected to %s:%d\n", SERVER_HOST, SERVER_PORT);
        serverConnected = true;
        digitalWrite(LED_PIN, HIGH);
        delay(200);
        digitalWrite(LED_PIN, LOW);
      }
      // Engine.IO ping: 2 → respond with pong: 3
      else if (msg == "2") {
        webSocket.sendTXT("3");
      }
      // Socket.IO event: 42["event_name", {...}]
      else if (msg.startsWith("42")) {
        String eventData = msg.substring(2);
        DynamicJsonDocument doc(1024);
        DeserializationError err = deserializeJson(doc, eventData);
        if (err) {
          Serial.printf("[SIO] JSON parse error: %s\n", err.c_str());
          break;
        }

        const char* eventName = doc[0];
        if (eventName && strcmp(eventName, "detection_event") == 0) {
          JsonObject data    = doc[1];
          const char* nodeId   = data["node_id"]        | "";
          const char* evtType  = data["event_type"]      | "";
          float confidence     = data["confidence"]      | 0.0f;
          const char* priority = data["alert_priority"]  | "none";

          Serial.printf("[ML] %s -> %s (%.0f%%) priority=%s\n",
                        nodeId, evtType, confidence * 100, priority);

          if (strcmp(priority, "none") != 0) {
            alertForDetection(evtType, priority, confidence);
          }
        }
      }
      // Socket.IO disconnect: 41
      else if (msg.startsWith("41")) {
        serverConnected = false;
        Serial.println("[SIO] Server sent disconnect");
      }
      break;
    }

    default:
      break;
  }
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                      AUDIO STREAMING                                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Send one sub-chunk (0.25s = 4000 samples) to the server
void sendSubChunk(int16_t* samples, int numSamples) {
  // Base64 encode the raw PCM bytes
  size_t olen = 0;
  int ret = mbedtls_base64_encode(
    (unsigned char*)base64Buf, BASE64_BUF_SIZE, &olen,
    (unsigned char*)samples, numSamples * sizeof(int16_t)
  );

  if (ret != 0) {
    Serial.printf("[STREAM] Base64 error: %d\n", ret);
    return;
  }
  base64Buf[olen] = '\0';

  // Build SocketIO event JSON manually to avoid extra memory copies
  // Format: ["audio_stream",{"node_id":"node_1","audio":"<b64>"}]
  String payload;
  payload.reserve(olen + 80);
  payload = "[\"audio_stream\",{\"node_id\":\"";
  payload += NODE_ID;
  payload += "\",\"audio\":\"";
  payload += base64Buf;
  payload += "\"}]";

  // Prepend "42" for Socket.IO event frame and send as raw WebSocket text
  String frame = "42";
  frame += payload;
  webSocket.sendTXT(frame);
}

// Process a full 1-second buffer: local peak check + stream to server
void processAndStreamAudio() {
  // ── Local peak detection (fast-path alert) ──
  int16_t peak = 0;
  for (int i = 0; i < STREAM_TOTAL_SAMPLES; i++) {
    int32_t v = abs((int32_t)streamBuf[i]);
    if (v > peak) peak = (int16_t)v;
  }
  lastAudioPeak = peak;   // remember for sensor telemetry
  Serial.printf("[MASTER] Audio peak (1s): %d  | SIO: %s\n",
                peak, serverConnected ? "CONNECTED" : "waiting...");

  // Only fire local buzzer after startup grace period
  if (peak > SOUND_THRESHOLD && (millis() - startupTime > STARTUP_GRACE_MS)) {
    alert("LOUD SOUND - Master Mic");
  }

  // ── Stream to server in 4 sub-chunks ──
  if (serverConnected) {
    for (int i = 0; i < 4; i++) {
      sendSubChunk(&streamBuf[i * STREAM_CHUNK_SAMPLES], STREAM_CHUNK_SAMPLES);
      webSocket.loop();  // Handle incoming messages between chunks
      delay(5);
    }
    Serial.println("[STREAM] Sent 1s audio (4 chunks)");
  }
}

// Non-blocking I2S read — accumulate samples into streamBuf
void readI2SIntoBuffer() {
  size_t bytesRead = 0;
  esp_err_t err = i2s_read(I2S_PORT, i2sReadBuf, sizeof(i2sReadBuf),
                           &bytesRead, pdMS_TO_TICKS(10));

  if (err != ESP_OK || bytesRead == 0) return;

  int samplesRead = bytesRead / sizeof(int16_t);
  int remaining   = STREAM_TOTAL_SAMPLES - streamPos;
  int toCopy      = (samplesRead < remaining) ? samplesRead : remaining;

  memcpy(&streamBuf[streamPos], i2sReadBuf, toCopy * sizeof(int16_t));
  streamPos += toCopy;
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        SENSOR CHECKS                                    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// Emit a "sensor_data" Socket.IO event with the full telemetry frame.
// Format: 42["sensor_data",{...}]
void sendSensorData(float accelG, float accelDelta, bool quake,
                    int waterRaw, bool waterAlert,
                    int smokeRaw, bool smokeAlert) {
  if (!serverConnected) return;

  String f = "42[\"sensor_data\",{";
  f += "\"node_id\":\"";    f += NODE_ID;                     f += "\",";
  f += "\"audio_peak\":";   f += lastAudioPeak;               f += ",";
  f += "\"accel_g\":";      f += String(accelG, 3);           f += ",";
  f += "\"accel_delta\":";  f += String(accelDelta, 3);       f += ",";
  f += "\"quake\":";        f += (quake ? "true" : "false");  f += ",";
  f += "\"water_raw\":";    f += waterRaw;                    f += ",";
  f += "\"water_alert\":";  f += (waterAlert ? "true" : "false"); f += ",";
  f += "\"smoke_raw\":";    f += smokeRaw;                    f += ",";
  f += "\"smoke_alert\":";  f += (smokeAlert ? "true" : "false");
  f += "}]";
  webSocket.sendTXT(f);
}

void checkSensors() {
  bool graceOver = (millis() - startupTime > STARTUP_GRACE_MS);

  // ── Accelerometer ──
  float accelMag = getAccel();
  float delta    = 0.0f;
  bool  quake    = false;
  if (!baselineInit) {
    accelBaseline = accelMag;
    baselineInit  = true;
    Serial.printf("[MASTER] Accel baseline initialized: %.3f g\n", accelBaseline);
  } else {
    accelBaseline = EMA_DECAY * accelBaseline + (1.0f - EMA_DECAY) * accelMag;
    delta = fabsf(accelMag - accelBaseline);
    quake = (delta > QUAKE_THRESHOLD) && graceOver;
    Serial.printf("[MASTER] Accel: %.3fg (Δ%.3f)%s\n",
                  accelMag, delta, quake ? "  *** QUAKE ***" : "");
    if (quake) alert("EARTHQUAKE DETECTED");
  }

  // ── Water Level ──
  int  waterVal   = analogRead(WATER_PIN);
  bool waterAlert = (waterVal > WATER_THRESHOLD) && graceOver;
  Serial.printf("[MASTER] Water: %d%s\n", waterVal, waterAlert ? "  *** FLOOD ***" : "");
  if (waterAlert) alert("WATER DETECTED");

  // ── Smoke (from SLAVE via UART) ──
  bool smokeAlert = (lastSmokeVal > SMOKE_THRESHOLD) && graceOver;

  // ── Push full telemetry frame to the dashboard ──
  sendSensorData(accelMag, delta, quake, waterVal, waterAlert, lastSmokeVal, smokeAlert);
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                             SETUP                                       ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  Serial.println("============================================");
  Serial.println("   ESP32 MASTER — WiFi + Dashboard Mode");
  Serial.println("============================================");

  // --- GPIO ---
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(WATER_PIN, INPUT_PULLDOWN);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  // --- UART2 to Slave ---
  Serial2.begin(UART2_BAUD, SERIAL_8N1, UART2_RX, UART2_TX);
  Serial2.setTimeout(50);
  Serial.printf("[UART2] Ready — %d baud\n", UART2_BAUD);

  // --- WiFi ---
  setupWiFi();

  // --- I2S Microphone ---
  setupMic();

  // --- MPU-6050 ---
  setupMPU();

  // --- WebSocket (raw Socket.IO v4) ---
  webSocket.begin(SERVER_HOST, SERVER_PORT, "/socket.io/?EIO=4&transport=websocket");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(SIO_RECONNECT_MS);
  Serial.printf("[WS] Connecting to ws://%s:%d ...\n", SERVER_HOST, SERVER_PORT);

  // --- Startup self-test ---
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(100);
    digitalWrite(LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    delay(100);
  }

  startupTime = millis();  // Record startup time for grace period
  Serial.println("--------------------------------------------");
  Serial.printf("  Entering main loop (alerts disabled for %ds)\n", STARTUP_GRACE_MS / 1000);
  Serial.println("--------------------------------------------");
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                           MAIN LOOP                                     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void loop() {
  // ── 1. WebSocket — handle connection, pings, incoming events ──
  webSocket.loop();

  // ── 2. WiFi reconnect if dropped ──
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Lost connection — reconnecting...");
    WiFi.reconnect();
    delay(1000);
    return;
  }

  // ── 3. Accumulate I2S audio into stream buffer ──
  readI2SIntoBuffer();

  // ── 4. When 1 second is ready: process + send ──
  if (streamPos >= STREAM_TOTAL_SAMPLES) {
    processAndStreamAudio();
    streamPos = 0;
  }

  // ── 5. Check local sensors periodically ──
  if (millis() - lastSensorCheck >= SENSOR_CHECK_MS) {
    lastSensorCheck = millis();
    checkSensors();
  }

  // ── 6. Check UART from Slave ──
  while (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    parseSlaveMessage(line);
  }
}