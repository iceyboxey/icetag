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
const MAX_MSGS_PER_SEC = 40;     // per player, extra messages are dropped
const EXTRA_LEN = 8;             // optional tail: colour r,g,b (-1 = none), then cosmetic ids head, face, body, left hand, right hand (0 = none)
const STATE_LEN = 18;            // head xyz, yaw, then left and right hand: xyz + quaternion xyzw

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.css': 'text/css' };

const server = http.createServer((req, res) => {
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

const wss = new WebSocketServer({ server, maxPayload: 2048 });
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
      send(ws, { t: 'welcome', id: c.id, room, peers, v: 2 });
      for (const p of members.values()) if (p !== c) send(p.ws, { t: 'join', id: c.id, name: c.name });
    } else if (m.t === 's' && c.room) {
      const st = validState(m.s);
      if (st) { c.state = st; c.dirty = true; }
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
