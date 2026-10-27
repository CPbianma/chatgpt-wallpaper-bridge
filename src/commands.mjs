// Shared command application: both the in-page panel (via /api/cmd) and the CLI
// mutate config through here, so every control has identical semantics.
// A command returns { changed, libChanged, message } — the caller persists
// config and bumps epochs accordingly.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FX, PRESET_DIR, CONFIG_FILE, BACKUP_DIR, VISUAL_RESTORE_FILE, activeList, clamp } from './config.mjs';
import { APPEARANCE_MODES, WORKBENCH_FX } from './visual-style.mjs';

const FX_LIMITS = {
  opacity: [0, 1], brightness: [0, 4], contrast: [0, 4], saturate: [0, 4], blur: [0, 40],
  dim: [0, 0.85], panX: [0, 100], panY: [0, 100], zoom: [1, 3],
  rate: [0.25, 3], volume: [0, 1], fadeMs: [0, 5000],
  panelAlpha: [0, 1], panelAlphaDark: [0, 1], panelBlur: [0, 60], composerAlpha: [0, 1],
  contentAlpha: [0, 1], contentBlur: [0, 60],
  sidebarAlpha: [0, 1], sidebarAlphaDark: [0, 1], sidebarBlur: [0, 60],
  transitionSpeed: [0.4, 3],
};
const TRANSITIONS = new Set(['cut', 'fade', 'slide', 'wipe', 'iris', 'zoom', 'bars']);
const DIRS = new Set(['left', 'right', 'up', 'down']);

function ensureList(cfg) {
  let list = activeList(cfg);
  if (!list) {
    list = { key: 'default', name: '默认列表', items: [], intervalSec: 600, order: 'sequential' };
    cfg.playlists.push(list);
    cfg.activePlaylist = list.key;
  }
  return list;
}

function nextIndex(cfg, from) {
  const list = activeList(cfg);
  const n = list ? list.items.length : 0;
  if (n < 2) return 0;
  if (list.order === 'shuffle') {
    let k = from;
    while (k === from) k = Math.floor(Math.random() * n);
    return k;
  }
  return ((from + 1) % n + n) % n;
}
export { nextIndex };

// The optimization restore point is deliberately field-scoped. In particular,
// never snapshot whole fx/mascot objects: that would also roll back playback,
// volume/rate and custom resource state on restore.
export const VISUAL_SNAPSHOT_PATHS = Object.freeze([
  'fx.appearance', 'fx.opacity', 'fx.brightness', 'fx.contrast', 'fx.saturate',
  'fx.blur', 'fx.dim', 'fx.fadeMs', 'fx.transition', 'fx.transitionSpeed',
  'fx.transitionDir', 'fx.panelAlpha', 'fx.panelAlphaDark', 'fx.panelBlur',
  'fx.composerAlpha', 'fx.contentAlpha', 'fx.contentBlur', 'fx.autoTint',
  'fx.sidebarAlpha', 'fx.sidebarAlphaDark', 'fx.sidebarBlur', 'fx.autoReadability',
  'fxLayer.click.enabled', 'fxLayer.trail.enabled',
  'parallax.enabled', 'parallax.uiPct', 'mascot.size', 'mascot.xPct',
]);

const getPath = (obj, dotted) => dotted.split('.').reduce((value, key) => value?.[key], obj);
const setPath = (obj, dotted, value) => {
  const keys = dotted.split('.');
  const leaf = keys.pop();
  let target = obj;
  for (const key of keys) target = target[key] ||= {};
  target[leaf] = value;
};

export function captureVisualValues(cfg) {
  return Object.fromEntries(VISUAL_SNAPSHOT_PATHS.map((key) => [key, getPath(cfg, key)]));
}

function validVisualValue(key, value) {
  if (key === 'fx.appearance') return APPEARANCE_MODES.includes(value);
  if (key === 'fx.transition') return TRANSITIONS.has(value);
  if (key === 'fx.transitionDir') return DIRS.has(value);
  if (key.endsWith('.enabled') || key === 'fx.autoTint' || key === 'fx.autoReadability') return typeof value === 'boolean';
  if (!Number.isFinite(value)) return false;
  if (key.startsWith('fx.')) {
    const limits = FX_LIMITS[key.slice(3)];
    return !!limits && value >= limits[0] && value <= limits[1];
  }
  if (key === 'parallax.uiPct') return value >= 0 && value <= 10;
  if (key === 'mascot.size') return value >= 0.6 && value <= 2;
  if (key === 'mascot.xPct') return value >= 0 && value <= 1;
  return false;
}

