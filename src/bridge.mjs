#!/usr/bin/env node
/**
 * ChatGPT Wallpaper bridge — Wallpaper Engine media behind the official
 * Windows ChatGPT / Codex desktop app, with playlists, transitions and an
 * in-app control panel.
 *
 * Talks to the app over its local Chromium DevTools endpoint; media and
 * thumbnails are served to the page through CDP Fetch interception on a
 * virtual host (no local HTTP server, no patched app files). Because the app
 * patches window.fetch to an allow-list, page -> bridge commands ride tiny
 * Image GETs to /api/cmd, and bridge -> page state is pushed over CDP
 * Runtime.evaluate. Node >= 22, zero npm deps.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CDP, appPages } from './cdp.mjs';
import { APP_DIR, CONFIG_FILE, PID_FILE, PRESET_DIR, DEFAULT_FX, readConfig, writeConfig, activeList, numberArg, clamp } from './config.mjs';
import { scanLibrary, resolveItem, contentType } from './library.mjs';
import { applyCommand, nextIndex } from './commands.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = fs.readFileSync(path.join(SCRIPT_DIR, 'inject.js'), 'utf8');
const PANEL_SRC = fs.readFileSync(path.join(SCRIPT_DIR, 'panel.js'), 'utf8');
const INJECT_ALL = INJECT_SRC + '\n;' + PANEL_SRC;
const VIRTUAL_HOST = 'https://wallpaper.local';
const CHUNK_BYTES = 2 * 1024 * 1024;
const ATTACH_POLL_MS = 3000;
const PUSH_MS = 2500;
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/* ---------------- CLI plumbing ---------------- */

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const rest = cmd === argv[0] ? argv.slice(1) : argv;
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined; };
const hasFlag = (name) => rest.includes(name);
const VALUE_OPTS = new Set(['--interval', '--order', '--opacity', '--brightness', '--contrast', '--saturate', '--blur', '--dim', '--pan-x', '--pan-y', '--zoom', '--rate', '--volume', '--fade-ms', '--transition', '--transition-dir', '--transition-speed', '--panel-alpha', '--panel-alpha-dark', '--panel-blur', '--composer-alpha', '--name', '--key', '--id']);
const positionals = () => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_OPTS.has(rest[i])) { i++; continue; }
    if (rest[i].startsWith('-')) continue;
    out.push(rest[i]);
  }
  return out;
};

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

// Advance the pointer if the interval elapsed. Returns true if config changed.
function advanceIfDue(cfg) {
  const list = activeList(cfg);
  const n = list ? list.items.length : 0;
  if (!n) return false;
  const now = Date.now();
  cfg.currentIndex = Math.min(Math.max(0, cfg.currentIndex | 0), n - 1);
  if (!cfg.lastSwitchAt) { cfg.lastSwitchAt = now; return true; }
  if (n < 2) return false;
  const due = Math.floor((now - cfg.lastSwitchAt) / (list.intervalSec * 1000));
  if (due <= 0) return false;
  for (let i = 0; i < Math.min(due, n); i++) cfg.currentIndex = nextIndex(cfg, cfg.currentIndex);
  cfg.lastSwitchAt = now;
  return true;
}

/* ---------------- shared command entry ---------------- */

