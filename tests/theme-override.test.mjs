import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the production theme functions themselves. The small DOM/observer
// harness keeps this regression independent of Codex, a running bridge and
// third-party DOM packages while still covering the actual source at the
// theme-follow / glass boundary.
const source = fs.readFileSync(new URL('../src/inject.js', import.meta.url), 'utf8');
const start = source.indexOf('  function setTint(t) {');
const end = source.indexOf('  // Dominant quantized RGB', start);
assert.ok(start >= 0 && end > start, 'Theme function source markers must exist');
const themeSource = source.slice(start, end);

function themeHarness() {
  const attrs = new Map([['data-theme', 'light']]);
  const html = {
    getAttribute: (key) => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, String(value)),
    removeAttribute: (key) => attrs.delete(key),
  };
  const observers = [];
  const timers = new Map();
  let timerSeq = 0;
  const state = {
    destroyed: false,
    tint: null,
    userThemeOverride: false,
    themeWrite: null,
    themeLastWrite: null,
    themeObserver: null,
    themeTimer: 0,
    initialTheme: null,
    fx: { autoTint: false },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const sandbox = {
    document: { documentElement: html },
    state,
    MutationObserver,
    Date,
    setTimeout(callback) { const id = ++timerSeq; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(`${themeSource}\nthis.themeApi = { setTint, applyTheme, initThemeWatch };`, sandbox);
  const api = sandbox.themeApi;
  api.initThemeWatch();
  const externalTheme = (value) => {
    html.setAttribute('data-theme', value);
    observers.at(-1).callback();
  };
  const snapshot = () => ({
    hostTheme: html.getAttribute('data-theme'),
    glassTint: html.getAttribute('data-we-tint') || html.getAttribute('data-theme'),
    wallpaperVote: state.tint,
  });
  return { api, state, snapshot, externalTheme, observers };
}

test('manual theme override keeps host and glass aligned when the same wallpaper is resampled', () => {
  const h = themeHarness();
  // With theme-follow off, two real external changes inside 10s are manual
  // intent. Finish in light mode, then let a dark wallpaper vote arrive from
  // the same-image analysis that runs when autoTint is enabled again.
  h.externalTheme('dark');
  h.externalTheme('light');
  assert.equal(h.state.userThemeOverride, true);
  h.state.fx.autoTint = true;
  h.api.setTint('dark');
  assert.deepEqual(h.snapshot(), { hostTheme: 'light', glassTint: 'light', wallpaperVote: 'dark' });

  // A new wallpaper releases the override. The same dark vote must still be
  // applied; a state.tint-only early return would strand the previous manual
  // light host with no tint attribute.
  h.state.userThemeOverride = false;
  h.api.setTint('dark');
  h.observers.at(-1).callback(); // acknowledge our own host mutation
  assert.deepEqual(h.snapshot(), { hostTheme: 'dark', glassTint: 'dark', wallpaperVote: 'dark' });
  assert.equal(h.state.userThemeOverride, false);
});
