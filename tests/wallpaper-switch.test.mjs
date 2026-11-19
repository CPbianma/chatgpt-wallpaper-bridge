import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const inject = fs.readFileSync(new URL('../src/inject.js', import.meta.url), 'utf8');
const showSource = inject.slice(inject.indexOf('  async function show('), inject.indexOf('  /* ================= theme-follow'));

test('slow loads survive repeated pushes but cannot override a newer selection', async () => {
  const state = { items: [], slots: [{ wrap: {} }, { wrap: {} }], active: -1, currentIndex: -1 };
  const loads = [];
  const displayed = [];
  const { show } = vm.runInNewContext(showSource + ';({ show })', {
    state,
    fillSlot(index, item) {
      const element = { id: item.id };
      Object.assign(state.slots[index], { el: element, kind: 'image' });
      return element;
    },
    whenReady(element) {
      return new Promise((resolve) => loads.push({ element, resolve }));
    },
    runTransition() { return 0; },
    cancelAnalysis() {},
    ensureStyle() {},
    setTimeout() {},
    analyzeActiveWallpaper(item) { displayed.push(item.id); },
  });
  const choose = (listKey, ids, index) => {
    state.lastPayload = { listKey };
    state.items = ids.map((id) => ({ id, kind: 'image' }));
    state.itemsKey = ids.join('|');
    return show(index);
  };
  const first = choose('one', ['A', 'B'], 0);
  await choose('one', ['A', 'B'], 0);
  assert.equal(loads.length, 1);
  const replacement = choose('two', ['C', 'D'], 0);
  assert.equal(loads[1].element.id, 'C');
  loads[0].resolve(true);
  await first;
  assert.deepEqual(displayed, []);
  loads[1].resolve(true);
  await replacement;
  assert.deepEqual(displayed, ['C']);
  const next = choose('two', ['C', 'D'], 1);
  await choose('two', ['C', 'D'], 0);
  loads[2].resolve(true);
  await next;
  assert.deepEqual(displayed, ['C']);
});
