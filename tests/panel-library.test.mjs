import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the real grid renderer without mounting the rest of the controller.
const source = fs.readFileSync(new URL('../src/panel.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('  function renderGrid()'), source.indexOf('  function renderPlay()'));

function render(rows, search = '') {
  const grid = { children: [], innerHTML: '', append(child) { this.children.push(child); } };
  const commands = [];
  const h = (tag, attrs, ...children) => ({
    tag, attrs, children, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  });
  vm.runInNewContext(renderer + ';renderGrid();', {
    $: () => grid, body: {}, payload: () => ({ items: [] }),
    lib: () => rows, h, cmd: (value) => commands.push(value), search,
    filterType: 'all', filterRating: 'all', showHidden: false,
  });
  return { cards: grid.children.filter((x) => x.attrs.class.startsWith('wep-card')), commands };
}

test('all matches beyond 120 render with lazy thumbnails and working selection', () => {
  const rows = Array.from({ length: 145 }, (_, i) => ({ id: String(i), title: `Wallpaper ${i}`, kind: 'video', hasThumb: true }));
  const { cards, commands } = render(rows);
  assert.equal(cards.length, 145);
  assert.ok(cards.every((x) => x.children[0].attrs.loading === 'lazy'));
  cards[144].handlers.click();
  assert.equal(commands[0].c, 'select');
  assert.equal(commands[0].id, '144');
});

test('search reaches the end of the library while hidden items stay excluded', () => {
  const rows = Array.from({ length: 145 }, (_, i) => ({ id: String(i), title: `Wallpaper ${i}`, kind: 'video', hasThumb: true }));
  rows[143].hidden = true;
  const { cards } = render(rows, 'Wallpaper 14');
  assert.deepEqual(cards.map((x) => x.attrs.title), ['Wallpaper 14', 'Wallpaper 140', 'Wallpaper 141', 'Wallpaper 142', 'Wallpaper 144']);
});
