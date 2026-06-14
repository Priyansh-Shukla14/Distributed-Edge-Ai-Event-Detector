/*
 * ============================================================================
 *  Node2_Slave.ino — SLAVE Node Firmware
 * ============================================================================
 *  ESP32 #2 (SLAVE) — Remote Sensor Reporter
 *
 *  Sensors:
 *    • INMP441 I2S Microphone (sound detection)
 *    • MQ-2 Smoke Sensor (smoke/gas detection)
 *
 *  Outputs:
 *    • Status LED (visual indicator on loud sound)
 *
 *  Communication:
 *    • UART2 cross-link to MASTER — sends "AUDIO:<val>" and "SMOKE:<val>"
 *    • Serial Monitor for debugging
 * ============================================================================
 */

#include <driver/i2s.h>
#include <math.h>

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                         PIN DEFINITIONS                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

// --- I2S Microphone (INMP441) ---
#define I2S_WS   25    // Word Select (L/R Clock)
#define I2S_SCK  26    // Serial Clock (BCLK)
#define I2S_SD   34    // Serial Data In

// --- Smoke Sensor (MQ-2, Analog) ---
#define SMOKE_PIN 35

// --- Status LED ---
#define LED_PIN 2

// --- UART2 Cross-Link to MASTER ---
#define UART2_RX   5
#define UART2_TX   4
#define UART2_BAUD 115200

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                      TUNABLE THRESHOLDS                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define SOUND_THRESHOLD 1500   // Raw int16 amplitude (0 – 32767)
// Note: SMOKE_THRESHOLD is evaluated on the MASTER side after receiving data.
//       The slave only reports raw values. A local threshold is kept here
//       for optional LED indication if desired in the future.
#define SMOKE_THRESHOLD 2000   // ADC value (0 – 4095) — for local reference

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                        I2S CONFIGURATION                                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define I2S_PORT          I2S_NUM_0
#define I2S_SAMPLE_RATE   16000
#define I2S_DMA_BUF_COUNT 8
#define I2S_DMA_BUF_LEN   64
#define AUDIO_SAMPLES     512   // Samples per peak measurement

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                       TIMING CONSTANTS                                  ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

#define LOOP_INTERVAL_MS 100

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                     FUNCTION: setupMic()                                ║
// ║  Configure I2S for the INMP441 MEMS microphone.                        ║
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

  esp_err_t err;
  err = i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[MIC] I2S driver install FAILED: %d\n", err);
  }

  err = i2s_set_pin(I2S_PORT, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("[MIC] I2S set pin FAILED: %d\n", err);
  }

  i2s_zero_dma_buffer(I2S_PORT);
  delay(500);  // Let I2S DMA stabilize before first read
  Serial.println("[MIC] INMP441 I2S configured — 16kHz, 16-bit, mono left");
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                     FUNCTION: getAudioPeak()                            ║
// ║  Read 512 samples from I2S, return max absolute amplitude.              ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

int16_t getAudioPeak() {
  static int16_t samples[AUDIO_SAMPLES];  // static to avoid 1KB stack allocation
  size_t  bytesRead = 0;

  esp_err_t err = i2s_read(I2S_PORT, samples, sizeof(samples), &bytesRead,
                           portMAX_DELAY);
  if (err != ESP_OK) {
    Serial.printf("[MIC] i2s_read error: %d\n", err);
    return 0;
  }

  int samplesRead = bytesRead / sizeof(int16_t);
  int16_t peak = 0;

  for (int i = 0; i < samplesRead; i++) {
    int32_t absVal = abs((int32_t)samples[i]);
    if (absVal > peak) {
      peak = (int16_t)absVal;
    }
  }

  return peak;
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                             SETUP                                       ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void setup() {
  // --- Serial Monitor ---
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  Serial.println("============================================");
  Serial.println("   ESP32 Alert System — SLAVE (Node 2)");
  Serial.println("============================================");

  // --- Status LED ---
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // --- UART2 Cross-Link ---
  Serial2.begin(UART2_BAUD, SERIAL_8N1, UART2_RX, UART2_TX);
  Serial.printf("[UART2] Initialized — %d baud (RX=%d, TX=%d)\n",
                UART2_BAUD, UART2_RX, UART2_TX);

  // --- I2S Microphone ---
  setupMic();

  // --- Smoke Sensor ---
  pinMode(SMOKE_PIN, INPUT);
  Serial.println("[SMOKE] Analog input configured on pin 35");

  // --- Startup self-test: blink LED ---
  Serial.println("[SELF-TEST] Running startup check...");
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(100);
    digitalWrite(LED_PIN, LOW);
    delay(100);
  }
  Serial.println("[SELF-TEST] Complete — SLAVE ready");

  Serial.println("--------------------------------------------");
  Serial.println("  Entering main loop...");
  Serial.println("--------------------------------------------");
}

// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║                           MAIN LOOP                                     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

void loop() {

  // ── 1. Audio Peak (Slave Mic) ──────────────────────────────────────────
  int16_t audioPeak = getAudioPeak();
  Serial.printf("[SLAVE] Audio peak: %d\n", audioPeak);

  // Send to MASTER over UART2
  Serial2.printf("AUDIO:%d\n", audioPeak);

  // Brief LED flash if over threshold (local visual indicator)
  if (audioPeak > SOUND_THRESHOLD) {
    Serial.println("[SLAVE] Sound threshold exceeded — LED flash");
    digitalWrite(LED_PIN, HIGH);
    delay(50);
    digitalWrite(LED_PIN, LOW);
  }

  // ── 2. Smoke Sensor (MQ-2) ────────────────────────────────────────────
  int smokeVal = analogRead(SMOKE_PIN);
  Serial.printf("[SLAVE] Smoke ADC: %d\n", smokeVal);

  // Send to MASTER over UART2
  Serial2.printf("SMOKE:%d\n", smokeVal);

  // ── Loop Timing ────────────────────────────────────────────────────────
  delay(LOOP_INTERVAL_MS);
}
