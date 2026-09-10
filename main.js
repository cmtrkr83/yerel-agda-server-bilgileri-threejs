import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------- STATE (sadece gerçek veri, simülasyon yok) ----------
let targetIp = '192.168.41.252';
let autoMode = true;
let lastDevTypes = {}; // ip -> wifi|lan|infra (3D iplik renkleri için)
let lastBootTs = null; // server2 son açılış (ajan)
let prevFlows = new Set(); // bağlanan/ayrılan takibi için
const PORTNAME = { 22: 'SSH/SFTP • dosya', 3000: 'APP', 80: 'HTTP', 443: 'HTTPS', 445: 'SMB • dosya', 139: 'SMB', 21: 'FTP', 3389: 'RDP' };
let history = []; // {t, ping, ok}
let totalChecks = 0, okChecks = 0;
let sessionStart = Date.now();
let serverOnline = null;
let lastPing = null;

// ---------- LOG ----------
const logEl = document.getElementById('log');
function log(msg, cls = 'info') {
  const time = new Date().toLocaleTimeString('tr-TR');
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">[${time}]</span><span class="${cls}">${msg}</span>`;
  logEl.prepend(div);
  while (logEl.children.length > 25) logEl.lastChild.remove();
}

// ---------- CLOCK ----------
setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('tr-TR');
}, 1000);

// =====================================================
// THREE.JS SCENE
// =====================================================
const wrap = document.getElementById('viewport-wrap');
document.getElementById('scene').style.display = 'none';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
wrap.appendChild(renderer.domElement);
renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05070f, 0.028);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
camera.position.set(7.5, 4.5, 9);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.9;
controls.maxDistance = 22; controls.minDistance = 4;
controls.maxPolarAngle = Math.PI / 2 + 0.15;

scene.add(new THREE.AmbientLight(0x8899ff, 0.5));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(6, 10, 6); scene.add(key);
const rim = new THREE.DirectionalLight(0x00e5ff, 1.1); rim.position.set(-7, 4, -6); scene.add(rim);
const under = new THREE.PointLight(0x1a2aff, 8, 20); under.position.set(0, 0.3, 0); scene.add(under);
const statusLight = new THREE.PointLight(0xffb224, 6, 12); statusLight.position.set(0, 4.6, 0); scene.add(statusLight);

// zemin
const grid = new THREE.GridHelper(30, 30, 0x1a2aff, 0x0d1530);
grid.position.y = -1.6; scene.add(grid);
const disc = new THREE.Mesh(
  new THREE.CircleGeometry(5.2, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a1230, transparent: true, opacity: 0.85 })
);
disc.rotation.x = -Math.PI / 2; disc.position.y = -1.59; scene.add(disc);
const ringGlow = new THREE.Mesh(
  new THREE.RingGeometry(5.2, 5.35, 80),
  new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
);
ringGlow.rotation.x = -Math.PI / 2; ringGlow.position.y = -1.58; scene.add(ringGlow);

// --- server kasası ---
const rack = new THREE.Group(); scene.add(rack);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x11182e, metalness: 0.85, roughness: 0.32 });
const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4.4, 2.2), bodyMat);
rack.add(body);
const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.55 }));
rack.add(edges);

// ön panel şeritleri (slotlar)
const slotLights = [];
for (let i = 0; i < 6; i++) {
  const slot = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.28, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x05070f, emissive: 0x00e5ff, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.4 }));
  slot.position.set(0, 1.55 - i * 0.55, 1.12);
  rack.add(slot); slotLights.push(slot);
}
// güç LED'i
const powerLed = new THREE.Mesh(new THREE.CircleGeometry(0.09, 24),
  new THREE.MeshBasicMaterial({ color: 0xffb224 }));
powerLed.position.set(-1.3, -1.75, 1.12); rack.add(powerLed);

// üst halka (durum halkası)
const statusRing = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.07, 20, 80),
  new THREE.MeshBasicMaterial({ color: 0xffb224 }));
statusRing.rotation.x = Math.PI / 2; statusRing.position.y = 2.75; scene.add(statusRing);

// IP text sprite
function makeLabel(text) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(2,6,20,.72)'; x.fillRect(0, 0, 1024, 160);
  x.strokeStyle = '#00e5ff'; x.lineWidth = 4; x.strokeRect(4, 4, 1016, 152);
  x.font = 'bold 72px monospace'; x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 512, 84);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
  s.scale.set(5.4, 0.85, 1); return s;
}
let ipSprite = makeLabel(targetIp);
ipSprite.position.y = 4.1; scene.add(ipSprite);