function runCommand(cfg, cmdObj, ctx) {
  const r = applyCommand(cfg, cmdObj, ctx);
  if (r.changed) {
    cfg.epoch = Date.now();
    if (r.libChanged) cfg.libEpoch = Date.now();
    writeConfig(cfg);
  }
  return r;
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
  let library = scanLibrary();
  const sessions = new Map(); // targetId -> { cdp, libEpoch }
  let writingSelf = false;
  function writeOwnConfig(c) { writingSelf = true; try { writeConfig(c); } finally { setTimeout(() => { writingSelf = false; }, 300); } }

  for (const p of cfg.playlists) p.items = p.items.filter((x) => x && x.path && fs.existsSync(x.path));
  if (!activeList(cfg)?.items.length && library.length) {
    // first run convenience: seed the default list with every video wallpaper
    const vids = library.filter((x) => x.kind === 'video');
    cfg.playlists = [{ key: 'default', name: '全部视频壁纸', items: vids.map(({ kind, path: p, title, id }) => ({ kind, path: p, title, id })), intervalSec: 600, order: 'sequential' }];
    cfg.activePlaylist = 'default';
    cfg.currentIndex = 0;
    cfg.lastSwitchAt = Date.now();
    console.log(`Seeded playlist with ${vids.length} video wallpapers from the library.`);
  }
  advanceIfDue(cfg);
  writeOwnConfig(cfg);

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
      });
      await c.send('Fetch.enable', { patterns: [{ urlPattern: `${VIRTUAL_HOST}/*`, requestStage: 'Request' }] });
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_ALL }).catch(() => {});
      await c.send('Runtime.evaluate', { expression: INJECT_ALL, returnByValue: true }).catch(() => {});
      c.ws.onclose = () => drop(p.id);
      sessions.set(p.id, { cdp: c, libEpoch: -1 });
      console.log(`[bridge] attached to page ${p.id.slice(0, 8)} (${p.url})`);
    } catch (e) { c.close(); }
  }
  const drop = (id) => { const s = sessions.get(id); if (s) { sessions.delete(id); s.cdp.close(); } };

  // config file watch: CLI edits take effect without restarting the bridge
  fs.mkdirSync(APP_DIR, { recursive: true });
  let debounce = 0;
  fs.watch(APP_DIR, (ev, file) => {
    if (file !== 'config.json' || writingSelf) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      cfg = readConfig();
      for (const p of cfg.playlists) p.items = p.items.filter((x) => x && x.path && fs.existsSync(x.path));
      void pushState();
    }, 250);
  });

  function fulfill(c, params, code, headers, body) {
    return c.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: code, responseHeaders: headers, body }).catch(() => {});
  }

  async function routeRequest(c, params) {
    const req = params.request || {};
    const u = new URL(req.url || '/', VIRTUAL_HOST);
    // command channel (Image GET from the panel; also usable from any element)
    if (u.pathname === '/api/cmd') {
      try {
        const cmdObj = JSON.parse(decodeURIComponent(u.searchParams.get('c') || '{}'));
        const r = runCommand(cfg, cmdObj, { library });
        if (r.changed) { writeOwnConfig(cfg); await pushState(); }
        if (r.message) console.log(`[cmd] ${r.message}`);
      } catch (e) { console.log(`[cmd] bad command: ${e.message}`); }
      return fulfill(c, params, 200, [{ name: 'Content-Type', value: 'image/gif' }, { name: 'Cache-Control', value: 'no-store' }], PIXEL_GIF.toString('base64'));
    }
    // library thumbnail
    const tm = /^\/thumb\/(\w+)$/.exec(u.pathname);
    if (tm) {
      const item = library.find((x) => x.id === tm[1]);
      if (item?.thumb && fs.existsSync(item.thumb)) return serveFile(c, params, item.thumb);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no thumb').toString('base64'));
    }
    // playlist media
    const m = /^\/media\/(\d+)$/.exec(u.pathname);
    if (m) {
      const list = activeList(cfg);
      const item = list?.items[Number(m[1])];
      if (!item || !fs.existsSync(item.path)) return c.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'NotFound' }).catch(() => {});
      return serveFile(c, params, item.path);
    }
    return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('not found').toString('base64'));
  }

  function libPayload() {
    return library.map((x) => ({
      id: x.id, title: x.title, kind: x.kind, weType: x.weType,
      rating: x.rating, schemeColor: x.schemeColor, hasThumb: !!x.thumb,
      hidden: cfg.hidden.includes(x.id),
    }));
  }

  function listPresets() {
    try { return fs.readdirSync(PRESET_DIR).filter((x) => x.endsWith('.json')).map((x) => x.slice(0, -5)); } catch { return []; }
  }

  function statePayload(forSession) {
    const list = activeList(cfg);
    const p = {
      epoch: cfg.epoch || 0,
      libEpoch: cfg.libEpoch || 0,
      index: cfg.currentIndex,
      paused: !!cfg.paused,
      listKey: cfg.activePlaylist,
      listName: list?.name || '',
      intervalSec: list?.intervalSec || 600,
      order: list?.order || 'sequential',
      items: (list?.items || []).map((x) => ({ kind: x.kind, title: x.title, id: x.id })),
      playlists: cfg.playlists.map((x) => ({ key: x.key, name: x.name, count: x.items.length, intervalSec: x.intervalSec, order: x.order })),
      fx: cfg.fx,
      occlusion: cfg.occlusion,
      fxLayer: cfg.fxLayer,
      parallax: cfg.parallax,
      presets: listPresets(),
    };
    if (forSession && forSession.libEpoch !== (cfg.libEpoch || 0)) {
      p.lib = libPayload();
      forSession.libEpoch = cfg.libEpoch || 0;
    }
    return p;
  }

  // Push state into every attached page; read diagnostics back (failed media
  // -> skip). Runs on a timer and after every command/config change.
  async function pushState() {
    if (advanceIfDue(cfg)) {
      cfg.epoch = Date.now(); // pages & panels notice rotation through the epoch
      writeOwnConfig(cfg);
      const cur = activeList(cfg)?.items[cfg.currentIndex];
      if (cur) console.log(`[bridge] → ${cur.title}`);
    }
    for (const [id, s] of sessions) {
      try {
        const expr = `window.__wallpaper && window.__wallpaper.applyState(${JSON.stringify(statePayload(s))})`;
        const r = await s.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        const d = r?.result?.value;
        if (d && d.failed != null && d.failed === cfg.currentIndex && (activeList(cfg)?.items.length || 0) > 1) {
          cfg.currentIndex = nextIndex(cfg, cfg.currentIndex);
          cfg.lastSwitchAt = Date.now();
          writeOwnConfig(cfg);
          console.log(`[bridge] skipped unreadable wallpaper #${d.failed + 1}`);
        }
      } catch { drop(id); }
    }
  }

  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  const list = activeList(cfg);
  console.log(`[bridge] running (pid ${process.pid}) — list「${list?.name || '-'}」${list?.items.length || 0} 张, every ${list?.intervalSec || '-'}s, ${list?.order || '-'}`);
  console.log(`[bridge] now showing: ${list?.items[cfg.currentIndex]?.title || '(empty playlist)'}`);

  const attachLoop = async () => {
    for (const p of await appPages()) if (!sessions.has(p.id)) await attach(p);
  };
  await attachLoop();
  const timer = setInterval(attachLoop, ATTACH_POLL_MS);
  const pushTimer = setInterval(pushState, PUSH_MS);
  // library rescan (workshop installs change) — light touch, once a minute
  const libTimer = setInterval(() => {
    try {
      const fresh = scanLibrary();
      if (JSON.stringify(fresh.map((x) => x.id)) !== JSON.stringify(library.map((x) => x.id))) {
        library = fresh;
        cfg.libEpoch = Date.now();
        writeOwnConfig(cfg);
      }
    } catch {}
  }, 60000);
  await pushState();

  const shutdown = () => {
    clearInterval(timer); clearInterval(pushTimer); clearInterval(libTimer);
    try { if (Number(fs.readFileSync(PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PID_FILE); } catch {}
    for (const s of sessions.values()) s.cdp.close();
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

// Nudge every open page to apply the latest config immediately.
async function pokePages(expression) {
  if (!expression) {
    const cfg = readConfig();
    const list = activeList(cfg);
    const payload = {
      epoch: cfg.epoch || 0, libEpoch: cfg.libEpoch || 0,
      index: cfg.currentIndex, paused: !!cfg.paused,
      listKey: cfg.activePlaylist, listName: list?.name || '',
      intervalSec: list?.intervalSec || 600, order: list?.order || 'sequential',
      items: (list?.items || []).map((x) => ({ kind: x.kind, title: x.title, id: x.id })),
      playlists: cfg.playlists.map((x) => ({ key: x.key, name: x.name, count: x.items.length, intervalSec: x.intervalSec, order: x.order })),
      fx: cfg.fx, occlusion: cfg.occlusion, fxLayer: cfg.fxLayer, parallax: cfg.parallax,
    };
    expression = `window.__wallpaper && window.__wallpaper.applyState(${JSON.stringify(payload)})`;
  }
  const pages = await appPages();
  let ok = 0;
  for (const p of pages) {
    const c = new CDP(p.webSocketDebuggerUrl);
    try { await c.open(); await c.send('Runtime.evaluate', { expression, returnByValue: true }); ok++; } catch {} finally { c.close(); }
  }
  return ok;
}

// CLI command execution: run through the same applyCommand, persist, poke.
async function cliCmd(cmdObj, { quiet } = {}) {
  const cfg = readConfig();
  const library = scanLibrary();
  const r = runCommand(cfg, cmdObj, { library });
  if (r.message && !quiet) console.log(r.message);
  if (r.changed) await pokePages();
  return r;
}

async function cmdStop() {
  const pid = killRecordedBridge();
  if (pid) { console.log(`Stopped bridge (pid ${pid}).`); await new Promise((r) => setTimeout(r, 300)); }
  try { fs.unlinkSync(PID_FILE); } catch {}
  const n = await pokePages('window.__wallpaper && window.__wallpaper.destroy()');
  console.log(n ? `Removed wallpaper layer from ${n} page(s).` : 'No app page found (layer was not active or app is closed).');
}

async function cmdListLibrary() {
  const lib = scanLibrary();
  const cfg = readConfig();
  const showAll = hasFlag('--all');
  const videos = lib.filter((x) => x.kind === 'video');
  const previews = lib.filter((x) => x.kind === 'image');
  const rows = showAll ? lib : videos;
  console.log(`Wallpaper Engine library: ${videos.length} video, ${previews.length} preview-only (scene/web).${showAll ? '' : ' Showing videos — pass --all for everything.'}\n`);
  rows.forEach((x, i) => {
    const size = (() => { try { return (fs.statSync(x.path).size / 1048576).toFixed(0) + ' MB'; } catch { return '?'; } })();
    const hid = cfg.hidden.includes(x.id) ? ' [hidden]' : '';
    console.log(`${String(i + 1).padStart(3)}  ${x.id || '-'}  ${x.kind.padEnd(5)}  ${x.rating.padEnd(8)}  ${size.padStart(7)}  ${x.title}${hid}`);
  });
}

async function cmdSet() {
  const cfg = readConfig();
  const library = scanLibrary();
  const tokens = positionals();
  if (!tokens.length) { console.error('Give at least one workshop id, file path, or title.'); process.exit(1); }
  const items = tokens.map((t) => { const it = resolveItem(t, library); return { kind: it.kind, path: it.path, title: it.title, id: it.id }; });
  let list = activeList(cfg);
  if (!list) { list = { key: 'default', name: '默认列表', items: [], intervalSec: 600, order: 'sequential' }; cfg.playlists.push(list); cfg.activePlaylist = list.key; }
  list.items = items;
  cfg.currentIndex = 0;
  cfg.lastSwitchAt = Date.now();
  cfg.epoch = Date.now(); cfg.libEpoch = Date.now();
  writeConfig(cfg);
  console.log(`Playlist「${list.name}」set (${items.length}):`);
  items.forEach((x, i) => console.log(`  ${i + 1}. [${x.kind}] ${x.title}`));
  await pokePages();
}

async function cmdAdd() {
  const cfg = readConfig();
  const library = scanLibrary();
  const tokens = positionals();
  if (!tokens.length) { console.error('Give at least one workshop id, file path, or title.'); process.exit(1); }
  const items = tokens.map((t) => { const it = resolveItem(t, library); return { kind: it.kind, path: it.path, title: it.title, id: it.id }; });
  let list = activeList(cfg);
  if (!list) { list = { key: 'default', name: '默认列表', items: [], intervalSec: 600, order: 'sequential' }; cfg.playlists.push(list); cfg.activePlaylist = list.key; }
  list.items.push(...items);
  cfg.epoch = Date.now(); cfg.libEpoch = Date.now();
  writeConfig(cfg);
  console.log(`Added — 「${list.name}」now ${list.items.length} items.`);
  await pokePages();
}

async function cmdPlaylist() {
  const cfg = readConfig();
  const sub = rest[0];
  if (!sub || sub === 'ls') {
    cfg.playlists.forEach((p) => console.log(`${p.key === cfg.activePlaylist ? '→' : ' '} ${p.key}  「${p.name}」 ${p.items.length} 张  ${p.intervalSec}s  ${p.order}`));
    return;
  }
  if (sub === 'create') { await cliCmd({ c: 'list.create', name: opt('--name') || positionals().slice(1).join(' ') }); return; }
  if (sub === 'use') { await cliCmd({ c: 'list.use', key: opt('--key') || rest[1] }); return; }
  if (sub === 'rename') { await cliCmd({ c: 'list.rename', key: opt('--key') || cfg.activePlaylist, name: opt('--name') || positionals().slice(1).join(' ') }); return; }
  if (sub === 'delete') { await cliCmd({ c: 'list.delete', key: opt('--key') || rest[1] }); return; }
  console.error('playlist: ls | create --name N | use <key> | rename --name N | delete <key>');
}

async function cmdPreset() {
  const sub = rest[0];
  if (sub === 'save') {
    const name = opt('--name') || rest[1];
    if (!name) { console.error('preset save --name N'); process.exit(1); }
    await cliCmd({ c: 'preset.save', name });
    return;
  }
  if (sub === 'apply') { await cliCmd({ c: 'preset.apply', name: opt('--name') || rest[1] }); return; }
  if (sub === 'delete') { await cliCmd({ c: 'preset.delete', name: opt('--name') || rest[1] }); return; }
  fs.mkdirSync(PRESET_DIR, { recursive: true });
  for (const f of fs.readdirSync(PRESET_DIR).filter((x) => x.endsWith('.json'))) {
    try { const d = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), 'utf8')); console.log(`  ${d.name}  (${d.savedAt})`); } catch {}
  }
}

