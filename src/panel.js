/* ChatGPT Wallpaper — in-app control panel (vanilla JS, no framework).
 * Injected after inject.js; talks to the bridge through window.__wallpaper.cmd()
 * (Image GET -> /api/cmd) and re-renders from pushed state. All class names are
 * prefixed wep-; root uses class "we-panel" so the fx layer skips its clicks.
 */
(() => {
  const PANEL_API = 4;
  const wp = window.__wallpaper;
  if (!wp) return { ok: false, reason: 'controller missing' };
  const prev = window.__wallpaperPanel;
  // Reuse only a same-version, same-build panel that actually mounted (the
  // build tag rides ahead of this source, so any panel.js edit forces a
  // rebuild — no more stale handlers surviving a fix).
  if (prev && prev.api === PANEL_API && prev.build === window.__wePanelBuild && document.getElementById('we-panel-root')) return { reused: true };
  try { prev && prev.destroy(); } catch {}

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const HOST = 'https://wallpaper.local';
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------- style ---------- */

  const CSS = `
.we-fab{position:fixed;right:14px;bottom:96px;width:42px;height:42px;border-radius:50%;z-index:999990;cursor:pointer;
  display:flex;align-items:center;justify-content:center;user-select:none;touch-action:none;
  background:rgba(128,128,160,.28);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
  border:1px solid rgba(255,255,255,.35);box-shadow:0 4px 18px rgba(0,0,0,.25);transition:transform .15s}
.we-fab:hover{transform:scale(1.08)}
.we-fab svg{width:20px;height:20px;stroke:#fff;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
/* pull-cord mascot (dsh .we-rope): hangs at the top edge; drag sideways to
   reposition, pull DOWN to open the panel as a drawer, click to toggle.
   No CSS filter on the rope (Chromium re-rasterization flash); the art is a
   page-derived alpha-cropped PNG. */
.we-rope{position:fixed;top:64px;left:80%;z-index:999992;width:52px;height:57px;cursor:grab;
  user-select:none;touch-action:none}
.we-rope.dragging{cursor:grabbing}
.we-rope.settle{transition:top .28s cubic-bezier(.16,1,.3,1),left .28s cubic-bezier(.16,1,.3,1)}
.we-rope .we-rope-art{width:100%;height:100%;transition:transform .12s ease}
.we-rope:hover .we-rope-art{transform:scale(1.06)}
.we-rope .we-rope-art img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}
.we-panel{position:fixed;right:14px;bottom:148px;width:400px;max-width:calc(100vw - 28px);height:min(620px,calc(100vh - 180px));
  z-index:999991;display:flex;flex-direction:column;overflow:hidden;border-radius:16px;
  background:rgba(30,32,44,.62);backdrop-filter:blur(28px) saturate(1.5);-webkit-backdrop-filter:blur(28px) saturate(1.5);
  border:1px solid rgba(255,255,255,.22);box-shadow:0 18px 60px rgba(0,0,0,.45);color:#f2f3f7;
  font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
.we-panel *{box-sizing:border-box;margin:0;padding:0}
.wep-head{display:flex;align-items:center;gap:4px;padding:10px 10px;border-bottom:1px solid rgba(255,255,255,.12);flex:none}
.wep-title{font-weight:650;font-size:12.5px;margin-right:auto;opacity:.95;white-space:nowrap}
.wep-tab{border:0;background:transparent;color:#cfd3e0;padding:5px 7px;border-radius:8px;cursor:pointer;font-size:12px;white-space:nowrap}
.wep-tab:hover{background:rgba(255,255,255,.1)}
.wep-tab.on{background:rgba(255,255,255,.2);color:#fff;font-weight:600}
.wep-close{border:0;background:transparent;color:#cfd3e0;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}
.wep-close:hover{background:rgba(255,255,255,.12)}
.wep-body{overflow-y:auto;flex:1;padding:12px;scrollbar-width:thin}
.wep-body::-webkit-scrollbar{width:6px}.wep-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:3px}
.wep-row{display:flex;align-items:center;gap:8px;margin:8px 0}
.wep-row label{flex:none;width:86px;opacity:.85;font-size:12.5px}
.wep-row output{flex:none;width:44px;text-align:right;font-variant-numeric:tabular-nums;opacity:.8;font-size:12px}
.wep-sec{margin:14px 0 6px;font-size:12px;font-weight:650;opacity:.65;letter-spacing:.04em}
.wep-slider{flex:1;accent-color:#7fa8ff;height:4px;cursor:pointer}
.wep-toggle{position:relative;width:36px;height:20px;flex:none;border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.12);cursor:pointer;transition:background .15s}
.wep-toggle.on{background:#5b8cff;border-color:#5b8cff}
.wep-toggle::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.wep-toggle.on::after{left:18px}
.wep-btn{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.12);color:#fff;border-radius:8px;padding:5px 12px;cursor:pointer;font-size:12.5px}
.wep-btn:hover{background:rgba(255,255,255,.22)}
.wep-btn.primary{background:#5b8cff;border-color:#5b8cff}
.wep-btn.primary:hover{background:#6f9bff}
.wep-btn.danger:hover{background:rgba(255,90,90,.35)}
.wep-select,.wep-input{flex:1;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:5px 8px;font-size:12.5px;outline:none}
.wep-select option{background:#262836;color:#fff}
.wep-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.wep-card{position:relative;border-radius:10px;overflow:hidden;cursor:pointer;aspect-ratio:16/10;background:rgba(255,255,255,.07);border:2px solid transparent}
.wep-card img{width:100%;height:100%;object-fit:cover;display:block;loading:lazy}
.wep-card .t{position:absolute;left:0;right:0;bottom:0;padding:10px 6px 4px;font-size:10.5px;background:linear-gradient(transparent,rgba(0,0,0,.75));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wep-card .b{position:absolute;top:4px;left:4px;font-size:9.5px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.55)}
.wep-card.cur{border-color:#5b8cff}
.wep-card .acts{position:absolute;top:4px;right:4px;display:none;gap:4px}
.wep-card:hover .acts{display:flex}
.wep-mini{border:0;border-radius:5px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:2px 7px;cursor:pointer}
.wep-mini:hover{background:rgba(40,60,120,.85)}
.wep-empty{opacity:.55;text-align:center;padding:26px 0;font-size:12.5px}
.wep-cur{display:flex;gap:10px;align-items:center;padding:10px;border-radius:12px;background:rgba(255,255,255,.09);margin-bottom:6px}
.wep-cur img{width:86px;height:54px;object-fit:cover;border-radius:8px;flex:none}
.wep-cur .n{font-weight:600;font-size:12.5px}
.wep-cur .s{opacity:.7;font-size:11.5px}
.wep-plist{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.wep-pitem{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.07);font-size:12px;cursor:pointer;transition:background .12s}
.wep-pitem:hover{background:rgba(255,255,255,.16)}
.wep-pitem .n{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wep-pitem.cur{outline:1.5px solid #5b8cff}
.wep-note{font-size:11.5px;opacity:.6;margin-top:8px}
.wep-color{width:48px;height:26px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:rgba(255,255,255,.08);padding:2px;cursor:pointer}
`;

  /* ---------- helpers ---------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const slider = (label, min, max, step, val, fmt, onIn) => {
    const out = h('output', {}, fmt(val));
    const s = h('input', { class: 'wep-slider', type: 'range', min, max, step, value: val });
    s.addEventListener('input', () => { out.textContent = fmt(Number(s.value)); onIn(Number(s.value)); });
    return h('div', { class: 'wep-row' }, h('label', {}, label), s, out);
  };
  const toggle = (label, on, onCh) => {
    const t = h('div', { class: 'wep-toggle' + (on ? ' on' : ''), role: 'switch' });
    t.addEventListener('click', () => { const v = !t.classList.contains('on'); t.classList.toggle('on', v); onCh(v); });
    return h('div', { class: 'wep-row' }, h('label', {}, label), t);
  };
  const select = (label, options, val, onCh) => {
    const s = h('select', { class: 'wep-select' });
    for (const [v, t] of options) s.append(h('option', { value: v, ...(String(v) === String(val) ? { selected: '' } : {}) }, t));
    s.addEventListener('change', () => onCh(s.value));
    return label ? h('div', { class: 'wep-row' }, h('label', {}, label), s) : s;
  };
  const pct = (v) => Math.round(v * 100) + '%';
  const px = (v) => Math.round(v) + 'px';

  // inline text input that replaces itself with a submit row (no window.prompt:
  // unsupported in Electron and native modals break focus tracking)
  const inlineInput = (placeholder, onSubmit) => {
    const inp = h('input', { class: 'wep-input', placeholder });
    const done = () => { const v = inp.value.trim(); if (v) onSubmit(v); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    const row = h('div', { class: 'wep-row' }, inp, h('button', { class: 'wep-btn primary', onclick: done }, '确定'));
    setTimeout(() => inp.focus(), 30);
    return row;
  };
  // two-step destructive button: first click arms, second confirms
  const confirmBtn = (label, onConfirm) => {
    const b = h('button', { class: 'wep-btn danger' }, label);
    let armed = false, timer = 0;
    b.addEventListener('click', () => {
      if (!armed) { armed = true; b.textContent = '确认' + label + '？'; clearTimeout(timer); timer = setTimeout(() => { armed = false; b.textContent = label; }, 2600); }
      else { clearTimeout(timer); armed = false; b.textContent = label; onConfirm(); }
    });
    return b;
  };

  /* ---------- panel shell ---------- */

  let root = null, body = null, tabBar = null;
  let tab = 'wall';
  let filterType = 'all', filterRating = 'all', search = '', showHidden = false;
  let refreshTimer = 0, lastEpoch = -1, lastIndex = -1, lastPropsId = '', panelBusy = false;

  const TABS = [['wall', '壁纸'], ['play', '播放'], ['fx', '效果'], ['lists', '轮播'], ['ext', '扩展'], ['sys', '系统']];

  const wpApi = () => window.__wallpaper;
  const full = () => wpApi()?.fullState() || {};
  const payload = () => full().payload || {};
  const lib = () => full().lib || [];
  // fire-and-forget; the 1.6s auto-refresh (paused while interacting) picks up results
  const cmd = (o) => { wpApi()?.cmd(o); };

  function fabIcon() {
    return `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="M4 17l5-4 4 3 3-2 4 3"/></svg>`;
  }

  function mount() {
    if (document.getElementById('we-panel-root')) return;
    const st = h('style', { id: 'we-panel-style' }, CSS);
    const fab = h('div', { class: 'we-fab', id: 'we-fab', title: '壁纸引擎' });
    fab.innerHTML = fabIcon();
    root = h('div', { id: 'we-panel-root' });
    document.documentElement.append(st, root, fab);

    let dragY = null;
    fab.addEventListener('pointerdown', (e) => { dragY = { y0: e.clientY, b0: parseInt(fab.style.bottom || '96', 10), moved: false }; fab.setPointerCapture(e.pointerId); });
    fab.addEventListener('pointermove', (e) => {
      if (!dragY) return;
      const dy = dragY.b0 + (dragY.y0 - e.clientY);
      if (Math.abs(e.clientY - dragY.y0) > 4) dragY.moved = true;
      fab.style.bottom = Math.max(12, Math.min(innerHeight - 60, dy)) + 'px';
    });
    fab.addEventListener('pointerup', () => { if (!dragY?.moved) togglePanel(); dragY = null; });
    lastMascotJson = ''; // force (re)build of rope/FAB visibility
    syncRope();
  }

  /* ---------- mascot rope (dsh 吉祥物拉绳) ---------- */

  const ROPE_W = 52, ROPE_H = 57, ROPE_TOP = 64;
  let rope = null, ropeImg = null, lastMascotJson = '';
  const ropePar = { tx: 0, ty: 0, cx: 0, cy: 0, raf: 0 };

  const mascotCfg = () => {
    const m = payload().mascot || {};
    return { enabled: m.enabled !== false, form: m.form || 'whale', xPct: num(m.xPct, 0.88), size: clamp(num(m.size, 1), 0.6, 2) };
  };

  // Keep the rope/FAB in step with pushed config (called on every refresh tick).
  function syncRope() {
    const mc = mascotCfg();
    const j = JSON.stringify(mc);
    const fab = document.getElementById('we-fab');
    if (!mc.enabled) {
      if (rope) { rope.remove(); rope = null; ropeImg = null; lastMascotJson = j; }
      if (fab) fab.style.display = '';
      return;
    }
    if (fab) fab.style.display = 'none';
    if (j === lastMascotJson && rope) return;
    lastMascotJson = j;
    if (!rope) mountRope();
    positionRope(mc);
    if (rope._form !== mc.form) { rope._form = mc.form; loadRopeArt(); }
  }

  function positionRope(mc = mascotCfg()) {
    if (!rope) return;
    rope.style.width = ROPE_W * mc.size + 'px';
    rope.style.height = ROPE_H * mc.size + 'px';
    rope._x = clamp(Math.round(mc.xPct * innerWidth - (ROPE_W * mc.size) / 2), 8, innerWidth - ROPE_W * mc.size - 8);
    rope.style.left = rope._x + 'px';
    rope.style.top = ROPE_TOP + 'px';
  }

  // Source art ships with 20-30% transparent margins (see vendor/mascot/
  // README): crop to the alpha bbox on a canvas, downscale to ~256px tall,
  // cache the result on the bridge, and use the cached file from then on.
  function loadRopeArt() {
    if (!ropeImg) return;
    const form = rope._form;
    if (form === 'vector') { ropeImg.src = `${HOST}/mascot/vector`; return; }
    const derived = `${HOST}/mascot-derived/${form}`;
    const probe = new Image();
    probe.onload = () => { if (ropeImg && rope._form === form) ropeImg.src = derived; };
    probe.onerror = () => {
      if (!ropeImg || rope._form !== form) return;
      ropeImg.src = `${HOST}/mascot/${form}`;
      deriveRopeArt(form);
    };
    probe.src = derived;
  }

  function deriveRopeArt(form) {
    const im = new Image();
    im.crossOrigin = 'anonymous'; // bridge sends ACAO:* — keeps the canvas clean
    im.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, cv.width, cv.height).data;
        let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
        for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) {
          if (d[(y * cv.width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        if (maxX < 0) return;
        const bw = maxX - minX + 2, bh = maxY - minY + 2;
        const oh = 256, ow = Math.round(bw * (oh / bh));
        const out = document.createElement('canvas');
        out.width = ow; out.height = oh;
        out.getContext('2d').drawImage(im, minX, minY, bw, bh, 0, 0, ow, oh);
        const url = out.toDataURL('image/png');
        if (ropeImg && rope._form === form) ropeImg.src = url;
        const b64 = url.split(',')[1].replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        new Image().src = `${HOST}/api/mascot-cache?form=${form}&d=${b64}`; // page -> bridge cache
      } catch {}
    };
    im.src = `${HOST}/mascot/${form}`;
  }

  function mountRope() {
    rope = h('div', { class: 'we-rope', id: 'we-rope', title: '下拉或点击打开面板 · 左右拖动换位' });
    const art = h('div', { class: 'we-rope-art' });
    ropeImg = h('img', { draggable: 'false', alt: '' });
    art.append(ropeImg);
    rope.append(art);
    rope._x = 8; rope._form = '';
    document.documentElement.append(rope);

    let drag = null;
    const settleBack = () => {
      rope.classList.add('settle');
      rope.style.top = ROPE_TOP + 'px';
      setTimeout(() => rope?.classList.remove('settle'), 300);
    };
    rope.addEventListener('pointerdown', (e) => {
      drag = { x0: e.clientX, y0: e.clientY, l0: rope._x, moved: false, opened: false };
      rope.setPointerCapture(e.pointerId);
      rope.classList.add('dragging');
      e.preventDefault();
    });
    rope.addEventListener('pointermove', (e) => {
      if (!drag || !rope) return;
      const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      rope._x = clamp(drag.l0 + dx, 8, innerWidth - rope.offsetWidth - 8);
      const pull = clamp(dy, 0, 140);
      rope.style.left = rope._x + 'px';
      rope.style.top = (ROPE_TOP + pull) + 'px';
      // dsh: 下拉拉过阈值 → 抽屉开在绳子下方（面板 z 低于绳子，绳子始终可抓）
      if (pull > 56 && !drag.opened) { drag.opened = true; if (!root.firstChild) togglePanel(rope); }
    });
    const release = (cancelled) => {
      if (!drag || !rope) { drag = null; return; }
      rope.classList.remove('dragging');
      if (!cancelled && !drag.moved) togglePanel(rope); // plain click toggles the drawer
      else {
        settleBack();
        cmd({ c: 'mascot.set', xPct: +((rope._x + rope.offsetWidth / 2) / innerWidth).toFixed(4) });
      }
      drag = null;
    };
    rope.addEventListener('pointerup', () => release(false));
    rope.addEventListener('pointercancel', () => release(true));
  }

  // mascot parallax: drifts WITH the wallpaper direction (mirrored cursor),
  // damped — independent easing loop so inject.js doesn't need to know the rope
  function ropeParMove(e) {
    if (!rope) return;
    const par = payload().parallax || {};
    if (!par.enabled) {
      ropePar.tx = ropePar.ty = 0;
      if (ropePar.cx || ropePar.cy) pumpRopePar();
      return;
    }
    ropePar.tx = clamp(-(e.clientX - innerWidth / 2) * 0.006, -8, 8);
    ropePar.ty = clamp(-(e.clientY - innerHeight / 2) * 0.006, -6, 6);
    pumpRopePar();
  }
  function pumpRopePar() {
    if (ropePar.raf) return;
    ropePar.raf = requestAnimationFrame(function step() {
      ropePar.cx += (ropePar.tx - ropePar.cx) * 0.1;
      ropePar.cy += (ropePar.ty - ropePar.cy) * 0.1;
      if (rope) rope.style.translate = `${ropePar.cx.toFixed(2)}px ${ropePar.cy.toFixed(2)}px`;
      if (Math.abs(ropePar.tx - ropePar.cx) > 0.05 || Math.abs(ropePar.ty - ropePar.cy) > 0.05) ropePar.raf = requestAnimationFrame(step);
      else ropePar.raf = 0;
    });
  }
  document.addEventListener('pointermove', ropeParMove, { passive: true });

  function togglePanel(anchor) {
    if (root.firstChild) { root.innerHTML = ''; clearInterval(refreshTimer); refreshTimer = 0; return; }
    tabBar = h('div', { class: 'wep-head' }, h('span', { class: 'wep-title' }, '壁纸引擎'));
    for (const [k, t] of TABS)
      tabBar.append(h('button', { class: 'wep-tab' + (k === tab ? ' on' : ''), onclick: () => { tab = k; render(); } }, t));
    tabBar.append(h('button', { class: 'wep-close', onclick: () => togglePanel() }, '✕'));
    body = h('div', { class: 'wep-body' });
    const p = h('div', { class: 'we-panel' }, tabBar, body);
    // opened from the rope: drawer anchored under it (dsh z 秩序 — 面板低于绳子)
    if (anchor && anchor.classList?.contains('we-rope')) {
      const w = Math.min(400, innerWidth - 28);
      const r = anchor.getBoundingClientRect();
      const top = Math.round(r.bottom + 8);
      p.style.left = clamp(Math.round(r.left + r.width / 2 - w / 2), 14, innerWidth - w - 14) + 'px';
      p.style.top = top + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
      p.style.height = `min(620px, ${Math.max(220, innerHeight - top - 14)}px)`;
      p.style.transformOrigin = 'top center';
    }
    // don't yank the UI while the user is interacting with it
    p.addEventListener('pointerdown', () => { panelBusy = true; });
    p.addEventListener('pointerup', () => { panelBusy = false; });
    p.addEventListener('focusin', () => { panelBusy = true; });
    p.addEventListener('focusout', () => { panelBusy = false; });
    root.append(p);
    render();
    const p0 = payload();
    lastEpoch = p0.epoch ?? -1; lastIndex = p0.index ?? -1; lastPropsId = full().propsId || '';
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (panelBusy || !root.firstChild) return;
      const p1 = payload();
      const pr1 = full().propsId || '';
      if ((p1.epoch ?? -1) !== lastEpoch || (p1.index ?? -1) !== lastIndex || pr1 !== lastPropsId) {
        lastEpoch = p1.epoch ?? -1; lastIndex = p1.index ?? -1; lastPropsId = pr1;
        render();
      }
    }, 1600);
  }

  function render() {
    if (!root || !root.firstChild || !body) return;
    for (const [i, [k]] of TABS.entries()) tabBar.children[i + 1].classList.toggle('on', k === tab);
    body.innerHTML = '';
    ({ wall: renderWall, play: renderPlay, fx: renderFx, lists: renderLists, ext: renderExt, sys: renderSys })[tab]();
  }

  /* ---------- tabs ---------- */

  function renderWall() {
    const p = payload(), L = lib();
    const cur = p.items?.[p.index];
    if (cur) {
      body.append(h('div', { class: 'wep-cur' },
        cur.id ? h('img', { src: `https://wallpaper.local/thumb/${cur.id}` }) : h('div'),
        h('div', {}, h('div', { class: 'n' }, cur.title || '(未选择)'),
          h('div', { class: 's' }, `${p.listName || ''} · ${cur.kind === 'video' ? '视频' : '图片'} · ${(p.index ?? 0) + 1}/${p.items?.length || 0}`))));
    }
    body.append(h('div', { class: 'wep-row' },
      h('input', { class: 'wep-input', placeholder: '搜索标题…', value: search, oninput: (e) => { search = e.target.value; renderGrid(); } })));
    body.append(h('div', { class: 'wep-row' },
      select('', [['all', '全部类型'], ['video', '视频'], ['image', '预览图']], filterType, (v) => { filterType = v; renderGrid(); }),
      select('', [['all', '全部分级'], ['everyone', 'Everyone'], ['pg13', 'PG13'], ['mature', 'Mature'], ['unrated', '未分级']], filterRating, (v) => { filterRating = v; renderGrid(); })));
    body.append(h('div', { class: 'wep-row' },
      h('label', {}, '显示已隐藏'),
      (() => { const t = h('div', { class: 'wep-toggle' + (showHidden ? ' on' : '') }); t.addEventListener('click', () => { showHidden = !showHidden; t.classList.toggle('on', showHidden); renderGrid(); }); return t; })(),
      h('span', { class: 'wep-note' }, `${L.length} 张`)));
    body.append(h('div', { class: 'wep-grid', id: 'wep-grid' }));
    renderGrid();
  }

  function renderGrid() {
    const grid = $('#wep-grid', body);
    if (!grid) return;
    const p = payload();
    const inList = new Set((p.items || []).map((x) => x.id));
    const curId = p.items?.[p.index]?.id;
    const needle = search.trim().toLowerCase();
    let rows = lib().filter((x) =>
      (filterType === 'all' || x.kind === filterType) &&
      (filterRating === 'all' || x.rating === filterRating) &&
      (!needle || (x.title || '').toLowerCase().includes(needle)) &&
      (showHidden ? x.hidden : !x.hidden));
    grid.innerHTML = '';
    if (!rows.length) { grid.append(h('div', { class: 'wep-empty', style: 'grid-column:1/-1' }, showHidden ? '没有已隐藏的壁纸' : '没有匹配的壁纸')); return; }
    for (const x of rows.slice(0, 120)) {
      const card = h('div', { class: 'wep-card' + (x.id === curId ? ' cur' : ''), title: x.title },
        x.hasThumb ? h('img', { src: `https://wallpaper.local/thumb/${x.id}`, loading: 'lazy' }) : h('div'),
        h('span', { class: 'b' }, x.weType === 'scene' ? '场景' : x.weType === 'web' ? '网页' : x.kind === 'video' ? '视频' : '图片'),
        h('span', { class: 't' }, x.title),
        h('span', { class: 'acts' },
          !inList.has(x.id) && !x.hidden ? h('button', { class: 'wep-mini', onclick: (e) => { e.stopPropagation(); cmd({ c: 'list.add', id: x.id }); } }, '＋') : null,
          x.hidden
            ? h('button', { class: 'wep-mini', onclick: (e) => { e.stopPropagation(); cmd({ c: 'unhide', id: x.id }); } }, '恢复')
            : h('button', { class: 'wep-mini', onclick: (e) => { e.stopPropagation(); cmd({ c: 'hide', id: x.id }); } }, '隐藏')));
      if (!x.hidden) card.addEventListener('click', () => cmd({ c: 'select', id: x.id }));
      grid.append(card);
    }
    if (rows.length > 120) grid.append(h('div', { class: 'wep-note', style: 'grid-column:1/-1' }, `…共 ${rows.length} 张，仅显示前 120`));
  }

  function renderPlay() {
    const p = payload(), fx = p.fx || {};
    body.append(h('div', { class: 'wep-sec' }, '当前'));
    body.append(h('div', { class: 'wep-row' },
      h('button', { class: 'wep-btn', onclick: () => cmd({ c: 'prev' }) }, '‹ 上一张'),
      h('button', { class: 'wep-btn primary', style: 'flex:1', onclick: () => cmd({ c: 'toggle' }) }, p.paused ? '▶ 播放' : '⏸ 暂停'),
      h('button', { class: 'wep-btn', onclick: () => cmd({ c: 'next' }) }, '下一张 ›')));
    body.append(h('div', { class: 'wep-sec' }, '视频'));
    body.append(select('倍速', [[0.5, '0.5×'], [0.75, '0.75×'], [1, '1×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']], num(fx.rate, 1), (v) => cmd({ c: 'fx', k: 'rate', v: Number(v) })));
    body.append(slider('音量', 0, 1, 0.01, num(fx.volume, 0), pct, (v) => cmd({ c: 'fx', k: 'volume', v })));
    body.append(toggle('水平翻转', !!fx.flipH, (v) => cmd({ c: 'fx', k: 'flipH', v })));
    body.append(h('div', { class: 'wep-sec' }, '切换过场'));
    body.append(select('动画', [['cut', '硬切'], ['fade', '交叉淡化'], ['slide', '推移'], ['wipe', '擦除'], ['iris', '光圈'], ['zoom', '缩放'], ['bars', '百叶窗']], fx.transition || 'fade', (v) => cmd({ c: 'fx', k: 'transition', v })));
    if (fx.transition === 'slide' || fx.transition === 'wipe' || fx.transition === 'bars')
      body.append(select('方向', [['left', '向左'], ['right', '向右'], ['up', '向上'], ['down', '向下']], fx.transitionDir || 'left', (v) => cmd({ c: 'fx', k: 'transitionDir', v })));
    body.append(slider('速度', 0.4, 3, 0.1, num(fx.transitionSpeed, 1), (v) => v.toFixed(1) + '×', (v) => cmd({ c: 'fx', k: 'transitionSpeed', v })));
    body.append(slider('基准时长', 0, 3000, 50, num(fx.fadeMs, 800), (v) => Math.round(v) + 'ms', (v) => cmd({ c: 'fx', k: 'fadeMs', v })));
    renderLiveSection(p);
  }

  /* ---------- live (WebWallGL) + per-wallpaper user properties ---------- */

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const weColorToHex = (v) => {
    const parts = String(v ?? '').trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return '#808080';
    return '#' + parts.slice(0, 3).map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('');
  };
  const hexToWeColor = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ');

  function propControl(d, id) {
    const set = (value) => cmd({ c: 'props.set', id, name: d.name, value });
    switch (d.ptype) {
      case 'bool': return toggle(d.text, !!d.value, set);
      case 'slider': {
        const min = num(d.min, 0), max = num(d.max, 100);
        const step = num(d.step, 0) > 0 ? d.step : Math.max(0.01, +(((max - min) / 100).toPrecision(2)));
        const fmt = (v) => (Math.abs(step) < 1 ? v.toFixed(2) : v.toFixed(1));
        return slider(d.text, min, max, step, num(d.value, num(d.default, min)), fmt, set);
      }
      case 'combo': {
        const opts = d.options || [];
        const cur = opts.findIndex((o) => JSON.stringify(o.value) === JSON.stringify(d.value));
        return select(d.text, opts.map((o, i) => [String(i), o.label]), String(cur < 0 ? 0 : cur), (v) => { const o = opts[Number(v)]; if (o) set(o.value); });
      }
      case 'color': {
        const inp = h('input', { type: 'color', class: 'wep-color', value: weColorToHex(d.value) });
        inp.addEventListener('input', () => set(hexToWeColor(inp.value)));
        return h('div', { class: 'wep-row' }, h('label', {}, d.text), inp);
      }
      case 'textinput': {
        const inp = h('input', { class: 'wep-input', value: String(d.value ?? '') });
        inp.addEventListener('change', () => set(inp.value));
        return h('div', { class: 'wep-row' }, h('label', {}, d.text), inp);
      }
      case 'file':
        return select(d.text, [['', '（未选择）'], ...(d.files || []).map((f) => [f, f])], String(d.value ?? ''), set);
      case 'text': return h('div', { class: 'wep-note' }, d.text);
      default: return null;
    }
  }

  function renderLiveSection(p) {
    const lv = p.liveSettings || { enabled: true, fps: 30 };
    const curItem = (p.items || [])[p.index];
    body.append(h('div', { class: 'wep-sec' }, '实时渲染（Scene/Web 壁纸）'));
    body.append(toggle('启用实时渲染', lv.enabled !== false, (v) => cmd({ c: 'live.set', enabled: v })));
    body.append(select('渲染帧率', [[15, '15 fps · 省电'], [30, '30 fps · 均衡'], [60, '60 fps · 流畅']], String(num(lv.fps, 30)), (v) => cmd({ c: 'live.set', fps: Number(v) })));
    if (!curItem?.live) body.append(h('div', { class: 'wep-note' }, '当前壁纸是视频/图片；切到 Scene/Web 壁纸时实时渲染自动生效，失败自动回退预览图。'));
    // defs are pushed once per (wallpaper, propsEpoch) and persist in the
    // controller — read the stored copy, not the transient payload key
    const defs = full().propsDefs, propsId = full().propsId;
    if (Array.isArray(defs) && defs.length && propsId && propsId === curItem?.id) {
      body.append(h('div', { class: 'wep-sec' }, `壁纸属性（${defs.length} 项）`));
      for (const d of defs) { const c = propControl(d, propsId); if (c) body.append(c); }
      body.append(h('div', { class: 'wep-row' }, confirmBtn('恢复默认属性', () => cmd({ c: 'props.reset', id: propsId }))));
    }
  }

  function renderFx() {
    const fx = payload().fx || {};
    body.append(h('div', { class: 'wep-sec' }, '壁纸画面'));
    body.append(slider('透明度', 0, 1, 0.01, num(fx.opacity, 0.32), pct, (v) => cmd({ c: 'fx', k: 'opacity', v })));
    body.append(slider('亮度', 0, 2, 0.01, num(fx.brightness, 0.68), pct, (v) => cmd({ c: 'fx', k: 'brightness', v })));
    body.append(slider('对比度', 0, 2, 0.01, num(fx.contrast, 1), pct, (v) => cmd({ c: 'fx', k: 'contrast', v })));
    body.append(slider('饱和度', 0, 3, 0.01, num(fx.saturate, 1.15), pct, (v) => cmd({ c: 'fx', k: 'saturate', v })));
    body.append(slider('模糊', 0, 40, 0.5, num(fx.blur, 0), px, (v) => cmd({ c: 'fx', k: 'blur', v })));
    body.append(slider('暗化', 0, 0.85, 0.01, num(fx.dim, 0), pct, (v) => cmd({ c: 'fx', k: 'dim', v })));
    body.append(slider('缩放', 1, 3, 0.05, num(fx.zoom, 1), (v) => v.toFixed(2) + '×', (v) => cmd({ c: 'fx', k: 'zoom', v })));
    body.append(slider('水平位移', 0, 100, 1, num(fx.panX, 50), (v) => v + '%', (v) => cmd({ c: 'fx', k: 'panX', v })));
    body.append(slider('垂直位移', 0, 100, 1, num(fx.panY, 50), (v) => v + '%', (v) => cmd({ c: 'fx', k: 'panY', v })));
    body.append(h('div', { class: 'wep-sec' }, '玻璃面板（大背景）'));
    body.append(slider('面板·亮色', 0, 1, 0.01, num(fx.panelAlpha, 0.22), pct, (v) => cmd({ c: 'fx', k: 'panelAlpha', v })));
    body.append(slider('面板·暗色', 0, 1, 0.01, num(fx.panelAlphaDark, 0.30), pct, (v) => cmd({ c: 'fx', k: 'panelAlphaDark', v })));
    body.append(slider('磨砂强度', 0, 60, 1, num(fx.panelBlur, 10), px, (v) => cmd({ c: 'fx', k: 'panelBlur', v })));
    body.append(slider('输入框', 0, 1, 0.01, num(fx.composerAlpha, 0.55), pct, (v) => cmd({ c: 'fx', k: 'composerAlpha', v })));
    body.append(h('div', { class: 'wep-sec' }, '对话内容卡片（文字保底）'));
    body.append(slider('卡片浓度', 0, 1, 0.01, num(fx.contentAlpha, 0.62), pct, (v) => cmd({ c: 'fx', k: 'contentAlpha', v })));
    body.append(slider('卡片磨砂', 0, 60, 1, num(fx.contentBlur, 18), px, (v) => cmd({ c: 'fx', k: 'contentBlur', v })));
    body.append(toggle('主题随壁纸', fx.autoTint !== false, (v) => cmd({ c: 'fx', k: 'autoTint', v })));
    body.append(h('div', { class: 'wep-note' }, '壁纸透出来靠「玻璃面板」压低，文字清楚靠「内容卡片」抬高——两者独立调。开启主题随壁纸后玻璃深浅跟随壁纸明暗。'));
  }

  function renderLists() {
    const p = payload();
    body.append(h('div', { class: 'wep-sec' }, '播放列表'));
    body.append(select('当前列表', (p.playlists || []).map((x) => [x.key, `${x.name}（${x.count}）`]), p.listKey, (v) => cmd({ c: 'list.use', key: v })));
    const tools = h('div', {});
    let mode = '';
    const drawTools = () => {
      tools.innerHTML = '';
      if (mode === 'create') tools.append(inlineInput('新列表名称，回车确定', (n) => { mode = ''; cmd({ c: 'list.create', name: n }); }));
      else if (mode === 'rename') tools.append(inlineInput('重命名为，回车确定', (n) => { mode = ''; cmd({ c: 'list.rename', key: p.listKey, name: n }); }));
      tools.append(h('div', { class: 'wep-row' },
        h('button', { class: 'wep-btn', onclick: () => { mode = mode === 'create' ? '' : 'create'; drawTools(); } }, '新建'),
        h('button', { class: 'wep-btn', onclick: () => { mode = mode === 'rename' ? '' : 'rename'; drawTools(); } }, '重命名'),
        confirmBtn('删除本列表', () => cmd({ c: 'list.delete', key: p.listKey }))));
    };
    drawTools();
    body.append(tools);
    body.append(slider('切换间隔', 5, 3600, 5, num(p.intervalSec, 600), (v) => v >= 60 ? (v / 60).toFixed(1) + 'min' : v + 's', (v) => cmd({ c: 'list.interval', sec: v })));
    body.append(select('播放顺序', [['sequential', '顺序'], ['shuffle', '随机']], p.order || 'sequential', (v) => cmd({ c: 'list.order', order: v })));
    body.append(h('div', { class: 'wep-sec' }, `本列表 ${p.items?.length || 0} 张`));
    const wrap = h('div', { class: 'wep-plist' });
    (p.items || []).forEach((x, i) => {
      const row = h('div', { class: 'wep-pitem' + (i === p.index ? ' cur' : ''), title: '点击切换到这张' },
        h('span', { class: 'n' }, `${i + 1}. ${x.title}`),
        h('button', { class: 'wep-mini', onclick: (e) => { e.stopPropagation(); cmd({ c: 'list.remove', idx: i }); } }, '移除'));
      // row body jumps straight to this wallpaper (dsh: 列表即选台)
      row.addEventListener('click', (e) => { if (!e.target.closest('.wep-mini')) cmd({ c: 'goto', idx: i }); });
      wrap.append(row);
    });
    if (!p.items?.length) wrap.append(h('div', { class: 'wep-empty' }, '空列表 — 到「壁纸」页点选或点 ＋ 加入'));
    body.append(wrap);
    body.append(h('div', { class: 'wep-note' }, '点任意一行直接切换；在「壁纸」页缩略图上点 ＋ 可把壁纸加入当前列表。'));
  }

  function renderExt() {
    const fl = payload().fxLayer || { click: {}, trail: {} };
    const par = payload().parallax || {};
    body.append(h('div', { class: 'wep-sec' }, '点击效果'));
    body.append(toggle('启用点击', !!fl.click?.enabled, (v) => cmd({ c: 'fxLayer', section: 'click', k: 'enabled', v })));
    body.append(select('样式', [['ripple', '涟漪'], ['sparks', '星火'], ['both', '两者']], fl.click?.style || 'ripple', (v) => cmd({ c: 'fxLayer', section: 'click', k: 'style', v })));
    body.append(select('颜色', [['rainbow', '彩虹'], ['theme', '主题蓝'], ['#ff5b8c', '粉'], ['#ffd166', '金'], ['#7bf1a8', '绿']], fl.click?.color || 'rainbow', (v) => cmd({ c: 'fxLayer', section: 'click', k: 'color', v })));
    body.append(slider('不透明度', 0.1, 1, 0.05, num(fl.click?.opacity, 0.8), pct, (v) => cmd({ c: 'fxLayer', section: 'click', k: 'opacity', v })));
    body.append(h('div', { class: 'wep-sec' }, '拖尾效果'));
    body.append(toggle('启用拖尾', !!fl.trail?.enabled, (v) => cmd({ c: 'fxLayer', section: 'trail', k: 'enabled', v })));
    body.append(select('样式', [['comet', '彗尾'], ['stardust', '星尘']], fl.trail?.style || 'comet', (v) => cmd({ c: 'fxLayer', section: 'trail', k: 'style', v })));
    body.append(select('颜色', [['rainbow', '彩虹'], ['theme', '主题蓝'], ['#ff5b8c', '粉'], ['#ffd166', '金'], ['#7bf1a8', '绿']], fl.trail?.color || 'rainbow', (v) => cmd({ c: 'fxLayer', section: 'trail', k: 'color', v })));
    body.append(slider('存续', 0.2, 3, 0.1, num(fl.trail?.ttl, 1), (v) => v.toFixed(1) + '×', (v) => cmd({ c: 'fxLayer', section: 'trail', k: 'ttl', v })));
    body.append(h('div', { class: 'wep-sec' }, '3D 视差'));
    body.append(toggle('启用视差', !!par.enabled, (v) => cmd({ c: 'parallax', k: 'enabled', v })));
    body.append(slider('壁纸纵深', 0, 4, 0.1, num(par.wallpaperPct, 1), (v) => v.toFixed(1) + '%', (v) => cmd({ c: 'parallax', k: 'wallpaperPct', v })));
    body.append(slider('界面视差', 0, 3, 0.1, num(par.uiPct, 0), (v) => v.toFixed(1) + '%', (v) => cmd({ c: 'parallax', k: 'uiPct', v })));
    body.append(h('div', { class: 'wep-note' }, '壁纸随光标反向轻移，对话区/输入框/侧栏正向浅移（界面视差=0 时只动壁纸）——层级恒在全部界面之下、不接管输入。'));
    body.append(h('div', { class: 'wep-sec' }, '吉祥物拉绳'));
    const mc = mascotCfg();
    body.append(toggle('显示吉祥物', mc.enabled, (v) => cmd({ c: 'mascot.set', enabled: v })));
    body.append(select('形态', [['whale', 'Deepseek 鲸'], ['maid', '小女仆'], ['portrait', '立绘'], ['vector', '矢量']], mc.form, (v) => cmd({ c: 'mascot.set', form: v })));
    body.append(slider('大小', 0.6, 2, 0.1, mc.size, (v) => v.toFixed(1) + '×', (v) => cmd({ c: 'mascot.set', size: v })));
    body.append(h('div', { class: 'wep-note' }, '顶边小挂件：左右拖动换位，向下拉或点击开合面板（关闭后回到右下角圆钮）。'));
  }

  function renderSys() {
    const oc = payload().occlusion || {};
    body.append(h('div', { class: 'wep-sec' }, '界面'));
    const FONTS = [['', '应用默认'], ['Microsoft YaHei', '微软雅黑'], ['SimSun', '宋体'], ['SimHei', '黑体'], ['KaiTi', '楷体'], ['Segoe UI', 'Segoe UI'], ['Consolas', 'Consolas（等宽）'], ['__custom', '自定义…']];
    const fam = payload().fx?.fontFamily || '';
    const famKnown = FONTS.some(([v]) => v === fam);
    const fontWrap = h('div', {});
    if (!famKnown) fontWrap.append(h('div', { class: 'wep-note' }, `当前：${fam}`));
    body.append(select('界面字体', FONTS, famKnown ? fam : '__custom', (v) => {
      if (v === '__custom') { fontWrap.innerHTML = ''; fontWrap.append(inlineInput('字体名（如 Microsoft YaHei），回车应用', (n) => cmd({ c: 'fx', k: 'fontFamily', v: n }))); return; }
      fontWrap.innerHTML = '';
      cmd({ c: 'fx', k: 'fontFamily', v });
    }));
    body.append(fontWrap);
    body.append(h('div', { class: 'wep-note' }, '只换界面文字，代码块保持等宽。'));
    body.append(h('div', { class: 'wep-sec' }, '会话头像'));
    const av = payload().avatars || {};
    body.append(toggle('显示头像', !!av.enabled, (v) => cmd({ c: 'avatars.set', enabled: v })));
    {
      const prevRow = h('div', { class: 'wep-row' }, h('label', {}, '当前'));
      for (const [slot, name] of [['user', '我'], ['assistant', '助手']]) {
        const file = av[slot] || '';
        const img = h('img', { src: file ? `${HOST}/avatar/${encodeURIComponent(file)}` : '', alt: name, style: `width:26px;height:26px;border-radius:${slot === 'user' ? '50%' : '8px'};background:rgba(255,255,255,.15);${file ? '' : 'display:none'}` });
        prevRow.append(h('span', { style: 'font-size:11.5px;opacity:.7' }, name), img);
      }
      body.append(prevRow);
    }
    body.append(h('div', { class: 'wep-note' }, '未设自定义图时用内置小图标。换图走 CLI：avatar --user <图片> --assistant <图片>（--clear 还原，--off 关闭）。'));
    body.append(h('div', { class: 'wep-sec' }, '省电（视频壁纸自动暂停解码）'));
    body.append(toggle('最小化/隐藏时', !!oc.hidden, (v) => cmd({ c: 'occlusion', k: 'hidden', v })));
    body.append(toggle('窗口失焦时', !!oc.blur, (v) => cmd({ c: 'occlusion', k: 'blur', v })));
    body.append(toggle('电池供电时', !!oc.battery, (v) => cmd({ c: 'occlusion', k: 'battery', v })));
    body.append(h('div', { class: 'wep-sec' }, '预设'));
    const presetWrap = h('div', {});
    let presetMode = false;
    const drawPreset = () => {
      presetWrap.innerHTML = '';
      if (presetMode) presetWrap.append(inlineInput('预设名称，回车保存', (n) => { presetMode = false; cmd({ c: 'preset.save', name: n }); }));
      presetWrap.append(h('div', { class: 'wep-row' },
        h('button', { class: 'wep-btn', onclick: () => { presetMode = !presetMode; drawPreset(); } }, '保存当前为预设')));
      const names = payload().presets || [];
      const wrap = h('div', { class: 'wep-plist' });
      for (const n of names)
        wrap.append(h('div', { class: 'wep-pitem' },
          h('span', { class: 'n' }, n),
          h('button', { class: 'wep-mini', onclick: () => cmd({ c: 'preset.apply', name: n }) }, '套用'),
          h('button', { class: 'wep-mini', onclick: () => cmd({ c: 'preset.delete', name: n }) }, '删除')));
      if (names.length) presetWrap.append(wrap);
    };
    drawPreset();
    body.append(presetWrap);
    body.append(h('div', { class: 'wep-sec' }, '关于'));
    body.append(h('div', { class: 'wep-note' },
      'chatgpt-wallpaper-bridge · 灵感来自 dsh-wallpaper-engine (MIT)\n' +
      '壁纸文件不出本机；媒体经 DevTools 拦截供给，未修改应用文件。\n' +
      'Scene/Web 壁纸由 WebWallGL 实时渲染（vendored，MIT）。'));
  }

  function cliPreset() { /* presets are CLI-only for now; see note in renderSys */ }

  /* ---------- lifecycle ---------- */

  // mascot config can change via CLI while the panel is closed — watch slowly
  const mascotTimer = setInterval(() => { try { syncRope(); } catch {} }, 2000);

  window.__wallpaperPanel = {
    api: PANEL_API,
    build: window.__wePanelBuild,
    open: () => { mount(); if (!root.firstChild) togglePanel(document.getElementById('we-rope')); },
    close: () => { if (root) root.innerHTML = ''; },
    destroy() {
      clearInterval(refreshTimer);
      clearInterval(mascotTimer);
      cancelAnimationFrame(ropePar.raf);
      document.removeEventListener('pointermove', ropeParMove);
      document.getElementById('we-rope')?.remove();
      rope = null; ropeImg = null;
      document.getElementById('we-fab')?.remove();
      document.getElementById('we-panel-root')?.remove();
      document.getElementById('we-panel-style')?.remove();
      delete window.__wallpaperPanel;
    },
  };

  mount();
  return { ok: true, api: PANEL_API };
})();
