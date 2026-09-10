// Gerçek ağ + sistem ölçümü yapan backend
// Çalıştır: npm install && node server.js  →  http://localhost:4000
//
// Ping/port her zaman çalışır. Sistem yükü (CPU/RAM/disk/ağ) için
// hedef Ubuntu sunucuya SSH erişimi gerekir:
//   SSH_USER=kullanici SSH_PASS=sifre node server.js
//   veya anahtarla: SSH_USER=kullanici SSH_KEY_PATH=~/.ssh/id_rsa node server.js
import express from 'express';
import cors from 'cors';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { Client } from 'ssh2';
import dgram from 'dgram';
import mdns from 'multicast-dns';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;
app.use(cors());
app.use(express.static(__dirname));

const DEFAULT_HOST = '192.168.41.252';
const CHECK_PORTS = [
  { port: 445, name: 'SMB' }, { port: 139, name: 'NetBIOS' },
  { port: 3389, name: 'RDP' }, { port: 80, name: 'HTTP' },
  { port: 443, name: 'HTTPS' }, { port: 22, name: 'SSH' },
  { port: 8080, name: 'ALT-HTTP' },
];

function tcpPing(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    sock.setTimeout(timeout);
    sock.on('connect', () => { const ms = Date.now() - start; sock.destroy(); resolve({ open: true, latencyMs: ms }); });
    sock.on('timeout', () => { sock.destroy(); resolve({ open: false, latencyMs: null }); });
    sock.on('error', () => { sock.destroy(); resolve({ open: false, latencyMs: null }); });
    sock.connect(port, host);
  });
}

function icmpPing(host) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? `ping -n 1 -w 2000 ${host}` : `ping -c 1 -W 2 ${host}`;
    const start = Date.now();
    exec(cmd, (err, stdout) => {
      const ms = Date.now() - start;
      if (err) return resolve({ online: false, pingMs: null });
      const m = stdout.match(/time[=<]([\d.]+)\s?ms/i);
      resolve({ online: true, pingMs: m ? Math.round(parseFloat(m[1])) : ms });
    });
  });
}

// ---------- SSH ile gerçek sistem ölçümü (Ubuntu hedef) ----------
const prevSamples = {}; // host -> { total, idle, bytes, t }

function sshExec(host, cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const user = process.env.SSH_USER;
    let done = false;
    const finish = (val) => { if (!done) { done = true; try { conn.end(); } catch { /* yok say */ } resolve(val); } };
    if (!user) return resolve(null);
    const conn = new Client();
    const timer = setTimeout(() => finish(null), timeoutMs);
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(null); }
        let out = '';
        stream.on('data', (d) => { out += d; });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { clearTimeout(timer); finish(out); });
      });
    }).on('error', () => { clearTimeout(timer); finish(null); });
    const cfg = { host, port: 22, username: user, readyTimeout: timeoutMs };
    if (process.env.SSH_KEY_PATH) {
      try {
        cfg.privateKey = fs.readFileSync(process.env.SSH_KEY_PATH);
        if (process.env.SSH_PASSPHRASE) cfg.passphrase = process.env.SSH_PASSPHRASE;
      } catch { clearTimeout(timer); return finish(null); }
    } else if (process.env.SSH_PASS) {
      cfg.password = process.env.SSH_PASS;
    } else { clearTimeout(timer); return finish(null); }
    conn.connect(cfg);
  });
}

async function getSystemViaSsh(host) {
  const out = await sshExec(host,
    "grep '^cpu ' /proc/stat; echo ---; free -b | sed -n 2p; echo ---; df -B1 / | tail -1; echo ---; grep ':' /proc/net/dev | grep -v '^\\s*lo:'");
  if (!out) return null;
  try {
    const parts = out.split('---').map((s) => s.trim());
    const c = parts[0].split(/\s+/).slice(1).map(Number);
    const total = c.reduce((a, b) => a + b, 0);
    const idle = c[3] + c[4];
    const mt = parts[1].split(/\s+/);
    const ramPct = (Number(mt[2]) / Number(mt[1])) * 100;
    const dt = parts[2].split(/\s+/);
    const diskPct = parseFloat(dt[4]);
    let bytes = 0;
    for (const line of parts[3].split('\n')) {
      const m = line.match(/:\s*(.*)/);
      if (!m) continue;
      const f = m[1].trim().split(/\s+/).map(Number);
      bytes += (f[0] || 0) + (f[8] || 0);
    }
    const now = Date.now();
    const prev = prevSamples[host];
    let cpu = null, netMbps = null;
    if (prev) {
      const dTotal = total - prev.total, dIdle = idle - prev.idle;
      if (dTotal > 0) cpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
      const dSec = (now - prev.t) / 1000;
      if (dSec > 0) netMbps = Math.round(((bytes - prev.bytes) * 8 / dSec / 1e6) * 10) / 10;
    }
    prevSamples[host] = { total, idle, bytes, t: now };
    return { cpu, ram: Math.round(ramPct * 10) / 10, disk: diskPct, netMbps };
  } catch { return null; }
}

