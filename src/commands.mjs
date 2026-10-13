// Shared command application: both the in-page panel (via /api/cmd) and the CLI
// mutate config through here, so every control has identical semantics.
// A command returns { changed, libChanged, message } — the caller persists
// config and bumps epochs accordingly.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FX, PRESET_DIR, activeList, clamp } from './config.mjs';

const FX_LIMITS = {
  opacity: [0, 1], brightness: [0, 4], contrast: [0, 4], saturate: [0, 4], blur: [0, 40],
  dim: [0, 0.85], panX: [0, 100], panY: [0, 100], zoom: [1, 3],
  rate: [0.25, 3], volume: [0, 1], fadeMs: [0, 5000],
  panelAlpha: [0, 1], panelAlphaDark: [0, 1], panelBlur: [0, 60], composerAlpha: [0, 1],
  contentAlpha: [0, 1], contentBlur: [0, 60],
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

    case 'fx': {
      const { k, v } = cmd;
      if (!(k in DEFAULT_FX)) return fail(`未知效果键: ${k}`);
      if (typeof DEFAULT_FX[k] === 'boolean') cfg.fx[k] = !!v;
      else if (typeof DEFAULT_FX[k] === 'number') cfg.fx[k] = clamp(Number(v) || 0, ...(FX_LIMITS[k] || [-Infinity, Infinity]));
      else if (k === 'transition') cfg.fx.transition = TRANSITIONS.has(v) ? v : cfg.fx.transition;
      else if (k === 'transitionDir') cfg.fx.transitionDir = DIRS.has(v) ? v : cfg.fx.transitionDir;
      else cfg.fx[k] = v;
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
      if (cmd.form !== undefined && ['whale', 'maid', 'portrait', 'vector'].includes(cmd.form)) cfg.mascot.form = cmd.form;
      if (cmd.xPct !== undefined) cfg.mascot.xPct = clamp(Number(cmd.xPct) || 0, 0, 1);
      if (cmd.size !== undefined) cfg.mascot.size = clamp(Number(cmd.size) || 1, 0.6, 2);
      out.message = `mascot: ${cfg.mascot.enabled ? cfg.mascot.form : 'off'}`;
      return out;
    }
    case 'avatars.set': {
      if (cmd.enabled !== undefined) cfg.avatars.enabled = !!cmd.enabled;
      if (cmd.user !== undefined) cfg.avatars.user = String(cmd.user || '');
      if (cmd.assistant !== undefined) cfg.avatars.assistant = String(cmd.assistant || '');
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
