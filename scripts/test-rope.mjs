// Dev helper: exercise the mascot rope with synthesized pointer input and
// report panel/rope state after each step. Run: node scripts/test-rope.mjs
import { CDP, appPages } from '../src/cdp.mjs';

const pages = await appPages();
if (!pages.length) { console.error('no app page'); process.exit(1); }
const c = new CDP(pages[0].webSocketDebuggerUrl);
await c.open();

const evalJs = async (expression) =>
  (await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
const mouse = async (type, x, y, opts = {}) =>
  c.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = (tag) => evalJs(`(() => {
  const rope = document.getElementById('we-rope');
  const panel = document.querySelector('.we-panel');
  const r = rope ? rope.getBoundingClientRect() : null;
  const pr = panel ? panel.getBoundingClientRect() : null;
  return ${JSON.stringify(tag)} + ': rope=' + (r ? Math.round(r.left)+','+Math.round(r.top) : 'null')
    + ' panel=' + (pr ? Math.round(pr.left)+','+Math.round(pr.top)+' '+Math.round(pr.width)+'x'+Math.round(pr.height) : 'closed');
})()`);

const r0 = await evalJs("(() => { const r = document.getElementById('we-rope').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()");

// 1. plain click -> toggles the drawer open under the rope
await mouse('mousePressed', r0.x, r0.y);
await mouse('mouseReleased', r0.x, r0.y);
await sleep(400);
console.log(await snap('click-open'));

// 2. click again -> closes
await mouse('mousePressed', r0.x, r0.y);
await mouse('mouseReleased', r0.x, r0.y);
await sleep(300);
console.log(await snap('click-close'));

// 3. pull down 90px -> drawer opens
await mouse('mousePressed', r0.x, r0.y);
for (let i = 1; i <= 9; i++) await mouse('mouseMoved', r0.x, r0.y + i * 10);
await mouse('mouseReleased', r0.x, r0.y + 90);
await sleep(500);
console.log(await snap('pull-open'));

// close it for the drag test (via panel close button)
await evalJs("document.querySelector('.wep-close')?.click(), true");
await sleep(300);

// 4. drag left 300px -> repositions + snaps back to top
await mouse('mousePressed', r0.x, r0.y);
for (let i = 1; i <= 10; i++) await mouse('mouseMoved', r0.x - i * 30, r0.y + 2);
await mouse('mouseReleased', r0.x - 300, r0.y + 2);
await sleep(600);
console.log(await snap('drag-left'));
console.log('persisted mascot:', JSON.stringify(await evalJs("window.__wallpaper.fullState().payload.mascot")));

c.close();
