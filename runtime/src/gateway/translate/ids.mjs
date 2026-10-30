// IDs for translated traffic (P6.1).
//   mintId(prefix)                   prefix + 24 random base62 ("resp_", "msg_", "rs_", "call_")
//   mistralIds(salt)                 → toUpstream(engineCallId): 9 base62, stable for a call
//                                    within one request, distinct (a counter re-derives on a
//                                    collision); fromUpstream(id) → the engine's id
// Upstream call IDs are never shown to the engine: each emitted call gets a minted id.

import { createHash, randomBytes } from "node:crypto";

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes, n) {
  let out = "";
  for (let i = 0; out.length < n && i < bytes.length * 4; i++) {
    const b = bytes[i % bytes.length];
    if (b >= 248) continue; // 248 = 62 * 4: no modulo bias
    out += B62[b % 62];
  }
  return out.length === n ? out : out.padEnd(n, "0");
}

export function mintId(prefix) {
  let s = "";
  while (s.length < 24) s += base62(randomBytes(32), 24 - s.length);
  return prefix + s;
}

/** Mistral wants tool-call IDs of exactly 9 characters [a-zA-Z0-9]. */
export function mistralIds(salt) {
  const toUp = new Map();
  const toEngine = new Map();
  return {
    toUpstream(engineId) {
      if (toUp.has(engineId)) return toUp.get(engineId);
      for (let n = 0; ; n++) {
        const h = createHash("sha256").update(`${salt}\n${engineId}\n${n}`).digest();
        const id = base62(h, 9);
        if (toEngine.has(id)) continue;
        toUp.set(engineId, id);
        toEngine.set(id, engineId);
        return id;
      }
    },
    fromUpstream: (id) => toEngine.get(id) ?? null,
  };
}
