// Dev helper: evaluate an expression in the first attached app page and print
// the JSON result. Usage: node scripts/eval-page.mjs '<expression>'
import { CDP, appPages } from '../src/cdp.mjs';

const expr = process.argv[2] || 'document.title';
const pages = await appPages();
if (!pages.length) { console.error('no app page found'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();
try {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r?.result?.value ?? r, null, 1));
} finally {
  c.close();
}
