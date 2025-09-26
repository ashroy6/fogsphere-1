# Fogsphere Demo

This is a lightweight 3D demo built with **Three.js** to showcase how a factory floor or site can be visualized, with cameras and events overlaid on top of the model. It’s designed as a proof-of-concept for edge/fog monitoring — everything runs locally in the browser, no cloud services needed.

---

## Features

* Loads a SketchUp/Blender/.GLB model in the browser
* Supports multiple camera nodes (CCTV_A1…A7)
* Optional event simulation feed (WebSocket)
* Runs with any static web server — no heavy backend required

---

## Getting Started

Clone the repo:

```bash
git clone https://github.com/ashroy6/fogsphere-1.git
cd fogsphere-1
```

You **must** serve the folder over HTTP (ES modules don’t work from `file://`).
Pick one of these quick methods:

### Option A — Python 3 (no extra installs)

```bash
python3 -m http.server 8080
# Windows PowerShell: py -m http.server 8080
```

Then open: [http://127.0.0.1:8080/](http://127.0.0.1:8080/)
http://localhost:8080/

---

### Option B — Node.js

```bash
npm i -g http-server
http-server -p 8080
```

Open: [http://127.0.0.1:8080/](http://127.0.0.1:8080/)

---

### Option C — VS Code

* Install the **Live Server** extension
* Open the folder in VS Code
* Right-click `index.html` → **Open with Live Server**

---

## Requirements

* Modern browser (Chrome, Edge, or Firefox) with WebGL2 enabled
* GPU drivers / hardware acceleration enabled
* No other special dependencies

---

## Notes

* If you see a **WebSocket error** in the browser console, that’s just the optional event simulator. The 3D scene will still load fine.
* If port **8080** is already taken, switch to another (e.g., 8081) and change the URL.
* Model file `test-1.glb` must remain in the repo’s root folder.

---

## Next Steps

* Add real event feeds from cameras or IoT devices via MQTT/WS
* Extend UI for alerts (halos, cones, heatmaps)
* Deploy behind Nginx/Apache for team-wide access

---

👉 This repo is for demo purposes only. Everything runs locally and no data leaves your machine.

---

