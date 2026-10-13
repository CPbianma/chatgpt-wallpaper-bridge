#!/usr/bin/env node
/**
 * ChatGPT Wallpaper bridge — puts Wallpaper Engine media behind the official
 * Windows ChatGPT / Codex desktop app, with playlist rotation.
 *
 * Talks to the app over its local Chromium DevTools endpoint; media is served
 * to the page through CDP Fetch interception on a virtual host. No app files
 * are patched and no local HTTP server is opened. Node >= 22, zero npm deps.
 *
 * Commands:
 *   start                 Attach & inject (default). Stays in foreground.
 *   stop                  Remove the layer from the app and kill the bridge.
 *   list [--all]          List the Wallpaper Engine library.
 *   set <tokens...>       Replace the playlist (workshop ids / file paths / titles).
 *   add <tokens...>       Append to the playlist.
 *   clear                 Empty the playlist.
 *   next | prev           Switch wallpaper now (resets the rotation timer).
 *   rotate [opts]         --interval <sec>  --order sequential|shuffle  --on/--off
 *   fx [opts]             --opacity --brightness --saturate --blur --fade-ms
 *                         --panel-alpha --panel-alpha-dark --panel-blur --composer-alpha
 *   status                Show config and the live in-page state.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CDP, devtoolsPorts, appPages } from './cdp.mjs';
import { APP_DIR, CONFIG_FILE, PID_FILE, readConfig, writeConfig, numberArg } from './config.mjs';
import { scanLibrary, resolveItem, contentType } from './library.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = fs.readFileSync(path.join(SCRIPT_DIR, 'inject.js'), 'utf8');
const VIRTUAL_HOST = 'https://wallpaper.local';
const CHUNK_BYTES = 2 * 1024 * 1024;
const ATTACH_POLL_MS = 3000;

/* ---------------- CLI plumbing ---------------- */

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined; };
const hasFlag = (name) => rest.includes(name);
const VALUE_OPTS = new Set(['--interval', '--order', '--opacity', '--brightness', '--saturate', '--blur', '--fade-ms', '--panel-alpha', '--panel-alpha-dark', '--panel-blur', '--composer-alpha']);
// positional args = everything that is neither an option flag nor an option value
function positionals() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_OPTS.has(rest[i])) { i++; continue; }
    if (rest[i].startsWith('-')) continue;
    out.push(rest[i]);
  }
  return out;
}

function usage() { console.log(fs.readFileSync(new URL('./usage.txt', import.meta.url), 'utf8')); }

function killRecordedBridge() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch {} return pid; }
  } catch {}
  return 0;
}
const bridgeAlive = () => {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid === process.pid ? 0 : pid;
  } catch { return 0; }
};

/* ---------------- rotation ---------------- */

function nextIndex(cfg, from) {
  const n = cfg.playlist.length;
  if (n < 2) return 0;
  if (cfg.order === 'shuffle') {
    let k = from;
    while (k === from) k = Math.floor(Math.random() * n);
    return k;
  }
  return (from + 1) % n;
}

// Advance the pointer if the interval elapsed. Returns true if config changed.
function advanceIfDue(cfg) {
  const n = cfg.playlist.length;
  if (n === 0) return false;
  const now = Date.now();
  cfg.currentIndex = Math.min(Math.max(0, cfg.currentIndex | 0), n - 1);
  if (!cfg.lastSwitchAt) { cfg.lastSwitchAt = now; return true; }
  if (n < 2) return false;
  const due = Math.floor((now - cfg.lastSwitchAt) / (cfg.intervalSec * 1000));
  if (due <= 0) return false;
  for (let i = 0; i < Math.min(due, n); i++) cfg.currentIndex = nextIndex(cfg, cfg.currentIndex);
  cfg.lastSwitchAt = now;
  return true;
}

/* ---------------- bridge (start) ---------------- */

