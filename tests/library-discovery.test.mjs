import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanLibrary, uniqueDirectories } from '../src/library.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots = ['SteamA', 'SteamB'].map((name) => path.join(dir, name));
  const uploadsDir = path.join(dir, 'uploads');
  for (const p of [...roots, uploadsDir]) fs.mkdirSync(p);
  const add = (root, id, playable = true) => {
    const item = path.join(root, id);
    fs.mkdirSync(item);
    fs.writeFileSync(path.join(item, 'project.json'), JSON.stringify({
      title: 'Same title', type: 'video', file: 'video.mp4', preview: 'preview.jpg',
    }));
    fs.writeFileSync(path.join(item, 'preview.jpg'), '');
    if (playable) fs.writeFileSync(path.join(item, 'video.mp4'), '');
  };
  return { dir, roots, uploadsDir, add };
}

test('directory aliases and Windows case variants are scanned only once', (t) => {
  const { dir, roots } = fixture(t);
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(roots[0], alias, process.platform === 'win32' ? 'junction' : 'dir');
  const paths = [roots[0], alias, path.join(roots[0], '.'), path.join(dir, 'missing')];
  if (process.platform === 'win32') paths.push(roots[0].toUpperCase());
  assert.deepEqual(uniqueDirectories(paths), [roots[0]]);
});

test('duplicate IDs across real libraries prefer playable files without merging equal titles', (t) => {
  const { roots, uploadsDir, add } = fixture(t);
  add(roots[0], '100', false);
  add(roots[1], '100', true);
  add(roots[0], '101', true);
  fs.writeFileSync(path.join(uploadsDir, 'u-test.png'), '');
  const lib = scanLibrary({ roots: [roots[0], roots[0], roots[1]], uploadsDir });
  assert.equal(lib.length, 3);
  assert.equal(new Set(lib.map((x) => x.id)).size, 3);
  assert.equal(lib.find((x) => x.id === '100').path, path.join(roots[1], '100', 'video.mp4'));
  assert.ok(lib.some((x) => x.id === '101'));
  assert.ok(lib.some((x) => x.id === 'u-test'));
});

test('library retains all distinct wallpapers beyond 120', (t) => {
  const { roots, uploadsDir, add } = fixture(t);
  for (let i = 0; i < 145; i++) add(roots[0], String(1000 + i));
  const lib = scanLibrary({ roots, uploadsDir });
  assert.equal(lib.length, 145);
  assert.ok(lib.some((x) => x.id === '1144'));
});
