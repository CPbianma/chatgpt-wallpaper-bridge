// Config persistence for the ChatGPT Wallpaper bridge.
// Lives in ~/.chatgpt-wallpaper/config.json (machine-local, not in the repo).
// NOT under %LOCALAPPDATA% on purpose: the Codex desktop app is MSIX-packaged
// and Windows transparently redirects AppData\Local\ChatGPT-Wallpaper for every
// process spawned from a Codex-hosted terminal — so a bridge started inside a
// Codex session and one started by Task Scheduler used to see TWO DIFFERENT
// state dirs (the task side saw an empty dir and seeded defaults: whale
// mascot, no avatars, video-only playlist). USERPROFILE is never redirected,
// so every launch context now shares one home.
// v2 schema: named playlists, extended effects, transitions, playback, occlusion,
// fx layer, parallax, theme-follow, hidden library items. Old v1 configs migrate on read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const APP_DIR = path.join(os.homedir(), '.chatgpt-wallpaper');
const LEGACY_APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ChatGPT-Wallpaper');

// One-time move from the legacy AppData location (whichever view of it the
// current process sees — for an MSIX-redirected process that's the package
// overlay holding the user's real settings).
let migrated = false;
function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  try {
    if (!fs.existsSync(APP_DIR) && fs.existsSync(LEGACY_APP_DIR)) fs.cpSync(LEGACY_APP_DIR, APP_DIR, { recursive: true });
  } catch {}
  fs.mkdirSync(APP_DIR, { recursive: true });
}

export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const PID_FILE = path.join(APP_DIR, 'bridge.pid');
export const PRESET_DIR = path.join(APP_DIR, 'presets');
export const BACKUP_DIR = path.join(APP_DIR, 'backups');
export const VISUAL_RESTORE_FILE = path.join(APP_DIR, 'visual-restore.json');

export const DEFAULT_FX = {
  appearance: 'legacy', // legacy | workbench; explicit opt-in only
  opacity: 0.5,         // wallpaper layer opacity
  brightness: 0.85,     // wallpaper CSS brightness
  contrast: 1.05,       // wallpaper CSS contrast
  saturate: 1.2,        // wallpaper CSS saturate
  blur: 0,              // wallpaper CSS blur px
  dim: 0.12,            // black overlay above wallpaper (0..0.8) — 暗化
  panX: 50,             // object-position % (0..100)
  panY: 50,
  zoom: 1.0,            // extra scale on media (1..3)
  flipH: false,         // horizontal mirror
  rate: 1.0,            // video playbackRate (0.25..3)
  volume: 0,            // 0..1 (0 = muted)
  fadeMs: 800,          // crossfade duration base
  transition: 'fade',   // cut | fade | slide | wipe | iris | zoom
  transitionSpeed: 1.0, // 0.5 fast? actually multiplier: 0.6 fast, 1 standard, 1.8 slow
  transitionDir: 'left',// for slide/wipe: left|right|up|down
  panelAlpha: 0.22,     // main conversation surface alpha (light theme)
  panelAlphaDark: 0.30, // main conversation surface alpha (dark theme)
  panelBlur: 10,        // backdrop blur for the panel
  composerAlpha: 0.55,  // composer surface alpha
  contentAlpha: 0.62,   // transcript card alpha (legacy readability backing)
  contentBlur: 18,      // transcript card backdrop blur (legacy)
  sidebarAlpha: 0.62,   // independent sidebar alpha (light theme)
  sidebarAlphaDark: 0.68,
  sidebarBlur: 18,
  autoReadability: false, // sampled wallpaper luminance adjusts glass only
  autoTint: true,       // theme-follow: glass tint follows wallpaper brightness
  fontFamily: '',       // app UI font override ('' = app default)
};

export const DEFAULT_OCCLUSION = {
  hidden: true,   // pause when window hidden/minimized
  blur: false,    // pause when window loses focus
  battery: false, // pause on battery power
};

export const DEFAULT_FXLAYER = {
  click: { enabled: false, style: 'ripple', color: 'rainbow', opacity: 0.8, size: 1.0 },  // ripple | sparks | both
  trail: { enabled: false, style: 'comet', color: 'rainbow', opacity: 0.8, width: 1.0, ttl: 1.0 }, // comet | stardust
};

export const DEFAULT_PARALLAX = { enabled: false, wallpaperPct: 1.0, uiPct: 0 };

export const DEFAULT_LIVE = { enabled: true, fps: 30 }; // WebWallGL scene/web real-time rendering

export const DEFAULT_MASCOT = { enabled: true, form: 'whale', xPct: 0.88, size: 1.0 }; // pull-cord mascot (forms: whale/maid/portrait/vector)
export const DEFAULT_AVATARS = { enabled: false, user: '', assistant: '' }; // chat-row avatars ('' = built-in glyph)

export const DEFAULTS = {
  playlists: [],          // [{ key, name, items: [{kind,path,title,id}], intervalSec, order }]
  activePlaylist: null,   // key
  currentIndex: 0,
  lastSwitchAt: 0,
  paused: false,
  fx: DEFAULT_FX,
  occlusion: DEFAULT_OCCLUSION,
  fxLayer: DEFAULT_FXLAYER,
  parallax: DEFAULT_PARALLAX,
  live: DEFAULT_LIVE,
  wallpaperProps: {},     // { [wallpaperId]: { [propName]: wireValue } } — user overrides
  mascot: DEFAULT_MASCOT,
  avatars: DEFAULT_AVATARS,
  hidden: [],             // library ids hidden by the user
  epoch: 0,
  libEpoch: 0,
  propsEpoch: 0,
};

const deep = (base, over) => {
  const out = structuredClone(base || {});
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') out[k] = deep(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
};

export function normalizeConfig(input = {}) {
  let cfg = structuredClone(input || {});
  // v1 -> v2 migration: { playlist, intervalSec, order, effects } -> playlists[0]
  if (!Array.isArray(cfg.playlists)) {
    cfg.playlists = [];
    if (Array.isArray(cfg.playlist) && cfg.playlist.length) {
      cfg.playlists.push({
        key: 'default', name: '默认列表',
        items: cfg.playlist,
        intervalSec: Number.isFinite(cfg.intervalSec) ? cfg.intervalSec : 600,
        order: cfg.order === 'shuffle' ? 'shuffle' : 'sequential',
      });
      cfg.activePlaylist = 'default';
    }
  }
  const merged = deep(DEFAULTS, cfg);
  if (!merged.playlists.length) merged.activePlaylist = null;
  if (!merged.playlists.some((p) => p.key === merged.activePlaylist)) merged.activePlaylist = merged.playlists[0]?.key ?? null;
  return merged;
}

export function readConfig() {
  ensureMigrated();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return normalizeConfig(cfg);
}

export function activeList(cfg) {
  return cfg.playlists.find((p) => p.key === cfg.activePlaylist) || null;
}

export function writeConfig(cfg) {
  ensureMigrated();
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export function numberArg(value, fallback, lo = -Infinity, hi = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}
