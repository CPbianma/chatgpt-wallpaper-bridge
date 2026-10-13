// Diagnose why page fetch to the virtual host fails: watch Network domain events.
import { CDP, appPages } from '../src/cdp.mjs';

const pages = await appPages();
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();

const events = [];
c.on((m) => {
  if (m.method === 'Network.requestWillBeSent') events.push(['req', m.params.request.url.slice(0, 70), m.params.request.method]);
  if (m.method === 'Network.loadingFailed') events.push(['fail', (m.params.errorText || '').slice(0, 90), m.params.blockedReason || '']);
  if (m.method === 'Network.loadingFinished') events.push(['done', m.params.encodedDataLength]);
  if (m.method === 'Network.responseReceived') events.push(['resp', m.params.response.status, m.params.response.url.slice(0, 60)]);
});
await c.send('Network.enable');

const r = await c.send('Runtime.evaluate', {
  expression: `(async () => {
    const out = {};
    try { const r = await fetch('https://wallpaper.local/api/state', { cache: 'no-store' }); out.wp = r.status; }
    catch (e) { out.wp = String(e); }
    // control: same-host media element style GET through an Image (no-cors)
    out.img = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res('loaded ' + im.naturalWidth + 'x' + im.naturalHeight);
      im.onerror = () => res('error');
      im.src = 'https://wallpaper.local/media/0?probe=' + Date.now();
      setTimeout(() => res('timeout'), 6000);
    });
    return out;
  })()`,
  returnByValue: true, awaitPromise: true,
});
await new Promise((r2) => setTimeout(r2, 1500));
console.log('evaluate:', JSON.stringify(r.result.value ?? r, null, 2));
console.log('network events:', JSON.stringify(events, null, 2));
c.close();
