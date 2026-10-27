// Detailed look at the confirmed workbench surfaces and overall layout containers.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const pick = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), id: el.id || '',
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 240),
      bg: cs.backgroundColor, backdrop: cs.backdropFilter, radius: cs.borderRadius,
      rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10),
    };
  };
  const fade = document.querySelector('main div.pointer-events-none.absolute.inset-x-0');
  const composer = document.querySelector('main [class*="ComposerLayoutRoot"]');
  const main = document.querySelector('main[class*="MainContentSurface"]');
  const transcript = document.querySelector('main [class*="transcriptContent"]');
  const aside = document.querySelector('aside.app-shell-left-panel');
  const chain = (el, n) => { const out = []; while (el && n-- > 0) { out.push(pick(el)); el = el.parentElement; } return out; };
  return {
    viewport: [innerWidth, innerHeight, devicePixelRatio],
    appearance: document.documentElement.getAttribute('data-we-appearance') || 'legacy',
    mainReady: document.documentElement.getAttribute('data-we-main'),
    fadeChain: chain(fade, 3),
    composerChain: chain(composer, 3),
    main: pick(main),
    transcript: pick(transcript),
    aside: pick(aside),
    header: pick(document.querySelector('main header.draggable')),
    rope: pick(document.getElementById('we-rope')),
    rightPanels: [...document.querySelectorAll('aside:not(.app-shell-left-panel),[class*="RightPanel"],[class*="SidePanel"]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 80 && r.height > 80 && r.left < innerWidth && r.right > 0; })
      .slice(0, 12).map(pick),
    bodyChildren: [...document.body.children].map((c) => pick(c)),
    rootEl: pick(document.getElementById('root')),
    existingLayer: !!document.getElementById('codex-wallpaper-layer'),
  };
})()`;

const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
try {
  const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  console.log(JSON.stringify(r.result.value, null, 2));
} finally {
  c.close();
}
