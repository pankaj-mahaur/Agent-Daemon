// P0.5: ad init writes Claude Code's settings files atomically
// (runtime/src/atomic-write.mjs): a failed rename leaves the original
// byte-identical with no temp file left; the mode is kept; a concurrent reader
// never sees half a file.

import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "../src/atomic-write.mjs";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "ad-atomic-"));

test("a rename that keeps failing leaves the original byte-identical, and no temp file remains", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "settings.json");
    const original = '{\n  "hooks": { "a": 1 }\n}\n';
    writeFileSync(file, original);
    const busy = { ...fsp, rename: async () => { const e = new Error("busy"); e.code = "EBUSY"; throw e; } };
    await assert.rejects(writeJsonAtomic(file, { hooks: { b: 2 } }, { fsx: busy, retries: 2, delayMs: 1 }), /it's in use; close Claude Code and run ad init again/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(readdirSync(dir), ["settings.json"], "no temp file left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename that fails once is retried and succeeds", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "x.json");
    writeFileSync(file, "{}");
    let n = 0;
    const flaky = { ...fsp, rename: async (a, b) => { if (n++ === 0) { const e = new Error("busy"); e.code = "EPERM"; throw e; } return fsp.rename(a, b); } };
    await writeJsonAtomic(file, { ok: true }, { fsx: flaky, delayMs: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ok: true });
    assert.deepEqual(readdirSync(dir), ["x.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the written file keeps its mode", { skip: process.platform === "win32" && "POSIX modes" }, async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "claude.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o600);
    await writeJsonAtomic(file, { a: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a concurrent reader never sees a partial file", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "s.json");
    const big = (i) => ({ i, pad: "x".repeat(200_000) });
    await writeJsonAtomic(file, big(0));
    let reading = true;
    let reads = 0;
    const reader = (async () => {
      while (reading) {
        try {
          JSON.parse(readFileSync(file, "utf8"));
          reads++;
        } catch (e) {
          // Windows: the file is mid-rename; anything else is a partial read.
          if (!(e.code === "ENOENT" || e.code === "EBUSY" || e.code === "EPERM")) throw new Error(`a partial read: ${e.message}`);
        }
        // Yield either way, so the writes run (a reader that holds the file
        // open nonstop would block every rename on Windows).
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    for (let i = 1; i <= 200; i++) await writeJsonAtomic(file, big(i));
    reading = false;
    await reader;
    assert.ok(reads > 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).i, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new file is created", async () => {
  const dir = tempDir();
  try {
    await writeFileAtomic(path.join(dir, "new.json"), "{}");
    assert.equal(readFileSync(path.join(dir, "new.json"), "utf8"), "{}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
