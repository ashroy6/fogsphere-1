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
scene.background = new THREE.Color(0xf5f5f5); // SketchUp-like background

const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 5000);
camera.position.set(12, 10, 16);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.zoomSpeed = 1.6;  // stronger wheel zoom
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

const markerGeo = new THREE.SphereGeometry(0.15,16,16);
const markerMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
const markers = new THREE.InstancedMesh(markerGeo, markerMat, 2048);
markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(markers);

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
let cams = [];
const camIndex = new Map();
let modelRoot = null;

// --- X-ray state ---
let xrayOn = false;
const originalMats = new Map();
const edgeOverlays = new Map();

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

    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    modelRoot.position.sub(center);
    controls.target.set(0,0,0);
    camera.position.set(size*0.25, size*0.22, size*0.28);

    // ---- UNCAP close zoom + huge range ----
    controls.minDistance = 0;                               // remove close-in floor
    controls.maxDistance = Math.max(2000, size * 100);      // allow very far pull-out
    camera.near = 1e-6;                                     // extremely tiny near plane
    camera.far  = Math.max(200000, size * 1000);            // very deep far plane
    camera.updateProjectionMatrix();
    controls.update();

    modelRoot.traverse((o)=>{
      if (!o.isMesh) return;
      if (o.name && o.name.startsWith(CAM_PREFIX)){
        const world = new THREE.Vector3();
        o.getWorldPosition(world);
        const i = cams.length;
        camIndex.set(o.name, i);
        cams.push({ id:o.name, obj:o, world, heat:0, markerIndex:i });
        const m = new THREE.Matrix4().setPosition(world);
        markers.setMatrixAt(i, m);
      }
      if (!originalMats.has(o.uuid)) originalMats.set(o.uuid, o.material);
    });
    markers.count = cams.length;
    markers.instanceMatrix.needsUpdate = true;
    document.getElementById('legend').textContent = `Detected ${cams.length} cameras by prefix "${CAM_PREFIX}"`;

    connectWS(cfg.websocket_url, cfg.simulate_if_no_ws !== false);
  }, undefined, (err)=>{
    console.error('GLB load error:', err);
  });
}

// ---- WebSocket ----
function connectWS(url, simulate){
  if (!url){ wsStatus.textContent = 'disabled'; if (simulate) startSim(); return; }
  try {
    const ws = new WebSocket(url);
    ws.onopen = ()=> wsStatus.textContent = 'connected';
    ws.onclose = ()=> { wsStatus.textContent = 'closed'; if (simulate) startSim(); };
    ws.onerror = ()=> { wsStatus.textContent = 'error'; if (simulate) startSim(); };
    ws.onmessage = (ev)=> { try { handleEvent(JSON.parse(ev.data)); } catch(_){} };
  } catch {
    wsStatus.textContent = 'failed';
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
  c.heat = c.heat * 0.9 + s * 0.8;
  if (heatmapEnabled) addHeatBlob(c.world.x, c.world.z, s);
  eventCount++; evCountEl.textContent = String(eventCount);
}

let simTimer = null;
function startSim(){
  if (simTimer || !cams.length) return;
  wsStatus.textContent = 'simulating';
  simTimer = setInterval(()=>{
    const i = Math.floor(Math.random()*cams.length);
    const sev = 0.3 + Math.random()*0.7;
    handleEvent({ camera_id: cams[i].id, severity: sev });
  }, 1500);
}

// ---- Markers update ----
const workColor = new THREE.Color();
function updateMarkers(dt){
  for (let i=0;i<cams.length;i++){
    const c = cams[i];
    c.heat = Math.max(0, c.heat - dt*0.12);
    workColor.copy(heatColor(c.heat));
    markers.setColorAt && markers.setColorAt(i, workColor);
    const s = 0.9 + 0.3*c.heat;
    const m = new THREE.Matrix4().compose(c.world, new THREE.Quaternion(), new THREE.Vector3(s,s,s));
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
  const XRAY_OPACITY = 0.25;
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

// ---- Keyboard ----
window.addEventListener('keydown', (e)=>{
  if (e.key==='h' || e.key==='H'){ heatmapEnabled = !heatmapEnabled; floor.visible = heatmapEnabled; }
  else if (e.key==='r' || e.key==='R'){ controls.reset(); }
  else if (e.key==='f' || e.key==='F'){
    if (!cams.length) return;
    const t = cams.reduce((a,b)=> a.world.distanceTo(controls.target) < b.world.distanceTo(controls.target) ? a : b);
    controls.target.copy(t.world);
    camera.position.lerp(new THREE.Vector3(t.world.x+6, t.world.y+4, t.world.z+6), 0.7);
  }
  else if (e.key==='x' || e.key==='X'){ if (xrayOn) disableXRay(); else enableXRay(); }
  else if (e.key==='e' || e.key==='E'){ // Zoom extents
    if (!modelRoot) return;
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = box.getSize(new THREE.Vector3()).length();
    camera.position.set(size*0.25, size*0.22, size*0.28);
    controls.target.set(0,0,0);
    controls.update();
  }
  else if (e.key==='c' || e.key==='C'){ // Close-focus: set target just ahead of camera
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    controls.target.copy(camera.position).add(dir.multiplyScalar(0.05)); // ~5 cm in front
    camera.near = 1e-6; camera.updateProjectionMatrix();
    controls.minDistance = 0; controls.update();
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
  updateMarkers(dt);
  if (heatmapEnabled) decayHeatmap();
  updateEdgeFollows();
  renderer.render(scene, camera);
}
animate(performance.now());
