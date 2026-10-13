// Detailed look at the composer fade element and overall layout containers.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(() => {
  const pick = (el) => el ? {
    tag: el.tagName.toLowerCase(), id: el.id || '',
    cls: (typeof el.className === 'string' ? el.className : ''),
    bg: getComputedStyle(el).backgroundColor,
  } : null;
  const fade = document.querySelector('main div.pointer-events-none.absolute.inset-x-0');
  const composer = document.querySelector('[class*="ComposerLayoutRoot"]');
  const main = document.querySelector('main[class*="MainContentSurface"]');
  // sidebar: the nav aside left of main
  const aside = document.querySelector('nav') || document.querySelector('[class*="Sidebar"], aside');
  const chain = (el, n) => { const out = []; while (el && n-- > 0) { out.push(pick(el)); el = el.parentElement; } return out; };
  return {
    fadeChain: chain(fade, 3),
    composerChain: chain(composer, 3),
    main: pick(main),
    aside: pick(aside),
    asideBg: aside ? getComputedStyle(aside).backgroundColor : null,
    bodyChildren: [...document.body.children].map((c) => pick(c)),
    rootEl: pick(document.getElementById('root')),
    existingLayer: !!document.getElementById('codex-wallpaper-layer'),
  };
})()`;

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 2));
c.close();
