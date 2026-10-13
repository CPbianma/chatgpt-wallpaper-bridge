// Debug: probe the virtual host from inside the page.
import { CDP, appPages } from '../src/cdp.mjs';

const EXPR = `(async () => {
  const out = {};
  try {
    const r = await fetch('https://wallpaper.local/api/state', { cache: 'no-store' });
    out.status = r.status;
    out.body = (await r.text()).slice(0, 300);
  } catch (e) { out.error = String(e); }
  const box = document.getElementById('codex-wallpaper-layer');
  out.hasBox = !!box;
  out.wp = window.__wallpaper ? window.__wallpaper.state() : null;
  const v = box && box.querySelector('video');
  if (v) out.video = { rs: v.readyState, ns: v.networkState, err: v.error && v.error.code, src: v.src.slice(0, 60), paused: v.paused, t: v.currentTime };
  return out;
})()`;

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(r.result.value ?? r, null, 2));
c.close();