// Sunucuyla o an ESTABLISHED TCP konuşması olan LAN istemcileri (gerçek veri akışı)
async function getConnsViaSsh(host) {
  const out = await sshExec(host, 'ss -tn state established 2>/dev/null');
  if (!out) return [];
  const seen = new Map();
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [local, peer] = [parts[parts.length - 2], parts[parts.length - 1]];
    const pm = peer.match(/^([\d.]+):(\d+)$/);
    const lm = local.match(/^([\d.]+):(\d+)$/);
    if (!pm || !lm) continue;
    if (!pm[1].startsWith(SUBNET + '.') || pm[1] === host) continue;
    if (!seen.has(pm[1])) seen.set(pm[1], { ip: pm[1], port: Number(lm[2]), dir: Number(lm[2]) < 10000 ? 'in' : 'out' });
  }
  return [...seen.values()];
}

// ---------- İnternet / modem ölçümü (modem giriş şifresi gerekmez) ----------
function pingStats(host, count = 4) {
  return new Promise((resolve) => {
    exec(`ping -c ${count} -W 2 ${host}`, (err, stdout) => {
      if (!stdout) return resolve({ reachable: false, avgMs: null, lossPct: 100 });
      const loss = stdout.match(/(\d+(?:\.\d+)?)% packet loss/);
      const avg = stdout.match(/min\/avg\/max[^=]*=\s*[\d.]+\/([\d.]+)/);
      const lossPct = loss ? parseFloat(loss[1]) : 100;
      resolve({ reachable: !err || lossPct < 100, avgMs: avg ? Math.round(parseFloat(avg[1]) * 10) / 10 : null, lossPct });
    });
  });
}

function dnsTime(host = 'google.com') {
  return new Promise((resolve) => {
    const start = Date.now();
    exec(`nslookup ${host} 2>&1 | tail -2`, () => resolve(Date.now() - start));
  });
}

let wanCache = { ip: null, t: 0 };
async function publicIp() {
  if (Date.now() - wanCache.t < 600000 && wanCache.ip) return wanCache.ip;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://api.ipify.org', { signal: ctrl.signal });
    clearTimeout(to);
    const ip = (await r.text()).trim();
    if (/^[\d.:a-fA-F]+$/.test(ip) && ip.length < 46) { wanCache = { ip, t: Date.now() }; return ip; }
  } catch { /* çevrimdışı — önbellek kullanılır */ }
  return wanCache.ip;
}

app.get('/api/internet', async (req, res) => {
  const gw = (req.query.modem || process.env.MODEM_IP || '192.168.41.1').trim();
  const [gateway, google, cloudflare, dnsMs, wanPub] = await Promise.all([
    pingStats(gw), pingStats('8.8.8.8'), pingStats('1.1.1.1'), dnsTime(), publicIp(),
  ]);
  let wanUse = { downMbps: null, upMbps: null };
  let line = { tech: 'VDSL', proto: 'PPPoE', up: null, uptimeSec: null };
  let drops = { count: wanState.drops.length, lastDrop: null };
  try {
    const dd = await zyDal('Traffic_Status');
    if (dd) { wanUse = zyWanRate(dd); line = getWanLine(dd); drops = trackDrops(line); }
  } catch { /* modem kapalıysa geç */ }
  res.json({
    backend: true, modem: gw, gateway, google, cloudflare, dnsMs, publicIp: wanPub, wanUse, line, drops,
    internetUp: google.reachable || cloudflare.reachable,
    at: new Date().toISOString(),
  });
});

