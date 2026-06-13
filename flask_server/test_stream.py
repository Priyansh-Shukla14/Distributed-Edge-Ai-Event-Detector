import socketio
import wave
import time
import base64
import os
import numpy as np

# Classes: 0=background, 1=dog, 2=glass_break, 3=gunshots, 4=scream, 5=siren
# Place a 16kHz mono WAV file in test_audio/ to test with real audio
# Recommended test files: glass_break.wav, gunshot.wav, scream.wav

# Configuration
SERVER_URL = "http://localhost:5000"
AUDIO_FILE = "test_audio/test_sound.wav"
SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2 # 16-bit
SAMPLES_PER_CHUNK = 16000 # 1 second
BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * BYTES_PER_SAMPLE

# Create standard Socket.IO client
sio = socketio.Client()

@sio.event
def connect():
    print("[Socket.IO] Connected to server.")

@sio.event
def disconnect():
    print("[Socket.IO] Disconnected from server.")

@sio.on('audio_stream')
def on_audio_stream(data):
    print(f"[Socket.IO] Ack received: {data}")


def load_audio_data(filepath):
    """
    Loads raw PCM bytes from a WAV file (strips header).
    If file doesn't exist, generates 3 seconds of random noise.
    """
    if os.path.exists(filepath):
        print(f"Loading real audio from {filepath}...")
        try:
            with wave.open(filepath, 'rb') as wf:
                if wf.getnchannels() != 1:
                    print("Warning: Audio is not mono.")
                if wf.getframerate() != SAMPLE_RATE:
                    print(f"Warning: Audio sample rate is {wf.getframerate()}, expected {SAMPLE_RATE}.")
                if wf.getsampwidth() != BYTES_PER_SAMPLE:
                    print(f"Warning: Audio sample width is {wf.getsampwidth()}, expected {BYTES_PER_SAMPLE}.")
                
                # Read all frames into raw bytes (header is automatically skipped by wave module)
                raw_bytes = wf.readframes(wf.getnframes())
                return raw_bytes
        except Exception as e:
            print(f"Error reading WAV file: {e}")
            print("Falling back to random noise.")
    else:
        print(f"File {filepath} not found. Generating 3s random noise...")
        
    # Fallback: 3 seconds of random int16 noise
    num_samples = 3 * SAMPLE_RATE
    # Generate noise centered around 0
    noise = np.random.randint(-10000, 10000, num_samples, dtype=np.int16)
    return noise.tobytes()

def stream_audio(raw_bytes, node_id):
    """
    Splits raw PCM bytes into 1-second chunks and emits them.
    """
    num_chunks = len(raw_bytes) // BYTES_PER_CHUNK
    # If the file is smaller than 1 chunk, pad or just send what we have
    if num_chunks == 0 and len(raw_bytes) > 0:
        chunks = [raw_bytes]
    else:
        chunks = [raw_bytes[i*BYTES_PER_CHUNK : (i+1)*BYTES_PER_CHUNK] for i in range(num_chunks)]
        
        # Add remaining bytes if any
        remainder = len(raw_bytes) % BYTES_PER_CHUNK
        if remainder > 0:
            chunks.append(raw_bytes[num_chunks*BYTES_PER_CHUNK:])
            
    print(f"\n--- Streaming as {node_id} ({len(chunks)} chunks) ---")
    
    for i, chunk in enumerate(chunks):
        b64_encoded = base64.b64encode(chunk).decode('utf-8')
        payload = {
            "node_id": node_id,
            "audio": b64_encoded
        }
        print(f"[{node_id}] Emitting chunk {i+1}/{len(chunks)} ({len(chunk)} bytes)...")
        sio.emit("audio_stream", payload)
        time.sleep(1) # Simulate real-time streaming (1s per chunk)

def main():
    try:
        sio.connect(SERVER_URL)
    except socketio.exceptions.ConnectionError as err:
        print(f"Failed to connect to {SERVER_URL}: {err}")
        return

    # Load audio data (real or noise)
    pcm_bytes = load_audio_data(AUDIO_FILE)
    
    # 1. Stream as node_1
    stream_audio(pcm_bytes, "node_1")
    
    # Wait to simulate offset
    print("\nWaiting 2 seconds before streaming node_2...")
    time.sleep(2)
    
    # 2. Stream as node_2
    stream_audio(pcm_bytes, "node_2")
    
    # Keep alive briefly to receive final acks
    time.sleep(1)
    sio.disconnect()
    print("Simulation complete.")

if __name__ == '__main__':
    main()
