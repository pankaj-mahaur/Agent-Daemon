// Tests for `ad agy` (harness/agy.mjs) with a fake agy script. Properties:
// opt-in consent before the first run, sandboxed headless flags, and
// agy's JSON result mapped to exit codes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyArgs, cmdAgy } from "../src/harness/agy.mjs";

const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

function fakeAgy(root, result) {
  const script = join(root, "fake-agy.mjs");
  writeFileSync(script, `process.stdout.write(JSON.stringify(${JSON.stringify(result)}));`);
  return { cmd: process.execPath, prefix: [script] };
}

test("agyArgs: prompt is one --prompt= token (no flag injection); sandboxed; edits opt-in", () => {
  const a = agyArgs({ prompt: "--dangerously-skip-permissions" });
  assert.equal(a[0], "--prompt=--dangerously-skip-permissions");
  assert.ok(!a.includes("--dangerously-skip-permissions"));
  assert.ok(a.includes("--sandbox") && a.includes("--disable-slash-commands"));
  assert.deepEqual(agyArgs({ prompt: "hi", model: "m", edits: true }).slice(-2), ["--model=m", "--mode=accept-edits"]);
});

test("odd agy output (null JSON, object error) is reported, not crashed on", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-agy-"));
  try {
    for (const [result, pattern] of [[null, /without a JSON result/], [{ status: "ERROR", error: { code: 7 } }, /{"code":7}/]]) {
      const err = sink();
      assert.equal(await cmdAgy("x", { userHome: root, command: fakeAgy(root, result), stdout: sink(), stderr: err, acceptRisk: true }), 1);
      assert.match(err.text, pattern);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first run needs --accept-risk; consent is remembered", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-agy-"));
  try {
    const command = fakeAgy(root, { status: "SUCCESS", response: "42", conversation_id: "c1" });
    const err = sink();
    assert.equal(await cmdAgy("what?", { userHome: root, command, stdout: sink(), stderr: err }), 2);
    assert.match(err.text, /--accept-risk/);
    const out = sink();
    assert.equal(await cmdAgy("what?", { userHome: root, command, stdout: out, stderr: sink(), acceptRisk: true }), 0);
    assert.equal(out.text, "42\n");
    assert.ok(existsSync(join(root, ".agent-daemon", "agy-consent.json")));
    assert.equal(await cmdAgy("again", { userHome: root, command, stdout: sink(), stderr: sink() }), 0, "no flag needed after consent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agy errors and a missing binary are reported with exit 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-agy-"));
  try {
    const failing = fakeAgy(root, { status: "ERROR", error: { message: "authentication required" } });
    const err = sink();
    assert.equal(await cmdAgy("x", { userHome: root, command: failing, stdout: sink(), stderr: err, acceptRisk: true }), 1);
    assert.match(err.text, /authentication required/);
    const err2 = sink();
    assert.equal(await cmdAgy("x", { userHome: root, command: { cmd: "definitely-not-agy-xyz", prefix: [] }, stdout: sink(), stderr: err2 }), 1);
    assert.match(err2.text, /agy not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