app.get('/api/speedtest', async (req, res) => {
  try {
    const downBytes = 25_000_000;
    const t0 = Date.now();
    const r = await fetch(`https://speed.cloudflare.com/__down?bytes=${downBytes}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const downMbps = Math.round((buf.length * 8 / ((Date.now() - t0) / 1000) / 1e6) * 10) / 10;
    const upBuf = Buffer.alloc(5_000_000);
    const u0 = Date.now();
    await fetch('https://speed.cloudflare.com/__up', { method: 'POST', body: upBuf });
    const upMbps = Math.round((upBuf.length * 8 / ((Date.now() - u0) / 1000) / 1e6) * 10) / 10;
    res.json({ backend: true, downMbps, upMbps, at: new Date().toISOString() });
  } catch { res.status(500).json({ backend: true, error: 'ölçülemedi' }); }
});

// ---------- Ağdaki cihazlar (modem şifresi gerekmez: ARP + sunucu komşu tablosu) ----------
const SUBNET = process.env.SUBNET || '192.168.41';
let ouiCache = {};
try { ouiCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'oui-cache.json'), 'utf8')); } catch { /* ilk çalıştırma */ }
function saveOuiCache() { try { fs.writeFileSync(path.join(__dirname, 'oui-cache.json'), JSON.stringify(ouiCache)); } catch { /* yok say */ } }
const normMac = (m) => m.toLowerCase().split(':').map((p) => p.padStart(2, '0')).join(':');

function localArp() {
  return new Promise((resolve) => {
    // tüm subnet'e unicast ping (her host ARP tablosuna düşer), sonra tabloyu oku
    const cmd = `for i in $(seq 1 254); do (ping -c 1 -W 300 ${SUBNET}.$i >/dev/null 2>&1 &); done; sleep 6; arp -a`;
    exec(cmd, { timeout: 30000 }, (err, stdout) => {
      const devs = [];
      for (const line of String(stdout || '').split('\n')) {
        const m = line.match(/^(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i);
        if (!m || /^ff(:ff){5}$/i.test(m[3])) continue;
        devs.push({ ip: m[2], mac: normMac(m[3]), name: m[1] === '?' ? null : m[1].replace(/\.local\.?$/i, '') });
      }
      resolve(devs);
    });
  });
}

async function serverNeigh(host) {
  const out = await sshExec(host, 'ip neigh show');
  if (!out) return [];
  const devs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]+)\s+(\S+)/i);
    if (!m || /^(FAILED|INCOMPLETE)$/i.test(m[3])) continue;
    devs.push({ ip: m[1], mac: normMac(m[2]), name: null });
  }
  return devs;
}

function pingOnce(ip) {
  return new Promise((resolve) => {
    exec(`ping -c 1 -W 800 ${ip}`, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).match(/time[=<]([\d.]+)\s?ms/i);
      resolve(m ? Math.round(parseFloat(m[1]) * 10) / 10 : null);
    });
  });
}

async function vendorOf(mac) {
  const key = mac.slice(0, 8);
  if (ouiCache[key]) return ouiCache[key];
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`https://api.macvendors.com/${mac}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const v = (await r.text()).trim().slice(0, 40);
    if (v && !/^not found/i.test(v)) { ouiCache[key] = v; saveOuiCache(); return v; }
  } catch { /* çevrimdışı / limit — sessiz geç */ }
  return null;
}

// ---------- Tenda AP istemci listesi (kablolu/kablosuz ayrımı) ----------
const AP_IP = process.env.AP_IP || '192.168.41.210';
const AP_PASS = process.env.AP_PASS || '';
const T_K1 = 'RDpbLfCPsJZ7fiv';
const T_K2 = 'yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW';
function tSec(f, d, b) {
  var k = b, a = '', h, e, c, j, l = 187, i = 187;
  e = f.length; c = d.length; j = k.length; h = e > c ? e : c;
  for (var g = 0; g < h; g++) {
    l = 187; i = 187;
    if (g >= e) { i = d.charCodeAt(g); }
    else if (g >= c) { l = f.charCodeAt(g); }
    else { l = f.charCodeAt(g); i = d.charCodeAt(g); }
    a += k.charAt((l ^ i) % j);
  }
  return a;
}
function tParse(t) {
  const x = t.indexOf('\r\n');
  const er = t.substring(0, x);
  if (/\D/.test(er) || er.length === 0) return [0, t];
  return [parseInt(er.replace(/^0+(?=\d)/, ''), 10), t.substring(x + 2)];
}
async function tPost(path, body, ms = 8000) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(`http://${AP_IP}${path}`, { method: 'POST', body: body || '', signal: ctrl.signal });
    clearTimeout(to);
    return tParse(await r.text());
  } catch { return null; }
}
let apSession = null;
async function apLogin() {
  if (!AP_PASS) return null;
  const init = await tPost('/?code=2&asyn=1', '');
  if (!init) return null;
  const a = init[1].replace(/\r\n$/, '').split('\r\n');
  if (a.length < 4) return null;
  const sess = tSec(a[2], tSec(AP_PASS, T_K1, T_K2), a[3]);
  const auth = await tPost(`/?code=7&asyn=0&id=${encodeURIComponent(sess)}`, '');
  if (!auth || auth[0] !== 0) return null;
  apSession = sess;
  return sess;
}
async function apClients() {
  if (!AP_PASS) return [];
  let sess = apSession || await apLogin();
  if (!sess) return [];
  let r = await tPost(`/?code=2&asyn=0&id=${encodeURIComponent(sess)}`, 'id 13\r\n');
  if (!r || r[0] !== 0) {
    apSession = null;
    sess = await apLogin();
    if (!sess) return [];
    r = await tPost(`/?code=2&asyn=0&id=${encodeURIComponent(sess)}`, 'id 13\r\n');
    if (!r || r[0] !== 0) return [];
  }
  const rows = {};
  for (const line of r[1].split('\r\n')) {
    const m = line.match(/^(\S+)\s+(\d+)\s?(.*)$/);
    if (!m || m[1] === 'id') continue;
    (rows[m[2]] = rows[m[2]] || {})[m[1]] = m[3];
  }
  return Object.values(rows)
    .filter((x) => x.ip && x.ip !== '0.0.0.0')
    .map((x) => ({ ip: x.ip, mac: normMac(String(x.mac || '').replace(/-/g, ':')), apType: x.type || null, apOnline: x.online === '1', apName: x.name || null }));
}

