#!/usr/bin/env node
/**
 * Watchdog — keeps the bridge alive while the ChatGPT / Codex app is open.
 *
 * The bridge is a separate Node process and can die on its own (security
 * tools force-kill unsigned background processes, a manual taskkill, a
 * terminal-spawned bridge dying with its parent tree, ...). When that
 * happens the wallpaper silently never comes back until the next login.
 * This watchdog closes that gap. Every POLL_MS:
 *
 *   · bridge lock port held          → alive, keep waiting
 *   · port free + ChatGPT.exe running → relaunch the bridge (detached)
 *   · port free + app closed          → nothing to do; check again later
 *
 * Every relaunch is appended to watchdog.log with a timestamp, so repeated
 * deaths leave a precise trail for diagnosis. Singleton via its own lock
 * port (28742, same trick as the bridge — loopback ports are not virtualized
 * by security-tool sandboxes, unlike pid files).
 *
 * Usage: node src/watchdog.mjs          run (self-guards against duplicates)
 *        node src/watchdog.mjs --off    stop the running watchdog
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_DIR } from './config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_JS = path.join(SCRIPT_DIR, 'bridge.mjs');
const BRIDGE_LOCK_PORT = 28741;   // held by a running bridge (see bridge.mjs LOCK_PORT)
const WATCHDOG_LOCK_PORT = 28742; // held by this watchdog
const WATCHDOG_PID_FILE = path.join(APP_DIR, 'watchdog.pid');
const LOG_FILE = path.join(APP_DIR, 'watchdog.log');
const BRIDGE_OUT = path.join(APP_DIR, 'autostart.log');
const BRIDGE_ERR = path.join(APP_DIR, 'autostart.err.log');
const POLL_MS = 10_000;
const RELAUNCH_COOLDOWN_MS = 60_000; // min interval between bridge relaunches
const LOG_CAP_BYTES = 256 * 1024;

const ts = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function log(msg) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > LOG_CAP_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    fs.appendFileSync(LOG_FILE, `${ts()} ${msg}\n`, 'utf8');
  } catch {}
}

function holdPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function portHeld(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

const appRunning = () => new Promise((resolve) => {
  execFile('tasklist.exe', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH', '/FO', 'CSV'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    resolve(!err && /ChatGPT\.exe/i.test(String(stdout)));
  });
});

let lastLaunch = 0;
function relaunchBridge() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const out = fs.openSync(BRIDGE_OUT, 'a');
  const err = fs.openSync(BRIDGE_ERR, 'a');
  try {
    fs.appendFileSync(BRIDGE_OUT, `${ts()} [watchdog] relaunching bridge\n`, 'utf8');
    const child = spawn(process.execPath, [BRIDGE_JS, 'start'], {
      detached: true, windowsHide: true, stdio: ['ignore', out, err],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

async function main() {
  if (process.argv.includes('--off')) {
    try {
      const pid = Number(fs.readFileSync(WATCHDOG_PID_FILE, 'utf8'));
      if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    } catch {}
    try { fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
    console.log('Watchdog stopped. (Logon task untouched — "autostart --off" removes it.)');
    return;
  }
  const lock = await holdPort(WATCHDOG_LOCK_PORT);
  if (!lock) { console.log('Watchdog already running (lock port held).'); return; }
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(WATCHDOG_PID_FILE, String(process.pid), 'utf8');
  log(`watchdog started (pid ${process.pid})`);
  const shutdown = () => {
    try { if (Number(fs.readFileSync(WATCHDOG_PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(WATCHDOG_PID_FILE); } catch {}
    try { lock.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  for (;;) {
    try {
      if (!(await portHeld(BRIDGE_LOCK_PORT)) && await appRunning()
        && Date.now() - lastLaunch >= RELAUNCH_COOLDOWN_MS) {
        lastLaunch = Date.now();
        const pid = relaunchBridge();
        log(`bridge was DOWN while the app was open — relaunched (pid ${pid})`);
      }
    } catch (e) { log(`check failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exitCode = 1; });
