// Token map for wallpaper payload serving (same discipline as dsh's tokenFor):
// a token is base64url of the wallpaper DIRECTORY, but requests are only ever
// served for tokens this process registered — decoding arbitrary tokens would
// let a requester name any directory on disk, so the map is the gate.
import path from 'node:path';

export function createTokenMap() {
  const map = new Map(); // token -> absolute wallpaper dir
  const byDir = new Map();
  return {
    tokenFor(dir) {
      const key = path.resolve(dir);
      const hit = byDir.get(key);
      if (hit) return hit;
      const token = Buffer.from(key, 'utf8').toString('base64url');
      map.set(token, key);
      byDir.set(key, token);
      return token;
    },
    resolve(token) { return map.get(token) || null; },
    get size() { return map.size; },
  };
}