// ---------- Modem (Zyxel) istemci listesi + anlık hızlar ----------
const MODEM_IP = process.env.MODEM_IP || '192.168.41.1';
const MODEM_USER = process.env.MODEM_USER || 'admin';
const MODEM_PASS = process.env.MODEM_PASS || '';
let zySess = null; // { sessionkey, cookie, aesKey }
const zyPrevBytes = new Map(); // mac -> { rx, tx, t }
let zyPrevWan = null; // { rx, tx, t } — WAN arayüz sayaçları

let wanState = { drops: [], last: null };
try { wanState = { drops: [], last: null, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'wan-drops.json'), 'utf8')) }; } catch { /* ilk çalıştırma */ }
function saveWan() { try { fs.writeFileSync(path.join(__dirname, 'wan-drops.json'), JSON.stringify(wanState)); } catch { /* yok say */ } }

function getWanLine(dd) {
  try {
    const o = dd.Object[0];
    const ppp = (o.pppIface || []).find((p) => p.X_ZYXEL_IfName === 'ppp1')
      || (o.pppIface || []).find((p) => p.Status === 'Up');
    if (!ppp) return { tech: 'VDSL', proto: 'PPPoE', up: false, uptimeSec: null };
    return {
      tech: 'VDSL', proto: 'PPPoE',
      up: ppp.Status === 'Up' || ppp.ConnectionStatus === 'Connected',
      uptimeSec: Number(ppp.LastChange) || null,
    };
  } catch { return { tech: 'VDSL', proto: 'PPPoE', up: null, uptimeSec: null }; }
}

function trackDrops(line) {
  const prev = wanState.last;
  if (prev && prev.up !== undefined && line.up) {
    if (prev.up === false || (line.uptimeSec != null && prev.uptime != null && line.uptimeSec < prev.uptime)) {
      wanState.drops.push({ at: new Date().toISOString() });
      if (wanState.drops.length > 30) wanState.drops.shift();
    }
  }
  wanState.last = { up: line.up, uptime: line.uptimeSec };
  saveWan();
  return { count: wanState.drops.length, lastDrop: wanState.drops.length ? wanState.drops[wanState.drops.length - 1].at : null };
}

function zyWanRate(d) {
  try {
    const o = d.Object[0];
    const sum = (lst) => (lst || []).reduce((a, e) => ({ rx: a.rx + (Number(e.BytesReceived) || 0), tx: a.tx + (Number(e.BytesSent) || 0) }), { rx: 0, tx: 0 });
    let t = sum(o.pppIfaceSt);
    if (!t.rx && !t.tx) t = sum(o.ipIfaceSt);
    const now = Date.now();
    let wan = { downMbps: null, upMbps: null };
    if (zyPrevWan && now > zyPrevWan.t) {
      const dt = (now - zyPrevWan.t) / 1000;
      if (dt > 0) {
        const dd = Math.max(0, t.rx - zyPrevWan.rx), du = Math.max(0, t.tx - zyPrevWan.tx);
        wan = { downMbps: Math.round((dd * 8 / dt / 1e6) * 10) / 10, upMbps: Math.round((du * 8 / dt / 1e6) * 10) / 10 };
      }
    }
    zyPrevWan = { ...t, t: now };
    return wan;
  } catch { return { downMbps: null, upMbps: null }; }
}

