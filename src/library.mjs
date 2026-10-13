// Wallpaper Engine library discovery: finds Steam workshop items (app 431960),
// parses project.json, and resolves playable media for the bridge.
//   - video wallpapers  -> the video file itself
//   - scene/web/other   -> their preview image (static stand-in until WebWallGL
//                          live rendering lands; scene-embedded MP4 is phase 2)
// Each item also carries contentrating, schemeColor and a thumbnail path for
// the picker UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR } from './config.mjs';

const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif)$/i;

export const isVideoFile = (f) => VIDEO_RE.test(f);
export const isImageFile = (f) => IMAGE_RE.test(f);

function steamRoots() {
  const roots = new Set();
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out);
      if (m) roots.add(m[1].trim().replaceAll('/', path.sep));
    } catch {}
  }
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'D:\\SteamLibrary', 'E:\\SteamLibrary']) roots.add(p);
  return [...roots].filter((p) => fs.existsSync(p));
}

function parseLibraryFolders(vdf) {
  const out = [];
  try {
    const text = fs.readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/gi)) out.push(m[1].replaceAll('\\\\', '\\'));
  } catch {}
  return out;
}

export function workshopRoots() {
  const out = new Set();
  for (const root of steamRoots()) {
    out.add(path.join(root, 'steamapps', 'workshop', 'content', '431960'));
    for (const lib of parseLibraryFolders(path.join(root, 'steamapps', 'libraryfolders.vdf')))
      out.add(path.join(lib, 'steamapps', 'workshop', 'content', '431960'));
  }
  return [...out].filter((p) => fs.existsSync(p));
}

// "0.75 0.75 0.75" (0..1 floats) -> [r,g,b] 0..255, or null. All-zero = unset (WE default).
export function parseSchemeColor(meta) {
  const v = meta?.general?.properties?.schemecolor?.value;
  if (typeof v !== 'string') return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return null;
  if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0) return null;
  return parts.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
}

// contentrating: "Everyone" | "Questionable" | "Mature" | missing
export function parseRating(meta) {
  const r = (meta?.contentrating || '').toLowerCase();
  if (r === 'everyone') return 'everyone';
  if (r === 'questionable') return 'pg13';
  if (r === 'mature') return 'mature';
  return 'unrated';
}

// One workshop item -> a bridge-playable entry, or null if nothing usable.
// `live` marks a WebWallGL-renderable source: scene wallpapers with a pkg
// container (or a loose scene.json project) and web wallpapers with an HTML
// entry. The preview image stays the item's `path` — it is both the picker
// thumbnail and the degradation-chain fallback when live rendering fails.
function readItem(root, id) {
  const dir = path.join(root, id);
  const pj = path.join(dir, 'project.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { return null; }
  const title = meta.title || id;
  const weType = (meta.type || 'unknown').toLowerCase();
  const file = meta.file ? path.join(dir, meta.file) : null;
  const preview = meta.preview ? path.join(dir, meta.preview) : null;
  const hasPreview = preview && fs.existsSync(preview) && isImageFile(preview);
  const base = {
    id, title, weType,
    rating: parseRating(meta),
    schemeColor: parseSchemeColor(meta),
    thumb: hasPreview ? preview : null,
  };
  let live = null;
  if (weType === 'scene') {
    // project.json's `file` names the loose entry (scene.json), but packaged
    // builds ship scene.pkg instead — and sometimes both claims hold while
    // only one exists. Mirror WebWallGL's probe order: pkg containers first,
    // then the loose json.
    const pkg = ['scene.pkg', 'scenes/scene.pkg', 'gifscene.pkg'].map((p) => path.join(dir, p)).find((p) => fs.existsSync(p));
    const loose = file && fs.existsSync(file) && /\.json$/i.test(file) ? file : null;
    let pkgBytes = 0;
    if (pkg) { try { pkgBytes = fs.statSync(pkg).size; } catch {} }
    if (pkg || loose) live = { type: 'scene', dir, pkgBytes, pkg: pkg || null };
  } else if (weType === 'web' && file && fs.existsSync(file) && /\.html?$/i.test(file)) {
    live = { type: 'web', dir, entry: String(meta.file).replaceAll('\\', '/') };
  }
  if (weType === 'video' && file && fs.existsSync(file) && isVideoFile(file))
    return { ...base, kind: 'video', path: file };
  // Scene / web / application / video-without-file: fall back to the preview image.
  if (hasPreview)
    return { ...base, kind: 'image', path: preview, title: `${title} (preview)`, live };
  if (file && fs.existsSync(file) && isImageFile(file))
    return { ...base, kind: 'image', path: file, live };
  if (live) return { ...base, kind: 'image', path: preview || file, live }; // no usable preview, live only
  return null;
}

export function scanLibrary() {
  const items = [];
  for (const root of workshopRoots()) {
    let ids = [];
    try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const id of ids) {
      const item = readItem(root, id);
      if (item) items.push(item);
    }
  }
  // user imports live outside Steam (survive workshop churn); id is the
  // u-<hash> filename base assigned at import time
  try {
    for (const f of fs.readdirSync(path.join(APP_DIR, 'uploads'))) {
      const p = path.join(APP_DIR, 'uploads', f);
      const id = path.basename(f, path.extname(f));
      if (isVideoFile(f)) items.push({ id, title: id, kind: 'video', path: p, weType: 'upload', rating: 'unrated', schemeColor: null, thumb: null, live: null });
      else if (isImageFile(f)) items.push({ id, title: id, kind: 'image', path: p, weType: 'upload', rating: 'unrated', schemeColor: null, thumb: p, live: null });
    }
  } catch {}
  const rank = { video: 0, image: 1 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title));
}

// Resolve a user-supplied token (workshop id, absolute file path, or title
// substring) into a playlist entry. Throws with a useful message on failure.
export function resolveItem(token, library) {
  const raw = String(token).trim();
  if (!raw) throw new Error('Empty wallpaper token.');
  const asPath = path.resolve(raw);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    if (isVideoFile(asPath)) return { kind: 'video', path: asPath, title: path.basename(asPath) };
    if (isImageFile(asPath)) return { kind: 'image', path: asPath, title: path.basename(asPath) };
    throw new Error(`Unsupported media type: ${asPath} (use MP4/WebM/MOV/M4V or PNG/JPG/GIF)`);
  }
  const byId = library.find((x) => x.id === raw);
  if (byId) return byId;
  const needle = raw.toLowerCase();
  const byTitle = library.filter((x) => x.title.toLowerCase().includes(needle));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`"${raw}" matches ${byTitle.length} wallpapers: ${byTitle.slice(0, 5).map((x) => x.id).join(', ')}… — use the workshop id.`);
  throw new Error(`Wallpaper not found: "${raw}" (not a file, workshop id, or library title).`);
}

export function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  })[ext] || 'application/octet-stream';
}