export function applyVisualValues(cfg, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  // Validate everything before the first mutation: malformed snapshots cannot
  // leave a half-restored configuration behind.
  for (const key of VISUAL_SNAPSHOT_PATHS) {
    if (!Object.hasOwn(values, key) || !validVisualValue(key, values[key])) return false;
  }
  for (const key of VISUAL_SNAPSHOT_PATHS) setPath(cfg, key, values[key]);
  return true;
}

function visualFiles(ctx = {}) {
  return {
    config: ctx.configFile || CONFIG_FILE,
    restore: ctx.visualRestoreFile || VISUAL_RESTORE_FILE,
    backups: ctx.backupDir || BACKUP_DIR,
  };
}

function saveVisualRestorePoint(cfg, ctx = {}) {
  const files = visualFiles(ctx);
  const suppliedNow = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const now = new Date(suppliedNow ?? Date.now());
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(files.backups, `visual-redesign-${stamp}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, 'config.json');
  // Preserve the exact on-disk bytes, not the merged/normalized config.
  const raw = fs.readFileSync(files.config, 'utf8');
  fs.writeFileSync(backup, raw, { encoding: 'utf8', flag: 'wx' });
  const snapshot = JSON.stringify({ version: 1, savedAt: now.toISOString(), values: captureVisualValues(cfg) }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(files.restore), { recursive: true });
  const tmp = files.restore + '.tmp';
  fs.writeFileSync(tmp, snapshot, 'utf8');
  fs.renameSync(tmp, files.restore);
  return { backup, restore: files.restore };
}

function readVisualRestorePoint(ctx = {}) {
  const files = visualFiles(ctx);
  const data = JSON.parse(fs.readFileSync(files.restore, 'utf8'));
  if (data?.version !== 1 || !data.values) throw new Error('invalid visual restore point');
  return { ...data, file: files.restore };
}

const booleanValue = (value) => {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
};

export function applyCommand(cfg, cmd, ctx = {}) {
  const c = cmd.c;
  const out = { changed: true, libChanged: false, message: '' };
  const fail = (m) => ({ changed: false, libChanged: false, message: m });
  const lib = ctx.library || [];

  switch (c) {
    case 'select': {
      const item = lib.find((x) => x.id === cmd.id);
      if (!item) return fail(`壁纸不在库中: ${cmd.id}`);
      const list = ensureList(cfg);
      let idx = list.items.findIndex((x) => x.id === cmd.id);
      if (idx < 0) {
        list.items.push({ kind: item.kind, path: item.path, title: item.title, id: item.id });
        idx = list.items.length - 1;
        out.libChanged = true;
      }
      cfg.currentIndex = idx;
      cfg.lastSwitchAt = Date.now();
      cfg.paused = false;
      out.message = `→ ${item.title}`;
      return out;
    }
    case 'next': case 'prev': {
      const list = activeList(cfg);
      if (!list || !list.items.length) return fail('播放列表为空');
      cfg.currentIndex = c === 'next' ? nextIndex(cfg, cfg.currentIndex) : ((cfg.currentIndex - 1) % list.items.length + list.items.length) % list.items.length;
      cfg.lastSwitchAt = Date.now();
      out.message = `→ ${list.items[cfg.currentIndex]?.title}`;
      return out;
    }
    case 'goto': {
      const list = activeList(cfg);
      if (!list || !list.items.length) return fail('播放列表为空');
      cfg.currentIndex = clamp(Number(cmd.idx) | 0, 0, list.items.length - 1);
      cfg.lastSwitchAt = Date.now();
      cfg.paused = false;
      out.message = `→ ${list.items[cfg.currentIndex]?.title}`;
      return out;
    }
    case 'play': cfg.paused = false; out.message = '播放'; return out;
    case 'pause': cfg.paused = true; out.message = '暂停'; return out;
    case 'toggle': cfg.paused = !cfg.paused; out.message = cfg.paused ? '暂停' : '播放'; return out;

    case 'appearance.set': {
      const mode = String(cmd.mode || '');
      if (!APPEARANCE_MODES.includes(mode)) return fail(`未知外观模式: ${mode}`);
      if (mode === 'legacy') {
        cfg.fx.appearance = 'legacy';
        out.message = '已切换到原有外观（视觉恢复点仍保留）';
        return out;
      }
      if (cfg.fx.appearance === 'workbench') {
        return { changed: false, libChanged: false, message: '深色磨砂工作台已启用' };
      }
      let restorePoint = null;
      const restoreFile = visualFiles(ctx).restore;
      if (!fs.existsSync(restoreFile)) {
        try { restorePoint = saveVisualRestorePoint(cfg, ctx); }
        catch (e) { return fail(`无法建立视觉备份，未修改配置: ${e.message}`); }
      }
      Object.assign(cfg.fx, WORKBENCH_FX);
      cfg.fxLayer.click.enabled = false;
      cfg.fxLayer.trail.enabled = false;
      cfg.parallax.enabled = false;
      cfg.parallax.uiPct = 0;
      cfg.mascot.size = 0.82;
      // In workbench mode this is a fraction of the measured main surface,
      // not the viewport; panel.js clamps it against real DOM bounds.
      cfg.mascot.xPct = 0.92;
      out.message = '深色磨砂工作台已启用';
      if (restorePoint) out.message += ` · 完整备份: ${restorePoint.backup}`;
      return out;
    }
    case 'appearance.restore': {
      let snapshot;
      try { snapshot = readVisualRestorePoint(ctx); }
      catch { return fail('没有可用的视觉恢复点'); }
      if (!applyVisualValues(cfg, snapshot.values)) return fail('视觉恢复点已损坏，未修改配置');
      out.clearVisualSnapshot = snapshot.file;
      out.message = '已恢复优化前外观；播放列表、当前壁纸和播放设置未改动';
      return out;
    }
    case 'fx': {
      const { k, v } = cmd;
      if (!(k in DEFAULT_FX)) return fail(`未知效果键: ${k}`);
      if (k === 'appearance') return fail('请使用 appearance.set 切换外观');
      if (typeof DEFAULT_FX[k] === 'boolean') {
        const parsed = booleanValue(v);
        if (parsed === null) return fail(`无效布尔值: ${k}`);
        cfg.fx[k] = parsed;
      } else if (typeof DEFAULT_FX[k] === 'number') {
        const parsed = Number(v);
        if (!Number.isFinite(parsed)) return fail(`无效数值: ${k}`);
        cfg.fx[k] = clamp(parsed, ...(FX_LIMITS[k] || [-Infinity, Infinity]));
      } else if (k === 'transition') {
        if (!TRANSITIONS.has(v)) return fail(`无效过场: ${v}`);
        cfg.fx.transition = v;
      } else if (k === 'transitionDir') {
        if (!DIRS.has(v)) return fail(`无效过场方向: ${v}`);
        cfg.fx.transitionDir = v;
      } else cfg.fx[k] = v;
      out.message = `${k} = ${cfg.fx[k]}`;
      return out;
    }
    case 'occlusion': {
      if (!(cmd.k in cfg.occlusion)) return fail(`未知省电键: ${cmd.k}`);
      cfg.occlusion[cmd.k] = !!cmd.v;
      out.message = `occlusion.${cmd.k} = ${cfg.occlusion[cmd.k]}`;
      return out;
    }
    case 'fxLayer': {
      const sec = cfg.fxLayer[cmd.section];
      if (!sec || !(cmd.k in sec)) return fail(`未知特效键: ${cmd.section}.${cmd.k}`);
      sec[cmd.k] = typeof sec[cmd.k] === 'boolean' ? !!cmd.v : cmd.v;
      out.message = `fxLayer.${cmd.section}.${cmd.k} = ${sec[cmd.k]}`;
      return out;
    }
    case 'parallax': {
      if (!(cmd.k in cfg.parallax)) return fail(`未知视差键: ${cmd.k}`);
      cfg.parallax[cmd.k] = typeof cfg.parallax[cmd.k] === 'boolean' ? !!cmd.v : clamp(Number(cmd.v) || 0, 0, 10);
      out.message = `parallax.${cmd.k} = ${cfg.parallax[cmd.k]}`;
      return out;
    }
    case 'live.set': {
      if (cmd.enabled !== undefined) cfg.live.enabled = !!cmd.enabled;
      if (cmd.fps !== undefined) cfg.live.fps = [15, 30, 60].includes(Number(cmd.fps)) ? Number(cmd.fps) : cfg.live.fps;
      out.message = `live: ${cfg.live.enabled ? 'on' : 'off'}, ${cfg.live.fps}fps`;
      return out;
    }
    case 'mascot.set': {
      if (cmd.enabled !== undefined) cfg.mascot.enabled = !!cmd.enabled;
      if (cmd.form !== undefined && ['whale', 'maid', 'portrait', 'vector', 'custom'].includes(cmd.form)) cfg.mascot.form = cmd.form;
      if (cmd.customFile !== undefined) cfg.mascot.customFile = String(cmd.customFile || '');
      if (cmd.xPct !== undefined) cfg.mascot.xPct = clamp(Number(cmd.xPct) || 0, 0, 1);
      if (cmd.size !== undefined) cfg.mascot.size = clamp(Number(cmd.size) || 1, 0.6, 2);
      out.message = `mascot: ${cfg.mascot.enabled ? cfg.mascot.form : 'off'}`;
      return out;
    }
    case 'avatars.set': {
      if (cmd.enabled !== undefined) cfg.avatars.enabled = !!cmd.enabled;
      if (cmd.user !== undefined) cfg.avatars.user = String(cmd.user || '');
      if (cmd.assistant !== undefined) cfg.avatars.assistant = String(cmd.assistant || '');
      if (cmd.user !== undefined || cmd.assistant !== undefined) cfg.avatars.v = Date.now(); // cache-bust same-filename swaps
      out.message = `avatars: ${cfg.avatars.enabled ? 'on' : 'off'}`;
      return out;
    }
    case 'props.set': {
      // per-wallpaper user property override (WE wire values, validated page-side)
      const id = String(cmd.id || '');
      const name = String(cmd.name || '');
      if (!id || !name) return fail('props.set 需要 id 与 name');
      (cfg.wallpaperProps[id] ||= {})[name] = cmd.value;
      out.propsChanged = true;
      out.message = `${id} · ${name} 已更新`;
      return out;
    }
    case 'props.reset': {
      const id = String(cmd.id || '');
      if (cfg.wallpaperProps[id]) { delete cfg.wallpaperProps[id]; out.propsChanged = true; }
      out.message = `已恢复默认属性`;
      return out;
    }

    case 'list.create': {
      const key = 'list-' + Date.now().toString(36);
      cfg.playlists.push({ key, name: String(cmd.name || '新列表').slice(0, 40), items: [], intervalSec: 600, order: 'sequential' });
      cfg.activePlaylist = key;
      cfg.currentIndex = 0;
      out.libChanged = true;
      out.message = `已创建并切换到「${cfg.playlists.at(-1).name}」`;
      return out;
    }
    case 'list.rename': {
      const p = cfg.playlists.find((x) => x.key === cmd.key);
      if (!p) return fail('列表不存在');
      p.name = String(cmd.name || p.name).slice(0, 40);
      out.libChanged = true;
      out.message = `已重命名为「${p.name}」`;
      return out;
    }
    case 'list.delete': {
      const i = cfg.playlists.findIndex((x) => x.key === cmd.key);
      if (i < 0) return fail('列表不存在');
      cfg.playlists.splice(i, 1);
      if (cfg.activePlaylist === cmd.key) { cfg.activePlaylist = cfg.playlists[0]?.key ?? null; cfg.currentIndex = 0; }
      out.libChanged = true;
      out.message = '已删除列表';
      return out;
    }
    case 'list.use': {
      if (!cfg.playlists.some((x) => x.key === cmd.key)) return fail('列表不存在');
      cfg.activePlaylist = cmd.key;
      cfg.currentIndex = 0;
      cfg.lastSwitchAt = Date.now();
      out.libChanged = true;
      out.message = `已切换列表`;
      return out;
    }
    case 'list.interval': {
      const p = ensureList(cfg);
      p.intervalSec = clamp(Number(cmd.sec) || p.intervalSec, 5, 86400);
      cfg.lastSwitchAt = Date.now();
      out.message = `间隔 ${p.intervalSec}s`;
      return out;
    }
    case 'list.order': {
      const p = ensureList(cfg);
      p.order = cmd.order === 'shuffle' ? 'shuffle' : 'sequential';
      out.message = `顺序 ${p.order}`;
      return out;
    }
    case 'list.add': {
      const item = lib.find((x) => x.id === cmd.id);
      if (!item) return fail(`壁纸不在库中: ${cmd.id}`);
      const list = ensureList(cfg);
      if (!list.items.some((x) => x.id === cmd.id)) list.items.push({ kind: item.kind, path: item.path, title: item.title, id: item.id });
      out.libChanged = true;
      out.message = `已加入「${list.name}」`;
      return out;
    }
    case 'list.remove': {
      const list = activeList(cfg);
      if (!list) return fail('无活动列表');
      const i = clamp(Number(cmd.idx) | 0, 0, list.items.length - 1);
      const [removed] = list.items.splice(i, 1);
      if (cfg.currentIndex >= list.items.length) cfg.currentIndex = Math.max(0, list.items.length - 1);
      out.libChanged = true;
      out.message = `已移除 ${removed?.title ?? ''}`;
      return out;
    }
    case 'list.clear': {
      const list = activeList(cfg);
      if (list) list.items = [];
      cfg.currentIndex = 0;
      out.libChanged = true;
      out.message = '已清空当前列表';
      return out;
    }

    case 'hide': {
      if (!cfg.hidden.includes(cmd.id)) cfg.hidden.push(cmd.id);
      out.libChanged = true;
      out.message = '已隐藏（源文件不动）';
      return out;
    }
    case 'unhide': {
      cfg.hidden = cfg.hidden.filter((x) => x !== cmd.id);
      out.libChanged = true;
      out.message = '已恢复';
      return out;
    }

    case 'preset.save': {
      const name = String(cmd.name || '').trim();
      if (!name) return fail('预设名为空');
      fs.mkdirSync(PRESET_DIR, { recursive: true });
      const file = path.join(PRESET_DIR, name.replace(/[^\w\-一-龥]+/g, '_') + '.json');
      const snapshot = {
        name, savedAt: new Date().toISOString(),
        cfg: { playlists: cfg.playlists, activePlaylist: cfg.activePlaylist, currentIndex: cfg.currentIndex, fx: cfg.fx, occlusion: cfg.occlusion, fxLayer: cfg.fxLayer, parallax: cfg.parallax, live: cfg.live, wallpaperProps: cfg.wallpaperProps, hidden: cfg.hidden },
      };
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
      return { changed: false, libChanged: false, message: `预设已保存: ${name}` };
    }
    case 'preset.apply': {
      const name = String(cmd.name || '').trim();
      const file = path.join(PRESET_DIR, name.replace(/[^\w\-一-龥]+/g, '_') + '.json');
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fail(`预设不存在: ${name}`); }
      const s = data.cfg || {};
      if (Array.isArray(s.playlists)) cfg.playlists = s.playlists;
      if (s.activePlaylist !== undefined) cfg.activePlaylist = s.activePlaylist;
      if (Number.isFinite(s.currentIndex)) cfg.currentIndex = s.currentIndex;
      if (s.fx) cfg.fx = { ...cfg.fx, ...s.fx };
      if (s.occlusion) cfg.occlusion = { ...cfg.occlusion, ...s.occlusion };
      if (s.fxLayer) cfg.fxLayer = { ...cfg.fxLayer, ...s.fxLayer };
      if (s.parallax) cfg.parallax = { ...cfg.parallax, ...s.parallax };
      if (s.live) cfg.live = { ...cfg.live, ...s.live };
      if (s.wallpaperProps) { cfg.wallpaperProps = s.wallpaperProps; out.propsChanged = true; }
      if (Array.isArray(s.hidden)) cfg.hidden = s.hidden;
      cfg.lastSwitchAt = Date.now();
      out.libChanged = true;
      out.message = `预设已套用: ${name}`;
      return out;
    }
    case 'preset.delete': {
      const name = String(cmd.name || '').trim();
      try { fs.unlinkSync(path.join(PRESET_DIR, name.replace(/[^\w\-一-龥]+/g, '_') + '.json')); out.message = `预设已删除: ${name}`; }
      catch { return fail(`预设不存在: ${name}`); }
      return out;
    }
    default:
      return fail(`未知命令: ${c}`);
  }
}
