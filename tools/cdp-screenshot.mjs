// Capture the app page via CDP Page.captureScreenshot (compositor-accurate).
import fs from 'node:fs';
import { CDP, appPages } from '../src/cdp.mjs';

const out = process.argv[2] || new URL('../scratch/cdp-shot.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
await c.send('Page.enable').catch(() => {});
// Give compositing a moment without changing playback or pause state.
await new Promise((r) => setTimeout(r, 900));
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(new URL('.', 'file:///' + out.replaceAll('\\', '/')).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, Buffer.from(shot.data, 'base64').length, 'bytes');
c.close();