// parçacıklar (ağ trafiği)
const P = 350;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(P * 3), pSpd = new Float32Array(P);
for (let i = 0; i < P; i++) {
  const r = 4 + Math.random() * 9, a = Math.random() * Math.PI * 2;
  pPos[i * 3] = Math.cos(a) * r; pPos[i * 3 + 1] = -1.5 + Math.random() * 7; pPos[i * 3 + 2] = Math.sin(a) * r;
  pSpd[i] = 0.4 + Math.random() * 1.6;
}
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0x00e5ff, size: 0.07, transparent: true, opacity: 0.85 }));
scene.add(particles);

// yörünge çizgileri
for (let k = 0; k < 3; k++) {
  const orb = new THREE.Mesh(new THREE.TorusGeometry(3.4 + k * 1.1, 0.012, 8, 120),
    new THREE.MeshBasicMaterial({ color: 0x2244ff, transparent: true, opacity: 0.4 }));
  orb.rotation.x = Math.PI / 2 - 0.12 * k; orb.position.y = 0.4 + k * 0.5; scene.add(orb);
}

// --- canlı bağlantı iplikleri (gerçek bağlı cihaz sayısı kadar) ---
const MAX_CONN = 24;
const TYPE_COLOR = { wifi: 0x4da6ff, lan: 0xffb224, infra: 0xff4d6d, unknown: 0x00e5ff };
const connGroup = new THREE.Group(); scene.add(connGroup);
const conns = [];
function makeThread() {
  const g = new THREE.Group();
  const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 3.5;
  const start = new THREE.Vector3(Math.cos(a) * r, -1 + Math.random() * 6.5, Math.sin(a) * r);
  const end = new THREE.Vector3((Math.random() - 0.5) * 2.4, -1.5 + Math.random() * 3.6, 1.0);
  const mid = start.clone().lerp(end, 0.5); mid.y += 1 + Math.random() * 1.5;
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
    new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0 })
  );
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 })
  );
  g.add(line, dot); g.visible = false; connGroup.add(g);
  return { g, line, dot, curve, t: Math.random(), speed: 0.25 + Math.random() * 0.5, targetOp: 0 };
}
for (let i = 0; i < MAX_CONN; i++) conns.push(makeThread());
function setConnections(list) {
  const n = Math.min(list.length, MAX_CONN);
  conns.forEach((c, i) => {
    if (i < n) {
      const col = TYPE_COLOR[list[i].type] ?? 0x00e5ff;
      c.g.visible = true; c.targetOp = 0.55;
      c.line.material.color.setHex(col); c.dot.material.color.setHex(col);
    } else c.targetOp = 0;
  });
}

function resize() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap); resize();

// durum rengi
function set3DStatus(mode) {
  const color = mode === 'online' ? 0x22ff9a : mode === 'offline' ? 0xff4d6d : 0xffb224;
  statusRing.material.color.setHex(color);
  statusLight.color.setHex(color);
  powerLed.material.color.setHex(color);
  particles.material.color.setHex(mode === 'offline' ? 0xff4d6d : 0x00e5ff);
  slotLights.forEach((s, i) => s.material.emissive.setHex(mode === 'offline' ? 0xff4d6d : i % 2 ? 0x1a2aff : 0x00e5ff));
}

