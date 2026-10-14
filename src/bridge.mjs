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
import { scanLibrary, resolveItem, contentType, isVideoFile, isImageFile, workshopRoots } from './library.mjs';
import { applyCommand, nextIndex } from './commands.mjs';
import { createTokenMap } from './tokens.mjs';
import { startMediaServer, probeHtml, VENDOR_DIR } from './media-server.mjs';
import { parseUserPropDefs, entryDirPrefix, filterKnownOverrides } from './we-props.mjs';
import { extractSceneVideoFromPkgFile, extractSceneVideoFromDir } from './scene-manifest.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = fs.readFileSync(path.join(SCRIPT_DIR, 'inject.js'), 'utf8');
const PANEL_SRC = fs.readFileSync(path.join(SCRIPT_DIR, 'panel.js'), 'utf8');
// Content-build tags ride ahead of the sources so same-API-version edits still
// force a remount — the page-side reuse guards compare them (a stale mounted
// panel once survived a behavior fix because PANEL_API wasn't bumped).
import { createHash } from 'node:crypto';
const srcHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 10);
const INJECT_ALL = `;window.__weInjectBuild=${JSON.stringify(srcHash(INJECT_SRC))};window.__wePanelBuild=${JSON.stringify(srcHash(PANEL_SRC))};\n`
  + INJECT_SRC + '\n;' + PANEL_SRC;