async function zyLogin() {
  if (!MODEM_PASS) return null;
  try {
    const { RSAPublicKey } = await (await fetch(`http://${MODEM_IP}/getRSAPublickKey`)).json();
    if (!RSAPublicKey) return null;
    const aesKey = crypto.randomBytes(32), ivFull = crypto.randomBytes(32);
    const obj = { Input_Account: MODEM_USER, Input_Passwd: Buffer.from(MODEM_PASS).toString('base64'), currLang: 'en', RememberPassword: '', SHA512_password: false };
    const c = crypto.createCipheriv('aes-256-cbc', aesKey, ivFull.slice(0, 16));
    const content = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
    const key = crypto.publicEncrypt({ key: RSAPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(aesKey.toString('base64'), 'utf8')).toString('base64');
    const r = await fetch(`http://${MODEM_IP}/UserLogin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, key, iv: ivFull.toString('base64') }) });
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ') : '';
    const lj = await r.json();
    if (!lj.content) return null;
    const dd = crypto.createDecipheriv('aes-256-cbc', aesKey, Buffer.from(lj.iv, 'base64').slice(0, 16));
    const plain = JSON.parse(Buffer.concat([dd.update(lj.content, 'base64'), dd.final()]).toString('utf8'));
    if (!plain.sessionkey) return null;
    zySess = { sessionkey: plain.sessionkey, cookie: setCookie, aesKey };
    return zySess;
  } catch { return null; }
}

async function zyDal(oid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!zySess && !(await zyLogin())) return null;
    try {
      const r = await fetch(`http://${MODEM_IP}/cgi-bin/DAL?oid=${oid}&DalGetOneObject=y`,
        { headers: { CSRFToken: zySess.sessionkey, Cookie: zySess.cookie } });
      const t = await r.text();
      const j = JSON.parse(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      if (j.content) {
        const dd = crypto.createDecipheriv('aes-256-cbc', zySess.aesKey, Buffer.from(j.iv, 'base64').slice(0, 16));
        return JSON.parse(Buffer.concat([dd.update(j.content, 'base64'), dd.final()]).toString('utf8'));
      }
      if (j.result && j.result !== 'ZCFG_SUCCESS') { zySess = null; continue; }
      return j;
    } catch { zySess = null; }
  }
  return null;
}

async function modemHosts() {
  const d = await zyDal('Traffic_Status');
  if (!d || !d.Object || !d.Object[0] || !Array.isArray(d.Object[0].hosts)) return [];
  const now = Date.now();
  return d.Object[0].hosts
    .filter((h) => h.IPAddress && h.IPAddress.startsWith(SUBNET + '.'))
    .map((h) => {
      const mac = String(h.PhysAddress || '').toLowerCase();
      const rx = Number(h.X_ZYXEL_BytesReceived) || 0, tx = Number(h.X_ZYXEL_BytesSent) || 0;
      let rate = null;
      const prev = zyPrevBytes.get(mac);
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0) rate = Math.round((((rx - prev.rx) + (tx - prev.tx)) * 8 / dt / 1e6) * 10) / 10;
        if (rate < 0) rate = 0;
      }
      zyPrevBytes.set(mac, { rx, tx, t: now });
      return { ip: h.IPAddress, mac: normMac(mac), name: h.HostName || null, active: h.Active !== false, rate };
    });
}

const ROUTER_RE = /zyxel|tp-?link|tenda|mercury|huawei|asus|keenetic|mikrotik|ubiquiti|d-?link|netgear|airties|totolink|cudy/i;

// ---------- Cihaz türü tanıma: mDNS + SSDP + port parmak izi + üretici ----------
let kindCache = { t: 0, byIp: {} };
let lastDeviceIps = [];

