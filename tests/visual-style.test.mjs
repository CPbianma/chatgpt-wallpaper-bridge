import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  WORKBENCH_FX,
  adaptWorkbenchAlphas,
  visualSampleIsCurrent,
  visualRuntimeSource,
} from '../src/visual-style.mjs';

const base = Object.freeze({ main: 0.64, sidebar: 0.78, composer: 0.86 });

test('workbench defaults are opt-in values, not legacy read-time defaults', () => {
  assert.equal(WORKBENCH_FX.appearance, 'workbench');
  assert.equal(WORKBENCH_FX.autoTint, false);
  assert.equal(WORKBENCH_FX.autoReadability, true);
  assert.equal(WORKBENCH_FX.sidebarAlphaDark, 0.78);
  assert.equal(WORKBENCH_FX.panelBlur, 16);
});

test('dark glass strengthens on bright images and relaxes on dark images', () => {
  const bright = adaptWorkbenchAlphas(base, 1, 'dark', true);
  const dark = adaptWorkbenchAlphas(base, 0, 'dark', true);
  assert.ok(bright.main > base.main);
  assert.ok(bright.sidebar > base.sidebar);
  assert.ok(bright.composer > base.composer);
  assert.ok(dark.main < base.main);
  assert.ok(dark.sidebar < base.sidebar);
  assert.ok(dark.composer < base.composer);
  assert.deepEqual(JSON.parse(JSON.stringify(bright)), { main: 0.70, sidebar: 0.84, composer: 0.92 });
  assert.deepEqual(JSON.parse(JSON.stringify(dark)), { main: 0.58, sidebar: 0.74, composer: 0.84 });
});

test('light glass moves in the opposite direction for dark text', () => {
  const bright = adaptWorkbenchAlphas(base, 1, 'light', true);
  const dark = adaptWorkbenchAlphas(base, 0, 'light', true);
  assert.ok(dark.main > bright.main);
  assert.ok(dark.sidebar > bright.sidebar);
  assert.ok(dark.composer > bright.composer);
  for (const result of [bright, dark]) {
    assert.ok(result.main >= 0.58 && result.main <= 0.82);
    assert.ok(result.sidebar >= 0.74 && result.sidebar <= 0.90);
    assert.ok(result.composer >= 0.84 && result.composer <= 0.96);
  }
});

test('disabled and failed sampling returns the exact configured baseline', () => {
  const unusual = { main: 0.31, sidebar: 0.66, composer: 0.81 };
  for (const result of [
    adaptWorkbenchAlphas(unusual, 1, 'dark', false),
    adaptWorkbenchAlphas(unusual, null, 'dark', true),
    adaptWorkbenchAlphas(unusual, Number.NaN, 'light', true),
  ]) assert.deepEqual(result, unusual);
});

test('stale sample guard rejects A -> B -> A, same-index rebuilds and mode changes', () => {
  const sample = { token: 4, key: '2:wall-a:0', appearance: 'workbench', readability: true };
  assert.equal(visualSampleIsCurrent(sample, { ...sample }), true);
  assert.equal(visualSampleIsCurrent(sample, { ...sample, token: 5 }), false);
  assert.equal(visualSampleIsCurrent(sample, { ...sample, key: '2:wall-b:0' }), false);
  assert.equal(visualSampleIsCurrent(sample, { ...sample, appearance: 'legacy' }), false);
  assert.equal(visualSampleIsCurrent(sample, { ...sample, readability: false }), false);
  assert.equal(visualSampleIsCurrent(sample, null), false);
});

test('serialized browser runtime is self-contained and matches pure helpers', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(visualRuntimeSource(), sandbox);
  assert.equal(typeof sandbox.window.__weVisual.adapt, 'function');
  assert.equal(typeof sandbox.window.__weVisual.isCurrent, 'function');
  const result = sandbox.window.__weVisual.adapt(base, 1, 'dark', true);
  assert.equal(result.main, 0.70);
  assert.equal(result.sidebar, 0.84);
  assert.equal(sandbox.window.__weVisual.isCurrent(
    { token: 1, key: 'a', appearance: 'workbench', readability: true },
    { token: 2, key: 'a', appearance: 'workbench', readability: true },
  ), false);
});
