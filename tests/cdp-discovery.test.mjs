import test from 'node:test';
import assert from 'node:assert/strict';
import { appPages } from '../src/cdp.mjs';

for (const stallAt of ['headers', 'body']) {
  test(`discovery advances after a listener stalls at ${stallAt}`, async (t) => {
    const requests = [];
    const keepAlive = setTimeout(() => {}, 5000);
    t.after(() => clearTimeout(keepAlive));
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, signal: options?.signal });
      if (requests.length === 1) {
        assert.ok(options.signal instanceof AbortSignal);
        const stalled = () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        if (stallAt === 'headers') return stalled();
        return { ok: true, json: stalled };
      }
      return {
        ok: true,
        json: async () => [{ type: 'page', url: 'app://-/index.html', id: 'recovered' }],
      };
    });
    const pages = await appPages();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(pages[0].id, 'recovered');
    assert.equal(pages[0].port, 1455);
  });
}