const MDNS_KIND = {
  '_printer._tcp': ['Yazıcı', '🖨'], '_ipp._tcp': ['Yazıcı', '🖨'], '_pdl-datastream._tcp': ['Yazıcı', '🖨'],
  '_airplay._tcp': ['TV / Medya', '📺'], '_mediaremotetv._tcp': ['TV / Medya', '📺'], '_googlecast._tcp': ['TV / Chromecast', '📺'],
  '_raop._tcp': ['Hoparlör', '🔊'], '_companion-link._tcp': ['Apple Cihazı', '📱'], '_hap._tcp': ['Akıllı Ev', '🏠'],
  '_smb._tcp': ['Dosya Paylaşımı', '💾'], '_afpovertcp._tcp': ['Mac Paylaşımı', '💾'],
  '_rfb._tcp': ['Bilgisayar', '💻'], '_ssh._tcp': ['Sunucu', '🖧'],
};

function mdnsScan(ms = 6000) {
  return new Promise((resolve) => {
    let sock = null;
    try { sock = mdns(); } catch { return resolve([]); }
    const instSvc = new Map(), instHost = new Map(), instDetail = new Map(), hostIp = new Map();
    const ingest = (recs) => {
      for (const a of recs || []) {
        if (a.type === 'PTR' && typeof a.data === 'string') {
          const svc = Object.keys(MDNS_KIND).find((k) => a.name === k + '.local');
          if (svc && !instSvc.has(a.data)) instSvc.set(a.data, svc);
        } else if (a.type === 'SRV' && a.data && a.data.target) {
          instHost.set(a.name, a.data.target);
        } else if (a.type === 'TXT' && Array.isArray(a.data)) {
          const txt = a.data.map((b) => b.toString()).join(' ');
          const tm = txt.match(/(?:^|\s)(?:ty|md|product|model|fn|vn)=([^;]+)/i);
          instDetail.set(a.name, (tm ? tm[1] : txt).slice(0, 48));
        } else if (a.type === 'A' && typeof a.data === 'string') {
          hostIp.set(a.name, a.data);
        }
      }
    };
    sock.on('response', (res) => { ingest(res.answers); ingest(res.additionals); });
    sock.on('error', () => {});
    const ask = (name, type) => { try { sock.query({ questions: [{ name, type }] }); } catch {} };
    for (const svc of Object.keys(MDNS_KIND)) ask(svc + '.local', 'PTR');
    setTimeout(() => { for (const inst of instSvc.keys()) { ask(inst, 'SRV'); ask(inst, 'TXT'); } }, 2500);
    setTimeout(() => {
      const hosts = new Set([...instHost.values()].filter(Boolean));
      for (const h of hosts) ask(h, 'A');
    }, 4000);
    setTimeout(() => {
      try { sock.destroy(); } catch {}
      const res = [];
      for (const [inst, svc] of instSvc) {
        const ip = hostIp.get(instHost.get(inst));
        if (!ip || !ip.startsWith(SUBNET + '.')) continue;
        const [kind, icon] = MDNS_KIND[svc];
        res.push({ ip, kind, icon, detail: instDetail.get(inst) || inst.split('._')[0].replace(/-/g, ' ') });
      }
      resolve(res);
    }, ms);
  });
}

function ssdpScan(ms = 4000) {
  return new Promise((resolve) => {
    const found = [];
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, ms);
    sock.on('message', (msg, rinfo) => {
      const t = msg.toString();
      const get = (h) => { const m = t.match(new RegExp(`^${h}:\\s*(.+)$`, 'im')); return m ? m[1].trim() : null; };
      found.push({ ip: rinfo.address, server: get('SERVER'), st: get('ST'), usn: get('USN') });
    });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {}
      sock.send('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ns:discovery"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n', 1900, '239.255.255.250');
    });
    if (timer.unref) timer.unref();
  });
}

function classifySsdp(server = '', st = '', usn = '') {
  const t = `${server} ${st} ${usn}`;
  if (/printer|ipp|pdl|laserjet|epson|canon|brother/i.test(t)) return ['Yazıcı', '🖨'];
  if (/tv|bravia|roku|chromecast|googlecast|smart-tv|vizio/i.test(t)) return ['TV / Medya', '📺'];
  if (/sonos|raop|airplay/i.test(t)) return ['Hoparlör', '🔊'];
  if (/windows|xbox/i.test(t)) return ['Bilgisayar', '💻'];
  return null;
}

