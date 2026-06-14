"""Quick test: send fake audio to Flask server to verify the pipeline works."""
import socketio
import base64
import numpy as np

sio = socketio.Client()

@sio.event
def connect():
    print("✔ Connected to Flask server!")
    
    # Generate 1 second of fake audio (16kHz, 16-bit, mono)
    fake_audio = np.random.randint(-1000, 1000, 16000, dtype=np.int16)
    audio_b64 = base64.b64encode(fake_audio.tobytes()).decode("utf-8")
    
    print(f"Sending fake audio: {len(fake_audio)} samples, {len(audio_b64)} base64 chars")
    result = sio.emit("audio_stream", {
        "node_id": "node_1",
        "audio": audio_b64
    }, callback=on_ack)

def on_ack(data):
    print(f"Server acknowledged: {data}")

@sio.on("detection_event")
def on_detection(data):
    print(f"🎯 Detection: {data}")

@sio.event
def disconnect():
    print("Disconnected")

print("Connecting to http://localhost:5000 ...")
sio.connect("http://localhost:5000", transports=["websocket"])
sio.sleep(5)

# Send 2 more seconds to fill the buffer (need 3 total)
for i in range(2):
    fake_audio = np.random.randint(-1000, 1000, 16000, dtype=np.int16)
    audio_b64 = base64.b64encode(fake_audio.tobytes()).decode("utf-8")
    sio.emit("audio_stream", {"node_id": "node_1", "audio": audio_b64})
    print(f"Sent chunk {i+2}/3")
    sio.sleep(1)

print("Waiting for detection result...")
sio.sleep(10)
sio.disconnect()
