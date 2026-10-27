import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_FX, normalizeConfig } from '../src/config.mjs';
import {
  applyCommand,
  applyVisualValues,
  captureVisualValues,
} from '../src/commands.mjs';

function rawConfig() {
  return {
    playlists: [{ key: 'default', name: '测试列表', items: [{ kind: 'image', path: 'C:\\wall-a.png', title: 'A', id: 'a' }], intervalSec: 300, order: 'sequential' }],
    activePlaylist: 'default', currentIndex: 0, lastSwitchAt: 12345, paused: false,
    fx: { opacity: 0.42, brightness: 0.77, autoTint: true, volume: 0.2, rate: 1.25 },
    fxLayer: { click: { enabled: true }, trail: { enabled: true } },
    parallax: { enabled: true, wallpaperPct: 1, uiPct: 2 },
    live: { enabled: false, fps: 60 },
    mascot: { enabled: true, form: 'custom', xPct: 0.4, size: 1, customFile: 'custom-src.png' },
    avatars: { enabled: true, user: 'user.jpg', assistant: '' },
    unknownFutureField: { keep: true },
  };
}

function nonvisual(cfg) {
  return {
    playlists: cfg.playlists,
    activePlaylist: cfg.activePlaylist,
    currentIndex: cfg.currentIndex,
    lastSwitchAt: cfg.lastSwitchAt,
    paused: cfg.paused,
    live: cfg.live,
    volume: cfg.fx.volume,
    rate: cfg.fx.rate,
    panX: cfg.fx.panX,
    zoom: cfg.fx.zoom,
    mascotForm: cfg.mascot.form,
    mascotFile: cfg.mascot.customFile,
    avatars: cfg.avatars,
    occlusion: cfg.occlusion,
    wallpaperProps: cfg.wallpaperProps,
    unknownFutureField: cfg.unknownFutureField,
  };
}