const VIRTUAL_HOST = 'https://wallpaper.local';
const SCENE_LIVE_PREFIX = '/wallpaper-engine/scene-live/';
const MEDIA_ORIGIN_FILE = path.join(APP_DIR, 'media-origin');
const LOG_FILE = path.join(APP_DIR, 'bridge.log');
const FRAMES_DIR = path.join(APP_DIR, 'frames'); // live frame backfill cache (per-wallpaper JPEG stills)
const SCENE_VIDEO_DIR = path.join(APP_DIR, 'scene-video'); // embedded MP4s extracted from scene.pkg (degradation tier)
const MASCOT_DIR = path.resolve(VENDOR_DIR, '..', 'mascot'); // vendored mascot source art (dsh, MIT)
const MASCOT_CACHE_DIR = path.join(APP_DIR, 'mascot'); // page-derived alpha-cropped PNGs
const AVATAR_DIR = path.join(APP_DIR, 'avatars'); // custom chat avatars (user.png / assistant.png)
const MASCOT_FILES = {
  whale: 'rope-whale-source-1024x1536.png',
  maid: 'rope-maid-source-1192x1320.png',
  portrait: 'alternate-portrait-937x1679.png',
  vector: 'vector-960x1024.svg',
};
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
const VALUE_OPTS = new Set(['--interval', '--order', '--opacity', '--brightness', '--contrast', '--saturate', '--blur', '--dim', '--pan-x', '--pan-y', '--zoom', '--rate', '--volume', '--fade-ms', '--transition', '--transition-dir', '--transition-speed', '--panel-alpha', '--panel-alpha-dark', '--panel-blur', '--composer-alpha', '--content-alpha', '--content-blur', '--name', '--key', '--id', '--fps', '--font', '--user', '--assistant', '--form', '--size']);
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
    if (r.propsChanged) cfg.propsEpoch = Date.now();
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

  // WebWallGL live rendering: token-gated payload dirs + a loopback media
  // origin (scene.pkg is far too big for base64-over-CDP — see media-server.mjs).
  const tokens = createTokenMap();
  let media = null;
  try {
    media = await startMediaServer({ tokens, log: (m) => console.log(m) });
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(MEDIA_ORIGIN_FILE, media.origin, 'utf8');
    console.log(`[bridge] media origin: ${media.origin} (scene-live + scene-files)`);
  } catch (e) { console.log(`[bridge] media server failed to start: ${e.message} — live rendering disabled`); }

  // Full WebWallGL render info for the current playlist item, or null.
  // Consumed by the page's live layer: it builds a same-origin srcdoc iframe
  // (the app guards cross-origin frame navigations) whose <base> points at the
  // media origin, so the vendored renderer loads and fetches from there.
  function liveForCurrent() {
    if (!media || !cfg.live?.enabled) return null;
    const item = activeList(cfg)?.items[cfg.currentIndex];
    if (!item?.id) return null;
    const lib = library.find((x) => x.id === item.id);
    if (!lib?.live) return null;
    const token = tokens.tokenFor(lib.live.dir);
    const mediaBase = `${media.origin}/wallpaper-engine/scene-files`;
    const fps = [15, 30, 60].includes(cfg.live.fps) ? cfg.live.fps : 30;
    if (lib.live.type === 'scene') {
      // first-frame budget scales with the pkg (dsh: 15s base + bytes/8MBps, 90s cap)
      const budgetMs = Math.max(15000, Math.min(90000, 15000 + Math.ceil((lib.live.pkgBytes || 0) / 8000)));
      return { type: 'scene', src: token, mediaBase, fps, budgetMs };
    }
    const entry = `${mediaBase}/${token}/${lib.live.entry.split('/').map(encodeURIComponent).join('/')}`;
    return { type: 'web', src: entry, mediaBase, fps };
  }

  // Degradation middle tier: many scene.pkgs embed an author-rendered MP4.
  // Extract it lazily (index + entry-prefix probe, full read only on hit) the
  // first time a scene wallpaper becomes current; the page falls back to it
  // when live rendering fails.
  const sceneVideoState = new Map(); // id -> 'pending' | 'ready' | 'none'
  function ensureSceneVideo(lib) {
    if (!lib?.live || lib.live.type !== 'scene') return;
    const id = lib.id;
    if (sceneVideoState.has(id)) return;
    const out = path.join(SCENE_VIDEO_DIR, `${id}.mp4`);
    if (fs.existsSync(out)) { sceneVideoState.set(id, 'ready'); return; }
    sceneVideoState.set(id, 'pending');
    void (async () => {
      try {
        const bytes = lib.live.pkg && fs.existsSync(lib.live.pkg)
          ? await extractSceneVideoFromPkgFile(lib.live.pkg)
          : extractSceneVideoFromDir(lib.live.dir);
        if (bytes && bytes.length > 1024) {
          fs.mkdirSync(SCENE_VIDEO_DIR, { recursive: true });
          fs.writeFileSync(out, Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.length));
          sceneVideoState.set(id, 'ready');
          console.log(`[scene-video] ${id}: extracted embedded MP4 (${(bytes.length / 1048576).toFixed(1)}MB)`);
        } else sceneVideoState.set(id, 'none');
      } catch (e) {
        sceneVideoState.set(id, 'none');
        console.log(`[scene-video] ${id}: no embedded MP4 (${e.message.slice(0, 80)})`);
      }
    })();
  }

  // from its project.json (dsh's calibrated parser), with the user's overrides
  // merged in. File-type props get a shallow listing of the wallpaper dir so
  // the panel can render a dropdown instead of a text field.
  // Panel-facing user-property defs for the current live wallpaper: parsed
  // from its project.json (dsh's calibrated parser), with the user's overrides
  // merged in. File-type props get a shallow listing of the wallpaper dir so
  // the panel can render a dropdown instead of a text field.
  const propsCache = new Map(); // dir -> { mtimeMs, project }
  function readProject(dir) {
    const pj = path.join(dir, 'project.json');
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(pj).mtimeMs; } catch { return null; }
    const hit = propsCache.get(dir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.project;
    let project = null;
    try { project = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch {}
    propsCache.set(dir, { mtimeMs, project });
    return project;
  }
  function propsForCurrent() {
    const item = activeList(cfg)?.items[cfg.currentIndex];
    const lib = item?.id ? library.find((x) => x.id === item.id) : null;
    if (!lib?.live) return null;
    const project = readProject(lib.live.dir);
    if (!project) return null;
    const rawOv = cfg.wallpaperProps[lib.id] || {};
    const overrides = filterKnownOverrides(project, rawOv); // stale props the author deleted are ignored
    if (Object.keys(rawOv).length !== Object.keys(overrides).length) {
      cfg.wallpaperProps[lib.id] = overrides; // self-heal the config; persist on next write
    }
    let listFiles = [];
    try {
      for (const e of fs.readdirSync(lib.live.dir, { withFileTypes: true })) {
        if (e.isFile()) listFiles.push(e.name);
        else if (e.isDirectory() && e.name !== 'shaders') {
          try { for (const f of fs.readdirSync(path.join(lib.live.dir, e.name))) listFiles.push(`${e.name}/${f}`); } catch {}
        }
      }
    } catch {}
    const filePrefix = lib.live.type === 'web' ? entryDirPrefix(lib.live.entry) : '';
    const defs = parseUserPropDefs(project, overrides, { filePrefix, listFiles });
    return { id: lib.id, defs, values: overrides };
  }

  // Renderer document for the srcdoc iframe: the vendored index.html plus a
  // <base> so its absolute /wallpaper-engine/scene-live/* references resolve
  // against the media origin (module scripts are element loads — unaffected
  // by the app's fetch patch — and carry ACAO:* from our server).
  let liveDocCache = '';
  function liveDoc() {
    if (!media) return '';
    if (!liveDocCache) {
      try {
        const html = fs.readFileSync(path.join(VENDOR_DIR, 'index.html'), 'utf8');
        liveDocCache = html;
      } catch { return ''; }
    }
    const base = `<base href="${media.origin}${SCENE_LIVE_PREFIX}">`;
    const m = /<head[^>]*>/i.exec(liveDocCache);
    return m ? liveDocCache.slice(0, m.index + m[0].length) + base + liveDocCache.slice(m.index + m[0].length) : base + liveDocCache;
  }

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
    // page-side diagnostics (Image GET — works even under the app's fetch patch)
    if (u.pathname === '/api/log') {
      console.log(`[page] ${(u.searchParams.get('m') || '').slice(0, 300)}`);
      return fulfill(c, params, 204, [{ name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: '*' }], '');
    }
    if (u.pathname === '/probe.html') {
      return fulfill(c, params, 200, [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }], Buffer.from(probeHtml(), 'utf8').toString('base64'));
    }
    // WebWallGL renderer static files, mirrored on the virtual host. Only small
    // files live here (index.html + ~1MB renderer JS fit the CDP chunk cap);
    // wallpaper payloads (scene.pkg up to 336MB) are served by the loopback
    // media origin, never over CDP.
    if (u.pathname.startsWith(SCENE_LIVE_PREFIX)) {
      const rel = decodeURIComponent(u.pathname.slice(SCENE_LIVE_PREFIX.length)) || 'index.html';
      const target = path.resolve(VENDOR_DIR, rel);
      if (!target.startsWith(path.resolve(VENDOR_DIR) + path.sep))
        return fulfill(c, params, 403, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('forbidden').toString('base64'));
      return serveFile(c, params, target);
    }
    // live frame backfill: the page posts one settled renderer frame per
    // activation (base64url in the query — the Image GET channel), the bridge
    // caches it on disk, and /frame/<id> serves it as an instant placeholder
    // while a live renderer warms up on rotation
    if (u.pathname === '/api/frame') {
      const id = (u.searchParams.get('id') || '').replace(/[^\w-]/g, '');
      const d = u.searchParams.get('d') || '';
      if (id && d && d.length <= 550000) {
        try {
          fs.mkdirSync(FRAMES_DIR, { recursive: true });
          fs.writeFileSync(path.join(FRAMES_DIR, `${id}.jpg`), Buffer.from(d, 'base64url'));
        } catch {}
      }
      return fulfill(c, params, 204, [{ name: 'Cache-Control', value: 'no-store' }], '');
    }
    const fm = /^\/frame\/([\w-]+)$/.exec(u.pathname);
    if (fm) {
      const file = path.join(FRAMES_DIR, `${fm[1]}.jpg`);
      if (fs.existsSync(file)) return serveFile(c, params, file);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no frame').toString('base64'));
    }
    // embedded MP4 extracted from a scene.pkg (video element streams via Range)
    const sv = /^\/scene-video\/([\w-]+)$/.exec(u.pathname);
    if (sv) {
      const file = path.join(SCENE_VIDEO_DIR, `${sv[1]}.mp4`);
      if (fs.existsSync(file)) return serveFile(c, params, file);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no scene video').toString('base64'));
    }
    // mascot: vendored source art + page-derived alpha-cropped cache. The page
    // crops transparent margins + downscales on canvas, then caches the result
    // back over the Image GET channel (same pattern as /api/frame).
    const ms = /^\/mascot\/([\w-]+)$/.exec(u.pathname);
    if (ms) {
      const f = MASCOT_FILES[ms[1]];
      const file = f && path.join(MASCOT_DIR, f);
      if (file && fs.existsSync(file)) return serveFile(c, params, file);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no mascot').toString('base64'));
    }
    const md = /^\/mascot-derived\/([\w-]+)$/.exec(u.pathname);
    if (md) {
      const file = path.join(MASCOT_CACHE_DIR, `${md[1]}.png`);
      if (fs.existsSync(file)) return serveFile(c, params, file);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no derived mascot').toString('base64'));
    }
    if (u.pathname === '/api/mascot-cache') {
      const form = (u.searchParams.get('form') || '').replace(/[^\w-]/g, '');
      const d = u.searchParams.get('d') || '';
      if (MASCOT_FILES[form] && d && d.length <= 600000) {
        try {
          fs.mkdirSync(MASCOT_CACHE_DIR, { recursive: true });
          fs.writeFileSync(path.join(MASCOT_CACHE_DIR, `${form}.png`), Buffer.from(d, 'base64url'));
        } catch {}
      }
      return fulfill(c, params, 204, [{ name: 'Cache-Control', value: 'no-store' }], '');
    }
    // custom chat avatars (copied here by the `avatar` CLI command)
    const av = /^\/avatar\/([\w.-]+)$/.exec(u.pathname);
    if (av) {
      const file = path.join(AVATAR_DIR, av[1]);
      if (path.dirname(file) === AVATAR_DIR && fs.existsSync(file)) return serveFile(c, params, file);
      return fulfill(c, params, 404, [{ name: 'Content-Type', value: 'text/plain' }], Buffer.from('no avatar').toString('base64'));
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
      items: (list?.items || []).map((x) => {
        const lib = x.id ? library.find((y) => y.id === x.id) : null;
        return { kind: x.kind, title: x.title, id: x.id, live: lib?.live?.type || null };
      }),
      playlists: cfg.playlists.map((x) => ({ key: x.key, name: x.name, count: x.items.length, intervalSec: x.intervalSec, order: x.order })),
      fx: cfg.fx,
      occlusion: cfg.occlusion,
      fxLayer: cfg.fxLayer,
      parallax: cfg.parallax,
      presets: listPresets(),
      // always present (null when the current item is not live-capable) so the
      // page tears down a stale live layer on rotation to a plain video/image
      live: liveForCurrent(),
      liveSettings: cfg.live,
      mascot: cfg.mascot,
      avatars: cfg.avatars,
    };
    // The srcdoc renderer document is pushed once per media-origin lifetime
    // (the origin port changes every bridge restart, so it doubles as the key).
    if (forSession && media && forSession.liveDocKey !== media.port) {
      const doc = liveDoc();
      if (doc) { p.liveDoc = doc; forSession.liveDocKey = media.port; }
    }
    // User-property defs for the current live wallpaper, gated per session by
    // (wallpaper id, propsEpoch); the override VALUES ride every push (small,
    // and the page must converge after missed pushes).
    if (p.live) {
      const pr = propsForCurrent();
      if (pr) {
        p.propsId = pr.id;
        p.propsValues = pr.values;
        const key = `${pr.id}:${cfg.propsEpoch || 0}`;
        if (forSession && forSession.propsKey !== key) {
          p.propsDefs = pr.defs;
          forSession.propsKey = key;
        }
      }
    }
    // cached renderer frame for the current live wallpaper (instant placeholder)
    {
      const item = activeList(cfg)?.items[cfg.currentIndex];
      p.liveStill = (p.live && item?.id && fs.existsSync(path.join(FRAMES_DIR, `${item.id}.jpg`)))
        ? `${VIRTUAL_HOST}/frame/${item.id}`
        : null;
    }
    // embedded-MP4 degradation tier for scene wallpapers
    {
      const item = activeList(cfg)?.items[cfg.currentIndex];
      const lib = item?.id ? library.find((x) => x.id === item.id) : null;
      if (lib?.live?.type === 'scene') ensureSceneVideo(lib);
      p.sceneVideo = !!(item?.id && sceneVideoState.get(item.id) === 'ready');
    }
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
    try { fs.unlinkSync(MEDIA_ORIGIN_FILE); } catch {}
    try { media?.server.close(); } catch {}
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

