// Shared Chrome DevTools Protocol helper (no npm deps; Node >= 22 built-in WebSocket).
import { execFileSync } from 'node:child_process';

export class CDP {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.handlers = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) { for (const fn of this.handlers) fn(m); }
    };
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export function devtoolsPorts(extra = []) {
  const ports = new Set([12230, 1455, 1457, ...extra]);
  if (process.platform === 'win32') {
    try {
      const ps = "$p=Get-CimInstance Win32_Process -Filter \"name='ChatGPT.exe'\"; $p.CommandLine | ForEach-Object { if ($_ -match '--remote-debugging-port=(\\d+)') { $Matches[1] } }";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      for (const m of out.matchAll(/\d+/g)) ports.add(Number(m[0]));
    } catch {}
  }
  return [...ports].filter((p) => p > 0 && p < 65536);
}

export async function appPages() {
  for (const port of devtoolsPorts()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!r.ok) continue;
      const pages = await r.json();
      const matches = pages.filter((p) => p.type === 'page' && p.url.startsWith('app://-/') && !p.url.toLowerCase().includes('avatar-overlay'));
      if (matches.length) return matches.map((p) => ({ ...p, port }));
    } catch {}
  }
  return [];
}