async function portKind(ip) {
  const checks = [[9100, 'Yazıcı', '🖨'], [631, 'Yazıcı', '🖨'], [8009, 'TV / Chromecast', '📺'], [548, 'Mac', '🖥'], [445, 'Windows PC', '💻']];
  const open = [];
  await Promise.all(checks.map(async ([p]) => { try { const r = await tcpPing(ip, p, 700); if (r.open) open.push(p); } catch {} }));
  if (open.includes(9100) || open.includes(631)) return ['Yazıcı', '🖨', 'yazıcı portu'];
  if (open.includes(8009)) return ['TV / Chromecast', '📺', 'cast portu'];
  if (open.includes(548)) return ['Mac', '🖥', 'AFP'];
  if (open.includes(445)) return ['Windows PC', '💻', 'SMB'];
  return null;
}

function vendorKind(v) {
  if (!v) return null;
  if (/hewlett|epson|canon|brother|kyocera|lexmark|xerox|oki/i.test(v)) return ['Yazıcı', '🖨'];
  if (/raspberry|espressif|arduino|tuya|sonoff/i.test(v)) return ['IoT', '🏠'];
  if (/apple/i.test(v)) return ['Apple', '🍏'];
  if (/samsung|xiaomi|huawei|oppo|vivo|oneplus|realme|honor|motorola/i.test(v)) return ['Telefon', '📱'];
  if (/intel|dell|lenovo|asus|acer|msi|gigabyte|fujitsu/i.test(v)) return ['Bilgisayar', '💻'];
  return null;
}

async function runKindScan() {
  try {
    const [m, s] = await Promise.all([mdnsScan(6000), ssdpScan(4000)]);
    const byIp = { ...kindCache.byIp };
    for (const e of m) byIp[e.ip] = { kind: e.kind, icon: e.icon, detail: e.detail };
    for (const e of s) {
      const c = classifySsdp(e.server, e.st, e.usn);
      if (c && e.ip.startsWith(SUBNET + '.') && !byIp[e.ip]) byIp[e.ip] = { kind: c[0], icon: c[1], detail: (e.server || '').slice(0, 48) };
    }
    await Promise.all(lastDeviceIps.slice(0, 40).map(async (ip) => {
      if (byIp[ip]) return;
      try { const pk = await portKind(ip); if (pk) byIp[ip] = { kind: pk[0], icon: pk[1], detail: pk[2] }; } catch {}
    }));
    kindCache = { t: Date.now(), byIp };
  } catch { /* sessiz geç */ }
}

// ---------- SERVER2 (Windows) paylaşım oturumları ----------
const S2_URL = process.env.SERVER2_URL || 'http://192.168.41.252:9419/smb';
let s2Cache = { t: 0, data: null };
async function getServer2() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(S2_URL, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error('http');
    const d = await r.json();
    s2Cache = { t: Date.now(), data: d };
    return { agentOk: true, stale: false, ...d };
  } catch { return s2Cache.data ? { agentOk: true, stale: true, ...s2Cache.data } : { agentOk: false }; }
}
app.get('/api/fileshares', async (req, res) => {
  res.json({ backend: true, ...(await getServer2()), at: new Date().toISOString() });
});