/* ---------------- autostart & import ---------------- */

// Login autostart via HKCU Run key -> wscript -> hidden VBS launcher (zero
// console flash, no Task Scheduler elevation, no npm deps).
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ChatGPTWallpaper';
const NODE_EXE = process.execPath;
const BRIDGE_JS = path.join(SCRIPT_DIR, 'bridge.mjs');

async function cmdAutostart() {
  const { execFileSync } = await import('node:child_process');
  const off = hasFlag('--off') || rest[0] === 'off';
  if (off) {
    try { execFileSync('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { windowsHide: true }); console.log('Autostart disabled.'); }
    catch { console.log('Autostart was not enabled.'); }
    return;
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  const vbs = path.join(APP_DIR, 'autostart.vbs');
  // Route through cmd so stdout/stderr land in autostart.log — a silent
  // launch failure at login is otherwise undebuggable (the hidden console
  // swallows everything). The doubled-quote wrapper is the cmd /c idiom.
  const cmdLine = `cmd.exe /c ""${NODE_EXE}" "${BRIDGE_JS}" start >> "${path.join(APP_DIR, 'autostart.log')}" 2>&1"`;
  // UTF-16 LE + BOM: wscript parses .vbs as ANSI without one, and the path
  // may contain non-ANSI characters (e.g. a CJK Windows username)
  const vbsText = `CreateObject("Wscript.Shell").Run "${cmdLine.replaceAll('"', '""')}", 0, False\r\n`;
  fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbsText, 'utf16le')]));
  execFileSync('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'], { windowsHide: true });
  console.log(`Autostart enabled: ${vbs}`);
  console.log('The bridge will start hidden at login and attach whenever the app is open.');
}

