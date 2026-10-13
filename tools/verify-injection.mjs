// Verify what the injected style/box look like in the live page.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const box = document.getElementById('codex-wallpaper-layer');
  const st = document.getElementById('codex-wallpaper-style');
  const main = document.querySelector('main[class*="MainContentSurface"]');
  const cs = main ? getComputedStyle(main) : null;
  const slotCount = box ? box.children.length : 0;
  const firstMedia = box ? box.querySelector('video,img') : null;
  const rect = box ? box.getBoundingClientRect() : null;
  return {
    hasBox: !!box,
    boxParent: box ? box.parentElement && box.parentElement.tagName : null,
    boxRect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : null,
    boxZ: box ? getComputedStyle(box).zIndex : null,
    boxOpacity: box ? getComputedStyle(box).opacity : null,
    slotCount,
    firstMedia: firstMedia ? { tag: firstMedia.tagName, src: firstMedia.src.slice(0, 60), rs: firstMedia.readyState } : null,
    hasStyle: !!st,
    styleLen: st ? st.textContent.length : 0,
    styleHead: st ? st.textContent.slice(0, 160) : null,
    mainBg: cs ? cs.backgroundColor : null,
    mainBackdrop: cs ? cs.backdropFilter : null,
    mainMatchesSelector: main ? main.matches('main[class*="MainContentSurface"]') : null,
    theme: document.documentElement.getAttribute('data-theme'),
    wpApi: window.__wallpaper ? window.__wallpaper.api : null,
  };
})()`;

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(r.result.value ?? r, null, 2));
c.close();
