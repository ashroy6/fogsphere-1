import * as THREE from './three.module.js';
import { OrbitControls } from './OrbitControls.module.js';
import { GLTFLoader } from './GLTFLoader.module.js';
import { RoomEnvironment } from './RoomEnvironment.module.js';

const $ = (id)=>document.getElementById(id);
const wsStatus = $("wsStatus");
const evCountEl = $("evCount");
let eventCount = 0;

// ---- Renderer ----
const renderer = new THREE.WebGLRenderer({ antialias:true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

// ---- Scene & Camera ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf5f5f5);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 5000);
camera.position.set(12, 10, 16);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.zoomSpeed = 1.2;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

// ---- Lights ----
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

scene.add(new THREE.HemisphereLight(0xffffff, 0xe0e0e0, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(8, 12, 6);
scene.add(dir);

// Optional grid
const grid = new THREE.GridHelper(400, 80, 0xdddddd, 0xeeeeee);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

// ---- Heatmap setup ----
const heatColor = (s)=>{
  s = Math.max(0, Math.min(1, s));
  const a = new THREE.Color(0xf4c430), b = new THREE.Color(0xff8c00), c = new THREE.Color(0xff2d2d);
  return s < 0.5 ? a.clone().lerp(b, s/0.5) : b.clone().lerp(c, (s-0.5)/0.5);
};

// 🔧 markers: visible & uncullable
const markerGeo = new THREE.SphereGeometry(2,24,24);
const markerMat = new THREE.MeshBasicMaterial({
  color: 0xff0000,
  transparent: true,
  opacity: 0.75,
  depthTest: false,
  depthWrite: false
});
const markers = new THREE.InstancedMesh(markerGeo, markerMat, 2048);
markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
markers.frustumCulled = false;
scene.add(markers);

// 🔔 Global pulse controls (in-sync)
let PULSE_PERIOD_MS = 1200;   // smaller = faster pulse
let BASE_SCALE      = 0.7;    // minimum size
let AMP_SCALE       = 0.3;    // pulse amount

const floorSize = 200;
const heatmapCanvas = document.createElement('canvas');
heatmapCanvas.width = 512; heatmapCanvas.height = 512;
const heatCtx = heatmapCanvas.getContext('2d');
const heatTex = new THREE.CanvasTexture(heatmapCanvas);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(floorSize, floorSize),
  new THREE.MeshBasicMaterial({ map: heatTex, transparent:true, opacity:0.55 })
);
floor.rotation.x = -Math.PI/2;
floor.position.y = 0.01;
floor.visible = false;
scene.add(floor);
let heatmapEnabled = false;

// ---- State ----
let cams = [];                         // [{id,obj,world,heat,lastTs,lastSev,lastType}]
const camIndex = new Map();            // name -> index
let modelRoot = null;

let selectedIndex = -1;                // current selected camera index
const lastEventById = new Map();       // id -> {ts, severity}
// Per-camera event history (id -> [{ts, severity, payload:{type,...}}])
const eventHistory = new Map();

// --- X-ray state ---
let xrayOn = false;
const originalMats = new Map();
const edgeOverlays = new Map();

// --- Raycast targeting state ---
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
const lastHit = new THREE.Vector3(); // last valid hit point
let haveLastHit = false;

// ---- DOM refs for UI ----
const pulseSpeed = $("pulseSpeed");
const pulseSpeedVal = $("pulseSpeedVal");
const pulseSize = $("pulseSize");
const pulseSizeVal = $("pulseSizeVal");
const opacityInput = $("opacity");
const opacityVal = $("opacityVal");
const toggleHeatmap = $("toggleHeatmap");
const toggleXray = $("toggleXray");
const cameraListEl = $("cameraList");
const selNameEl = $("selName");
const selTimeEl = $("selTime");
const selSevEl = $("selSev");
const selTypeEl = $("selType"); // <-- added

// extra details
const dIdEl = $("d_id");
const dPosEl = $("d_pos");
const dDistEl = $("d_dist");
const eventListEl = $("eventList");

// ---- Type map (label + hue for bar color). Unknown types fall back cleanly.
const TYPE_META = {
  zone_intrusion:        { label: "Zone Intrusion",   hue: 10  },
  line_crossing:         { label: "Line Crossing",    hue: 20  },
  loitering:             { label: "Loitering",        hue: 35  },
  object_left:           { label: "Object Left",      hue: 290 },
  object_removed:        { label: "Object Removed",   hue: 280 },
  ppe_missing_hardhat:   { label: "No Hard Hat",      hue: 0   },
  ppe_missing_hivis:     { label: "No Hi-Vis",        hue: 330 },
  ppe_missing_glasses:   { label: "No Safety Glasses",hue: 300 },
  smoke:                 { label: "Smoke",            hue: 0   },
  fire:                  { label: "Fire",             hue: 0   },
  vehicle_speeding:      { label: "Speeding",         hue: 15  },
  wrong_way_vehicle:     { label: "Wrong Way",        hue: 25  },
  crowding:              { label: "Crowding",         hue: 40  },
  queue_overlimit:       { label: "Queue Overlimit",  hue: 45  },
  worker_down:           { label: "Worker Down",      hue: 0   },
};

// ---- Helpers ----
function metaOf(type){
  return TYPE_META[type] || { label: (type || "—"), hue: 210 };
}
function fmtXYZ(v){ return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`; }
function timeAgo(ts){
  const s = Math.max(0, Math.round((Date.now()-ts)/1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60), r = s%60;
  return `${m}m ${r}s`;
}
function pushEvent(id, sev, payload){
  const arr = eventHistory.get(id) || [];
  arr.push({ ts: Date.now(), severity: sev, payload });
  while (arr.length > 20) arr.shift();
  eventHistory.set(id, arr);
}
function renderEventList(id){
  const arr = eventHistory.get(id) || [];
  const rows = arr.slice(-10).reverse().map(e=>{
    const w = Math.round(e.severity * 100);
    const type = e.payload?.type;
    const meta = metaOf(type);
    return `<div class="ev">
      <span class="ts">${timeAgo(e.ts)} ago</span>
      <span class="type">${meta.label}</span>
      <div class="bar" style="width:${w}%; background: hsla(${meta.hue},70%,50%,.5)"></div>
      <span>${e.severity.toFixed(2)}</span>
    </div>`;
  }).join("");
  eventListEl.innerHTML = rows || `<div class="ev"><span class="ts">no events</span><span class="type">—</span><div></div><span>—</span></div>`;
}

// ---- Load model ----
fetch('config.json')
  .then(r => r.ok ? r.json() : { model:'test-1.glb', websocket_url:null, camera_prefix:'CCTV_', simulate_if_no_ws:true })
  .then(cfg => startWithConfig(cfg))
  .catch(()=> startWithConfig({ model:'test-1.glb', websocket_url:null, camera_prefix:'CCTV_', simulate_if_no_ws:true }));

function startWithConfig(cfg){
  const CAM_PREFIX = cfg.camera_prefix || 'CCTV_';
  const glbPath = cfg.model || 'test-1.glb';

  const loader = new GLTFLoader();
  loader.load(glbPath, (gltf)=>{
    modelRoot = gltf.scene;
    scene.add(modelRoot);

    // --- Frame model and set camera limits sanely ---
    const box = new THREE.Box3().setFromObject(modelRoot);
    const sizeVec = new THREE.Vector3();
    box.getSize(sizeVec);
    const radius = 0.5 * Math.max(sizeVec.x, sizeVec.y, sizeVec.z) || 1;
    const fovRad = camera.fov * Math.PI / 180;
    const idealDist = radius / Math.tan(fovRad * 0.5);
    const center = box.getCenter(new THREE.Vector3());
    modelRoot.position.sub(center);

    controls.target.set(0, 0, 0);
    camera.position.copy(new THREE.Vector3(1, 0.85, 1).normalize().multiplyScalar(idealDist * 1.6));

    camera.near = Math.max(0.01, idealDist / 1000);
    camera.far  = idealDist * 200;
    camera.updateProjectionMatrix();

    controls.minDistance = Math.max(0.05, idealDist * 0.02);
    controls.maxDistance = idealDist * 20;
    controls.update();

    modelRoot.updateMatrixWorld(true);

    // --- Camera detection and markers ---
    modelRoot.traverse((o)=>{
      if (o.name && o.name.startsWith(CAM_PREFIX)){
        const world = new THREE.Vector3();
        o.getWorldPosition(world);
        const i = cams.length;
        camIndex.set(o.name, i);
        cams.push({ id:o.name, obj:o, world, heat:0, lastTs:null, lastSev:null, lastType:null });

        const p = new THREE.Vector3(world.x, world.y + 0.2, world.z);
        const m = new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(1,1,1));
        markers.setMatrixAt(i, m);
      }
      if (o.isMesh && !originalMats.has(o.uuid)) {
        originalMats.set(o.uuid, o.material);
      }
    });

    markers.count = cams.length;
    markers.instanceMatrix.needsUpdate = true;
    const legend = document.getElementById('legend');
    legend && (legend.textContent = `Detected ${cams.length} cameras by prefix "${CAM_PREFIX}"`);

    buildCameraList();
    connectWS(cfg.websocket_url, cfg.simulate_if_no_ws !== false);
  }, undefined, (err)=>{
    console.error('GLB load error:', err);
  });
}

// ---- WebSocket ----
function connectWS(url, simulate){
  if (!url){ wsStatus && (wsStatus.textContent = 'disabled'); if (simulate) startSim(); return; }
  try {
    const ws = new WebSocket(url);
    ws.onopen = ()=> wsStatus && (wsStatus.textContent = 'connected');
    ws.onclose = ()=> { wsStatus && (wsStatus.textContent = 'closed'); if (simulate) startSim(); };
    ws.onerror = ()=> { wsStatus && (wsStatus.textContent = 'error'); if (simulate) startSim(); };
    ws.onmessage = (ev)=> { try { handleEvent(JSON.parse(ev.data)); } catch(_){} };
  } catch {
    wsStatus && (wsStatus.textContent = 'failed');
    if (simulate) startSim();
  }
}

// ---- Events ----
function handleEvent(evt){
  if (!evt || !evt.camera_id) return;
  const idx = camIndex.get(evt.camera_id);
  if (idx === undefined) return;
  const c = cams[idx];

  const s = Math.max(0, Math.min(1, Number(evt.severity ?? 1)));
  const typ = String(evt.type || "unknown");

  c.heat = c.heat * 0.9 + s * 0.8;
  c.lastTs = Date.now();
  c.lastSev = s;
  c.lastType = typ;
  lastEventById.set(c.id, { ts: c.lastTs, severity: s });

  // store in history with type
  pushEvent(c.id, s, { ...(evt.payload||{}), type: typ });

  if (selectedIndex === idx){
    refreshSelectedDetails();
    renderEventList(c.id);
  }
  bumpListRow(idx, s);
  if (heatmapEnabled) addHeatBlob(c.world.x, c.world.z, s);
  eventCount++; evCountEl && (evCountEl.textContent = String(eventCount));
}

let simTimer = null;
// Random demo types
const SIM_TYPES = [
  "zone_intrusion","line_crossing","loitering",
  "ppe_missing_hardhat","ppe_missing_hivis","ppe_missing_glasses",
  "smoke","fire","vehicle_speeding","wrong_way_vehicle",
  "crowding","queue_overlimit","worker_down"
];
function randType(){ return SIM_TYPES[(Math.random()*SIM_TYPES.length)|0]; }

function startSim(){
  if (simTimer || !cams.length) return;
  wsStatus && (wsStatus.textContent = 'simulating');
  simTimer = setInterval(()=>{
    const i = Math.floor(Math.random()*cams.length);
    const sev = 0.3 + Math.random()*0.7;
    handleEvent({ camera_id: cams[i].id, severity: sev, type: randType(), ts: Date.now() });
  }, 1500);
}

// ---- Markers update (global, in-sync pulse) ----
const workColor = new THREE.Color();
function updateMarkers(dt, now){
  const TWO_PI = Math.PI * 2;
  const pulse01 = 0.5 + 0.5 * Math.sin((now % PULSE_PERIOD_MS) * (TWO_PI / PULSE_PERIOD_MS));
  const sGlobal = BASE_SCALE + AMP_SCALE * pulse01;

  for (let i=0;i<cams.length;i++){
    const c = cams[i];
    c.heat = Math.max(0, c.heat - dt*0.75);

    workColor.copy(heatColor(c.heat));
    markers.setColorAt && markers.setColorAt(i, workColor);

    const selBoost = (i === selectedIndex) ? 1.2 : 1.0;
    const s = sGlobal * selBoost;
    const p = new THREE.Vector3(c.world.x, c.world.y + 0.2, c.world.z);
    const m = new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    markers.setMatrixAt(i, m);
  }
  markers.instanceColor && (markers.instanceColor.needsUpdate = true);
  markers.instanceMatrix.needsUpdate = true;
}

// ---- Heatmap ----
function addHeatBlob(x, z, s){
  const w = heatmapCanvas.width, h = heatmapCanvas.height;
  const u = (x + floorSize/2) / floorSize;
  const v = 1 - ((z + floorSize/2) / floorSize);
  const cx = Math.floor(u*w), cy = Math.floor(v*h);
  const rad = Math.floor(20 + 40*s);
  const c = heatColor(s);
  const g = heatCtx.createRadialGradient(cx, cy, 1, cx, cy, rad);
  g.addColorStop(0, '#'+c.getHexString());
  g.addColorStop(1, 'rgba(0,0,0,0)');
  heatCtx.globalCompositeOperation = 'lighter';
  heatCtx.fillStyle = g;
  heatCtx.beginPath(); heatCtx.arc(cx, cy, rad, 0, Math.PI*2); heatCtx.fill();
  heatTex.needsUpdate = true;
}
function decayHeatmap(){
  heatCtx.fillStyle = 'rgba(0,0,0,0.04)';
  heatCtx.globalCompositeOperation = 'destination-out';
  heatCtx.fillRect(0,0,heatmapCanvas.width, heatmapCanvas.height);
  heatTex.needsUpdate = true;
}

// ---- X-ray ----
function enableXRay(){
  if (xrayOn || !modelRoot) return;
  xrayOn = true;
  const XRAY_OPACITY = 0.15;
  const EDGE_COLOR = 0x000000;
  const EDGE_OPACITY = 0.35;
  modelRoot.traverse((o)=>{
    if (!o.isMesh || o === markers) return;
    const base = originalMats.get(o.uuid);
    const mat = base ? base.clone() : new THREE.MeshPhysicalMaterial({ color: 0xaaaaaa });
    mat.transparent = true;
    mat.opacity = XRAY_OPACITY;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    o.material = mat;
    if (!edgeOverlays.has(o.uuid)){
      const eg = new THREE.EdgesGeometry(o.geometry, 30);
      const lm = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent:true, opacity: EDGE_OPACITY });
      const lines = new THREE.LineSegments(eg, lm);
      lines.matrixAutoUpdate = false;
      o.updateWorldMatrix(true, false);
      lines.applyMatrix4(o.matrixWorld);
      lines.userData.follow = o;
      scene.add(lines);
      edgeOverlays.set(o.uuid, lines);
    }
  });
}
function disableXRay(){
  if (!xrayOn || !modelRoot) return;
  xrayOn = false;
  modelRoot.traverse((o)=>{
    if (!o.isMesh || o === markers) return;
    const orig = originalMats.get(o.uuid);
    if (orig) o.material = orig;
  });
  edgeOverlays.forEach((lines)=>{
    scene.remove(lines);
    if (lines.geometry) lines.geometry.dispose();
    if (lines.material) lines.material.dispose();
  });
  edgeOverlays.clear();
}
function updateEdgeFollows(){
  edgeOverlays.forEach((lines)=>{
    const follow = lines.userData.follow;
    if (follow) lines.matrix.copy(follow.matrixWorld);
  });
}

// ---- UI: list + selection ----
function buildCameraList(){
  cameraListEl.innerHTML = '';
  cams.forEach((c, i)=>{
    const li = document.createElement('li');
    li.className = 'cam-row';
    li.dataset.index = String(i);
    li.innerHTML = `<span>${c.id}</span><span class="sev" id="sev-${i}">—</span>`;
    li.addEventListener('click', ()=> selectCamera(i, true));
    cameraListEl.appendChild(li);
  });
  refreshListSelection();
}
function refreshListSelection(){
  const rows = cameraListEl.querySelectorAll('.cam-row');
  rows.forEach(r => r.classList.toggle('active', Number(r.dataset.index) === selectedIndex));
}
function bumpListRow(i, sev){
  const el = document.getElementById(`sev-${i}`);
  if (!el) return;
  el.textContent = sev.toFixed(2);
}
function refreshSelectedDetails(){
  if (selectedIndex < 0){
    selNameEl.textContent='—'; selTimeEl.textContent='—'; selSevEl.textContent='—';
    selTypeEl.textContent='—';
    dIdEl.textContent = '—'; dPosEl.textContent = '—'; dDistEl.textContent = '—';
    eventListEl.innerHTML = '';
    return;
  }
  const c = cams[selectedIndex];
  selNameEl.textContent = c.id;
  selSevEl.textContent = (c.lastSev==null?'—':c.lastSev.toFixed(2));
  selTypeEl.textContent = c.lastType ? metaOf(c.lastType).label : '—';
  if (c.lastTs){
    selTimeEl.textContent = `${timeAgo(c.lastTs)} ago`;
  } else {
    selTimeEl.textContent = '—';
  }
  dIdEl.textContent = c.id;
  dPosEl.textContent = fmtXYZ(c.world);
  dDistEl.textContent = `${camera.position.distanceTo(c.world).toFixed(2)} m`;
  renderEventList(c.id);
}
function selectCamera(i, frame){
  selectedIndex = i;
  refreshListSelection();
  refreshSelectedDetails();
  if (frame) frameSelected();
}
function frameSelected(){
  if (selectedIndex < 0) return;
  const t = cams[selectedIndex].world;
  controls.target.copy(t);
  const camDir = new THREE.Vector3(6, 4, 6);
  camera.position.lerp(new THREE.Vector3(t.x + camDir.x, t.y + camDir.y, t.z + camDir.z), 0.7);
  controls.update();
}

// ---- Click picking (markers) ----
renderer.domElement.addEventListener('pointerdown', (e)=>{
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, camera);
  // Pick instanced markers first
  const hits = raycaster.intersectObject(markers, true);
  if (hits.length && hits[0].instanceId != null){
    const idx = hits[0].instanceId;
    if (idx >=0 && idx < cams.length) selectCamera(idx, true);
    return;
  }
  // Fallback: pick scene meshes (rare)
  if (modelRoot){
    const hits2 = raycaster.intersectObject(modelRoot, true);
    if (hits2.length && hits2[0].object && hits2[0].object.name){
      const name = hits2[0].object.name;
      const idx = camIndex.get(name);
      if (idx !== undefined) selectCamera(idx, true);
    }
  }
});

// ---- Controls wiring ----
pulseSpeed.addEventListener('input', ()=>{
  PULSE_PERIOD_MS = Number(pulseSpeed.value);
  pulseSpeedVal.textContent = (PULSE_PERIOD_MS/1000).toFixed(2) + 's';
});
pulseSize.addEventListener('input', ()=>{
  AMP_SCALE = Number(pulseSize.value);
  pulseSizeVal.textContent = AMP_SCALE.toFixed(2);
});
opacityInput.addEventListener('input', ()=>{
  markerMat.opacity = Number(opacityInput.value);
  opacityVal.textContent = markerMat.opacity.toFixed(2);
});
toggleHeatmap.addEventListener('change', ()=>{
  heatmapEnabled = toggleHeatmap.checked;
  floor.visible = heatmapEnabled;
});
toggleXray.addEventListener('change', ()=>{
  if (toggleXray.checked) enableXRay(); else disableXRay();
});

// ---- Targeting helpers (fix zoom by re-targeting under cursor) ----
function updateMouseNDC(event){
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}
function raycastUnderMouse(){
  if (!modelRoot) return null;
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(modelRoot, true);
  return hits.length ? hits[0] : null;
}
renderer.domElement.addEventListener('pointermove', (e)=>{
  updateMouseNDC(e);
  const hit = raycastUnderMouse();
  if (hit){
    lastHit.copy(hit.point);
    haveLastHit = true;
  }
});
renderer.domElement.addEventListener('dblclick', (e)=>{
  updateMouseNDC(e);
  const hit = raycastUnderMouse();
  if (hit){
    controls.target.copy(hit.point);
    haveLastHit = true;
    lastHit.copy(hit.point);
    controls.update();
  }
});

// ---- Keyboard ----
window.addEventListener('keydown', (e)=>{
  if (e.key==='h' || e.key==='H'){ heatmapEnabled = !heatmapEnabled; floor.visible = heatmapEnabled; toggleHeatmap.checked = heatmapEnabled; }
  else if (e.key==='r' || e.key==='R'){ controls.reset(); }
  else if (e.key==='f' || e.key==='F'){
    if (selectedIndex >= 0) frameSelected();
    else if (cams.length){
      const t = cams.reduce((a,b)=> a.world.distanceTo(controls.target) < b.world.distanceTo(controls.target) ? a : b);
      const idx = camIndex.get(t.id) ?? cams.findIndex(x=>x.id===t.id);
      if (idx>=0) selectCamera(idx, true);
    }
  }
  else if (e.key==='x' || e.key==='X'){ toggleXray.checked = !toggleXray.checked; if (toggleXray.checked) enableXRay(); else disableXRay(); }
  else if (e.key==='e' || e.key==='E'){
    if (!modelRoot) return;
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = box.getSize(new THREE.Vector3()).length();
    camera.position.set(size*0.25, size*0.22, size*0.28);
    controls.target.set(0,0,0);
    controls.update();
  }
  else if (e.key==='c' || e.key==='C'){
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    controls.target.copy(camera.position).add(dir.multiplyScalar(0.1));
    camera.near = Math.max(0.01, camera.near);
    camera.updateProjectionMatrix();
    controls.minDistance = Math.max(0.05, controls.minDistance);
    controls.update();
  }
  else if (e.key==='z' || e.key==='Z'){
    if (haveLastHit){
      controls.target.copy(lastHit);
      controls.update();
    } else {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      controls.target.copy(camera.position).add(dir.multiplyScalar(5));
      controls.update();
    }
  }
});

// ---- Resize + animate ----
window.addEventListener('resize', ()=>{
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
let last = performance.now();
function animate(now){
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now-last)/1000); last = now;
  controls.update();
  updateMarkers(dt, now);
  if (heatmapEnabled) decayHeatmap();
  updateEdgeFollows();
  renderer.render(scene, camera);
}
animate(performance.now());