async function cmdStart() {
  const alive = bridgeAlive();
  if (alive) {
    console.log(`Bridge already running (pid ${alive}). Use "stop" first if you want a restart.`);
    await pokePages();
    return;
  }
  killRecordedBridge();

  let cfg = readConfig();
  cfg.playlist = cfg.playlist.filter((x) => x && x.path && fs.existsSync(x.path));
  if (!cfg.playlist.length) {
    // first run convenience: seed the playlist with every video wallpaper in the library
    const lib = scanLibrary().filter((x) => x.kind === 'video');
    if (!lib.length) { console.error('No Wallpaper Engine media found. Use "set" with explicit file paths.'); process.exit(1); }
    cfg.playlist = lib.map(({ kind, path: p, title, id }) => ({ kind, path: p, title, id }));
    cfg.currentIndex = 0; cfg.lastSwitchAt = Date.now();
    console.log(`Seeded playlist with ${cfg.playlist.length} video wallpapers from the library.`);
  }
  advanceIfDue(cfg);
  writeOwnConfig(cfg);

  const sessions = new Map(); // targetId -> CDP
  let writingSelf = false;
  function writeOwnConfig(c) { writingSelf = true; try { writeConfig(c); } finally { setTimeout(() => { writingSelf = false; }, 300); } }

  async function attach(p) {
    const c = new CDP(p.webSocketDebuggerUrl);
    try {
      await c.open();
      await c.send('Page.enable').catch(() => {});
      await c.send('Page.setBypassCSP', { enabled: true }).catch(() => {});
      c.on((m) => {
        if (m.method === 'Fetch.requestPaused') void routeRequest(c, m.params);
        if (m.method === 'Page.frameNavigated' && m.params?.frame?.parentId === undefined)
          c.send('Page.setBypassCSP', { enabled: true }).catch(() => {});
        if (m.method === 'Inspector.targetCrashed' || m.method === 'Target.targetDestroyed') drop(p.id);
      });
      await c.send('Fetch.enable', { patterns: [{ urlPattern: `${VIRTUAL_HOST}/*`, requestStage: 'Request' }] });
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SRC }).catch(() => {});
      await c.send('Runtime.evaluate', { expression: INJECT_SRC, returnByValue: true }).catch(() => {});
      c.ws.onclose = () => drop(p.id);
      sessions.set(p.id, c);
      console.log(`[bridge] attached to page ${p.id.slice(0, 8)} (${p.url})`);
    } catch (e) { c.close(); }
  }
  const drop = (id) => { const c = sessions.get(id); if (c) { sessions.delete(id); c.close(); } };

  // config file watch: CLI edits take effect without restarting the bridge
  fs.mkdirSync(APP_DIR, { recursive: true });
  let debounce = 0;
  fs.watch(APP_DIR, (ev, file) => {
    if (file !== 'config.json' || writingSelf) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      cfg = readConfig();
      cfg.playlist = cfg.playlist.filter((x) => x && x.path && fs.existsSync(x.path));
      await pokePages();
    }, 250);
  });

  async function routeRequest(c, params) {
    const req = params.request || {};
    const u = new URL(req.url || '/', VIRTUAL_HOST);
    const fulfill = (code, headers, body) => c.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: code, responseHeaders: headers, body }).catch(() => {});
    if (u.pathname === '/api/state') {
      if (advanceIfDue(cfg)) writeOwnConfig(cfg);
      const body = JSON.stringify({
        epoch: cfg.epoch || 0,
        index: cfg.currentIndex,
        intervalSec: cfg.intervalSec,
        order: cfg.order,
        effects: cfg.effects,
        items: cfg.playlist.map((x) => ({ kind: x.kind, title: x.title })),
      });
      return fulfill(200, [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: '*' }], Buffer.from(body).toString('base64'));
    }
    if (u.pathname === '/api/skip') {
      const i = Number(u.searchParams.get('i'));
      if (Number.isInteger(i) && i === cfg.currentIndex && cfg.playlist.length > 1) {
        cfg.currentIndex = nextIndex(cfg, cfg.currentIndex);
        cfg.lastSwitchAt = Date.now();
        writeOwnConfig(cfg);
        console.log(`[bridge] skipped unreadable item #${i}`);
      }
      return fulfill(204, [{ name: 'Access-Control-Allow-Origin', value: '*' }]);
    }
    const m = /^\/media\/(\d+)$/.exec(u.pathname);
    if (m) {
      const item = cfg.playlist[Number(m[1])];
      if (!item || !fs.existsSync(item.path)) return c.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'NotFound' }).catch(() => {});
      return serveFile(c, params, item.path);
    }
    return fulfill(404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('not found').toString('base64'));
  }

  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  const cur = cfg.playlist[cfg.currentIndex];
  console.log(`[bridge] running (pid ${process.pid}) — ${cfg.playlist.length} wallpapers, every ${cfg.intervalSec}s, ${cfg.order}`);
  console.log(`[bridge] now showing: ${cur ? cur.title : '(empty playlist)'}`);

  const attachLoop = async () => {
    for (const p of await appPages()) if (!sessions.has(p.id)) await attach(p);
  };
  await attachLoop();
  const timer = setInterval(attachLoop, ATTACH_POLL_MS);

  const shutdown = () => {
    clearInterval(timer);
    try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
    for (const c of sessions.values()) c.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

async function serveFile(c, params, file) {
  const req = params.request || {};
  if (req.method !== 'GET')
    return c.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }).catch(() => {});
  const headers = req.headers || {};
  const rangeHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === 'range')?.[1] || '';
  let stat; try { stat = await fsp.stat(file); } catch { return c.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }).catch(() => {}); }
  const range = /bytes=(\d+)-(\d*)/i.exec(rangeHeader);
  let start = range ? Number(range[1]) : 0;
  if (!Number.isSafeInteger(start) || start >= stat.size) start = 0;
  let end = range && range[2] ? Number(range[2]) : Math.min(stat.size - 1, start + CHUNK_BYTES - 1);
  end = Math.min(stat.size - 1, Math.max(start, end), start + CHUNK_BYTES - 1);
  const fh = await fsp.open(file, 'r');
  let data;
  try { data = Buffer.alloc(end - start + 1); await fh.read(data, 0, data.length, start); } finally { await fh.close(); }
  const hs = [
    { name: 'Content-Type', value: contentType(file) },
    { name: 'Accept-Ranges', value: 'bytes' },
    { name: 'Content-Length', value: String(data.length) },
    { name: 'Cache-Control', value: 'no-store' },
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
  ];
  if (range) hs.push({ name: 'Content-Range', value: `bytes ${start}-${end}/${stat.size}` });
  await c.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: range ? 206 : 200, responseHeaders: hs, body: data.toString('base64') }).catch(() => {});
}

