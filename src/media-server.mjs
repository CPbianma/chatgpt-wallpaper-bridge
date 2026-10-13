// Loopback media origin for WebWallGL live rendering (dsh's hard-won lesson:
// scene.pkg payloads of 70–336MB cannot ride CDP Fetch.fulfillRequest — the
// whole body would have to be one base64 message — so payload bytes stream
// from a real HTTP server on 127.0.0.1, which Chromium treats as a
// potentially-trustworthy origin even from the app:// page).
//
// Routes (paths mirror dsh exactly so the vendored renderer runs unmodified):
//   /wallpaper-engine/scene-live/*   vendored WebWallGL renderer (static)
//   /wallpaper-engine/scene-files/<token>/<subpath>
//       wallpaper's own files, fenced to its directory two layers deep
//       (literal resolve + realpath), Range + ETag/304, HTML entries get the
//       WE API shim + site-root declaration injected (strict-sandbox web
//       wallpapers cannot be reached from the renderer page, so the shim must
//       arrive with the document).
//   /api/log?m=     page-side diagnostics -> bridge log (Image GET, works even
//                   where the app's fetch allow-list patch applies)
//   /probe.html     connectivity/capability probe used to pick the live origin
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'webwallgl');
const SCENE_LIVE_PREFIX = '/wallpaper-engine/scene-live/';
const SCENE_FILES_PREFIX = '/wallpaper-engine/scene-files/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.pkg': 'application/octet-stream', '.tex': 'application/octet-stream',
};
const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

export const probeHtml = () => `<!doctype html><meta charset="utf-8"><title>probe</title><script>
(async () => {
  const q = new URLSearchParams(location.search);
  const peer = q.get('peer') || '';
  const tag = '[probe ' + location.origin + '] ';
  const say = (m) => { try { new Image().src = '/api/log?m=' + encodeURIComponent(tag + m); } catch {} };
  say('loaded; ua=' + navigator.userAgent.slice(0, 80));
  try { say('webgl2=' + !!document.createElement('canvas').getContext('webgl2')); } catch (e) { say('webgl2 ERR ' + e.message); }
  try { const r = await fetch('/api/log?m=' + encodeURIComponent(tag + 'fetch-self-answered'), { cache: 'no-store' }); say('fetch(self)=' + r.status); }
  catch (e) { say('fetch(self) ERR ' + e.message); }
  try {
    const x = new XMLHttpRequest();
    x.onload = () => say('xhr(self)=' + x.status);
    x.onerror = () => say('xhr(self) ERR');
    x.open('GET', '/api/log?m=' + encodeURIComponent(tag + 'xhr-self-answered'));
    x.send();
  } catch (e) { say('xhr(self) ERR ' + e.message); }
  if (peer) {
    try { const r = await fetch(peer + '/api/log?m=' + encodeURIComponent(tag + 'fetch-peer-answered'), { cache: 'no-store' }); say('fetch(peer)=' + r.status); }
    catch (e) { say('fetch(peer) ERR ' + e.message); }
    try { new Image().src = peer + '/api/log?m=' + encodeURIComponent(tag + 'img-peer-ok'); } catch {}
  }
})();
</script>`;

