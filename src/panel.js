/* ChatGPT Wallpaper — in-app control panel (vanilla JS, no framework).
 * Injected after inject.js; talks to the bridge through window.__wallpaper.cmd()
 * (Image GET -> /api/cmd) and re-renders from pushed state. All class names are
 * prefixed wep-; root uses class "we-panel" so the fx layer skips its clicks.
 */
(() => {
  const PANEL_API = 3;
  const wp = window.__wallpaper;
  if (!wp) return { ok: false, reason: 'controller missing' };
  const prev = window.__wallpaperPanel;
  // Reuse only a same-version panel that actually mounted; otherwise rebuild
  // (guards against half-initialized instances and stale code on re-evaluate).
  if (prev && prev.api === PANEL_API && document.getElementById('we-panel-root')) return { reused: true };
  try { prev && prev.destroy(); } catch {}

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------- style ---------- */

  const CSS = `
.we-fab{position:fixed;right:14px;bottom:96px;width:42px;height:42px;border-radius:50%;z-index:999990;cursor:pointer;
  display:flex;align-items:center;justify-content:center;user-select:none;touch-action:none;
  background:rgba(128,128,160,.28);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
  border:1px solid rgba(255,255,255,.35);box-shadow:0 4px 18px rgba(0,0,0,.25);transition:transform .15s}
.we-fab:hover{transform:scale(1.08)}
.we-fab svg{width:20px;height:20px;stroke:#fff;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
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
.wep-pitem{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.07);font-size:12px}
.wep-pitem .n{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wep-pitem.cur{outline:1.5px solid #5b8cff}
.wep-note{font-size:11.5px;opacity:.6;margin-top:8px}
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
  let refreshTimer = 0, lastEpoch = -1, lastIndex = -1, panelBusy = false;

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
  }

  function togglePanel() {
    if (root.firstChild) { root.innerHTML = ''; clearInterval(refreshTimer); refreshTimer = 0; return; }
    tabBar = h('div', { class: 'wep-head' }, h('span', { class: 'wep-title' }, '壁纸引擎'));
    for (const [k, t] of TABS)
      tabBar.append(h('button', { class: 'wep-tab' + (k === tab ? ' on' : ''), onclick: () => { tab = k; render(); } }, t));
    tabBar.append(h('button', { class: 'wep-close', onclick: togglePanel }, '✕'));
    body = h('div', { class: 'wep-body' });
    const p = h('div', { class: 'we-panel' }, tabBar, body);
    // don't yank the UI while the user is interacting with it
    p.addEventListener('pointerdown', () => { panelBusy = true; });
    p.addEventListener('pointerup', () => { panelBusy = false; });
    p.addEventListener('focusin', () => { panelBusy = true; });
    p.addEventListener('focusout', () => { panelBusy = false; });
    root.append(p);
    render();
    const p0 = payload();
    lastEpoch = p0.epoch ?? -1; lastIndex = p0.index ?? -1;
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (panelBusy || !root.firstChild) return;
      const p1 = payload();
      if ((p1.epoch ?? -1) !== lastEpoch || (p1.index ?? -1) !== lastIndex) {
        lastEpoch = p1.epoch ?? -1; lastIndex = p1.index ?? -1;
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
    body.append(select('动画', [['cut', '硬切'], ['fade', '交叉淡化'], ['slide', '推移'], ['wipe', '擦除'], ['iris', '光圈'], ['zoom', '缩放']], fx.transition || 'fade', (v) => cmd({ c: 'fx', k: 'transition', v })));
    if (fx.transition === 'slide' || fx.transition === 'wipe')
      body.append(select('方向', [['left', '向左'], ['right', '向右'], ['up', '向上'], ['down', '向下']], fx.transitionDir || 'left', (v) => cmd({ c: 'fx', k: 'transitionDir', v })));
    body.append(slider('速度', 0.4, 3, 0.1, num(fx.transitionSpeed, 1), (v) => v.toFixed(1) + '×', (v) => cmd({ c: 'fx', k: 'transitionSpeed', v })));
    body.append(slider('基准时长', 0, 3000, 50, num(fx.fadeMs, 800), (v) => Math.round(v) + 'ms', (v) => cmd({ c: 'fx', k: 'fadeMs', v })));
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
      wrap.append(h('div', { class: 'wep-pitem' + (i === p.index ? ' cur' : '') },
        h('span', { class: 'n' }, `${i + 1}. ${x.title}`),
        h('button', { class: 'wep-mini', onclick: () => cmd({ c: 'list.remove', idx: i }) }, '移除')));
    });
    if (!p.items?.length) wrap.append(h('div', { class: 'wep-empty' }, '空列表 — 到「壁纸」页点选或点 ＋ 加入'));
    body.append(wrap);
    body.append(h('div', { class: 'wep-note' }, '在「壁纸」页缩略图上点 ＋ 可把壁纸加入当前列表。'));
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
    body.append(h('div', { class: 'wep-note' }, '壁纸随光标偏移反向轻移，层级恒在全部界面之下、不接管输入。'));
  }

  function renderSys() {
    const oc = payload().occlusion || {};
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
      'Scene/Web 壁纸的实时渲染（WebWallGL）在路线图上。'));
  }

  function cliPreset() { /* presets are CLI-only for now; see note in renderSys */ }

  /* ---------- lifecycle ---------- */

  window.__wallpaperPanel = {
    api: PANEL_API,
    open: () => { mount(); if (!root.firstChild) togglePanel(); },
    close: () => { if (root) root.innerHTML = ''; },
    destroy() {
      clearInterval(refreshTimer);
      document.getElementById('we-fab')?.remove();
      document.getElementById('we-panel-root')?.remove();
      document.getElementById('we-panel-style')?.remove();
      delete window.__wallpaperPanel;
    },
  };

  mount();
  return { ok: true, api: PANEL_API };
})();