/* ---------------- one-shot commands ---------------- */

async function pokePages(expression = 'window.__wallpaper && window.__wallpaper.refresh()') {
  const pages = await appPages();
  let ok = 0;
  for (const p of pages) {
    const c = new CDP(p.webSocketDebuggerUrl);
    try { await c.open(); await c.send('Runtime.evaluate', { expression, returnByValue: true }); ok++; } catch {} finally { c.close(); }
  }
  return ok;
}

async function cmdStop() {
  const pid = killRecordedBridge();
  if (pid) { console.log(`Stopped bridge (pid ${pid}).`); await new Promise((r) => setTimeout(r, 300)); }
  try { fs.unlinkSync(PID_FILE); } catch {}
  const n = await pokePages('window.__wallpaper && window.__wallpaper.destroy()');
  console.log(n ? `Removed wallpaper layer from ${n} page(s).` : 'No app page found (layer was not active or app is closed).');
}

async function cmdList() {
  const lib = scanLibrary();
  const videos = lib.filter((x) => x.kind === 'video');
  const previews = lib.filter((x) => x.kind === 'image');
  const showAll = hasFlag('--all');
  const rows = showAll ? lib : videos;
  console.log(`Wallpaper Engine library: ${videos.length} video, ${previews.length} preview-only (scene/web).${showAll ? '' : ' Showing videos — pass --all for everything.'}\n`);
  rows.forEach((x, i) => {
    const size = (() => { try { return (fs.statSync(x.path).size / 1048576).toFixed(0) + ' MB'; } catch { return '?'; } })();
    console.log(`${String(i + 1).padStart(3)}  ${x.id || '-'}  ${x.kind.padEnd(5)}  ${size.padStart(7)}  ${x.title}`);
  });
}

function mutatePlaylist(mutator) {
  const cfg = readConfig();
  const lib = scanLibrary();
  const tokens = positionals();
  if (!tokens.length) { console.error('Give at least one workshop id, file path, or title.'); process.exit(1); }
  const items = tokens.map((t) => { const it = resolveItem(t, lib); return { kind: it.kind, path: it.path, title: it.title, id: it.id }; });
  mutator(cfg, items);
  cfg.currentIndex = Math.min(cfg.currentIndex, Math.max(0, cfg.playlist.length - 1));
  cfg.lastSwitchAt = Date.now();
  cfg.epoch = Date.now();
  writeConfig(cfg);
  return cfg;
}

async function cmdSet() {
  const cfg = mutatePlaylist((c, items) => { c.playlist = items; c.currentIndex = 0; });
  console.log(`Playlist set (${cfg.playlist.length}):`);
  cfg.playlist.forEach((x, i) => console.log(`  ${i + 1}. [${x.kind}] ${x.title}`));
  await pokePages();
}

