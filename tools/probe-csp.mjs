// Debug CSP bypass and fetch behavior step by step.
import { CDP, appPages } from '../src/cdp.mjs';

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();

const bypass = await c.send('Page.setBypassCSP', { enabled: true }).then(() => 'ok').catch((e) => 'ERR ' + e.message);
console.log('setBypassCSP:', bypass);

const r = await c.send('Runtime.evaluate', {
  expression: `(async () => {
    const out = {};
    try { const r = await fetch('https://wallpaper.local/api/state', { cache: 'no-store' }); out.wp = r.status; out.body = (await r.text()).slice(0, 120); }
    catch (e) { out.wp = String(e); }
    try { const r2 = await fetch('https://example.com', { cache: 'no-store' }); out.example = r2.status; }
    catch (e) { out.example = String(e).slice(0, 80); }
    return out;
  })()`,
  returnByValue: true, awaitPromise: true,
});
console.log(JSON.stringify(r.result.value ?? r, null, 2));
c.close();