async function cmdFx() {
  const map = {
    '--opacity': 'opacity', '--brightness': 'brightness', '--contrast': 'contrast', '--saturate': 'saturate',
    '--blur': 'blur', '--dim': 'dim', '--pan-x': 'panX', '--pan-y': 'panY', '--zoom': 'zoom',
    '--rate': 'rate', '--volume': 'volume', '--fade-ms': 'fadeMs',
    '--transition': 'transition', '--transition-dir': 'transitionDir', '--transition-speed': 'transitionSpeed',
    '--panel-alpha': 'panelAlpha', '--panel-alpha-dark': 'panelAlphaDark', '--panel-blur': 'panelBlur', '--composer-alpha': 'composerAlpha',
  };
  let any = false;
  for (const [flag, key] of Object.entries(map)) {
    const v = opt(flag);
    if (v !== undefined) { await cliCmd({ c: 'fx', k: key, v: key === 'transition' || key === 'transitionDir' ? v : Number(v) }, { quiet: true }); any = true; }
  }
  if (hasFlag('--flip')) { await cliCmd({ c: 'fx', k: 'flipH', v: true }, { quiet: true }); any = true; }
  if (hasFlag('--no-flip')) { await cliCmd({ c: 'fx', k: 'flipH', v: false }, { quiet: true }); any = true; }
  if (hasFlag('--auto-tint')) { await cliCmd({ c: 'fx', k: 'autoTint', v: true }, { quiet: true }); any = true; }
  if (hasFlag('--no-auto-tint')) { await cliCmd({ c: 'fx', k: 'autoTint', v: false }, { quiet: true }); any = true; }
  if (!any) console.log(JSON.stringify(readConfig().fx, null, 2));
  else console.log(JSON.stringify(readConfig().fx));
}

