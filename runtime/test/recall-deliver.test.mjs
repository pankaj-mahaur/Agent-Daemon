// L6 (design decision 8): two entries serving the same session and event deliver once.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-deliver-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const { claimDelivery } = await import("../src/memory/recall-deliver.mjs");

test("the first claim delivers, a second for the same session, event and ask doesn't", () => {
  const o = { root: ROOT };
  assert.equal(claimDelivery({ session: "s1", event: "session.start", what: "startup" }, o), true);
  assert.equal(claimDelivery({ session: "s1", event: "session.start", what: "startup" }, o), false);
  // another source (a compaction restarts the session), event, session or prompt: its own delivery
  assert.equal(claimDelivery({ session: "s1", event: "session.start", what: "compact" }, o), true);
  assert.equal(claimDelivery({ session: "s1", event: "prompt.submit", what: "hello" }, o), true);
  assert.equal(claimDelivery({ session: "s1", event: "prompt.submit", what: "hello again" }, o), true);
  assert.equal(claimDelivery({ session: "s2", event: "session.start", what: "startup" }, o), true);
});

test("a claim counts for 60 seconds: a later compaction or resume of the same session delivers again", () => {
  const o = { root: ROOT };
  const t0 = Date.now();
  assert.equal(claimDelivery({ session: "c1", event: "session.start", what: "compact" }, { ...o, now: t0 }), true);
  assert.equal(claimDelivery({ session: "c1", event: "session.start", what: "compact" }, { ...o, now: t0 + 5_000 }), false, "a second entry of the same start");
  assert.equal(claimDelivery({ session: "c1", event: "session.start", what: "compact" }, { ...o, now: t0 + 61_000 }), true, "the second compaction");
  assert.equal(claimDelivery({ session: "c1", event: "session.start", what: "compact" }, { ...o, now: t0 + 62_000 }), false);
});

test("no session id: always delivers; the marker holds no text", () => {
  assert.equal(claimDelivery({ session: null, event: "session.start" }, { root: ROOT }), true);
  assert.equal(claimDelivery({ session: null, event: "session.start" }, { root: ROOT }), true);
  claimDelivery({ session: "s9", event: "prompt.submit", what: "use pnpm not npm" }, { root: ROOT });
  for (const f of fs.readdirSync(path.join(ROOT, "recall", "served"))) {
    assert.match(f, /^[0-9a-f]{32}(\.\d+)?$/);
    assert.equal(fs.readFileSync(path.join(ROOT, "recall", "served", f), "utf8"), "");
  }
});

test("a store that can't be written still delivers (recall is never silenced by a full disk)", () => {
  const blocked = path.join(ROOT, "blocked");
  fs.writeFileSync(blocked, "a file where the folder should be");
  assert.equal(claimDelivery({ session: "s3", event: "session.start" }, { root: blocked }), true);
});

test("a stale marker is replaced by one entry only (the replacement token is exclusive)", async () => {
  const crypto = await import("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l6-race-"));
  try {
    const t0 = Date.now();
    assert.equal(claimDelivery({ session: "r1", event: "session.start", what: "compact" }, { root, now: t0 }), true);
    const file = path.join(root, "recall", "served", crypto.createHash("sha256").update("r1\0session.start\0compact").digest("hex").slice(0, 32));
    const mtime = fs.statSync(file).mtimeMs;
    // another entry already took the replacement of this stale marker
    fs.writeFileSync(`${file}.${Math.floor(mtime)}`, "");
    assert.equal(claimDelivery({ session: "r1", event: "session.start", what: "compact" }, { root, now: t0 + 61_000 }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
