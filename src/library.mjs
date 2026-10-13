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
  if (weType === 'video' && file && fs.existsSync(file) && isVideoFile(file))
    return { ...base, kind: 'video', path: file };
  // Scene / web / application / video-without-file: fall back to the preview image.
  if (hasPreview)
    return { ...base, kind: 'image', path: preview, title: `${title} (preview)` };
  if (file && fs.existsSync(file) && isImageFile(file))
    return { ...base, kind: 'image', path: file };
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
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  })[ext] || 'application/octet-stream';
}
