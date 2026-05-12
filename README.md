# Distributed Edge-AI Acoustic Event Detection Network

A modern, responsive web monitoring platform for an intelligent acoustic event detection system using Edge AI and IoT nodes. This system is designed to detect dangerous environmental sounds—like glass breaking, explosions, and vehicle crashes—in real-time.

![AcousticEdge Dashboard Demo](https://via.placeholder.com/800x400.png?text=AcousticEdge+Dashboard) <!-- Replace with actual screenshot later -->

## 🌟 Project Overview
Our distributed edge AI acoustic monitoring system places intelligent sensing directly at the source. Instead of sending raw audio to the cloud, our ESP32 IoT nodes process and classify sounds locally. This ensures immediate alert generation, preserves privacy, and significantly reduces network load.

### Key Features
* **Real-Time Monitoring**: Instantaneous acoustic analysis for immediate threat detection.
* **Edge AI Inference**: TensorFlow Lite ML models running directly on ESP32 microcontrollers.
* **Adaptive Routing**: Self-healing network paths ensure alert delivery even if nodes drop.
* **Low Bandwidth**: Only event metadata is transmitted, preserving network bandwidth.
* **Live Web Dashboard**: Interactive, cyber-themed dashboard for live event tracking.

## 🏗️ System Architecture
1. **ESP32 Edge Node**: Captures environmental sounds using an I2S microphone.
2. **Audio Processing**: Filters noise and extracts spectrograms/MFCC features.
3. **ML Model Inference**: Runs highly-optimized TensorFlow Lite classification.
4. **Event Detection**: Classifies sound and calculates a confidence score.
5. **Adaptive Routing**: Sends data through a mesh network securely.
6. **Web Dashboard**: Displays the real-time alerts.

## 💻 Tech Stack
The frontend monitoring dashboard is built completely from scratch using vanilla technologies:
* **HTML5** (Multi-page architecture)
* **CSS3** (Glassmorphism, Neon glow effects, Responsive grids)
* **Vanilla JavaScript** (Canvas network animations, dynamic telemetry simulation)
* *No frameworks (React, Vue, Tailwind, etc.) used.*

## 🚀 How to Run Locally
Since this project uses pure HTML, CSS, and JS without any bundlers, running it is incredibly simple:

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/Distributed-Edge-Ai-Event-Detector.git
   ```
2. Navigate into the directory:
   ```bash
   cd Distributed-Edge-Ai-Event-Detector
   ```
3. Open `index.html` directly in your favorite web browser by double-clicking it.
   *Alternatively, use [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) in VS Code or `npx serve .` for a better development experience.*

## 📂 File Structure
* `index.html` - Home page and Hero section
* `about.html` - Project context and Core features
* `architecture.html` - Visual flow of the system
* `monitoring.html` - Live simulated data dashboard
* `topology.html` - Network mesh visualization
* `style.css` - Custom styling and variables
* `script.js` - Background animations and live logic
* `README.md` - Project documentation

---
*Created as a demonstration prototype for distributed IoT systems.*
