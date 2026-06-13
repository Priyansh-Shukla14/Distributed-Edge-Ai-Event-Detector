# Distributed Edge-AI Acoustic Event Detection Network

A complete, end-to-end distributed acoustic event detection system featuring ESP32 edge nodes, a central ML inference server, a Node.js persistence backend, and a real-time cyber-neon monitoring dashboard.

## 🌟 Project Overview

This project implements a scalable architecture where low-cost edge microcontrollers capture and stream raw environmental audio to a central inference server. The server runs a two-stage deep learning pipeline (YAMNet embeddings + custom TFLite classifier) to identify sounds like breaking glass, gunshots, or sirens in real-time. High-confidence detections are persisted to a cloud database, while all live telemetry streams directly to a browser-based dashboard.

### Key Features
* **MicroPython Edge Streaming**: Custom memory-efficient Socket.IO WebSocket implementation running on ESP32 hardware to stream base64-encoded PCM audio.
* **Two-Stage ML Pipeline**: Utilises Google's YAMNet model for robust feature extraction and a custom lightweight TFLite model for 6-class event classification.
* **Dual-Channel Live Dashboard**: The vanilla JS frontend receives persisted, high-priority events via Supabase Realtime and a raw telemetry feed via direct Socket.IO connection.
* **Cloud Persistence**: Uses Supabase (PostgreSQL) for storing historical events and tracking the live heartbeat/health of all connected edge nodes.
* **Cyber-Neon UI**: A completely custom, framework-free glassmorphism interface with CSS-only animations for audio waveforms and dynamic network topology.

---

## 🏗️ System Architecture

The architecture is broken down into four primary components:

### 1. Edge Nodes (ESP32 / MicroPython)
* **Location:** `node1/` & `node2/`
* **Hardware:** ESP32 with INMP441 I2S microphone.
* **Role:** Captures 16kHz mono audio. It splits the audio into 1-second chunks, base64 encodes the PCM bytes, and streams it to the Flask server via a custom, low-RAM WebSocket Socket.IO implementation.

### 2. Inference Server (Flask)
* **Location:** `flask_server/`
* **Role:** The brain of the operation. Uses Flask-SocketIO to accept concurrent streams from multiple nodes. Maintains a 3-second rolling circular buffer for each node.
* **Machine Learning:** 
  - Stage 1: Google YAMNet extracts a 1024-dimensional acoustic embedding from the audio.
  - Stage 2: A dense TFLite classifier assigns probabilities to 6 classes (Background, Dog, Glass Break, Gunshots, Scream, Siren).
* **Routing:** Emits a `detection_event` with alert priorities back to any connected Socket.IO clients.

### 3. Backend Service (Node.js/Express)
* **Location:** `backend/`
* **Role:** Bridges the live inference feed with persistent cloud storage.
* **Functions:** Uses a `flaskBridgeService` to listen for Flask events. If an event has a high confidence score and isn't just background noise (`stored=true`), it securely inserts the event into Supabase and upserts the node's online status. Also exposes a REST API for historical data.

### 4. Live Dashboard (Vanilla Web)
* **Location:** Root directory (`index.html`, `monitoring.html`, etc.)
* **Role:** Visualises the entire network in real time.
* **Features:** Node cards with flashing alerts and animated streaming waveforms. A live event feed table distinguishing between stored DB events and transient ambient noise. Connects to both the Node.js API (REST + Supabase Realtime) and the Flask server (Socket.IO).

---

## 🚀 How to Run Locally

### Prerequisites
* Python 3.10+
* Node.js v18+
* A [Supabase](https://supabase.com) project

### 1. Setup the Database (Supabase)
Run the SQL queries found in `backend/supabase/migrations/001_init.sql` in your Supabase SQL Editor to create the `events` and `node_status` tables, along with realtime configuration.

### 2. Start the Backend (Node.js)
```bash
cd backend
npm install
# Copy .env.example to .env and fill in your Supabase credentials
cp .env.example .env
npm run start
```
*The Express server will start on port 3000.*

### 3. Start the Inference Server (Flask)
```bash
cd flask_server
python -m venv .venv
# Activate venv (Windows: .venv\Scripts\activate | Mac/Linux: source .venv/bin/activate)
pip install -r requirements.txt
# Copy .env.example to .env and fill in your Supabase credentials
cp .env.example .env
python app.py
```
*The Flask server will start on port 5000 and load the YAMNet model.*

### 4. Serve the Dashboard
In a new terminal at the project root, start a simple HTTP server:
```bash
python -m http.server 8080
```
Open `http://localhost:8080` in your browser. (Note: You must set up `config.js` based on `config.example.js` first).

### 5. Run the Hardware Simulation
If you don't have ESP32 hardware, you can simulate the audio streams:
```bash
cd flask_server
# With the venv activated
python test_stream.py
```
*This will stream test chunks to the server, and you will see the dashboard light up with detections!*

---

## 📂 Repository Structure

* `backend/` - Node.js Express server, Supabase config, and Bridge services.
* `flask_server/` - ML Inference server, rolling audio buffers, and simulation scripts.
* `node1/` & `node2/` - MicroPython firmware for the ESP32 hardware nodes.
* `*.html` / `style.css` / `script.js` - The vanilla frontend dashboard.
