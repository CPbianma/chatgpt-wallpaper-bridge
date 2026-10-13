/* ChatGPT Wallpaper — page-side controller.
 * Injected into the ChatGPT/Codex desktop app via CDP (Page.addScriptToEvaluateOnNewDocument
 * + Runtime.evaluate). No imports allowed: this file is shipped as source text.
 *
 * The app patches window.fetch to an allow-list, so the controller never
 * fetches: the bridge PUSHES state via applyState(), and page -> bridge
 * commands ride tiny Image GETs (media/thumbnail loads are unaffected by the
 * app's fetch patch).
 *
 * Responsibilities: wallpaper layer with transitions, glass panel style,
 * occlusion-aware playback, theme-follow tint, click/trail fx canvas,
 * 3D parallax, and self-healing DOM.
 */
(() => {
  const API = 5;
  const HOST = 'https://wallpaper.local';
  const BOX_ID = 'codex-wallpaper-layer';
  const DIM_ID = 'codex-wallpaper-dim';
  const FXC_ID = 'codex-wallpaper-fxcanvas';
  const STYLE_ID = 'codex-wallpaper-style';
  const HEAL_MS = 1000;
  const READY_TIMEOUT_MS = 9000;
  const OCCLUSION_RECHECK_MS = 3000;

  const prev = window.__wallpaper;
  // Reuse only a same-version controller whose layer is actually in the DOM.
  if (prev && prev.api === API && document.getElementById(BOX_ID)) return { reused: true };
  try { prev && prev.destroy(); } catch {}

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const state = {
    destroyed: false,
    box: null, dim: null,
    slots: [],
    active: -1,
    currentIndex: -1,
    epoch: -1,
    fx: null, occlusion: null, fxLayer: null, parallaxCfg: null,
    items: [], lib: [], playlists: [],
    itemsKey: '',
    paused: false,
    diagFailed: null,
    timers: [],
    switching: false,
    occluded: false,
    tint: null,            // 'light' | 'dark' | null (auto)
    battery: null,         // null = unknown
    lastPayload: null,
    // fx canvas
    fxCanvas: null, fxCtx: null, fxParts: [], fxRaf: 0, pointer: { x: -1, y: -1 },
    trailPrev: { x: -1, y: -1 }, trailAcc: 0,
    // parallax
    parTarget: { x: 0, y: 0 }, parCurrent: { x: 0, y: 0 }, parRaf: 0,
  };

  /* ================= DOM ================= */

  function ensureBox() {
    let box = document.getElementById(BOX_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = BOX_ID;
    Object.assign(box.style, { position: 'fixed', inset: '0', zIndex: '-1000', pointerEvents: 'none', overflow: 'hidden', background: '#0b0b0d' });
    for (let i = 0; i < 2; i++) {
      const slot = document.createElement('div');
      Object.assign(slot.style, { position: 'absolute', inset: '0', opacity: '0', willChange: 'opacity,transform,clip-path' });
      box.appendChild(slot);
      state.slots[i] = { wrap: slot, el: null, index: -1 };
    }
    const dim = document.createElement('div');
    dim.id = DIM_ID;
    Object.assign(dim.style, { position: 'absolute', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none' });
    box.appendChild(dim);
    state.dim = dim;
    (document.documentElement || document.body).appendChild(box);
    state.box = box;
    return box;
  }

  function panelCss() {
    const fx = state.fx || {};
    const a = num(fx.panelAlpha, 0.55), ad = num(fx.panelAlphaDark, 0.55);
    const c = num(fx.composerAlpha, 0.66), b = num(fx.panelBlur, 22);
    const glass = (r, g, bch, alpha) =>
      `background:rgba(${r},${g},${bch},${alpha})!important;` +
      (b > 0 ? `backdrop-filter:blur(${b}px) saturate(1.35)!important;-webkit-backdrop-filter:blur(${b}px) saturate(1.35)!important;` : '');
    const L = glass(255, 255, 255, a), D = glass(20, 20, 24, ad);
    const LC = glass(255, 255, 255, c), DC = glass(28, 28, 33, c);
    const M = 'main[class*="MainContentSurface"]', C = 'main [class*="ComposerLayoutRoot"]';
    return `
html,body,#root{background:transparent!important}
html:not([data-we-tint]) ${M}{${L}}
html:not([data-we-tint])[data-theme=dark] ${M}{${D}}
html[data-we-tint=light] ${M}{${L}}
html[data-we-tint=dark] ${M}{${D}}
html:not([data-we-tint]) ${C}{${LC}}
html:not([data-we-tint])[data-theme=dark] ${C}{${DC}}
html[data-we-tint=light] ${C}{${LC}}
html[data-we-tint=dark] ${C}{${DC}}
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
    const css = panelCss();
    if (st.textContent !== css) st.textContent = css;
    return st;
  }

  function applyFx() {
    const fx = state.fx || {};
    const box = ensureBox();
    box.style.opacity = String(num(fx.opacity, 0.32));
    box.style.filter = `brightness(${num(fx.brightness, 0.68)}) contrast(${num(fx.contrast, 1)}) saturate(${num(fx.saturate, 1.15)}) blur(${num(fx.blur, 0)}px)`;
    if (state.dim) state.dim.style.opacity = String(num(fx.dim, 0));
    ensureStyle();
    styleActiveMedia();
  }

  function styleActiveMedia() {
    const fx = state.fx || {};
    for (const s of state.slots) {
      if (!s || !s.el) continue;
      s.el.style.objectPosition = `${num(fx.panX, 50)}% ${num(fx.panY, 50)}%`;
      s.el.style.transform = `scale(${num(fx.zoom, 1)}) scaleX(${fx.flipH ? -1 : 1})`;
      if (s.el.tagName === 'VIDEO') {
        s.el.playbackRate = clamp(num(fx.rate, 1), 0.25, 3);
        s.el.volume = clamp(num(fx.volume, 0), 0, 1);
        s.el.muted = num(fx.volume, 0) <= 0;
      }
    }
  }

  /* ================= media & transitions ================= */

  function fillSlot(slotIdx, item, index) {
    const slot = state.slots[slotIdx];
    if (slot.el) { try { slot.el.pause && slot.el.pause(); } catch {} slot.wrap.innerHTML = ''; slot.el = null; }
    const isVideo = item.kind === 'video';
    const el = document.createElement(isVideo ? 'video' : 'img');
    el.crossOrigin = 'anonymous'; // media responses carry ACAO:* — keeps canvas tint sampling readable
    if (isVideo) { el.loop = true; el.autoplay = true; el.playsInline = true; el.preload = 'auto'; }
    else { el.alt = ''; el.draggable = false; }
    Object.assign(el.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' });
    el.src = `${HOST}/media/${index}?e=${state.epoch}`;
    slot.wrap.appendChild(el);
    slot.el = el; slot.index = index; slot.kind = item.kind;
    styleActiveMedia();
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

  const TRANSITION_DUR = () => clamp(num(state.fx?.fadeMs, 800) * num(state.fx?.transitionSpeed, 1), 0, 8000);

  function runTransition(nextSlotWrap, oldSlotWrap) {
    const type = state.fx?.transition || 'fade';
    const dir = state.fx?.transitionDir || 'left';
    const dur = TRANSITION_DUR();
    const axis = dir === 'left' || dir === 'right' ? 'X' : 'Y';
    const sign = dir === 'left' || dir === 'up' ? 1 : -1; // next enters from this side
    const clipIn = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' };
    const wraps = [nextSlotWrap, oldSlotWrap].filter(Boolean);
    for (const w of wraps) { w.style.transitionProperty = 'none'; w.style.transitionDuration = '0ms'; }
    if (type === 'cut') {
      nextSlotWrap.style.opacity = '1';
      if (oldSlotWrap) oldSlotWrap.style.opacity = '0';
      return 0;
    }
    // initial poses
    if (type === 'slide') nextSlotWrap.style.transform = `translate${axis}(${sign * 100}%)`;
    if (type === 'wipe') nextSlotWrap.style.clipPath = clipIn[dir];
    if (type === 'iris') nextSlotWrap.style.clipPath = 'circle(0% at 50% 50%)';
    if (type === 'zoom') { nextSlotWrap.style.transform = 'scale(1.12)'; nextSlotWrap.style.opacity = '0'; }
    // force reflow, then animate
    void nextSlotWrap.offsetWidth;
    for (const w of wraps) {
      w.style.transitionProperty = type === 'fade' ? 'opacity' : `opacity,transform,clip-path`;
      w.style.transitionDuration = `${dur}ms`;
      w.style.transitionTimingFunction = 'ease';
    }
    nextSlotWrap.style.opacity = '1';
    if (oldSlotWrap) oldSlotWrap.style.opacity = '0';
    if (type === 'slide') { nextSlotWrap.style.transform = 'translateX(0)'; if (oldSlotWrap) oldSlotWrap.style.transform = `translate${axis}(${-sign * 100}%)`; }
    if (type === 'wipe') nextSlotWrap.style.clipPath = 'inset(0 0 0 0)';
    if (type === 'iris') nextSlotWrap.style.clipPath = 'circle(75% at 50% 50%)';
    if (type === 'zoom') { nextSlotWrap.style.transform = 'scale(1)'; if (oldSlotWrap) { oldSlotWrap.style.transform = 'scale(1.06)'; } }
    return dur;
  }

  function resetWrap(w) { if (!w) return; w.style.transitionProperty = 'none'; w.style.transform = ''; w.style.clipPath = ''; }

  async function show(index) {
    if (state.switching || state.destroyed) return;
    if (index === state.currentIndex && state.active >= 0) return;
    const item = state.items[index];
    if (!item) return;
    state.switching = true;
    try {
      const nextSlot = state.active === 0 ? 1 : 0;
      const oldSlot = state.active >= 0 ? state.active : -1;
      const el = fillSlot(nextSlot, item, index);
      const ready = await whenReady(el, item.kind);
      if (state.destroyed) return;
      if (!ready) { state.diagFailed = index; return; }
      state.diagFailed = null;
      if (item.kind === 'video' && !state.paused && !state.occluded) { try { await el.play(); } catch {} }
      const dur = runTransition(state.slots[nextSlot].wrap, oldSlot >= 0 ? state.slots[oldSlot].wrap : null);
      state.active = nextSlot;
      state.currentIndex = index;
      const old = oldSlot >= 0 ? state.slots[oldSlot] : null;
      setTimeout(() => {
        if (state.destroyed) return;
        resetWrap(state.slots[nextSlot].wrap);
        if (old) {
          resetWrap(old.wrap);
          if (old.el && old.el.tagName === 'VIDEO') { try { old.el.pause(); } catch {} }
        }
      }, dur + 120);
      updateTint(item);
    } finally {
      state.switching = false;
    }
  }

  /* ================= theme-follow tint ================= */

  const relLum = (r, g, b) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  function setTint(t) {
    if (state.tint === t) return;
    state.tint = t;
    const html = document.documentElement;
    if (!t) html.removeAttribute('data-we-tint');
    else html.setAttribute('data-we-tint', t);
  }

  function sampleMediaTint(el) {
    try {
      const S = 32;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      const w = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
      const h = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
      if (!w || !h) return null;
      cx.drawImage(el, 0, 0, S, S);
      const d = cx.getImageData(0, 0, S, S).data;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
      let best = null, bestN = 0;
      for (const [k, n] of buckets) if (n > bestN) { bestN = n; best = k; }
      if (best == null) return null;
      return [(best >> 8 & 15) * 17, (best >> 4 & 15) * 17, (best & 15) * 17];
    } catch { return null; } // tainted canvas or not ready — keep current tint
  }

  function updateTint(item) {
    if (!state.fx?.autoTint) { setTint(null); return; }
    const libItem = item?.id != null ? state.lib.find((x) => x.id === item.id) : null;
    const sc = libItem?.schemeColor;
    if (sc && sc.length === 3) { setTint(relLum(sc[0], sc[1], sc[2]) > 0.40 ? 'light' : 'dark'); return; }
    const s = state.slots[state.active];
    if (s?.el) {
      const rgb = sampleMediaTint(s.el);
      if (rgb) { setTint(relLum(rgb[0], rgb[1], rgb[2]) > 0.40 ? 'light' : 'dark'); return; }
    }
  }

  /* ================= occlusion & playback ================= */

  function occlusionReason() {
    const oc = state.occlusion || {};
    if (oc.hidden && document.hidden) return 'hidden';
    if (oc.blur && !document.hasFocus()) return 'blur';
    if (oc.battery && state.battery === true) return 'battery';
    return '';
  }

  function syncPlayback() {
    const reason = occlusionReason();
    const occluded = !!reason;
    state.occluded = occluded;
    for (const s of state.slots) {
      if (!s || !s.el || s.el.tagName !== 'VIDEO') continue;
      const isActive = state.slots.indexOf(s) === state.active;
      if (!isActive) { if (!s.el.paused) s.el.pause(); continue; }
      if (state.paused || occluded) { if (!s.el.paused) s.el.pause(); }
      else if (s.el.paused && !document.hidden) s.el.play().catch(() => {});
    }
  }

  function initBattery() {
    try {
      navigator.getBattery?.().then((b) => {
        if (!b) return;
        state.battery = !b.charging;
        b.addEventListener('chargingchange', () => { state.battery = !b.charging; syncPlayback(); });
      });
    } catch {}
  }

  /* ================= fx canvas (click & trail) ================= */

  function ensureFxCanvas() {
    let cv = document.getElementById(FXC_ID);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.id = FXC_ID;
    Object.assign(cv.style, { position: 'fixed', inset: '0', zIndex: '-999', pointerEvents: 'none', width: '100vw', height: '100vh' });
    (document.documentElement || document.body).appendChild(cv);
    state.fxCanvas = cv;
    state.fxCtx = cv.getContext('2d');
    const fit = () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; state.fxCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); };
    fit();
    addEventListener('resize', fit);
    return cv;
  }

  const fxEnabled = () => !!(state.fxLayer && (state.fxLayer.click?.enabled || state.fxLayer.trail?.enabled));

  function fxColor(sec, seed) {
    const c = sec.color || 'rainbow';
    if (c === 'rainbow') return `hsl(${(seed * 47 + performance.now() / 50) % 360} 90% 65%)`;
    if (c === 'theme') return '#4f8cff';
    return /^#?[0-9a-f]{6}$/i.test(c) ? (c.startsWith('#') ? c : '#' + c) : '#4f8cff';
  }

  function spawnClick(x, y) {
    const cfg = state.fxLayer?.click;
    if (!cfg?.enabled) return;
    const style = cfg.style || 'ripple';
    const size = num(cfg.size, 1), op = num(cfg.opacity, 0.8);
    const now = performance.now();
    if (style === 'ripple' || style === 'both') {
      state.fxParts.push({ kind: 'ring', x, y, r0: 6, r1: 90 * size, t0: now, ttl: 620, w: 2.5, color: fxColor(cfg, state.fxParts.length), op });
      state.fxParts.push({ kind: 'ring', x, y, r0: 6, r1: 64 * size, t0: now + 110, ttl: 620, w: 1.8, color: fxColor(cfg, state.fxParts.length + 1), op: op * 0.8 });
    }
    if (style === 'sparks' || style === 'both') {
      state.fxParts.push({ kind: 'flash', x, y, r: 26 * size, t0: now, ttl: 180, color: '#ffffff', op: op * 0.9 });
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
        const v = (60 + Math.random() * 140) * size;
        state.fxParts.push({ kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, len: 4 + Math.random() * 10 * size, t0: now, ttl: 480 + Math.random() * 240, color: fxColor(cfg, i), op });
      }
    }
    pumpFx();
  }

  function spawnTrail(x, y, moved) {
    const cfg = state.fxLayer?.trail;
    if (!cfg?.enabled || !moved) return;
    const now = performance.now();
    const op = num(cfg.opacity, 0.8), w = num(cfg.width, 1), ttl = num(cfg.ttl, 1);
    if (cfg.style === 'comet') {
      const p = state.trailPrev;
      if (p.x >= 0) state.fxParts.push({ kind: 'seg', x0: p.x, y0: p.y, x1: x, y1: y, w: 3.5 * w, t0: now, ttl: 520 * ttl, color: fxColor(cfg, state.fxParts.length), op });
      state.trailPrev = { x, y };
    } else { // stardust
      state.trailAcc += moved;
      const step = 14;
      while (state.trailAcc >= step) {
        state.trailAcc -= step;
        state.fxParts.push({ kind: 'dot', x: x + (Math.random() - 0.5) * 6, y: y + (Math.random() - 0.5) * 6, r: 1.2 + Math.random() * 2.2 * w, t0: now, ttl: 900 * ttl, color: fxColor(cfg, state.fxParts.length), op });
      }
      state.trailPrev = { x, y };
    }
    pumpFx();
  }

  function pumpFx() {
    if (state.fxRaf || state.destroyed) return;
    state.fxRaf = requestAnimationFrame(fxFrame);
  }

  function fxFrame() {
    state.fxRaf = 0;
    if (state.destroyed) return;
    if (!fxEnabled()) { state.fxParts.length = 0; return; }
    const cv = ensureFxCanvas(), cx = state.fxCtx;
    const now = performance.now();
    cx.clearRect(0, 0, innerWidth, innerHeight);
    if (!state.fxParts.length) return;
    cx.globalCompositeOperation = 'lighter';
    state.fxParts = state.fxParts.filter((p) => now - p.t0 < p.ttl);
    for (const p of state.fxParts) {
      const k = clamp((now - p.t0) / p.ttl, 0, 1);
      const alpha = (p.op ?? 0.8) * (1 - k);
      if (alpha <= 0.01) continue;
      cx.strokeStyle = p.color; cx.fillStyle = p.color; cx.globalAlpha = alpha;
      if (p.kind === 'ring') {
        cx.lineWidth = p.w * (1 - k * 0.6);
        cx.beginPath(); cx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - k, 2.2)), 0, Math.PI * 2); cx.stroke();
      } else if (p.kind === 'flash') {
        cx.beginPath(); cx.arc(p.x, p.y, p.r * (1 - k), 0, Math.PI * 2); cx.fill();
      } else if (p.kind === 'spark') {
        const dx = p.vx * k * 0.5, dy = p.vy * k * 0.5 + 30 * k * k;
        cx.lineWidth = 1.6;
        cx.beginPath(); cx.moveTo(p.x + dx, p.y + dy);
        cx.lineTo(p.x + dx - p.vx * 0.001 * p.len * 8, p.y + dy - p.vy * 0.001 * p.len * 8); cx.stroke();
      } else if (p.kind === 'seg') {
        cx.lineWidth = p.w * (1 - k); cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(p.x0, p.y0); cx.lineTo(p.x1, p.y1); cx.stroke();
      } else if (p.kind === 'dot') {
        cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, Math.PI * 2); cx.fill();
      }
    }
    cx.globalAlpha = 1;
    if (state.fxParts.length) pumpFx();
  }

  const UI_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"], .we-panel, .we-fab';
  function onPointerDown(e) {
    if (!fxEnabled()) return;
    if (e.target.closest && e.target.closest(UI_SELECTOR)) return;
    spawnClick(e.clientX, e.clientY);
  }
  function onPointerMove(e) {
    if (state.parallaxCfg?.enabled) {
      const pct = num(state.parallaxCfg.wallpaperPct, 1);
      state.parTarget = { x: 2 * pct / 100 * (e.clientX - innerWidth / 2), y: 2 * pct / 100 * (e.clientY - innerHeight / 2) };
      pumpParallax();
    }
    if (!fxEnabled() || !state.fxLayer?.trail?.enabled) return;
    const p = state.trailPrev;
    const moved = p.x < 0 ? 0 : Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (p.x < 0) { state.trailPrev = { x: e.clientX, y: e.clientY }; return; }
    spawnTrail(e.clientX, e.clientY, moved);
  }

  /* ================= parallax ================= */

  function pumpParallax() {
    if (state.parRaf || state.destroyed) return;
    state.parRaf = requestAnimationFrame(parFrame);
  }
  function parFrame(t) {
    state.parRaf = 0;
    if (state.destroyed) return;
    if (!state.parallaxCfg?.enabled) {
      if (state.box && state.box.style.translate) state.box.style.translate = '';
      return;
    }
    const k = 1 - Math.exp(-(t - (state.parLastT || t)) / 90);
    state.parLastT = t;
    const dx = state.parTarget.x - state.parCurrent.x, dy = state.parTarget.y - state.parCurrent.y;
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return;
    state.parCurrent.x += dx * k; state.parCurrent.y += dy * k;
    ensureBox().style.translate = `${-state.parCurrent.x.toFixed(2)}px ${-state.parCurrent.y.toFixed(2)}px`;
    // wallpaper edges must over-scan so parallax never reveals the void
    state.box.style.scale = String(1 + num(state.parallaxCfg.wallpaperPct, 1) / 50);
    pumpParallax();
  }

  /* ================= bridge-driven state ================= */

  async function applyState(s) {
    if (state.destroyed || !s || !Array.isArray(s.items)) return null;
    state.lastPayload = s;
    if (Array.isArray(s.lib)) state.lib = s.lib;
    if (Array.isArray(s.playlists)) state.playlists = s.playlists;
    const fxChanged = JSON.stringify(s.fx || {}) !== JSON.stringify(state.fx || {});
    const occlChanged = JSON.stringify(s.occlusion || {}) !== JSON.stringify(state.occlusion || {});
    const layerChanged = JSON.stringify(s.fxLayer || {}) !== JSON.stringify(state.fxLayer || {});
    const parChanged = JSON.stringify(s.parallax || {}) !== JSON.stringify(state.parallaxCfg || {});
    state.fx = s.fx || {};
    state.occlusion = s.occlusion || {};
    state.fxLayer = s.fxLayer || {};
    state.parallaxCfg = s.parallax || {};
    state.items = s.items;
    state.epoch = num(s.epoch, 0);
    state.paused = !!s.paused;
    state.listInfo = { key: s.listKey, name: s.listName, intervalSec: s.intervalSec, order: s.order };
    if (fxChanged) applyFx();
    if (layerChanged && !fxEnabled() && state.fxParts.length) state.fxParts.length = 0;
    if (parChanged && !state.parallaxCfg.enabled && state.box) { state.box.style.translate = ''; state.box.style.scale = ''; }
    const itemsKey = s.items.map((x) => x.id || x.title).join('|');
    if (itemsKey !== state.itemsKey) { state.itemsKey = itemsKey; state.currentIndex = -1; }
    if (s.items.length) {
      const want = num(s.index, 0) % s.items.length;
      await show(want);
    }
    if (occlChanged || s.paused !== undefined) syncPlayback();
    return diag();
  }

  function diag() {
    const s = state.active >= 0 ? state.slots[state.active] : null;
    const v = s && s.el && s.el.tagName === 'VIDEO' ? s.el : null;
    return { failed: state.diagFailed, index: state.currentIndex, ready: state.active >= 0, playing: v ? !v.paused : null, occluded: state.occluded, tint: state.tint };
  }

  /* ================= command channel (page -> bridge) ================= */

  function cmdSend(obj) {
    try {
      const im = new Image();
      im.src = `${HOST}/api/cmd?c=${encodeURIComponent(JSON.stringify(obj))}&t=${Date.now()}`;
    } catch {}
  }

  /* ================= self-heal ================= */

  function heal() {
    if (state.destroyed || !document.documentElement) return;
    if (!document.getElementById(BOX_ID)) {
      state.box = null; state.dim = null; state.active = -1; state.slots = [];
      const idx = state.currentIndex; state.currentIndex = -1;
      ensureBox(); applyFx();
      if (idx >= 0) show(idx);
    }
    if (!document.getElementById(STYLE_ID)) ensureStyle();
    if (fxEnabled() && !document.getElementById(FXC_ID)) ensureFxCanvas();
    syncPlayback();
  }

  function start() {
    const boot = () => {
      if (state.destroyed) return;
      ensureBox(); applyFx(); ensureFxCanvas();
      state.timers.push(setInterval(heal, HEAL_MS));
      state.timers.push(setInterval(syncPlayback, OCCLUSION_RECHECK_MS));
      document.addEventListener('visibilitychange', syncPlayback);
      addEventListener('blur', syncPlayback);
      addEventListener('focus', syncPlayback);
      document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
      document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
      initBattery();
    };
    if (document.documentElement) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  /* ================= public API ================= */

  window.__wallpaper = {
    api: API,
    applyState,
    state: diag,
    fullState: () => ({ payload: state.lastPayload, lib: state.lib, tint: state.tint, occluded: state.occluded }),
    cmd: cmdSend,
    destroy() {
      state.destroyed = true;
      for (const t of state.timers) clearInterval(t);
      document.removeEventListener('visibilitychange', syncPlayback);
      removeEventListener('blur', syncPlayback);
      removeEventListener('focus', syncPlayback);
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.getElementById(BOX_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
      document.getElementById(FXC_ID)?.remove();
      document.documentElement.removeAttribute('data-we-tint');
      delete window.__wallpaper;
    },
  };

  start();
  return { ok: true, api: API };
})();