// Import local media files as user wallpapers: copied into APP_DIR/uploads so
// the library survives the source file moving; ids are u-<hash>.
async function cmdImport() {
  const files = positionals();
  if (!files.length) { console.error('import <file...> — jpg/png/gif/mp4/webm/mov'); process.exit(1); }
  const dir = path.join(APP_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const { createHash } = await import('node:crypto');
  let n = 0;
  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) { console.error(`  not found: ${abs}`); continue; }
    if (!isVideoFile(abs) && !isImageFile(abs)) { console.error(`  unsupported type: ${abs}`); continue; }
    const id = 'u-' + createHash('sha1').update(abs + '|' + fs.statSync(abs).mtimeMs).digest('hex').slice(0, 10);
    const dest = path.join(dir, id + path.extname(abs).toLowerCase());
    fs.copyFileSync(abs, dest);
    console.log(`  imported ${id}  ${path.basename(abs)}`);
    n++;
  }
  if (n) console.log(`Imported ${n} file(s). They appear in the panel's 壁纸 tab within a minute (library rescan), or restart the bridge.`);
}

/* ---------------- chat avatars ---------------- */

async function cmdAvatar() {
  if (hasFlag('--off')) { await cliCmd({ c: 'avatars.set', enabled: false }); console.log('Avatars off.'); return; }
  if (hasFlag('--clear')) { await cliCmd({ c: 'avatars.set', user: '', assistant: '' }); console.log('Custom avatars cleared (built-in glyphs now).'); return; }
  const kw = {};
  for (const [flag, slot] of [['--user', 'user'], ['--assistant', 'assistant']]) {
    const file = opt(flag);
    if (file === undefined) continue;
    const abs = path.resolve(file);
    if (!fs.existsSync(abs) || !isImageFile(abs)) { console.error(`not an image: ${abs}`); process.exit(1); }
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const dest = slot + path.extname(abs).toLowerCase();
    fs.copyFileSync(abs, path.join(AVATAR_DIR, dest));
    kw[slot] = dest;
  }
  if (Object.keys(kw).length) {
    await cliCmd({ c: 'avatars.set', ...kw, enabled: true });
    console.log(`Avatars set: ${JSON.stringify(kw)} — shown next to chat rows in the app.`);
  } else {
    console.log(`avatar --user <img> [--assistant <img>]  set chat avatars
       --clear   back to built-in glyphs    --off   hide avatars
Current: ${JSON.stringify(readConfig().avatars)}`);
  }
}