// animasyon
let frames = 0, lastFpsT = performance.now();
const fpsEl = document.getElementById('fps');
const clock3 = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock3.getElapsedTime();
  rack.rotation.y = Math.sin(t * 0.25) * 0.25;
  statusRing.rotation.z = t * (serverOnline === false ? 0.3 : 1.6);
  statusRing.position.y = 2.75 + Math.sin(t * 2) * 0.06;
  const blink = (Math.sin(t * (serverOnline === false ? 8 : 3)) + 1) / 2;
  powerLed.scale.setScalar(1 + blink * 0.9);
  slotLights.forEach((s, i) => { s.material.emissiveIntensity = 0.4 + ((Math.sin(t * 2 + i * 1.3) + 1) / 2) * 1.1; });
  const arr = pGeo.attributes.position.array;
  for (let i = 0; i < P; i++) {
    arr[i * 3 + 1] += pSpd[i] * 0.02;
    arr[i * 3] += Math.sin(t + i) * 0.002;
    if (arr[i * 3 + 1] > 6) arr[i * 3 + 1] = -1.5;
  }
  pGeo.attributes.position.needsUpdate = true;
  ringGlow.material.opacity = 0.45 + Math.sin(t * 2.4) * 0.25;
  // bağlantı iplikleri: opaklık geçişi + server'a akan ışık noktaları
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - (animate._last ?? nowMs)) / 1000);
  animate._last = nowMs;
  for (const c of conns) {
    if (!c.g.visible) continue;
    const m = c.line.material, target = c.targetOp;
    m.opacity += (target - m.opacity) * Math.min(1, dt * 3);
    if (target === 0 && m.opacity < 0.02) { c.g.visible = false; continue; }
    c.t = (c.t + c.speed * dt) % 1;
    c.dot.position.copy(c.curve.getPoint(c.t));
    c.dot.material.opacity = m.opacity + 0.35;
    const s = 1 + Math.sin(t * 6 + c.t * 20) * 0.25;
    c.dot.scale.setScalar(s);
  }
  controls.update();
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - lastFpsT > 1000) { fpsEl.textContent = `${frames} fps`; frames = 0; lastFpsT = now; }
}
animate();

// fare ile bakış
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width - 0.5), ny = ((e.clientY - r.top) / r.height - 0.5);
  camera.position.x += (7.5 + nx * 2 - camera.position.x) * 0.03;
  camera.position.y += (4.5 - ny * 2 - camera.position.y) * 0.03;
});

// =====================================================
// MONITORING
// =====================================================
const pill = document.getElementById('status-pill');

