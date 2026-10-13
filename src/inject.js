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
  const API = 6;
  const HOST = 'https://wallpaper.local';
  const BOX_ID = 'codex-wallpaper-layer';
  const DIM_ID = 'codex-wallpaper-dim';
  const FXC_ID = 'codex-wallpaper-fxcanvas';
  const STYLE_ID = 'codex-wallpaper-style';
  const HEAL_MS = 1000;
  const READY_TIMEOUT_MS = 9000;
  const LIVE_READY_MS = 15000;   // first-frame budget for WebWallGL (pkg fetch + texture decode + shader compile)
  const LIVE_STALL_MS = 12000;   // heartbeat: no new frame for this long -> degrade
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
    userThemeOverride: false, // user changed the app theme by hand — yield
    themeWrite: null,      // last theme we wrote (distinguish our own writes)
    initialTheme: null,    // app's theme at inject time (restored on destroy)
    battery: null,         // null = unknown
    lastPayload: null,
    liveInfo: null,        // live render config for the current index (null = plain media)
    liveDoc: '',           // srcdoc for the WebWallGL renderer iframe (pushed by bridge)
    liveSettings: null,    // { enabled, fps } for the panel
    propsDefs: null,       // current live wallpaper's user-property defs (panel UI)
    propsId: '',           // wallpaper id the defs/values belong to
    propsValues: null,     // user's override wire values for that wallpaper
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
    const a = num(fx.panelAlpha, 0.22), ad = num(fx.panelAlphaDark, 0.30);
    const c = num(fx.composerAlpha, 0.55), b = num(fx.panelBlur, 10);
    const ca = num(fx.contentAlpha, 0.62), cb = num(fx.contentBlur, 18);
    const glass = (r, g, bch, alpha, blur) =>
      `background:rgba(${r},${g},${bch},${alpha})!important;` +
      (blur > 0 ? `backdrop-filter:blur(${blur}px) saturate(1.35)!important;-webkit-backdrop-filter:blur(${blur}px) saturate(1.35)!important;` : '');
    const L = glass(255, 255, 255, a, b), D = glass(20, 20, 24, ad, b);
    const LC = glass(255, 255, 255, c, b), DC = glass(28, 28, 33, c, b);
    // readability card behind the transcript column (dsh 文字面保底, adapted)
    const LT = glass(255, 255, 255, ca, cb) + 'border-radius:14px;';
    const DT = glass(22, 22, 27, Math.min(1, ca + 0.06), cb) + 'border-radius:14px;';
    const M = 'main[class*="MainContentSurface"]', C = 'main [class*="ComposerLayoutRoot"]';
    const T = 'main [class*="transcriptContent"]';
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
html:not([data-we-tint]) ${T}{${LT}}
html:not([data-we-tint])[data-theme=dark] ${T}{${DT}}
html[data-we-tint=light] ${T}{${LT}}
html[data-we-tint=dark] ${T}{${DT}}
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
      if (s.kind !== 'live') s.el.style.objectPosition = `${num(fx.panX, 50)}% ${num(fx.panY, 50)}%`;
      s.el.style.transform = `scale(${num(fx.zoom, 1)}) scaleX(${fx.flipH ? -1 : 1})`;
      if (s.el.tagName === 'VIDEO') {
        s.el.playbackRate = clamp(num(fx.rate, 1), 0.25, 3);
        s.el.volume = clamp(num(fx.volume, 0), 0, 1);
        s.el.muted = num(fx.volume, 0) <= 0;
      }
    }
  }

  /* ================= live layer (WebWallGL scene/web) =================
   * The vendored renderer runs in a srcdoc iframe: same-origin with the app
   * page (direct __wp control, dsh live-layer style), element-level module
   * loads from the loopback media origin via <base> (the app's fetch patch
   * does not reach the srcdoc window), and no frame navigation for the app's
   * navigation guard to block. Config is delivered via __wp.setWallpaper()
   * because about:srcdoc has no query string to parse.
   */

  function liveCfgFor(live) {
    return {
      type: live.type,
      src: live.src,
      mediaBase: live.mediaBase,
      fit: 'cover',
      sceneFps: num(live.fps, 30),
      muted: !(state.fx && num(state.fx.volume, 0) > 0),
      webSandbox: live.type === 'web' ? 'strict' : undefined,
    };
  }

  function liveWp(slot) {
    try { return (slot.el && slot.el.contentWindow) || null; } catch { return null; }
  }

  // Diffed control surface (dsh applyLiveControls): pause/resume/setVolume are
  // only sent on change — a redundant resume() resets the renderer's frame
  // meter and would defeat the heartbeat below.
  function syncLiveSlot(slot, isActive, occluded) {
    const ctl = slot.liveCtl;
    if (!ctl || !ctl.configured) return;
    const w = liveWp(slot);
    const wp = w && w.__wp;
    if (!wp) return;
    const wantPlaying = !!(isActive && !state.paused && !occluded);
    if (ctl.appliedPlaying !== wantPlaying) {
      ctl.appliedPlaying = wantPlaying;
      try { wantPlaying ? wp.resume() : wp.pause(); } catch {}
    }
    const vol = isActive ? clamp(num(state.fx?.volume, 0), 0, 1) : 0;
    if (ctl.appliedVolume !== vol) {
      ctl.appliedVolume = vol;
      try { wp.setVolume(vol); } catch {}
    }
    const fps = clamp(Math.round(num(ctl.cfg?.sceneFps, 30)), 5, 120);
    if (ctl.configured && ctl.appliedFps !== fps) {
      ctl.appliedFps = fps;
      try { wp.setSceneFps && wp.setSceneFps(fps); } catch {}
    }
  }

  // __wpStats.frame() is {fps, running, ...} over a recent 500ms window.
  // Ready = running && fps>0; a paused/occluded page legitimately reads
  // {fps:0, running:false}, so the budget only ticks while playback is wanted
  // (dsh: 暂停期不计时 — 无帧有正当理由就不算失败). Web wallpapers paint no
  // continuous frames — their readiness is "configured and settled".
  function liveReady(slot) {
    const budget = clamp(num(slot.liveCtl?.budgetMs, 0), LIVE_READY_MS, 90000);
    const isWeb = slot.liveCtl?.cfg?.type === 'web';
    return new Promise((resolve) => {
      let waited = 0;
      let last = Date.now();
      let configuredAt = 0;
      const tick = () => {
        if (state.destroyed) return resolve(false);
        if (slot.el == null) return resolve(false); // torn down meanwhile
        const now = Date.now();
        const frozen = state.paused || state.occluded || document.hidden;
        if (!frozen) waited += now - last;
        last = now;
        const w = liveWp(slot);
        const ctl = slot.liveCtl;
        if (w && w.__wp && w.__wpStats && ctl) {
          if (!ctl.configured) {
            ctl.configured = true;
            configuredAt = now;
            try { w.__wp.setWallpaper(ctl.cfg); } catch {}
            syncLiveSlot(slot, true, state.occluded); // honor an already-paused state immediately
            applyPropsTo(slot); // user's per-wallpaper overrides, if any
          }
          let st = null;
          try { st = w.__wpStats.frame(); } catch {}
          if (st && st.running && st.fps > 0) return resolve(true);
          if (isWeb && configuredAt && now - configuredAt > 1500) return resolve(true);
        }
        if (waited > budget) return resolve(false);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  // Push the user's per-wallpaper property overrides into the renderer
  // (scene: sceneCtl.applyUserProperties; web: shim relay). Diffed by JSON —
  // the renderer re-runs property scripts on every call, so don't spam it.
  function applyPropsTo(slot) {
    const ctl = slot?.liveCtl;
    if (!ctl || !ctl.configured) return;
    const w = liveWp(slot);
    if (!w || !w.__wp || !w.__wp.updateWebProps) return;
    const vals = state.propsValues || {};
    const j = JSON.stringify(vals);
    if (ctl.appliedPropsJson === j) return;
    ctl.appliedPropsJson = j;
    if (!Object.keys(vals).length) return; // nothing overridden — renderer defaults stand
    try { w.__wp.updateWebProps(vals); } catch {}
  }

  // Frame sampling for the theme vote: draw the renderer's WebGL canvas inside
  // the iframe's own rAF (the drawing buffer is still valid there, no
  // preserveDrawingBuffer needed). Same-origin makes this legal at all.
  function sampleLiveTint(frame, cb) {
    let done = false;
    const finish = (rgb) => { if (!done) { done = true; cb(rgb); } };
    setTimeout(() => finish(null), 3500);
    try {
      const w = frame.contentWindow;
      w.requestAnimationFrame(() => {
        try {
          const cv = w.document.querySelector('canvas');
          if (!cv || !cv.width || !cv.height) return finish(null);
          finish(dominantColor((cx, S) => { cx.drawImage(cv, 0, 0, S, S); }));
        } catch { finish(null); }
      });
    } catch { finish(null); }
  }

  // 抓帧回填 (dsh live frame backfill): grab one settled frame as a small JPEG
  // and hand it to the bridge; on the next rotation onto this wallpaper the
  // still covers the slot instantly while the renderer warms up (pkg fetch +
  // shader compile can take seconds on big scenes).
  function captureLiveFrame(frame, cb) {
    let done = false;
    const finish = (url) => { if (!done) { done = true; cb(url); } };
    setTimeout(() => finish(null), 4000); // hidden page: rAF never fires
    try {
      const w = frame.contentWindow;
      w.requestAnimationFrame(() => {
        try {
          const src = w.document.querySelector('canvas');
          if (!src || !src.width) return finish(null);
          const k = Math.min(1, 480 / src.width);
          const cv = document.createElement('canvas');
          cv.width = Math.max(2, Math.round(src.width * k));
          cv.height = Math.max(2, Math.round(src.height * k));
          cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
          finish(cv.toDataURL('image/jpeg', 0.62));
        } catch { finish(null); }
      });
    } catch { finish(null); }
  }

  function sendFrame(id, dataUrl) {
    try {
      const b64 = dataUrl.split(',')[1].replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      if (!b64 || b64.length > 550000) return; // ~400KB decoded cap
      const im = new Image();
      im.src = `${HOST}/api/frame?id=${encodeURIComponent(id)}&d=${b64}`;
    } catch {}
  }

  /* ================= media & transitions ================= */

  function fillSlot(slotIdx, item, index, live) {
    const slot = state.slots[slotIdx];
    if (slot.el) { try { slot.el.pause && slot.el.pause(); } catch {} slot.wrap.innerHTML = ''; slot.el = null; slot.liveCtl = null; slot.still = null; }
    if (live && state.liveDoc) {
      const f = document.createElement('iframe');
      f.setAttribute('allow', 'autoplay');
      f.setAttribute('title', 'wallpaper-live');
      Object.assign(f.style, { width: '100%', height: '100%', border: '0', display: 'block' });
      f.srcdoc = state.liveDoc;
      // cached still under the (initially transparent) iframe: the wallpaper
      // appears instantly, the live renderer fades in over it when ready
      if (state.liveStill) {
        const still = document.createElement('img');
        still.alt = ''; still.draggable = false;
        Object.assign(still.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' });
        still.src = state.liveStill;
        slot.wrap.appendChild(still);
        slot.still = still;
        f.style.opacity = '0';
        f.style.transition = 'opacity 700ms ease';
      }
      slot.wrap.appendChild(f);
      slot.el = f; slot.index = index; slot.kind = 'live';
      slot.liveCtl = { cfg: liveCfgFor(live), budgetMs: num(live.budgetMs, 0), configured: false, appliedPlaying: null, appliedVolume: null, lastFrameAt: Date.now(), rescued: false };
      styleActiveMedia();
      return f;
    }
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
    if (kind === 'live') {
      const slot = state.slots.find((s) => s && s.el === el);
      return slot ? liveReady(slot) : Promise.resolve(false);
    }
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

  // 7-slat blinds. One polygon traces all slats with 5 points each (slat rect
  // + return along the top/left border so connectors stay zero-area); start
  // (full cover) and end (zero width) share the point count, so a plain CSS
  // transition interpolates every vertex (dsh bars, clip-path edition).
  function barsPoly(n, axis, t) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 100, b = ((i + 1) / n) * 100;
      const m = (a + b) / 2, half = ((b - a) / 2) * t;
      const p0 = m - half, p1 = m + half;
      if (axis === 'X') pts.push(`${p0}% 0%`, `${p1}% 0%`, `${p1}% 100%`, `${p0}% 100%`, `${p0}% 0%`);
      else pts.push(`0% ${p0}%`, `100% ${p0}%`, `100% ${p1}%`, `0% ${p1}%`, `0% ${p0}%`);
    }
    return `polygon(${pts.join(',')})`;
  }

  function runTransition(nextSlotWrap, oldSlotWrap) {
    const type = state.fx?.transition || 'fade';
    const dir = state.fx?.transitionDir || 'left';
    const dur = TRANSITION_DUR();
    const axis = dir === 'left' || dir === 'right' ? 'X' : 'Y';
    const sign = dir === 'left' || dir === 'up' ? 1 : -1; // next enters from this side
    const clipIn = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' };
    const wraps = [nextSlotWrap, oldSlotWrap].filter(Boolean);
    for (const w of wraps) { w.style.transitionProperty = 'none'; w.style.transitionDuration = '0ms'; }
    // stacking: reveal-type transitions (fade/slide/bars) keep the OLD layer on
    // top while it vacates; grow-type ones (wipe/iris/zoom) animate the new
    // layer over the old
    const oldOnTop = type === 'fade' || type === 'slide' || type === 'bars';
    if (oldSlotWrap) oldSlotWrap.style.zIndex = oldOnTop ? '2' : '1';
    nextSlotWrap.style.zIndex = oldOnTop ? '1' : '2';
    if (type === 'cut') {
      nextSlotWrap.style.opacity = '1';
      if (oldSlotWrap) oldSlotWrap.style.opacity = '0';
      return 0;
    }
    if (type === 'bars') {
      // next sits ready underneath; the old wallpaper's blinds close over it
      nextSlotWrap.style.opacity = '1';
      if (oldSlotWrap) {
        const barAxis = dir === 'up' || dir === 'down' ? 'Y' : 'X';
        oldSlotWrap.style.opacity = '1';
        oldSlotWrap.style.clipPath = barsPoly(7, barAxis, 1);
        void oldSlotWrap.offsetWidth;
        oldSlotWrap.style.transitionProperty = 'clip-path';
        oldSlotWrap.style.transitionDuration = `${dur}ms`;
        oldSlotWrap.style.transitionTimingFunction = 'ease';
        oldSlotWrap.style.clipPath = barsPoly(7, barAxis, 0);
      }
      return dur;
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

  function resetWrap(w) { if (!w) return; w.style.transitionProperty = 'none'; w.style.transform = ''; w.style.clipPath = ''; w.style.zIndex = ''; }

  async function show(index) {
    if (state.switching || state.destroyed) return;
    if (index === state.currentIndex && state.active >= 0) return;
    const item = state.items[index];
    if (!item) return;
    const live = state.liveInfo; // captured with this payload — never mix across payloads
    state.switching = true;
    try {
      const nextSlot = state.active === 0 ? 1 : 0;
      const oldSlot = state.active >= 0 ? state.active : -1;
      const el = fillSlot(nextSlot, item, index, live);
      const kind = state.slots[nextSlot].kind;
      const ready = await whenReady(el, kind);
      if (state.destroyed) return;
      if (!ready) { state.diagFailed = index; return; }
      state.diagFailed = null;
      if (kind === 'video' && !state.paused && !state.occluded) { try { await el.play(); } catch {} }
      if (kind === 'live') {
        const st = state.slots[nextSlot];
        if (st.still) {
          st.el.style.opacity = '1'; // renderer fades in over its own cached frame
          setTimeout(() => { try { st.still?.remove(); } catch {} st.still = null; }, 900);
        }
        // backfill the frame cache once the scene has settled (for instant
        // display the next time rotation lands on this wallpaper)
        const capId = item.id;
        if (capId) setTimeout(() => {
          if (state.destroyed || state.currentIndex !== index || state.slots[state.active]?.el !== st.el) return;
          captureLiveFrame(st.el, (url) => { if (url) sendFrame(capId, url); });
        }, 2500);
      }
      const dur = runTransition(state.slots[nextSlot].wrap, oldSlot >= 0 ? state.slots[oldSlot].wrap : null);
      state.active = nextSlot;
      state.currentIndex = index;
      state.userThemeOverride = false; // new wallpaper — theme-follow resumes (dsh: 换下一张恢复)
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
    applyTheme(t);
  }

  // theme-follow: flip the app's own data-theme so text colors stay readable.
  // Yields when the user changes the theme by hand (until the next wallpaper),
  // and never rewrites the same value (dsh's courtesy rules, adapted).
  function applyTheme(t) {
    if (!t || !state.fx?.autoTint) return;
    const html = document.documentElement;
    if (state.userThemeOverride) return;
    if (html.getAttribute('data-theme') === t) return;
    state.themeWrite = t;
    html.setAttribute('data-theme', t);
  }

  function initThemeWatch() {
    state.initialTheme = document.documentElement.getAttribute('data-theme');
    // External data-theme changes can be the app re-applying its stored theme
    // (navigation noise) or the user toggling the theme (real intent). They
    // look identical, so: re-assert once after a beat; only a second external
    // change within 10s counts as the user fighting us — then yield until the
    // next wallpaper (dsh's 让位 rule, adapted).
    let external = [];
    new MutationObserver(() => {
      const v = document.documentElement.getAttribute('data-theme');
      if (state.themeWrite && v === state.themeWrite) { state.themeWrite = null; return; } // our own write
      if (!v || state.userThemeOverride) return;
      const now = Date.now();
      external = external.filter((t) => now - t < 10000);
      external.push(now);
      if (external.length >= 2) {
        state.userThemeOverride = true;
        external = [];
        document.documentElement.removeAttribute('data-we-tint');
        return;
      }
      setTimeout(() => {
        if (!state.destroyed && !state.userThemeOverride && state.tint && state.fx?.autoTint) applyTheme(state.tint);
      }, 1500);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // 4-bit/channel mode bucket over a 32x32 downscale (draw callback fills it).
  function dominantColor(draw) {
    try {
      const S = 32;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      draw(cx, S);
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
    } catch { return null; }
  }

  function sampleMediaTint(el) {
    const w = el.tagName === 'VIDEO' ? el.videoWidth : el.naturalWidth;
    const h = el.tagName === 'VIDEO' ? el.videoHeight : el.naturalHeight;
    if (!w || !h) return null;
    return dominantColor((cx, S) => { cx.drawImage(el, 0, 0, S, S); }); // tainted canvas -> null, keep current tint
  }

  function tintOf(rgb) { return rgb && relLum(rgb[0], rgb[1], rgb[2]) > 0.40 ? 'light' : rgb ? 'dark' : null; }

  // schemeColor (author) and the real frame each get a vote; light only wins
  // when both agree (dsh's rule — a light schemeColor on a dark wallpaper is
  // treated as "author didn't fill it properly").
  function updateTint(item) {
    if (!state.fx?.autoTint) { setTint(null); return; }
    const libItem = item?.id != null ? state.lib.find((x) => x.id === item.id) : null;
    const schemeTint = tintOf(libItem?.schemeColor);
    const s = state.slots[state.active];
    const el = s?.el;
    const forIndex = state.currentIndex;
    const decide = (rgb) => {
      if (state.destroyed || state.currentIndex !== forIndex) return; // stale vote from the previous wallpaper
      const frameTint = tintOf(rgb);
      if (schemeTint && frameTint && schemeTint !== frameTint) return setTint('dark');
      setTint(frameTint || schemeTint);
    };
    if (!el) return;
    if (s.kind === 'live') { sampleLiveTint(el, decide); return; }
    if (el.tagName === 'VIDEO' && (el.readyState < 2 || el.currentTime < 0.25)) {
      // first frames are often black — sample once playback actually shows content
      el.addEventListener('playing', () => setTimeout(() => decide(sampleMediaTint(el)), 600), { once: true });
      setTimeout(() => decide(sampleMediaTint(el)), 3500); // fallback if 'playing' never fires (occluded window)
    } else {
      decide(sampleMediaTint(el));
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
      if (!s || !s.el) continue;
      const isActive = state.slots.indexOf(s) === state.active;
      if (s.kind === 'live') { syncLiveSlot(s, isActive, occluded); continue; }
      if (s.el.tagName !== 'VIDEO') continue;
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
    if ('live' in s) {
      const nl = s.live || null;
      const keyOf = (l) => (l ? `${l.type}|${l.src}` : '');
      const rebuild = keyOf(nl) !== keyOf(state.liveInfo);
      state.liveInfo = nl;
      // fps 等热字段不进重建键 —— 它们经 setSceneFps 差分下发，不重建槽位
      if (nl) {
        const act = state.slots[state.active];
        if (act && act.kind === 'live' && act.liveCtl) act.liveCtl.cfg.sceneFps = num(nl.fps, 30);
      }
      if (rebuild && state.active >= 0) state.currentIndex = -1; // live mode flipped for the current item -> rebuild its slot
    }
    if (typeof s.liveDoc === 'string' && s.liveDoc) state.liveDoc = s.liveDoc;
    if (s.liveSettings) state.liveSettings = s.liveSettings;
    if ('liveStill' in s) state.liveStill = s.liveStill || null;
    if (Array.isArray(s.propsDefs)) state.propsDefs = s.propsDefs;
    if (typeof s.propsId === 'string') state.propsId = s.propsId;
    if (s.propsValues && typeof s.propsValues === 'object') {
      state.propsValues = s.propsValues;
      const act = state.slots[state.active];
      if (act && act.kind === 'live') applyPropsTo(act); // live wallpaper: hot-apply edited props
    }
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
    const live = s && s.kind === 'live' ? { configured: !!(s.liveCtl && s.liveCtl.configured), stalledSec: s.liveCtl ? Math.round((Date.now() - s.liveCtl.lastFrameAt) / 1000) : 0 } : null;
    return { failed: state.diagFailed, index: state.currentIndex, ready: state.active >= 0, playing: v ? !v.paused : null, occluded: state.occluded, tint: state.tint, live };
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
    // the app may re-apply its stored theme on navigation — re-assert ours
    if (state.tint && !state.userThemeOverride && state.fx?.autoTint)
      applyTheme(state.tint);
    // live heartbeat: the renderer must keep producing frames while the
    // wallpaper is meant to animate ({fps,running} over a recent window).
    // One resume self-rescue, then report as failed so the bridge degrades
    // (dsh: 先单次 resume 自救，再失败).
    const act = state.slots[state.active];
    if (act && act.kind === 'live' && act.liveCtl && act.liveCtl.configured && !state.paused && !state.occluded && !document.hidden) {
      let st = null;
      try { const w = act.el.contentWindow; st = w && w.__wpStats ? w.__wpStats.frame() : null; } catch {}
      const now = Date.now();
      if (st && st.running && st.fps > 0) { act.liveCtl.lastFrameAt = now; act.liveCtl.rescued = false; }
      else if (now - act.liveCtl.lastFrameAt > LIVE_STALL_MS && state.diagFailed == null) {
        if (!act.liveCtl.rescued && st) {
          act.liveCtl.rescued = true;
          act.liveCtl.lastFrameAt = now;
          try { act.el.contentWindow.__wp.resume(); } catch {}
        } else state.diagFailed = act.index;
      }
    }
    syncPlayback();
  }

  function start() {
    const boot = () => {
      if (state.destroyed) return;
      ensureBox(); applyFx(); ensureFxCanvas();
      initThemeWatch();
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
    fullState: () => ({ payload: state.lastPayload, lib: state.lib, tint: state.tint, occluded: state.occluded, propsDefs: state.propsDefs, propsId: state.propsId, propsValues: state.propsValues }),
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
      // put the app's theme back the way we found it (dsh: 壁纸退场放回原偏好)
      if (state.initialTheme) document.documentElement.setAttribute('data-theme', state.initialTheme);
      delete window.__wallpaper;
    },
  };

  start();
  return { ok: true, api: API };
})();
