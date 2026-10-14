// Dev helper: capture the app page. Usage:
//   node scripts/shot-page.mjs <out> [--jpeg] [--clip x,y,w,h]
import fs from 'node:fs';
import { CDP, appPages } from '../src/cdp.mjs';

const out = process.argv[2] || 'page-shot.png';
const jpeg = process.argv.includes('--jpeg');
const ci = process.argv.indexOf('--clip');
const clip = ci > 0
  ? (() => { const [x, y, width, height] = process.argv[ci + 1].split(',').map(Number); return { x, y, width, height, scale: 1 }; })()
  : undefined;

const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Page.captureScreenshot', { format: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 85 } : {}), ...(clip ? { clip } : {}) });
fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
console.log(out);
c.close();