async function checkBackend(host) {
  try {
    const r = await fetch(`/api/status?host=${encodeURIComponent(host)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function setPill(mode, text) {
  pill.className = 'pill ' + mode;
  pill.textContent = text;
  document.getElementById('live-text').textContent = mode === 'online' ? 'CANLI' : mode === 'offline' ? 'KESİNTİ' : 'KONTROL';
}

async function runCheck(manual = false) {
  if (!autoMode && !manual) return;
  setPill('checking', 'KONTROL EDİLİYOR…');
  set3DStatus('checking');

  const backend = await checkBackend(targetIp);

  if (!backend || !backend.backend) {
    document.getElementById('backend-status').textContent = 'backend: BAĞLANTI YOK — node server.js çalıştırın';
    setPill('offline', '● BACKEND YOK — VERİ ALINAMIYOR');
    set3DStatus('offline');
    renderPortsUnknown();
    setMetersUnknown();
    log('Backend erişilemiyor. Sahte veri gösterilmiyor — `node server.js` çalıştırın.', 'err');
    return;
  }

  document.getElementById('backend-status').textContent = 'backend: bağlı ✓ gerçek ölçüm';
  const ok = backend.online, ping = backend.pingMs;
  renderPorts(backend.ports || []);
  if (backend.system) { updateMeters(backend.system); setSysTag(backend.systemSrc === 'agent' ? 'live-agent' : 'live'); }
  else { setMetersUnknown(); setSysTag(backend.sshConfigured ? 'retry' : 'noconfig'); }

  totalChecks++; if (ok) okChecks++;
  serverOnline = ok; lastPing = ping;
  history.push({ t: Date.now(), ping: ping ?? -1, ok });
  if (history.length > 60) history.shift();

  setPill(ok ? 'online' : 'offline', ok ? `● ÇEVRİMİÇİ — ${ping} ms` : '● ÇEVRİMDIŞI — ERİŞİLEMİYOR');
  set3DStatus(ok ? 'online' : 'offline');

  document.getElementById('stat-ping').textContent = ok ? `${ping} ms` : 'zaman aşımı';
  document.getElementById('bar-ping').style.width = ok ? Math.min(100, ping / 1.2) + '%' : '100%';
  document.getElementById('bar-ping').style.background = ok ? '' : 'var(--red)';
  const succ = Math.round((okChecks / totalChecks) * 100);
  document.getElementById('stat-success').textContent = `%${succ}`;
  document.getElementById('bar-success').style.width = succ + '%';
  document.getElementById('stat-last').textContent = new Date().toLocaleTimeString('tr-TR');
  const flows = (backend.conns || []).map((c) => ({ ...c, svc: PORTNAME[c.port] || ('port ' + c.port) }));
  document.getElementById('stat-mode').textContent = `backend: gerçek ölçüm • ${flows.length} aktif bağlantı`;
  try { setConnections(flows.map((c) => ({ type: lastDevTypes[c.ip] || 'unknown' }))); } catch { /* sahne hazır değilse geç */ }
  const cur = new Set(flows.map((c) => `${c.ip}:${c.port}`));
  for (const c of flows) { const k = `${c.ip}:${c.port}`; if (!prevFlows.has(k)) log(`🔗 ${c.ip} → :${c.port} (${c.svc})`, 'info'); }
  for (const k of prevFlows) { if (!cur.has(k)) log(`🔌 ${k} ayrıldı`, 'warn'); }
  prevFlows = cur;

  const okP = history.filter(h => h.ok && h.ping >= 0).map(h => h.ping);
  const avg = okP.length ? Math.round(okP.reduce((a, b) => a + b, 0) / okP.length) : null;
  document.getElementById('ping-avg-tag').textContent = avg != null ? `ort: ${avg} ms` : 'ort: —';

  drawChart();
  log(`${ok ? '✓' : '✗'} ${targetIp} → ${ok ? ping + ' ms' : 'yanıt yok'}${manual ? ' (manuel)' : ''}`, ok ? 'ok' : 'err');

  if (backend.boot) lastBootTs = new Date(backend.boot).getTime();
  renderUptime();
  if (backend.drives) renderDrives(backend.drives, backend.ortakGB);
}

function renderUptime() {
  if (!lastBootTs) {
    document.getElementById('stat-uptime').textContent = '—';
    document.getElementById('stat-uptime-sub').textContent = 'ajan bekleniyor';
    return;
  }
  const s = Math.floor((Date.now() - lastBootTs) / 1000);
  const d = Math.floor(s / 86400);
  document.getElementById('stat-uptime').textContent =
    `${d > 0 ? d + 'g ' : ''}${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  document.getElementById('stat-uptime-sub').textContent = 'reboot: ' +
    new Date(lastBootTs).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderDrives(drives, ortakGB) {
  document.getElementById('drives').innerHTML = drives.map((x) =>
    `<div class="drive"><b>${esc(x.DeviceID)}</b><div class="meter-track"><div class="meter-fill disk" style="width:${x.pct}%"></div></div><span>%${x.pct} • ${x.freeGB} GB boş</span></div>`
  ).join('');
  document.getElementById('ortak-val').textContent = ortakGB != null ? `${ortakGB} GB` : '—';
}

// --- grafik ---
function drawChart() {
  const c = document.getElementById('ping-chart'), x = c.getContext('2d');
  const W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  x.strokeStyle = 'rgba(120,160,255,.12)'; x.lineWidth = 1;
  for (let g = 0; g < 4; g++) { x.beginPath(); x.moveTo(0, (H / 4) * g); x.lineTo(W, (H / 4) * g); x.stroke(); }
  if (!history.length) return;
  const max = Math.max(80, ...history.map(h => h.ping));
  const step = W / 60;
  history.forEach((h, i) => {
    const px = W - (history.length - i) * step;
    const ph = h.ok ? H - (h.ping / max) * (H - 20) - 8 : 6;
    x.fillStyle = h.ok ? (h.ping > 60 ? '#ffb224' : '#22ff9a') : '#ff4d6d';
    x.fillRect(px, ph, Math.max(3, step - 2), H - ph);
  });
  const okP = history.filter(h => h.ok).map(h => h.ping);
  if (okP.length) {
    const avg = okP.reduce((a, b) => a + b, 0) / okP.length;
    const ay = H - (avg / max) * (H - 20) - 8;
    x.strokeStyle = '#4da6ff'; x.setLineDash([6, 5]); x.beginPath(); x.moveTo(0, ay); x.lineTo(W, ay); x.stroke(); x.setLineDash([]);
  }
}

// --- portlar (sadece backend'den gelen gerçek sonuç) ---
function renderPorts(list) {
  if (!list.length) { renderPortsUnknown(); return; }
  document.getElementById('ports').innerHTML = list.map(p =>
    `<div class="port ${p.open ? 'open' : 'closed'}"><span>${p.port} • ${p.name || ''}</span><b>${p.open ? '● AÇIK' : '○ KAPALI'}</b>${p.latencyMs != null ? `<span>${p.latencyMs} ms</span>` : ''}</div>`
  ).join('');
}
function renderPortsUnknown() {
  document.getElementById('ports').innerHTML =
    `<div class="port unknown"><span>veri yok</span><b>ÖLÇÜM YOK</b><span>backend gerekli</span></div>`;
}

// --- metreler (SSH'den gelen GERÇEK değerler; yoksa sahte veri yerine durum yazısı) ---
function setSysTag(mode) {
  const el = document.getElementById('sys-tag');
  if (!el) return;
  if (mode === 'live') el.textContent = 'SSH üzerinden canlı';
  else if (mode === 'live-agent') el.textContent = 'Ajan üzerinden canlı';
  else if (mode === 'retry') el.textContent = 'SSH hatası / ilk ölçüm bekleniyor';
  else el.textContent = 'SSH bilgisi girilmedi';
}
function updateMeters(s) {
  for (const k of ['cpu', 'ram', 'disk']) {
    const v = s[k];
    document.getElementById(`${k}-val`).textContent = v == null ? '—' : `%${Math.round(v)}`;
    document.getElementById(`${k}-bar`).style.width = `${v ?? 0}%`;
  }
  const n = s.netMbps;
  document.getElementById('net-val').textContent = n == null ? '—' : `${n} Mb/s`;
  document.getElementById('net-bar').style.width = `${Math.min(100, n ?? 0)}%`;
}
function setMetersUnknown() {
  for (const k of ['cpu', 'ram', 'disk']) {
    document.getElementById(`${k}-val`).textContent = 'ölçülemiyor';
    document.getElementById(`${k}-bar`).style.width = '0%';
  }
  document.getElementById('net-val').textContent = 'ölçülemiyor';
  document.getElementById('net-bar').style.width = '0%';
}

// --- internet / modem (gerçek WAN ölçümü) ---
let prevInternetUp = null;
function setNetRow(rowId, valId, s) {
  const row = document.getElementById(rowId), val = document.getElementById(valId);
  if (!s || s.avgMs == null) { row.className = 'port unknown'; val.textContent = s && s.lossPct === 100 ? 'ulaşılamıyor' : '—'; return; }
  const bad = s.lossPct > 5 || s.avgMs > 150;
  row.className = 'port ' + (bad ? 'closed' : 'open');
  val.textContent = `${s.avgMs} ms • kayıp %${s.lossPct}`;
}
async function checkInternet() {
  try {
    const r = await fetch('/api/internet', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    setNetRow('row-gw', 'net-gw', d.gateway);
    setNetRow('row-g', 'net-g', d.google);
    setNetRow('row-cf', 'net-cf', d.cloudflare);
    document.getElementById('dns-val').textContent = `${d.dnsMs} ms`;
    if (d.publicIp) document.getElementById('wan-ip').textContent = d.publicIp;
    const pill2 = document.getElementById('net-pill');
    pill2.className = 'pill ' + (d.internetUp ? 'online' : 'offline');
    pill2.textContent = d.internetUp ? '● İNTERNET VAR' : '● İNTERNET YOK';
    if (prevInternetUp !== null && prevInternetUp !== d.internetUp)
      log(d.internetUp ? '🌐 İnternet bağlantısı geri geldi' : '🌐 İnternet bağlantısı kesildi!', d.internetUp ? 'ok' : 'err');
    prevInternetUp = d.internetUp;
  } catch { /* sessiz geç */ }
}
async function runSpeedTest() {
  const val = document.getElementById('speed-val');
  val.textContent = 'ölçülüyor…';
  try {
    const r = await fetch('/api/speedtest', { cache: 'no-store' });
    const d = await r.json();
    if (d.error) throw 0;
    val.textContent = `↓ ${d.downMbps} • ↑ ${d.upMbps} Mb/s`;
    document.getElementById('speed-bar').style.width = Math.min(100, (d.downMbps / 55) * 100) + '%';
    log(`⇅ Hız: ↓ ${d.downMbps} Mb/s • ↑ ${d.upMbps} Mb/s`, 'ok');
  } catch { val.textContent = 'ölçülemedi'; log('Hız testi başarısız', 'err'); }
}

// --- ağdaki cihazlar (gerçek ARP taraması) ---
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function checkDevices() {
  try {
    const r = await fetch('/api/devices', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    document.getElementById('dev-count').textContent = d.apOk ? `${d.count} cihaz • ${d.wifi} kablosuz` : `${d.count} cihaz`;
    const smbByIp = {};
    for (const s of (lastSmb?.sessions || [])) {
      const ip = s.ClientComputerName;
      if (ip) smbByIp[ip] = (smbByIp[ip] || 0) + 1;
    }
    document.getElementById('devices').innerHTML = d.devices.map((x) => {
      const title = x.name || x.vendor || 'bilinmeyen cihaz';
      let sub = x.name && x.vendor ? x.vendor : x.mac;
      if (smbByIp[x.ip]) sub += ` • 📁 ${smbByIp[x.ip]} oturum`;
      const cls = x.pingMs == null ? 'dead' : x.pingMs > 100 ? 'slow' : '';
      const tcls = (x.type === 'wifi' ? 'wifi' : x.type === 'infra' ? 'infra' : x.type === 'lan' ? 'lan' : '') + (x.apOnline === false ? ' off' : '');
      return `<div class="dev-row${tcls ? ' ' + tcls.trim() : ''}"><b>${esc(x.ip)}</b><span>${esc(x.conn)} • ${esc(title)} • ${esc(sub)}</span><i class="${cls}">${x.pingMs != null ? x.pingMs + ' ms' : '—'}</i></div>`;
    }).join('') || '<div class="dev-row"><b>—</b><span>cihaz bulunamadı</span><i></i></div>';
    lastDevTypes = {};
    for (const x of d.devices) lastDevTypes[x.ip] = x.type || 'unknown';
  } catch { /* sessiz geç */ }
}

// --- server2 paylaşım oturumları (📁 kim, hangi dosyayı açmış) ---
let prevSmb = new Set(), lastSmb = null;
async function checkFileshares() {
  try {
    const r = await fetch('/api/fileshares', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.agentOk) { lastSmb = null; return; }
    lastSmb = d;
    const cur = new Set();
    for (const s of d.sessions || []) {
      const ip = s.ClientComputerName || '?';
      const k = `${ip}|${s.ClientUserName || '?'}`;
      cur.add(k);
      if (!prevSmb.has(k)) {
        const mine = (d.files || []).filter((f) => (f.ClientComputerName || '') === (s.ClientComputerName || '')).slice(0, 3);
        const fstr = mine.map((f) => `${f.ShareName || ''}${f.Path || ''}`).join(', ');
        log(`📁 ${s.ClientUserName || '?'} @ ${ip} bağlandı${fstr ? ' → ' + fstr : ''}`, 'info');
      }
    }
    for (const k of prevSmb) if (!cur.has(k)) log(`📁 ${k} ayrıldı`, 'warn');
    prevSmb = cur;
  } catch { /* sessiz geç */ }
}

// --- UI olayları ---
document.getElementById('btn-check').onclick = () => runCheck(true);document.getElementById('btn-scan').onclick = () => { log('Port taraması başlatıldı…', 'warn'); runCheck(true); };
document.getElementById('btn-clear').onclick = () => logEl.innerHTML = '';
document.getElementById('auto-check').onchange = e => { autoMode = e.target.checked; log(`Otomatik kontrol ${autoMode ? 'açıldı' : 'duraklatıldı'}`, 'warn'); };
document.getElementById('btn-copy').onclick = () => { navigator.clipboard.writeText(targetIp); log(`IP kopyalandı: ${targetIp}`, 'info'); };
document.getElementById('btn-edit-ip').onclick = () => {
  const v = prompt('Sunucu IP adresi:', targetIp);
  if (v && /^[\d.]+$/.test(v.trim())) {
    targetIp = v.trim();
    document.getElementById('ip-label').textContent = targetIp;
    scene.remove(ipSprite); ipSprite = makeLabel(targetIp); ipSprite.position.y = 4.1; scene.add(ipSprite);
    totalChecks = 0; okChecks = 0; history = []; sessionStart = Date.now();
    log(`Hedef değiştirildi → ${targetIp}`, 'warn'); runCheck(true);
  }
};
setInterval(() => renderUptime(), 1000);

// başlat (sadece gerçek veri)
log(`NEXUS başlatıldı. Hedef: ${targetIp}`, 'info');
runCheck(true);
checkInternet();
setInterval(() => runCheck(false), 60000);
setInterval(checkInternet, 15000);
setTimeout(runSpeedTest, 15000); // açılışta bir kez
setInterval(runSpeedTest, 3600000); // sonra saatte bir
setTimeout(checkDevices, 10000);
setInterval(checkDevices, 60000); // ağ taraması dakikada bir
setTimeout(checkFileshares, 20000);
setInterval(checkFileshares, 60000); // paylaşım oturumları dakikada bir
