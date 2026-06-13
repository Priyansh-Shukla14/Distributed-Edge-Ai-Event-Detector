"""
model_inference.py — Two-stage acoustic event classifier.

Stage 1: YAMNet (TF Hub) converts 3s of 16 kHz mono audio into a
         mean-pooled 1024-dim embedding vector.
Stage 2: A custom TFLite dense classifier maps that embedding to
         probabilities over 6 classes.

Usage:
    from model_inference import load_models, predict

    load_models()                       # call once at startup
    result = predict(pcm_int16_array)   # → {"class": "siren", "confidence": 0.93}
"""

import logging
import os

import numpy as np
import tensorflow as tf
import tensorflow_hub as hub

log = logging.getLogger("edge-ai")

# ── Class labels (index order must match the TFLite output) ───
CLASS_LABELS = [
    "background",    # 0
    "dog",           # 1
    "glass_break",   # 2
    "gunshots",      # 3
    "scream",        # 4
    "siren",         # 5
]

EXPECTED_SAMPLES = 48_000   # 3 seconds × 16 000 Hz

# ── Module-level singletons (populated by load_models()) ──────
_yamnet_model = None
_tflite_interpreter = None
_tflite_input_details = None
_tflite_output_details = None


# ═══════════════════════════════════════════════════════════════
#  Model loading
# ═══════════════════════════════════════════════════════════════

def load_models(tflite_path: str | None = None) -> None:
    """
    Load YAMNet from TF Hub and the custom TFLite classifier
    from disk.  Call exactly once during server startup.
    """
    global _yamnet_model, _tflite_interpreter
    global _tflite_input_details, _tflite_output_details

    # ── 1. YAMNet ─────────────────────────────────────────────
    log.info("[Models] Loading YAMNet from TensorFlow Hub …")
    _yamnet_model = hub.load("https://tfhub.dev/google/yamnet/1")
    log.info("[Models] ✔  YAMNet loaded")

    # ── 2. TFLite classifier ──────────────────────────────────
    if tflite_path is None:
        tflite_path = os.path.join(
            os.path.dirname(__file__),
            "models",
            "audio_classifier_6class.tflite",
        )

    log.info("[Models] Loading TFLite classifier from %s …", tflite_path)

    if not os.path.isfile(tflite_path):
        raise FileNotFoundError(
            f"TFLite model not found at {tflite_path}. "
            "Place audio_classifier_6class.tflite inside flask_server/models/."
        )

    _tflite_interpreter = tf.lite.Interpreter(model_path=tflite_path)
    _tflite_interpreter.allocate_tensors()

    _tflite_input_details = _tflite_interpreter.get_input_details()
    _tflite_output_details = _tflite_interpreter.get_output_details()

    log.info("[Models] ✔  TFLite classifier loaded  (input: %s  output: %s)",
             _tflite_input_details[0]["shape"],
             _tflite_output_details[0]["shape"])


# ═══════════════════════════════════════════════════════════════
#  Inference
# ═══════════════════════════════════════════════════════════════

def predict(pcm_int16: np.ndarray) -> dict:
    """
    Run the two-stage pipeline on a 16-bit mono PCM buffer.

    Parameters
    ----------
    pcm_int16 : np.ndarray, dtype=int16
        Raw audio samples (ideally 48 000 = 3 s @ 16 kHz).
        Zero-padded automatically if shorter.

    Returns
    -------
    dict  {"class": str, "confidence": float}
    """
    if _yamnet_model is None or _tflite_interpreter is None:
        raise RuntimeError("Models not loaded — call load_models() first")

    # ── 1. int16 → float32 normalised to [-1.0, 1.0] ─────────
    waveform = pcm_int16.astype(np.float32) / 32768.0

    # ── 2. Ensure exactly 3 seconds ──────────────────────────
    if len(waveform) < EXPECTED_SAMPLES:
        pad = np.zeros(EXPECTED_SAMPLES - len(waveform), dtype=np.float32)
        waveform = np.concatenate([waveform, pad])
    elif len(waveform) > EXPECTED_SAMPLES:
        waveform = waveform[:EXPECTED_SAMPLES]

    # ── 3. YAMNet → frame embeddings → mean-pool ─────────────
    scores, embeddings, spectrogram = _yamnet_model(waveform)
    embedding = tf.reduce_mean(embeddings, axis=0).numpy()   # shape (1024,)

    # ── 4. TFLite classifier ─────────────────────────────────
    input_data = embedding.reshape(1, 1024).astype(np.float32)

    _tflite_interpreter.set_tensor(
        _tflite_input_details[0]["index"], input_data
    )
    _tflite_interpreter.invoke()

    output_data = _tflite_interpreter.get_tensor(
        _tflite_output_details[0]["index"]
    )                                              # shape (1, 6)

    probabilities = output_data[0]                 # shape (6,)
    top_idx = int(np.argmax(probabilities))
    confidence = float(probabilities[top_idx])

    return {
        "class": CLASS_LABELS[top_idx],
        "confidence": round(confidence, 4),
    }
