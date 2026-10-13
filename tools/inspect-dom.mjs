// Inspect the live ChatGPT app DOM: find elements with (near-)opaque backgrounds
// that cover meaningful screen area — these are the layers hiding the wallpaper.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight, area = vw * vh;
  const seen = new Set();
  const walk = (el) => {
    if (!el || seen.has(el)) return; seen.add(el);
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const m = /rgba?\\(([^)]+)\\)/.exec(bg);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s));
      const alpha = parts.length === 4 ? parts[3] : 1;
      if (alpha > 0.05) {
        const r = el.getBoundingClientRect();
        const cover = (r.width * r.height) / area;
        if (cover > 0.02 && r.width > 100 && r.height > 60) {
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 160),
            id: el.id || '',
            bg, alpha,
            cover: Math.round(cover * 1000) / 10,
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            z: cs.zIndex, pos: cs.position,
          });
        }
      }
    }
    for (const c of el.children) walk(c);
  };
  walk(document.body);
  out.sort((a, b) => b.cover - a.cover);
  return {
    theme: document.documentElement.getAttribute('data-theme') || (document.documentElement.classList.contains('dark') ? 'dark(class)' : 'unknown'),
    htmlClass: document.documentElement.className,
    url: location.href, count: out.length, items: out.slice(0, 40),
  };
})()`;

const pages = await appPages();
if (!pages.length) { console.error('No ChatGPT page found.'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
c.close();
