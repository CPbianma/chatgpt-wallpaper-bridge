// Dev helper: capture the app page to a PNG. Usage: node scripts/shot-page.mjs <out.png>
import fs from 'node:fs';
import { CDP, appPages } from '../src/cdp.mjs';

const out = process.argv[2] || 'page-shot.png';
const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
const r = await c.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
console.log(out);
c.close();
