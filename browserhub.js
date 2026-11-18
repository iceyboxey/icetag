'use strict';
// Cloud browser for the VR monitor: a real Chromium on this server opens the page and sends a picture of it about 5 times a second.
// The game sends back clicks, scrolling and typing. Needs the "playwright" package and Chromium (see Dockerfile).
let pw = null;
try { pw = require('playwright'); } catch (e) { try { pw = require('playwright-core'); } catch (e2) { /* no browser installed */ } }
const chromium = pw && pw.chromium;
const ENGINE = (process.env.BROWSER_ENGINE || 'chromium').toLowerCase();   // chromium's headless shell with tiny-memory flags fits a 512 MB free instance best; BROWSER_ENGINE=firefox is available
const dns = require('dns').promises;
const net = require('net');

const VW = 880, VH = 562, FRAME_MS = 200;
const MAX_SESSIONS = Math.max(1, parseInt(process.env.BROWSER_MAX || '1', 10) || 2);
const ALLOW_PRIVATE = process.env.BROWSER_ALLOW_PRIVATE === '1';   // only for testing on one machine
const IDLE_MS = 5 * 60 * 1000;
const LIGHT = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--single-process', '--no-zygote', '--renderer-process-limit=1', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-breakpad', '--disable-features=site-per-process,IsolateOrigins,TranslateUI', '--js-flags=--max-old-space-size=' + (parseInt(process.env.BROWSER_HEAP_MB || '512', 10) || 512)];
let browserP = null, sessions = 0, closeT = null;
function maybeClose() {   // give the memory back when nobody is browsing
  clearTimeout(closeT);
  closeT = setTimeout(() => { if (sessions === 0 && browserP) { const b = browserP; browserP = null; b.then((x) => x.close()).catch(() => {}); } }, 20000);
}

function getBrowser() {
  clearTimeout(closeT);
  if (!browserP) {
    const useFx = ENGINE === 'firefox' && pw && pw.firefox;
    const first = useFx
      ? pw.firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 5, 'media.peerconnection.enabled': false, 'dom.ipc.processCount': 1, 'browser.cache.memory.capacity': 16384, 'permissions.default.geo': 2 } })
      : chromium.launch({ args: LIGHT });
    browserP = first
      .catch((e) => { if (!useFx) throw e; console.log('[browser] firefox failed, using chromium:', e.message); return chromium.launch({ args: LIGHT }); })
      .then((b) => { b.on('disconnected', () => { browserP = null; }); return b; })
      .catch((e) => { browserP = null; throw e; });
  }
  return browserP;
}

function privateIp(ip) {   // loopback, private, link-local and other internal ranges: a visitor must never reach these through this server
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::' || s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? privateIp(m[1]) : false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const hostCache = new Map();   // host -> { ok, t }
async function hostOk(host) {
  if (ALLOW_PRIVATE) return true;
  const c = hostCache.get(host);
  if (c && Date.now() - c.t < 60000) return c.ok;
  let ok = false;
  try {
    if (net.isIP(host)) ok = !privateIp(host);
    else if (/^localhost$|\.local$|\.internal$/i.test(host)) ok = false;
    else { const a = await dns.lookup(host, { all: true }); ok = a.length > 0 && !a.some((x) => privateIp(x.address)); }
  } catch (e) { ok = false; }
  hostCache.set(host, { ok, t: Date.now() });
  if (hostCache.size > 500) hostCache.clear();
  return ok;
}
async function safeUrl(u) {
  let url; try { url = new URL(String(u)); } catch (e) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return (await hostOk(url.hostname.replace(/^\[|\]$/g, ''))) ? url.href : null;
}

const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };

function attach(wss) {
  wss.on('connection', (ws) => {
    const say = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    if (!chromium) { say({ t: 'err', msg: 'This server has no browser installed' }); ws.close(); return; }
    if (sessions >= MAX_SESSIONS) { say({ t: 'err', msg: 'The cloud browser is busy, try again in a minute' }); ws.close(); return; }
    sessions++;
    let ctx = null, page = null, alive = true, busy = false, timer = null, last = null, idle = Date.now(), mx = VW / 2, my = VH / 2, msgs = 0, win = Date.now();
    const end = async () => {
      if (!alive) return; alive = false; sessions--; clearInterval(timer);
      try { if (ctx) await ctx.close(); } catch (e) { /* already gone */ }
      if (sessions === 0) maybeClose();
    };
    ws.on('close', end); ws.on('error', end);
    (async () => {
      const br = await getBrowser();
      ctx = await br.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
      await ctx.route('**/*', async (route) => {   // every request, not only the first page, must be to a public address
        const u = route.request().url();
        if (/^(data|blob|about):/i.test(u)) return route.continue();
        if (['media', 'font'].includes(route.request().resourceType())) return route.abort();   // videos and web fonts are heavy and not needed
        return (await safeUrl(u)) ? route.continue() : route.abort();
      });
      page = await ctx.newPage();
      page.on('popup', (p) => { p.close().catch(() => {}); });
      if (!alive) { await end(); return; }
      say({ t: 'ready', w: VW, h: VH });
      timer = setInterval(async () => {
        if (busy || !page || ws.readyState !== 1 || ws.bufferedAmount > 500000) return;
        if (Date.now() - idle > IDLE_MS) { ws.close(); return; }
        busy = true;
        try {
          const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 2500 });
          if (!(last && last.equals(buf)) && ws.readyState === 1) ws.send(buf, { binary: true });
          last = buf;
        } catch (e) { /* page busy loading: try again next tick */ }
        busy = false;
      }, FRAME_MS);
    })().catch((e) => { console.log('[browser] start failed', e.message); say({ t: 'err', msg: 'The browser could not start' }); ws.close(); });

    ws.on('message', async (data, isBinary) => {
      if (isBinary || !page || !alive) return;
      const now = Date.now(); if (now - win > 1000) { win = now; msgs = 0; } if (++msgs > 40) return;
      idle = now;
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      try {
        if (m.t === 'go') {
          const u = await safeUrl(String(m.url || '').slice(0, 600));
          if (!u) { say({ t: 'err', msg: 'That address is not allowed' }); return; }
          page.goto(u, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {});
        } else if (m.t === 'click') {
          mx = num(m.x, 0, VW - 1, mx); my = num(m.y, 0, VH - 1, my);
          await page.mouse.click(mx, my);
        } else if (m.t === 'scroll') {
          if (m.x !== undefined) { mx = num(m.x, 0, VW - 1, mx); my = num(m.y, 0, VH - 1, my); }
          await page.mouse.move(mx, my); await page.mouse.wheel(0, num(m.dy, -2000, 2000, 0));
        } else if (m.t === 'type') {
          await page.keyboard.type(String(m.text || '').slice(0, 40));
        } else if (m.t === 'key' && KEYS.has(m.key)) {
          await page.keyboard.press(m.key);
        } else if (m.t === 'back') { await page.goBack({ timeout: 8000 }).catch(() => {}); }
        else if (m.t === 'reload') { await page.reload({ timeout: 15000 }).catch(() => {}); }
      } catch (e) { /* the page changed under us: ignore */ }
    });
  });
}
module.exports = { attach, safeUrl, privateIp };