function sandbox(t, { writeConfig = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-visual-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = rawConfig();
  const rawText = JSON.stringify(raw, null, 2) + '\n';
  const ctx = {
    configFile: path.join(dir, 'config.json'),
    visualRestoreFile: path.join(dir, 'visual-restore.json'),
    backupDir: path.join(dir, 'backups'),
    now: '2026-10-27T05:30:00.000Z',
  };
  if (writeConfig) fs.writeFileSync(ctx.configFile, rawText, 'utf8');
  return { cfg: normalizeConfig(raw), raw, rawText, ctx, dir };
}

test('legacy configs merge additively without mutating input or shared defaults', () => {
  const old = {
    playlist: [{ kind: 'video', path: 'old.mp4', title: 'Old', id: 'old' }],
    intervalSec: 456,
    order: 'shuffle',
    fx: { opacity: 0.37, autoTint: false },
    future: { untouched: true },
  };
  const before = structuredClone(old);
  const cfg = normalizeConfig(old);
  assert.deepEqual(old, before);
  assert.equal(cfg.fx.appearance, 'legacy');
  assert.equal(cfg.fx.sidebarAlpha, 0.62);
  assert.equal(cfg.fx.sidebarAlphaDark, 0.68);
  assert.equal(cfg.fx.sidebarBlur, 18);
  assert.equal(cfg.fx.autoReadability, false);
  assert.equal(cfg.fx.opacity, 0.37);
  assert.equal(cfg.fx.autoTint, false);
  assert.equal(cfg.playlists[0].intervalSec, 456);
  assert.deepEqual(cfg.future, { untouched: true });
  cfg.fx.opacity = 0.91;
  assert.notEqual(DEFAULT_FX.opacity, 0.91);
});

test('readConfig does not rewrite an old on-disk config', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-home-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = path.join(home, '.chatgpt-wallpaper');
  fs.mkdirSync(app, { recursive: true });
  const file = path.join(app, 'config.json');
  const raw = '{"fx":{"opacity":0.41},"playlists":[],"future":"keep"}\n';
  fs.writeFileSync(file, raw, 'utf8');
  const moduleUrl = pathToFileURL(path.resolve('src/config.mjs')).href;
  const script = `import {readConfig } from ${JSON.stringify(moduleUrl)}; const c=readConfig(); console.log(JSON.stringify({mode:c.fx.appearance,opacity:c.fx.opacity,future:c.future}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'local') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { mode: 'legacy', opacity: 0.41, future: 'keep' });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('enable backs up first and visual restore preserves later nonvisual changes', (t) => {
  const { cfg, rawText, ctx } = sandbox(t);
  const originalVisual = captureVisualValues(cfg);
  const originalNonvisual = nonvisual(cfg);
  const enabled = applyCommand(cfg, { c: 'appearance.set', mode: 'workbench' }, ctx);
  assert.equal(enabled.changed, true, enabled.message);
  assert.equal(cfg.fx.appearance, 'workbench');
  assert.equal(cfg.fx.sidebarAlphaDark, 0.78);
  assert.equal(cfg.fx.contentAlpha, originalVisual['fx.contentAlpha']);
  assert.deepEqual(nonvisual(cfg), originalNonvisual);
  assert.equal(fs.readFileSync(ctx.configFile, 'utf8'), rawText, 'applyCommand itself must not persist');
  const backupDirs = fs.readdirSync(ctx.backupDir);
  assert.equal(backupDirs.length, 1);
  const backup = path.join(ctx.backupDir, backupDirs[0], 'config.json');
  assert.equal(fs.readFileSync(backup, 'utf8'), rawText);
  const snapshot = JSON.parse(fs.readFileSync(ctx.visualRestoreFile, 'utf8'));
  assert.deepEqual(snapshot.values, originalVisual);

  cfg.playlists[0].items.push({ kind: 'video', path: 'D:\\later.mp4', title: 'Later', id: 'later' });
  cfg.currentIndex = 1;
  cfg.lastSwitchAt = 987654;
  cfg.paused = true;
  cfg.fx.volume = 0.9;
  cfg.fx.rate = 2;
  cfg.live = { enabled: true, fps: 15 };
  cfg.mascot.customFile = 'later-custom.png';
  cfg.avatars.user = 'later-avatar.png';
  const laterNonvisual = nonvisual(cfg);
  const restored = applyCommand(cfg, { c: 'appearance.restore' }, ctx);
  assert.equal(restored.changed, true, restored.message);
  assert.equal(restored.clearVisualSnapshot, ctx.visualRestoreFile);
  assert.deepEqual(captureVisualValues(cfg), originalVisual);
  assert.deepEqual(nonvisual(cfg), laterNonvisual);
  assert.equal(cfg.fx.appearance, 'legacy');
});

test('repeat enable and legacy/workbench toggles never overwrite the original snapshot', (t) => {
  const { cfg, ctx } = sandbox(t);
  const original = captureVisualValues(cfg);
  assert.equal(applyCommand(cfg, { c: 'appearance.set', mode: 'workbench' }, ctx).changed, true);
  assert.equal(applyCommand(cfg, { c: 'appearance.set', mode: 'workbench' }, ctx).changed, false);
  assert.equal(fs.readdirSync(ctx.backupDir).length, 1);
  cfg.fx.opacity = 0.73;
  assert.equal(applyCommand(cfg, { c: 'appearance.set', mode: 'legacy' }, ctx).changed, true);
  assert.equal(applyCommand(cfg, { c: 'appearance.set', mode: 'workbench' }, ctx).changed, true);
  assert.equal(fs.readdirSync(ctx.backupDir).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.visualRestoreFile, 'utf8')).values, original);
});

test('invalid values leave config untouched; valid numeric boundaries clamp', (t) => {
  const { cfg, ctx } = sandbox(t);
  for (const command of [
    { c: 'fx', k: 'sidebarAlpha', v: 'not-a-number' },
    { c: 'fx', k: 'sidebarBlur', v: Number.POSITIVE_INFINITY },
    { c: 'fx', k: 'autoReadability', v: 'perhaps' },
    { c: 'fx', k: 'transition', v: 'unknown' },
    { c: 'appearance.set', mode: 'blue' },
  ]) {
    const before = structuredClone(cfg);
    const result = applyCommand(cfg, command, ctx);
    assert.equal(result.changed, false, result.message);
    assert.deepEqual(cfg, before);
  }
  assert.equal(applyCommand(cfg, { c: 'fx', k: 'sidebarAlpha', v: 2 }, ctx).changed, true);
  assert.equal(cfg.fx.sidebarAlpha, 1);
  assert.equal(applyCommand(cfg, { c: 'fx', k: 'sidebarBlur', v: -5 }, ctx).changed, true);
  assert.equal(cfg.fx.sidebarBlur, 0);
});

test('backup failure aborts enable before mutation', (t) => {
  const { cfg, ctx } = sandbox(t, { writeConfig: false });
  const before = structuredClone(cfg);
  const result = applyCommand(cfg, { c: 'appearance.set', mode: 'workbench' }, ctx);
  assert.equal(result.changed, false);
  assert.match(result.message, /无法建立视觉备份/);
  assert.deepEqual(cfg, before);
});

test('missing, malformed and partial restore snapshots cannot mutate config', (t) => {
  const { cfg, ctx } = sandbox(t);
  let before = structuredClone(cfg);
  assert.equal(applyCommand(cfg, { c: 'appearance.restore' }, ctx).changed, false);
  assert.deepEqual(cfg, before);
  fs.writeFileSync(ctx.visualRestoreFile, '{broken', 'utf8');
  assert.equal(applyCommand(cfg, { c: 'appearance.restore' }, ctx).changed, false);
  assert.deepEqual(cfg, before);
  fs.writeFileSync(ctx.visualRestoreFile, JSON.stringify({ version: 1, values: { 'fx.appearance': 'legacy' } }), 'utf8');
  assert.equal(applyCommand(cfg, { c: 'appearance.restore' }, ctx).changed, false);
  assert.deepEqual(cfg, before);
  before = structuredClone(cfg);
  assert.equal(applyVisualValues(cfg, { 'fx.appearance': 'legacy' }), false);
  assert.deepEqual(cfg, before);
});
