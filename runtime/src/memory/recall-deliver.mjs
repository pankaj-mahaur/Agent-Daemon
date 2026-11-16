// One delivery per session start, on every host (MCP launch plan L6, design decision
// 8). Two entries can serve the same hook — ad's engine entry and the product launcher
// on the same host, or a leftover duplicate — and only the first may add learnings to the
// context. Each claims the delivery, just before printing, by creating a marker file
// exclusively; the second finds it and delivers nothing.
//
// A marker counts for 60 seconds only: two entries of one start fire within seconds,
// while a later compaction or resume of the same session must deliver again (the stale
// marker is replaced: unlink, then a fresh exclusive create, so of two racing claimers
// one wins). The marker names a session, an event and what was asked (the start's
// source), hashed: no text is stored. Old markers are pruned by the context job.
// Without a session id there is nothing to share, so it delivers; any failure but
// "already claimed" delivers too (recall is never silenced by a full disk).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { adRoot } from "../ad-root.mjs";

export const CLAIM_MS = 60_000;

/**
 * Claim the delivery of `event` for `session` (and `what`). → true when this process
 * may deliver, false when another entry delivered it in the last 60 seconds.
 */
export function claimDelivery({ session, event, what = "" }, { root = adRoot(), now = Date.now() } = {}) {
  if (!session) return true;
  const dir = path.join(root, "recall", "served");
  // Old markers go now and then (the context job prunes too, but not every user has a repo).
  if (Math.random() < 0.02) pruneMarkers(dir, now);
  const file = path.join(dir, crypto.createHash("sha256").update(`${session}\0${event}\0${what}`).digest("hex").slice(0, 32));
  const create = () => {
    fs.writeFileSync(file, "", { flag: "wx" });
    fs.utimesSync(file, now / 1000, now / 1000); // the claim's own time (an injected clock in tests)
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    create();
    return true;
  } catch (err) {
    if (err?.code !== "EEXIST") return true;
  }
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false; // removed between the two calls: another entry is replacing it
  }
  const age = now - mtime;
  if (age >= 0 && age < CLAIM_MS) return false; // another entry of this start delivered
  // A stale marker: of the entries that found it, only the one that creates the
  // replacement token for this very marker replaces it.
  try {
    fs.writeFileSync(`${file}.${Math.floor(mtime)}`, "", { flag: "wx" });
  } catch (err) {
    return err?.code !== "EEXIST";
  }
  try {
    fs.rmSync(file, { force: true });
    create();
    return true;
  } catch (err) {
    return err?.code !== "EEXIST";
  }
}

function pruneMarkers(dir, now) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      try {
        if (now - fs.statSync(f).mtimeMs > 86_400_000) fs.rmSync(f, { force: true });
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // no folder yet
  }
}
