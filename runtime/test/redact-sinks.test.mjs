// P3.3: an engine crash whose stderr holds a key never shows it: not in the CLI's error
// lines, the engine error detail (/warnings), the notes, or what the gateway registered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, engineErrorDetail, engineErrorText } from "../src/engine/index.mjs";
import { cliErrorLines } from "../src/harness/io.mjs";
import { noteOnce } from "../src/harness/notes.mjs";
import { registerSecret, _resetForTests } from "../src/auth/redact.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE], source: "test-double" };
const KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");

test("an engine crash whose stderr holds a key never shows it in cliErrorLines, the detail (/warnings) or a note", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-redact-sinks-"));
  const engine = await createEngine({ home: join(root, "home"), command, env: { FAKE_CRASH_STDERR: `panicked: auth header Bearer ${KEY} rejected` } });
  try {
    let caught;
    await assert.rejects(engine.testRequest("test/crash"), (err) => ((caught = err), true));
    const lines = cliErrorLines("run", caught);
    assert.ok(!lines.includes(KEY), lines);
    assert.match(lines, /\[redacted/);
    assert.ok(!String(engineErrorDetail(caught)).includes(KEY));
    assert.ok(!engineErrorText(caught).includes(KEY));
    const out = [];
    noteOnce(`k-${Date.now()}`, `the key ${KEY} was refused`, { err: { write: (s) => out.push(s) }, file: join(root, "notes.json") });
    assert.ok(!out.join("").includes(KEY));
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a registered value that matches no pattern is redacted too (the gateway token)", () => {
  _resetForTests();
  const token = "Zx9-token-without-a-pattern-12345";
  registerSecret(token, "gateway token");
  assert.equal(cliErrorLines("run", new Error(`connect with ${token} failed`)), "ad run: connect with [redacted: gateway token] failed\n");
});
