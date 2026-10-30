// Random, time-ordered ids (ULID: 26 Crockford base-32 characters), shared by the
// project registry (memory/projects.mjs) and the account registry (auth/accounts).
// Never derived from a label, an email or a path.

import crypto from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 characters of time, 16 of randomness. */
export function ulid(now = Date.now(), rand = crypto.randomBytes(16)) {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return time + r;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