async function cmdAdd() {
  const cfg = mutatePlaylist((c, items) => { c.playlist.push(...items); });
  console.log(`Added — playlist now ${cfg.playlist.length} items.`);
  await pokePages();
}

async function cmdClear() {
  const cfg = readConfig();
  cfg.playlist = []; cfg.currentIndex = 0; cfg.lastSwitchAt = 0; cfg.epoch = Date.now();
  writeConfig(cfg);
  console.log('Playlist cleared.');
  await pokePages();
}

async function cmdStep(dir) {
  const cfg = readConfig();
  const n = cfg.playlist.length;
  if (!n) { console.error('Playlist is empty — use "set" first.'); process.exit(1); }
  cfg.currentIndex = ((cfg.currentIndex + dir) % n + n) % n;
  cfg.lastSwitchAt = Date.now();
  writeConfig(cfg);
  console.log(`→ ${cfg.currentIndex + 1}/${n}  ${cfg.playlist[cfg.currentIndex].title}`);
  await pokePages();
}

async function cmdRotate() {
  const cfg = readConfig();
  if (opt('--interval') !== undefined) cfg.intervalSec = numberArg(opt('--interval'), cfg.intervalSec, 5, 86400);
  if (opt('--order') !== undefined) cfg.order = opt('--order') === 'shuffle' ? 'shuffle' : 'sequential';
  if (hasFlag('--off')) cfg.intervalSec = 365 * 86400; // effectively pinned
  if (hasFlag('--on') && cfg.intervalSec > 86400) cfg.intervalSec = 600;
  cfg.lastSwitchAt = Date.now();
  cfg.epoch = Date.now();
  writeConfig(cfg);
  console.log(`Rotation: every ${cfg.intervalSec}s, ${cfg.order}.`);
  await pokePages();
}

async function cmdFx() {
  const cfg = readConfig();
  const e = cfg.effects;
  const set = (flag, key, lo, hi) => { const v = opt(flag); if (v !== undefined) e[key] = numberArg(v, e[key], lo, hi); };
  set('--opacity', 'opacity', 0, 1);
  set('--brightness', 'brightness', 0, 4);
  set('--saturate', 'saturate', 0, 4);
  set('--blur', 'blur', 0, 40);
  set('--fade-ms', 'fadeMs', 0, 5000);
  set('--panel-alpha', 'panelAlpha', 0.05, 1);
  set('--panel-alpha-dark', 'panelAlphaDark', 0.05, 1);
  set('--panel-blur', 'panelBlur', 0, 60);
  set('--composer-alpha', 'composerAlpha', 0.05, 1);
  cfg.epoch = Date.now();
  writeConfig(cfg);
  console.log('Effects:', JSON.stringify(cfg.effects));
  await pokePages();
}

async function cmdStatus() {
  const cfg = readConfig();
  const pid = bridgeAlive();
  console.log(`Bridge: ${pid ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Playlist: ${cfg.playlist.length} item(s), current #${cfg.currentIndex + 1}, every ${cfg.intervalSec}s, ${cfg.order}`);
  cfg.playlist.forEach((x, i) => console.log(`  ${i === cfg.currentIndex ? '→' : ' '} ${i + 1}. [${x.kind}] ${x.title}`));
  console.log('Effects:', JSON.stringify(cfg.effects));
  const pages = await appPages();
  for (const p of pages) {
    const c = new CDP(p.webSocketDebuggerUrl);
    try {
      await c.open();
      const r = await c.send('Runtime.evaluate', { expression: 'window.__wallpaper ? JSON.stringify(window.__wallpaper.state()) : "not injected"', returnByValue: true });
      console.log(`Page ${p.id.slice(0, 8)}: ${r.result.value}`);
    } catch {} finally { c.close(); }
  }
  if (!pages.length) console.log('No app page found — is the ChatGPT app open?');
}

/* ---------------- dispatch ---------------- */

const main = async () => {
  switch (cmd) {
    case 'start': return cmdStart();
    case 'stop': return cmdStop();
    case 'list': return cmdList();
    case 'set': return cmdSet();
    case 'add': return cmdAdd();
    case 'clear': return cmdClear();
    case 'next': return cmdStep(1);
    case 'prev': return cmdStep(-1);
    case 'rotate': return cmdRotate();
    case 'fx': return cmdFx();
    case 'status': return cmdStatus();
    case 'help': case '--help': case '-h': return usage();
    default: console.error(`Unknown command: ${cmd}\n`); usage(); process.exit(1);
  }
};

main().catch((e) => { console.error(`chatgpt-wallpaper: ${e.message}`); process.exitCode = 1; });
