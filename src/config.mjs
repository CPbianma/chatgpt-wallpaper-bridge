// Config persistence for the ChatGPT Wallpaper bridge.
// Lives in %LOCALAPPDATA%\ChatGPT-Wallpaper\config.json (machine-local, not in the repo).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ChatGPT-Wallpaper');
export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const PID_FILE = path.join(APP_DIR, 'bridge.pid');

export const DEFAULTS = {
  playlist: [],          // [{ kind: 'video'|'image', path, title, id? }]
  currentIndex: 0,
  lastSwitchAt: 0,       // epoch ms; bridge advances rotation from this
  intervalSec: 600,      // rotation interval
  order: 'sequential',   // 'sequential' | 'shuffle'
  effects: {
    opacity: 0.32,       // wallpaper layer opacity
    brightness: 0.68,    // wallpaper CSS brightness
    saturate: 1.15,      // wallpaper CSS saturate
    blur: 0,             // wallpaper CSS blur px
    fadeMs: 800,         // crossfade duration
    panelAlpha: 0.55,    // main conversation surface alpha (light theme)
    panelAlphaDark: 0.55,// main conversation surface alpha (dark theme)
    panelBlur: 22,       // backdrop blur for panels
    composerAlpha: 0.66, // composer surface alpha
  },
};

export function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const merged = { ...DEFAULTS, ...cfg, effects: { ...DEFAULTS.effects, ...(cfg.effects || {}) } };
  if (!Array.isArray(merged.playlist)) merged.playlist = [];
  if (merged.order !== 'shuffle') merged.order = 'sequential';
  return merged;
}

export function writeConfig(cfg) {
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
