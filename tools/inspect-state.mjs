// Check current injection state (layer/video/style) and enumerate surface CSS tokens.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const layer = document.getElementById('codex-wallpaper-layer');
  const style = document.getElementById('codex-wallpaper-style');
  let video = null;
  if (layer && layer.tagName === 'VIDEO') {
    video = { readyState: layer.readyState, networkState: layer.networkState, error: layer.error ? { code: layer.error.code, msg: layer.error.message } : null, src: layer.src, paused: layer.paused, w: layer.videoWidth, h: layer.videoHeight, t: layer.currentTime };
  }
  // enumerate CSS custom properties on :root related to surfaces/backgrounds
  const rootStyles = getComputedStyle(document.documentElement);
  const tokens = {};
  for (const name of rootStyles) {
    if (/surface|background|^--bg|thread|composer|main-content/i.test(name)) {
      const v = rootStyles.getPropertyValue(name).trim();
      if (v) tokens[name] = v.slice(0, 120);
    }
  }
  // all pointer-events-none absolute inset-x-0 divs with rects
  const fades = [...document.querySelectorAll('main div.pointer-events-none.absolute.inset-x-0')].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { cls: el.className.slice(0, 220), rect: [Math.round(r.y), Math.round(r.height)], bg: cs.backgroundColor, bgImg: cs.backgroundImage.slice(0, 140) };
  });
  return { hasLayer: !!layer, layerTag: layer ? layer.tagName : null, hasStyle: !!style, styleText: style ? style.textContent.slice(0, 400) : null, video, tokens, fades };
})()`;

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
c.close();
