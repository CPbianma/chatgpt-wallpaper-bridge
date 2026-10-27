// Verify the injected wallpaper, workbench surfaces and duplicate-mount guards.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const box = document.getElementById('codex-wallpaper-layer');
  const st = document.getElementById('codex-wallpaper-style');
  const surface = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      bg: cs.backgroundColor,
      backdrop: cs.backdropFilter,
      radius: cs.borderRadius,
      shadow: cs.boxShadow,
      rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10),
    };
  };
  const slotCount = box ? box.children.length : 0;
  const firstMedia = box ? box.querySelector('video,img') : null;
  const rect = box ? box.getBoundingClientRect() : null;
  const wp = window.__wallpaper;
  return {
    hasBox: !!box,
    boxParent: box ? box.parentElement && box.parentElement.tagName : null,
    boxRect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
    boxZ: box ? getComputedStyle(box).zIndex : null,
    boxOpacity: box ? getComputedStyle(box).opacity : null,
    layerCount: document.querySelectorAll('#codex-wallpaper-layer').length,
    panelCount: document.querySelectorAll('#we-panel-root').length,
    ropeCount: document.querySelectorAll('#we-rope').length,
    slotCount,
    firstMedia: firstMedia ? { tag: firstMedia.tagName, src: firstMedia.src.slice(0, 60), rs: firstMedia.readyState } : null,
    hasStyle: !!st,
    styleLen: st ? st.textContent.length : 0,
    main: surface('main[class*="MainContentSurface"]'),
    sidebar: surface('aside.app-shell-left-panel'),
    transcript: surface('main [class*="transcriptContent"]'),
    composer: surface('main [class*="ComposerLayoutRoot"]'),
    header: surface('main header.draggable'),
    theme: document.documentElement.getAttribute('data-theme'),
    tint: document.documentElement.getAttribute('data-we-tint'),
    appearance: document.documentElement.getAttribute('data-we-appearance') || 'legacy',
    mainReady: document.documentElement.getAttribute('data-we-main'),
    runtime: !!window.__weVisual,
    wpApi: wp ? wp.api : null,
    build: wp ? wp.build : null,
    state: wp ? wp.state() : null,
  };
})()`;

const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
try {
  const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  console.log(JSON.stringify(r.result.value ?? r, null, 2));
} finally {
  c.close();
}
