'use strict';
// Monke multiplayer relay: players send their head and hand poses, the server fans them out to everyone in the same room.
// It also serves ./public (put index.html there to host the game from the same address).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 16;          // per room
const TICK_MS = 66;              // about 15 snapshots per second
const MAX_MSGS_PER_SEC = 120;    // per player, extra messages are dropped (voice chat set-up sends a burst of small messages)
const EXTRA_LEN = 8;             // optional tail: colour r,g,b (-1 = none), then cosmetic ids head, face, body, left hand, right hand (0 = none)
const STATE_LEN = 18;            // head xyz, yaw, then left and right hand: xyz + quaternion xyzw

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.css': 'text/css' };

// ---- cosmetic problem reports: POST /report  ->  an email to the owner (set REPORT_TO and RESEND_API_KEY on the host; nothing is hard-coded) ----
const REPORT_TO = process.env.REPORT_TO || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const REPORT_FROM = process.env.REPORT_FROM || 'Sigma Tag <onboarding@resend.dev>';
const reportSeen = new Map();   // ip -> { windowStart, count, keys:Set }
const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
function handleReport(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  let r = reportSeen.get(ip);
  if (!r || now - r.windowStart > 3600000) { r = { windowStart: now, count: 0, keys: new Set() }; reportSeen.set(ip, r); }
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4000) req.destroy(); });
  req.on('end', async () => {
    let j; try { j = JSON.parse(body); } catch (e) { res.writeHead(400, CORS); res.end('bad json'); return; }
    const key = clip(j.id, 20) + '|' + clip(j.name, 60);
    if (++r.count > 12) { res.writeHead(429, CORS); res.end('too many reports'); return; }
    if (r.keys.has(key)) { res.writeHead(200, CORS); res.end('already reported'); return; }
    r.keys.add(key);
    const text = ['A cosmetic does not work in Sigma Tag.', '',
      'Name: ' + clip(j.name, 80), 'Id: ' + clip(j.id, 20), 'Key: ' + clip(j.key, 60), 'Tab: ' + clip(j.tab, 20), 'Owned: ' + clip(j.owned, 5),
      'Build: ' + clip(j.build, 20), 'Player: ' + clip(j.player, 20), 'Room: ' + clip(j.room, 20), 'Device: ' + clip(j.device, 160), 'Note: ' + clip(j.note, 300)].join('\n');
    console.log('[report]', text.replace(/\n/g, ' | '));
    if (!REPORT_TO || !RESEND_API_KEY) { res.writeHead(202, CORS); res.end('logged (email not set up on the server)'); return; }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: REPORT_FROM, to: [REPORT_TO], subject: 'Sigma Tag cosmetic not working: ' + clip(j.name, 60), text })
      });
      if (!resp.ok) { console.log('[report] email service said', resp.status, (await resp.text()).slice(0, 200)); res.writeHead(502, CORS); res.end('email failed'); return; }
      res.writeHead(200, CORS); res.end('sent');
    } catch (e) { console.log('[report] email error', e.message); res.writeHead(502, CORS); res.end('email failed'); }
  });
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.split('?')[0] === '/report') {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === 'POST') { handleReport(req, res); return; }
  }
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Monke multiplayer server is running.\n');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const bwss = new WebSocketServer({ noServer: true, maxPayload: 4096 });   // the cloud browser for the VR monitor
require('./browserhub').attach(bwss);
server.on('upgrade', (req, socket, head) => {
  const target = (req.url || '').split('?')[0] === '/browser' ? bwss : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});
const rooms = new Map();   // room name -> Map(id -> client)
let nextId = 1;

const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16) || 'monke';
const cleanRoom = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 16) || 'main';
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function validState(a) {
  if (!Array.isArray(a) || (a.length !== STATE_LEN && a.length !== STATE_LEN + EXTRA_LEN)) return null;
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10000) return null;
    out[i] = Math.round(v * 1000) / 1000;
  }
  return out;
}

wss.on('connection', (ws) => {
  const c = { id: nextId++, ws, name: 'monke', room: null, state: null, dirty: false, alive: true, count: 0, windowStart: Date.now() };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - c.windowStart > 1000) { c.windowStart = now; c.count = 0; }
    if (++c.count > MAX_MSGS_PER_SEC) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !c.room) {
      const room = cleanRoom(m.room);
      const members = rooms.get(room) || new Map();
      if (members.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      c.name = cleanName(m.name); c.room = room;
      const peers = [...members.values()].map((p) => ({ id: p.id, name: p.name }));
      members.set(c.id, c); rooms.set(room, members);
      send(ws, { t: 'welcome', id: c.id, room, peers, v: 2, voice: true });
      for (const p of members.values()) if (p !== c) send(p.ws, { t: 'join', id: c.id, name: c.name });
    } else if (m.t === 's' && c.room) {
      const st = validState(m.s);
      if (st) { c.state = st; c.dirty = true; }
    } else if (m.t === 'sig' && c.room) {
      // voice chat set-up (WebRTC offers, answers, ICE candidates): pass it on to one player in the same room, the audio itself never touches the server
      const to = (rooms.get(c.room) || new Map()).get(Number(m.to));
      if (to && to !== c && m.d && typeof m.d === 'object') {
        const txt = JSON.stringify(m.d);
        if (txt.length < 6000) send(to.ws, { t: 'sig', from: c.id, d: m.d });
      }
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong' });
    }
  });
  ws.on('close', () => {
    if (!c.room) return;
    const members = rooms.get(c.room);
    if (!members) return;
    members.delete(c.id);
    for (const p of members.values()) send(p.ws, { t: 'leave', id: c.id });
    if (members.size === 0) rooms.delete(c.room);
  });
  ws.on('error', () => {});
});

// fan out snapshots
setInterval(() => {
  for (const members of rooms.values()) {
    const changed = [...members.values()].filter((p) => p.dirty && p.state);
    if (!changed.length) continue;
    for (const to of members.values()) {
      const s = changed.filter((p) => p !== to).map((p) => [p.id, ...p.state]);
      if (s.length) send(to.ws, { t: 'snap', s });
    }
    for (const p of changed) p.dirty = false;
  }
}, TICK_MS);

// drop connections that stopped answering pings (also keeps idle connections open through proxies)
setInterval(() => {
  for (const members of rooms.values()) {
    for (const c of members.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch (e) { /* closing */ }
    }
  }
}, 25000);

server.listen(PORT, () => console.log('Monke multiplayer listening on ' + PORT));
