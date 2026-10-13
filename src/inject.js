/* ChatGPT Wallpaper — page-side controller.
 * Injected into the ChatGPT/Codex desktop app via CDP (Page.addScriptToEvaluateOnNewDocument
 * + Runtime.evaluate). No imports allowed: this file is shipped as source text.
 *
 * Responsibilities:
 *  - own the wallpaper layer (two slots, crossfade) behind the app UI
 *  - install the "glass panel" style that lets the wallpaper show through
 *  - poll the bridge for state (playlist pointer + effects) and follow it
 *  - self-heal: re-append DOM if React wipes it, resume playback, pause when hidden
 */
(() => {
  const API = 3;
  const HOST = 'https://wallpaper.local';
  const BOX_ID = 'codex-wallpaper-layer';
  const STYLE_ID = 'codex-wallpaper-style';
  const POLL_MS = 3000;
  const HEAL_MS = 1000;
  const READY_TIMEOUT_MS = 9000;

  const prev = window.__wallpaper;
  if (prev && prev.api === API) { prev.refresh(); return { reused: true }; }
  try { prev && prev.destroy(); } catch {}

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  const state = {
    api: API,
    destroyed: false,
    box: null,
    slots: [],        // [{ el, kind, index }]
    active: -1,       // which slot is visible
    currentIndex: -1, // playlist index currently shown
    epoch: -1,
    fx: null,
    timers: [],
    lastSwitchAt: 0,
    switching: false,
  };

  /* ---------- DOM ---------- */

  function ensureBox() {
    let box = document.getElementById(BOX_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = BOX_ID;
    Object.assign(box.style, {
      position: 'fixed', inset: '0', zIndex: '-1000', pointerEvents: 'none',
      overflow: 'hidden', background: '#0b0b0d',
    });
    for (let i = 0; i < 2; i++) {
      const slot = document.createElement('div');
      Object.assign(slot.style, {
        position: 'absolute', inset: '0', opacity: '0', transitionProperty: 'opacity',
        transitionTimingFunction: 'ease', willChange: 'opacity',
      });
      box.appendChild(slot);
      state.slots[i] = { wrap: slot, el: null, index: -1 };
    }
    (document.documentElement || document.body).appendChild(box);
    state.box = box;
    return box;
  }

  function panelCss(fx) {
    const a = num(fx.panelAlpha, 0.55), ad = num(fx.panelAlphaDark, 0.55);
    const c = num(fx.composerAlpha, 0.66), b = num(fx.panelBlur, 22);
    const glass = (r, g, bch, alpha) =>
      `background:rgba(${r},${g},${bch},${alpha})!important;` +
      (b > 0 ? `backdrop-filter:blur(${b}px) saturate(1.35)!important;-webkit-backdrop-filter:blur(${b}px) saturate(1.35)!important;` : '');
    return `
html,body,#root{background:transparent!important}
main[class*="MainContentSurface"]{${glass(255, 255, 255, a)}}
html[data-theme=dark] main[class*="MainContentSurface"]{${glass(20, 20, 24, ad)}}
main [class*="ComposerLayoutRoot"]{${glass(255, 255, 255, c)}}
html[data-theme=dark] main [class*="ComposerLayoutRoot"]{${glass(28, 28, 33, c)}}
main div.pointer-events-none.absolute.inset-x-0.-top-8{background:transparent!important;background-image:none!important}
`.trim();
  }

  function ensureStyle() {
    let st = document.getElementById(STYLE_ID);
    if (!st) {
      st = document.createElement('style');
      st.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(st);
    }
    const css = panelCss(state.fx || {});
    if (st.textContent !== css) st.textContent = css;
    return st;
  }

  function applyFx() {
    const fx = state.fx || {};
    const box = ensureBox();
    box.style.opacity = String(num(fx.opacity, 0.32));
    box.style.filter = `brightness(${num(fx.brightness, 0.68)}) saturate(${num(fx.saturate, 1.15)}) blur(${num(fx.blur, 0)}px)`;
    for (const s of state.slots) if (s) s.wrap.style.transitionDuration = `${num(fx.fadeMs, 800)}ms`;
    ensureStyle();
  }

  /* ---------- media ---------- */

  function fillSlot(slotIdx, item, index) {
    const slot = state.slots[slotIdx];
    if (slot.el) { try { slot.el.pause && slot.el.pause(); } catch {} slot.wrap.innerHTML = ''; slot.el = null; }
    const isVideo = item.kind === 'video';
    const el = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      el.muted = true; el.loop = true; el.autoplay = true; el.playsInline = true; el.preload = 'auto';
    } else { el.alt = ''; el.draggable = false; }
    Object.assign(el.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
    el.src = `${HOST}/media/${index}?e=${state.epoch}`;
    slot.wrap.appendChild(el);
    slot.el = el; slot.index = index; slot.kind = item.kind;
    return el;
  }

  function whenReady(el, kind) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      const t = setTimeout(() => finish(false), READY_TIMEOUT_MS);
      const ok = () => { clearTimeout(t); finish(true); };
      const bad = () => { clearTimeout(t); finish(false); };
      if (kind === 'video') {
        if (el.readyState >= 3) return ok();
        el.addEventListener('canplay', ok, { once: true });
        el.addEventListener('error', bad, { once: true });
      } else {
        if (el.complete && el.naturalWidth > 0) return ok();
        el.addEventListener('load', ok, { once: true });
        el.addEventListener('error', bad, { once: true });
      }
    });
  }

  async function show(index, items) {
    if (state.switching || state.destroyed) return;
    if (index === state.currentIndex && state.active >= 0) return;
    const item = items[index];
    if (!item) return;
    state.switching = true;
    try {
      const nextSlot = state.active === 0 ? 1 : 0;
      const el = fillSlot(nextSlot, item, index);
      const ready = await whenReady(el, item.kind);
      if (state.destroyed) return;
      if (!ready) {
        // media broken — ask the bridge to skip past it, follow on next poll
        fetch(`${HOST}/api/skip?i=${index}`).catch(() => {});
        return;
      }
      if (item.kind === 'video') { try { await el.play(); } catch {} }
      for (let i = 0; i < 2; i++) state.slots[i].wrap.style.opacity = i === nextSlot ? '1' : '0';
      state.active = nextSlot;
      state.currentIndex = index;
      state.lastSwitchAt = Date.now();
      const old = state.slots[nextSlot === 0 ? 1 : 0];
      setTimeout(() => {
        if (state.destroyed || !old) return;
        if (old.el && old.el.tagName === 'VIDEO') { try { old.el.pause(); } catch {} }
      }, num((state.fx || {}).fadeMs, 800) + 150);
    } finally {
      state.switching = false;
    }
  }

  /* ---------- bridge sync ---------- */

  async function sync() {
    if (state.destroyed) return;
    let s;
    try {
      const r = await fetch(`${HOST}/api/state?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      s = await r.json();
    } catch { return; }
    if (state.destroyed || !s || !Array.isArray(s.items)) return;
    const fxChanged = JSON.stringify(s.effects || {}) !== JSON.stringify(state.fx || {});
    state.fx = s.effects || {};
    if (fxChanged) applyFx();
    state.epoch = num(s.epoch, 0);
    if (s.items.length === 0) return;
    const want = num(s.index, 0) % s.items.length;
    await show(want, s.items);
  }

  function heal() {
    if (state.destroyed) return;
    if (!document.documentElement) return;
    if (!document.getElementById(BOX_ID)) { state.box = null; ensureBox(); applyFx(); state.currentIndex = -1; sync(); return; }
    if (!document.getElementById(STYLE_ID)) ensureStyle();
    if (state.active >= 0) {
      const s = state.slots[state.active];
      if (s && s.el && s.el.tagName === 'VIDEO' && s.el.paused && !document.hidden) s.el.play().catch(() => {});
    }
  }

  function onVisibility() {
    if (state.active < 0) return;
    const s = state.slots[state.active];
    if (!s || !s.el || s.el.tagName !== 'VIDEO') return;
    if (document.hidden) { try { s.el.pause(); } catch {} }
    else s.el.play().catch(() => {});
  }

  function start() {
    const boot = () => {
      if (state.destroyed) return;
      ensureBox(); applyFx(); sync();
      state.timers.push(setInterval(sync, POLL_MS));
      state.timers.push(setInterval(heal, HEAL_MS));
      document.addEventListener('visibilitychange', onVisibility);
    };
    if (document.documentElement) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  /* ---------- public API (used by the CLI over CDP) ---------- */

  window.__wallpaper = {
    api: API,
    refresh: sync,
    state: () => ({ index: state.currentIndex, epoch: state.epoch, fx: state.fx }),
    destroy() {
      state.destroyed = true;
      for (const t of state.timers) clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
      document.getElementById(BOX_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      delete window.__wallpaper;
    },
  };

  start();
  return { ok: true, api: API };
})();