async function cmdStatus() {
  const cfg = readConfig();
  const pid = bridgeAlive();
  const list = activeList(cfg);
  console.log(`Bridge: ${pid ? `running (pid ${pid})` : 'not running'}`);
  console.log(`Playlists: ${cfg.playlists.length}, active「${list?.name || '-'}」(${list?.items.length || 0} 张, every ${list?.intervalSec || '-'}s, ${list?.order || '-'}), current #${cfg.currentIndex + 1}${cfg.paused ? ' [paused]' : ''}`);
  (list?.items || []).forEach((x, i) => console.log(`  ${i === cfg.currentIndex ? '→' : ' '} ${i + 1}. [${x.kind}] ${x.title}`));
  console.log('FX:', JSON.stringify(cfg.fx));
  console.log('Occlusion:', JSON.stringify(cfg.occlusion), 'FxLayer:', JSON.stringify({ click: cfg.fxLayer.click.enabled, trail: cfg.fxLayer.trail.enabled }), 'Parallax:', JSON.stringify(cfg.parallax));
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
    case 'list': return cmdListLibrary();
    case 'set': return cmdSet();
    case 'add': return cmdAdd();
    case 'clear': return cliCmd({ c: 'list.clear' });
    case 'next': return cliCmd({ c: 'next' });
    case 'prev': return cliCmd({ c: 'prev' });
    case 'play': return cliCmd({ c: 'play' });
    case 'pause': return cliCmd({ c: 'pause' });
    case 'toggle': return cliCmd({ c: 'toggle' });
    case 'select': return cliCmd({ c: 'select', id: rest[0] });
    case 'hide': return cliCmd({ c: 'hide', id: rest[0] });
    case 'unhide': return cliCmd({ c: 'unhide', id: rest[0] });
    case 'rotate': {
      if (opt('--interval') !== undefined) await cliCmd({ c: 'list.interval', sec: Number(opt('--interval')) }, { quiet: true });
      if (opt('--order') !== undefined) await cliCmd({ c: 'list.order', order: opt('--order') }, { quiet: true });
      const l = activeList(readConfig());
      console.log(`Rotation: every ${l?.intervalSec}s, ${l?.order}.`);
      return;
    }
    case 'playlist': return cmdPlaylist();
    case 'preset': return cmdPreset();
    case 'fx': return cmdFx();
    case 'status': return cmdStatus();
    case 'help': case '--help': case '-h': return usage();
    default: console.error(`Unknown command: ${cmd}\n`); usage(); process.exit(1);
  }
};

main().catch((e) => { console.error(`chatgpt-wallpaper: ${e.message}`); process.exitCode = 1; });
