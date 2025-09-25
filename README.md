# Fogsphere 3D Heatmap Viewer

This is a tiny, production‑friendly viewer that loads your SketchUp factory model as GLB, auto‑detects CCTV nodes by name (e.g., `CCTV_01`…`CCTV_50`), and renders live heat pulses when events arrive via WebSocket. If no WebSocket is found, it simulates events so you can demo instantly.

## Files
- `index.html` — web page that pulls three.js from CDN
- `app.js` — viewer logic (orbit controls, GLB load, markers, heatmap)
- `config.json` — path to your model and WS URL
- `test-1.glb` — place your GLB here

## Quick Start
1. Copy your GLB to this folder and name it `test-1.glb` (or update `config.json`).
2. Start a static server (one-liner):
   - Python 3: `python -m http.server 8000`
3. Open: `http://localhost:8000`

You can rotate, zoom, and pan with the mouse (OrbitControls). The app will try to connect to `ws://localhost:9001`. If unavailable, it switches to a **simulator** that sends random events to your cameras.

## Live Events
Expected JSON (WebSocket message):
```json
{ "camera_id": "CCTV_09", "severity": 0.8, "type": "NoHelmet", "ts": "2025-09-25T10:11:22Z" }
```
- `camera_id` must match an object name inside the GLB.
- `severity` ∈ [0..1] maps to color (amber-orange-red) and pulse size.

## Controls
- **F** — frame nearest camera
- **H** — toggle floor heatmap overlay
- **R** — reset orbit view
- **Click** a camera marker — focus the orbit target

## Notes
- Uses **InstancedMesh** for markers (fast even with hundreds of cameras).
- Floor heatmap is a simple render‑to‑texture with gaussian blobs and decay.
- You can point the viewer to your fog broker gateway by editing `config.json`.

## Security
If you connect to a real broker, ensure you’re using a WS gateway with auth (per‑viewer credentials) and that you don’t expose raw internal topics to the public internet.
