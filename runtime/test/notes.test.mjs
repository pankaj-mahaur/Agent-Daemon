// Tests for once-per-install notes (harness/notes.mjs): shown once, shown
// again when the record is unreadable, and wired into startHarnessEngine
// through notesFile (tests never touch the real notes file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { noteOnce } from "../src/harness/notes.mjs";
import { startHarnessEngine } from "../src/harness/start.mjs";

const FAKE = { cmd: process.execPath, prefix: [fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url))] };

class Sink {
  constructor() {
    this.text = "";
  }
  write(s) {
    this.text += s;
  }
}

test("noteOnce shows once, then not again", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-notes-"));
  try {
    const file = join(dir, "notes.json");
    const err = new Sink();
    assert.equal(noteOnce("k", "hello", { err, file }), true);
    assert.match(err.text, /hello/);
    assert.equal(noteOnce("k", "hello", { err, file }), false);
    assert.equal(err.text.match(/hello/g).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noteOnce shows again when the record stays unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-notes-"));
  try {
    const file = join(dir, "notes.json");
    writeFileSync(file, "{broken");
    const err = new Sink();
    assert.equal(noteOnce("k", "hello", { err, file }), true, "broken record: shown");
    mkdirSync(join(dir, "unwritable"));
    const stuck = join(dir, "unwritable");
    assert.equal(noteOnce("k", "hello", { err, file: stuck }), true, "unwritable record: shown");
    assert.equal(noteOnce("k", "hello", { err, file: stuck }), true, "still unwritable: shown again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startHarnessEngine writes the legacy-bin note once to notesFile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-notes-"));
  const home = mkdtempSync(join(tmpdir(), "ad-notes-home-"));
  try {
    const file = join(dir, "notes.json");
    const err = new Sink();
    const opts = { home, command: FAKE, setup: false, err, notesFile: file, env: { AD_CODEX_BIN: "/tmp/ad-notes-bin" } };
    const first = await startHarnessEngine(opts);
    await first.engine?.close();
    assert.match(err.text, /AD_CODEX_BIN still works \(its new name is AD_ENGINE_BIN\)\./);
    const second = await startHarnessEngine(opts);
    await second.engine?.close();
    assert.equal(err.text.match(/AD_CODEX_BIN still works/g).length, 1, "shown once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