/* ---------------- WE playlist import ---------------- */

// Wallpaper Engine's own client stores playlists in <install>/config.json
// (per profile, general.playlists; older builds nest them under
// wallpaperconfig.selectedwallpapers). Items are absolute project paths, so
// resolution keys off the /431960/<workshop-id>/ segment (dsh's approach,
// with a folder-name fallback for install-relative entries).
function weInstallDirs() {
  const out = [];
  for (const root of workshopRoots()) // .../steamapps/workshop/content/431960 -> .../steamapps/common/wallpaper_engine
    out.push(path.resolve(root, '..', '..', '..', 'common', 'wallpaper_engine'));
  return [...new Set(out)].filter((p) => fs.existsSync(path.join(p, 'config.json')));
}

function wePlaylistRows(profile) {
  const general = profile?.general;
  if (!general || typeof general !== 'object') return [];
  if (Array.isArray(general.playlists) && general.playlists.length) return general.playlists;
  const selected = general.wallpaperconfig?.selectedwallpapers;
  if (!selected || typeof selected !== 'object') return [];
  return Object.values(selected).map((m) => m?.playlist).filter((p) => p && typeof p === 'object');
}

function readWePlaylists() {
  const out = [];
  const seen = new Set();
  for (const dir of weInstallDirs()) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); } catch { continue; }
    for (const profile of Object.values(config || {})) {
      for (const row of wePlaylistRows(profile)) {
        const items = Array.isArray(row.items) ? row.items.filter((x) => typeof x === 'string' && x.trim()) : [];
        if (!items.length) continue;
        const name = (typeof row.name === 'string' && row.name.trim()) || '未命名列表';
        const sig = `${name}\0${items.join('\0')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const settings = row.settings && typeof row.settings === 'object' ? row.settings : {};
        out.push({ name, items, order: settings.order === 'random' ? 'shuffle' : 'sequential', delayMin: Number.isFinite(settings.delay) ? settings.delay : null });
      }
    }
  }
  return out;
}

function weItemToLibId(item, library) {
  const m = /[\\/]431960[\\/](\d+)[\\/]/i.exec(item);
  if (m && library.some((x) => x.id === m[1])) return m[1];
  const folder = /[\\/]([^\\/]+)[\\/][^\\/]+$/i.exec(item);
  if (folder && library.some((x) => x.id === folder[1])) return folder[1];
  return null;
}

async function cmdImportWe() {
  const rows = readWePlaylists();
  if (!rows.length) { console.log('No WE playlists found (is Wallpaper Engine installed via Steam?)'); return; }
  const apply = opt('--apply');
  if (apply === undefined) {
    console.log(`Found ${rows.length} WE playlist(s):`);
    rows.forEach((r, i) => console.log(`  ${i + 1}. 「${r.name}」 ${r.items.length} 张 · ${r.order === 'shuffle' ? '随机' : '顺序'}${r.delayMin ? ` · 每 ${r.delayMin}min` : ''}`));
    console.log('Import one: import-we --apply <序号|名称>');
    return;
  }
  const library = scanLibrary();
  const row = rows[Number(apply) - 1] || rows.find((r) => r.name === apply || r.name.includes(apply));
  if (!row) { console.error(`Playlist not found: ${apply}`); process.exit(1); }
  const items = [];
  let missed = 0;
  for (const it of row.items) {
    const id = weItemToLibId(it, library);
    const lib = id ? library.find((x) => x.id === id) : null;
    if (lib) items.push({ kind: lib.kind, path: lib.path, title: lib.title, id: lib.id });
    else missed++;
  }
  if (!items.length) { console.error('None of the playlist items resolve to your local workshop library.'); process.exit(1); }
  const cfg = readConfig();
  const key = 'we-' + Date.now().toString(36);
  cfg.playlists.push({
    key, name: row.name.slice(0, 40), items,
    intervalSec: clamp(Math.round((row.delayMin || 10) * 60), 60, 86400),
    order: row.order,
  });
  cfg.activePlaylist = key;
  cfg.currentIndex = 0;
  cfg.lastSwitchAt = Date.now();
  cfg.epoch = Date.now(); cfg.libEpoch = Date.now();
  writeConfig(cfg);
  console.log(`Imported 「${row.name}」 (${items.length} 张${missed ? `, ${missed} 张本地没有已跳过` : ''}), 每 ${Math.round((row.delayMin || 10) * 60)}s, ${row.order === 'shuffle' ? '随机' : '顺序'} — 已设为当前列表。`);
  await pokePages();
}


// Inject probe iframes (virtual host + loopback media origin) into every app
// page, wait for their Image-GET reports, then print the matching log lines.
// This decides which origin the live layer can use and whether the app's
// fetch patch reaches iframe documents.
async function cmdProbe() {
  let origin = '';
  try { origin = fs.readFileSync(MEDIA_ORIGIN_FILE, 'utf8').trim(); } catch {}
  if (!origin) { console.error('No media origin recorded — is the bridge running?'); process.exit(1); }
  const expr = `(() => {
    const mk = (src) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;width:8px;height:8px;right:0;bottom:0;opacity:.02;pointer-events:none;';
      f.src = src;
      document.documentElement.appendChild(f);
      setTimeout(() => f.remove(), 15000);
      return src;
    };
    mk(${JSON.stringify(VIRTUAL_HOST + '/probe.html?peer=')} + encodeURIComponent(${JSON.stringify(origin)}));
    mk(${JSON.stringify(origin + '/probe.html?peer=')} + encodeURIComponent(${JSON.stringify(VIRTUAL_HOST)}));
    return 'probe iframes injected';
  })()`;
  const before = (() => { try { return fs.readFileSync(LOG_FILE, 'utf8').length; } catch { return 0; } })();
  const n = await pokePages(expr);
  console.log(`Probe injected into ${n} page(s); waiting 9s for reports…`);
  await new Promise((r) => setTimeout(r, 9000));
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').slice(before);
    const lines = text.split(/\r?\n/).filter((x) => x.includes('[probe'));
    console.log(lines.length ? lines.join('\n') : '(no probe reports — check the bridge log yourself)');
  } catch { console.log('(bridge log not found — reports go to the bridge process stdout)'); }
}

/* ---------------- one-shot commands ---------------- */

// Nudge every open page to apply the latest config immediately.
async function pokePages(expression) {
  if (!expression) {
    const cfg = readConfig();
    const library = scanLibrary();
    // mirror the bridge's live field so CLI-driven switches to a scene/web
    // wallpaper don't leave the page holding the previous item's live layer
    let origin = '';
    try { origin = fs.readFileSync(MEDIA_ORIGIN_FILE, 'utf8').trim(); } catch {}
    let live = null;
    const item = activeList(cfg)?.items[cfg.currentIndex];
    const lib = item?.id ? library.find((x) => x.id === item.id) : null;
    if (origin && lib?.live && cfg.live?.enabled) {
      const token = Buffer.from(path.resolve(lib.live.dir), 'utf8').toString('base64url');
      const mediaBase = `${origin}/wallpaper-engine/scene-files`;
      const fps = [15, 30, 60].includes(cfg.live.fps) ? cfg.live.fps : 30;
      live = lib.live.type === 'scene'
        ? { type: 'scene', src: token, mediaBase, fps, budgetMs: Math.max(15000, Math.min(90000, 15000 + Math.ceil((lib.live.pkgBytes || 0) / 8000))) }
        : { type: 'web', src: `${mediaBase}/${token}/${lib.live.entry.split('/').map(encodeURIComponent).join('/')}`, mediaBase, fps };
    }
    const list = activeList(cfg);
    const payload = {
      epoch: cfg.epoch || 0, libEpoch: cfg.libEpoch || 0,
      index: cfg.currentIndex, paused: !!cfg.paused,
      listKey: cfg.activePlaylist, listName: list?.name || '',
      intervalSec: list?.intervalSec || 600, order: list?.order || 'sequential',
      items: (list?.items || []).map((x) => {
        const li = x.id ? library.find((y) => y.id === x.id) : null;
        return { kind: x.kind, title: x.title, id: x.id, live: li?.live?.type || null };
      }),
      playlists: cfg.playlists.map((x) => ({ key: x.key, name: x.name, count: x.items.length, intervalSec: x.intervalSec, order: x.order })),
      fx: cfg.fx, occlusion: cfg.occlusion, fxLayer: cfg.fxLayer, parallax: cfg.parallax,
      live,
      liveSettings: cfg.live,
      liveStill: (live && item?.id && fs.existsSync(path.join(FRAMES_DIR, `${item.id}.jpg`))) ? `${VIRTUAL_HOST}/frame/${item.id}` : null,
      sceneVideo: !!(item?.id && fs.existsSync(path.join(SCENE_VIDEO_DIR, `${item.id}.mp4`))),
      mascot: cfg.mascot,
      avatars: cfg.avatars,
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
    '--content-alpha': 'contentAlpha', '--content-blur': 'contentBlur', '--font': 'fontFamily',
  };
  const STRING_KEYS = new Set(['transition', 'transitionDir', 'fontFamily']);
  let any = false;
  for (const [flag, key] of Object.entries(map)) {
    const v = opt(flag);
    if (v !== undefined) { await cliCmd({ c: 'fx', k: key, v: STRING_KEYS.has(key) ? v : Number(v) }, { quiet: true }); any = true; }
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
    case 'goto': return cliCmd({ c: 'goto', idx: Number(rest[0]) - 1 });
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
    case 'live': {
      const kw = {};
      if (hasFlag('--on')) kw.enabled = true;
      if (hasFlag('--off')) kw.enabled = false;
      if (opt('--fps') !== undefined) kw.fps = Number(opt('--fps'));
      if (Object.keys(kw).length) await cliCmd({ c: 'live.set', ...kw });
      console.log('Live rendering:', JSON.stringify(readConfig().live));
      return;
    }
    case 'autostart': return cmdAutostart();
    case 'import': return cmdImport();
    case 'import-we': return cmdImportWe();
    case 'mascot': {
      const kw = {};
      if (hasFlag('--on')) kw.enabled = true;
      if (hasFlag('--off')) kw.enabled = false;
      if (opt('--form') !== undefined) kw.form = opt('--form');
      if (opt('--size') !== undefined) kw.size = Number(opt('--size'));
      if (Object.keys(kw).length) await cliCmd({ c: 'mascot.set', ...kw });
      console.log('Mascot:', JSON.stringify(readConfig().mascot));
      return;
    }
    case 'avatar': return cmdAvatar();
    case 'status': return cmdStatus();
    case 'probe': return cmdProbe();
    case 'help': case '--help': case '-h': return usage();
    default: console.error(`Unknown command: ${cmd}\n`); usage(); process.exit(1);
  }
};

main().catch((e) => { console.error(`chatgpt-wallpaper: ${e.message}`); process.exitCode = 1; });