app.get('/api/devices', async (req, res) => {
  const host = (req.query.host || DEFAULT_HOST).trim();
  const modemIp = process.env.MODEM_IP || '192.168.41.1';
  // Linux komşu tablosu yalnızca hedefte SSH (22) açıksa okunur
  const ssh22 = await tcpPing(host, 22, 1500);
  const [local, neigh, ap, mh] = await Promise.all([localArp(), ssh22.open ? serverNeigh(host) : [], apClients(), modemHosts()]);
  const map = new Map();
  for (const d of [...local, ...neigh]) {
    if (!map.has(d.mac)) map.set(d.mac, { ...d });
    else if (d.name && !map.get(d.mac).name) map.get(d.mac).name = d.name;
  }
  for (const a of ap) {
    if (!map.has(a.mac)) map.set(a.mac, { ip: a.ip, mac: a.mac, name: a.apName });
    const e = map.get(a.mac);
    e.apType = a.apType; e.apOnline = a.apOnline;
    if (a.apName && !e.name) e.name = a.apName;
  }
  for (const m of mh) {
    if (!map.has(m.mac)) map.set(m.mac, { ip: m.ip, mac: m.mac, name: m.name });
    const e = map.get(m.mac);
    if (m.name && !e.name) e.name = m.name;
    e.rate = m.rate;
  }
  const num = (ip) => ip.split('.').map(Number).reduce((x, y) => x * 256 + y);
  let devices = [...map.values()].filter((d) => d.ip.startsWith(SUBNET + '.')).sort((a, b) => num(a.ip) - num(b.ip));
  await Promise.all(devices.map(async (d) => { d.pingMs = await pingOnce(d.ip); }));
  // yalnızca o an çevrimiçi olanlar: AP'de online görünen veya ping'e cevap veren
  devices = devices.filter((d) => d.apOnline === true || d.pingMs != null);
  lastDeviceIps = devices.map((d) => d.ip);
  let lookups = 0;
  for (const d of devices) {
    const key = d.mac.slice(0, 8);
    if (ouiCache[key]) d.vendor = ouiCache[key];
    else if (lookups < 4) { lookups++; d.vendor = await vendorOf(d.mac); }
    else d.vendor = null;
    if (d.ip === modemIp || d.ip === AP_IP || (d.vendor && ROUTER_RE.test(d.vendor))) { d.type = 'infra'; d.conn = 'Altyapı'; }
    else if (d.apType === '1' || d.apType === '3') { d.type = 'wifi'; d.conn = 'Kablosuz'; }
    else if (d.apType === '0') { d.type = 'lan'; d.conn = 'Kablolu'; }
    else { d.type = 'unknown'; d.conn = '—'; }
  }
  res.json({
    backend: true, count: devices.length,
    wifi: devices.filter((d) => d.type === 'wifi').length, apOk: ap.length > 0,
    top: devices.filter((d) => d.rate != null && d.rate > 0)
      .sort((a, b) => b.rate - a.rate).slice(0, 5)
      .map((d) => ({ ip: d.ip, name: d.name || d.vendor || null, rate: d.rate })),
    devices, at: new Date().toISOString(),
  });
});
app.get('/api/status', async (req, res) => {
  const host = (req.query.host || DEFAULT_HOST).trim();
  const [icmp, ...ports] = await Promise.all([
    icmpPing(host),
    ...CHECK_PORTS.map(async (p) => ({ ...p, ...(await tcpPing(host, p.port)) })),
  ]);
  const anyPortOpen = ports.some((p) => p.open);
  const online = icmp.online || anyPortOpen;
  // Linux SSH metrikleri yalnızca hedefte 22 açık + SSH bilgisi varsa denenir (Windows'ta atlanır)
  const sshWanted = online && Boolean(process.env.SSH_USER && (process.env.SSH_PASS || process.env.SSH_KEY_PATH))
    && ports.some((p) => p.port === 22 && p.open);
  const [sshSys, sshConns, agent] = await Promise.all([
    sshWanted ? getSystemViaSsh(host) : null,
    sshWanted ? getConnsViaSsh(host) : [],
    online ? getServer2().catch(() => null) : null,
  ]);
  const system = (agent && agent.system) || sshSys || null;
  const agentConns = ((agent && agent.conns) || []).map((c) => ({
    ip: String(c.ip || ''), port: Number(c.port) || 0,
    dir: Number(c.port) < 10000 ? 'in' : 'out', via: 'agent',
  })).filter((c) => c.ip.startsWith(SUBNET + '.') && c.port !== 9419); // 9419 = kendi ajan yoklamamız
  const seen = new Set(sshConns.map((c) => c.ip));
  const conns = [...sshConns, ...agentConns.filter((c) => !seen.has(c.ip))];
  res.json({
    backend: true,
    host,
    online,
    pingMs: icmp.pingMs ?? ports.find((p) => p.open)?.latencyMs ?? null,
    ports,
    system, // ajan (Windows) veya SSH (Linux) kaynaklı; yoksa null
    systemSrc: (agent && agent.system) ? 'agent' : (sshSys ? 'ssh' : null),
    drives: (agent && agent.drives) || null,
    boot: (agent && agent.boot) || null,
    ortakGB: (agent && agent.ortakGB) ?? null,
    conns, // hedefle o an aktif TCP konuşan LAN IP'leri (gerçek veri akışı)
    agentOk: Boolean(agent && agent.ok),
    sshConfigured: Boolean(process.env.SSH_USER && (process.env.SSH_PASS || process.env.SSH_KEY_PATH)),
    at: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n  NEXUS backend hazır → http://localhost:${PORT}`);
  console.log(`  Test: http://localhost:${PORT}/api/status?host=${DEFAULT_HOST}`);
  if (!process.env.AP_PASS) console.log('  AP şifresi yok → kablolu/kablosuz ayrımı yapılamaz. Örnek: AP_PASS=xxx node server.js');
  console.log('');
});