// Stream a file with Range + revalidating cache (ETag from size+mtime, 304).
// Errors are always no-store so a later-arriving file is never masked by a
// cached failure.
async function serveFileHttp(req, res, abs, { revalidate = false, contentType, cacheControl } = {}) {
  let stat;
  try { stat = await fsp.stat(abs); } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const base = {
    'Content-Type': contentType || mimeOf(abs),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (revalidate) {
    base['Cache-Control'] = 'no-cache';
    base['ETag'] = etag;
    base['Last-Modified'] = stat.mtime.toUTCString();
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').map((x) => x.trim().replace(/^W\//, '')).includes(etag)) {
      res.writeHead(304, base);
      res.end();
      return;
    }
  } else {
    base['Cache-Control'] = 'no-store';
  }
  if (cacheControl) base['Cache-Control'] = cacheControl;
  if (req.method === 'HEAD') { res.writeHead(200, { ...base, 'Content-Length': stat.size }); res.end(); return; }
  const rm = /^bytes=(\d+)-(\d*)$/i.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  let code = 200;
  if (rm) {
    start = Number(rm[1]);
    end = rm[2] ? Math.min(Number(rm[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isSafeInteger(start) || start >= stat.size || end < start) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    code = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  res.writeHead(code, { ...base, 'Content-Length': end - start + 1 });
  fs.createReadStream(abs, { start, end }).pipe(res);
}

// Two-layer fence, ported from dsh serve.js: the literal resolved path AND the
// realpath must both stay inside the wallpaper root; a symlinked final
// component is refused outright. Fail-closed on any resolution error except
// "not there", which is a plain 404 (not a fence breach).
function fencePath(root, subpath) {
  const target = path.resolve(root, subpath);
  if (target === root || !target.startsWith(root + path.sep)) return { error: 'path' };
  let realTarget = '';
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return { error: 'symlink' };
    realTarget = fs.realpathSync.native(target);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { target }; // plain 404 downstream
    return { error: 'unresolved' };
  }
  let realRoot = '';
  try { realRoot = fs.realpathSync.native(root); } catch { return { error: 'unresolved-root' }; }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return { error: 'realpath' };
  return { target };
}

export function startMediaServer({ tokens, log = console.log } = {}) {
  let shimCache = null;
  const readShim = () => {
    if (shimCache === null) {
      try { shimCache = fs.readFileSync(path.join(VENDOR_DIR, 'web-shim.js'), 'utf8'); } catch { shimCache = ''; }
    }
    return shimCache;
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const method = (req.method || 'GET').toUpperCase();

      if (u.pathname === '/api/log') {
        log(`[page] ${(u.searchParams.get('m') || '').slice(0, 300)}`);
        res.writeHead(204, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }
      if (u.pathname === '/probe.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(probeHtml());
        return;
      }
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'range, content-type',
          'Access-Control-Max-Age': '600',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Cache-Control': 'no-store' });
        res.end('method not allowed');
        return;
      }

      if (u.pathname.startsWith(SCENE_LIVE_PREFIX)) {
        const rest = decodeURIComponent(u.pathname.slice(SCENE_LIVE_PREFIX.length));
        const f = fencePath(VENDOR_DIR, rest || 'index.html');
        if (f.error) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end('forbidden'); return; }
        const immutable = /^assets\//.test(rest);
        await serveFileHttp(req, res, f.target, immutable
          ? { cacheControl: 'max-age=31536000, immutable' }   // hashed filenames never change
          : { cacheControl: 'no-store' });                    // index.html carries the query contract
        return;
      }

      if (u.pathname.startsWith(SCENE_FILES_PREFIX)) {
        const rest = decodeURIComponent(u.pathname.slice(SCENE_FILES_PREFIX.length));
        const token = rest.split('/')[0] || '';
        const root = tokens?.resolve(token);
        if (!root) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('unknown-token'); return; }
        const subpath = rest.slice(token.length).replace(/^\/+/, '');
        if (!subpath) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('missing-subpath'); return; }
        const f = fencePath(root, subpath);
        if (f.error) {
          log(`[scene-files] fenced (${f.error}): ${subpath.slice(0, 120)}`);
          res.writeHead(403, { 'Cache-Control': 'no-store' });
          res.end('forbidden-scene-files');
          return;
        }
        if (/\.html?$/i.test(f.target)) {
          // Web wallpaper entry: inject site-root declaration + WE API shim
          // ahead of the author's scripts. no-store — the injection must never
          // be served stale.
          let html = '';
          try { html = await fsp.readFile(f.target, 'utf8'); } catch {
            res.writeHead(404, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
            res.end('not found');
            return;
          }
          const shim = readShim();
          if (shim && !html.includes('data-we-shim')) {
            const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
            const siteRoot = `${SCENE_FILES_PREFIX}${token}/`;
            const tag = `<script data-we-site-root="host">window.__weSiteRoot=${JSON.stringify(siteRoot)};</script>`
              + `<script data-we-shim="host">${esc(shim)}</script>`;
            const m = /<head[^>]*>/i.exec(html);
            html = m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          res.end(html);
          return;
        }
        await serveFileHttp(req, res, f.target, { revalidate: true });
        return;
      }

      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('not found');
    })().catch((e) => {
      try { res.writeHead(500, { 'Cache-Control': 'no-store' }); res.end('internal'); } catch {}
      log(`[media] ${e.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
