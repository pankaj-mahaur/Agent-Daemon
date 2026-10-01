// Tests for the Windows sandbox setup (harness/sandbox.mjs) and the engine
// restart in harness/start.mjs. Against the fake app-server, whose
// readiness follows `windows.sandbox` in its persisted config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdSandbox } from "../src/harness/sandbox.mjs";
import { startHarnessEngine } from "../src/harness/start.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sink = () => ({ text: "", write(c) { this.text += c; return true; } });

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-sbx-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("non-Windows platforms need no setup", async () => {
  const out = sink();
  assert.equal(await cmdSandbox("setup", { platform: "linux", stdout: out, stderr: sink() }), 0);
  assert.match(out.text, /No setup needed/);
});

test("sandbox setup writes the mode and reports readiness from a fresh process", () =>
  withRoot(async (root) => {
    const home = join(root, "home");
    const out = sink();
    assert.equal(await cmdSandbox("setup", { platform: "win32", home, command, stdout: out, stderr: sink(), elevated: true }), 0);
    assert.match(out.text, /administrator approval/);
    assert.match(out.text, /windows sandbox: ready/);
    assert.equal(JSON.parse(readFileSync(join(home, "fake-config.json"), "utf8")).windows.sandbox, "elevated");
    const status = sink();
    await cmdSandbox("status", { platform: "win32", home, command, stdout: status, stderr: sink() });
    assert.match(status.text, /ready/);
  }));

test("a failed setup exits 1 with the reason", () =>
  withRoot(async (root) => {
    process.env.FAKE_SANDBOX_FAIL = "1";
    try {
      const err = sink();
      assert.equal(await cmdSandbox("setup", { platform: "win32", home: join(root, "home"), command, stdout: sink(), stderr: err }), 1);
      assert.match(err.text, /denied by policy/);
    } finally {
      delete process.env.FAKE_SANDBOX_FAIL;
    }
  }));

test("startHarnessEngine auto-configures the Windows sandbox once and restarts the engine", () =>
  withRoot(async (root) => {
    const home = join(root, "home");
    const err = sink();
    const { engine } = await startHarnessEngine({ cwd: root, home, command, err, platform: "win32", store: { get: () => null } });
    try {
      assert.match(err.text, /set up the Windows sandbox \(unelevated\)/);
      assert.equal(await engine.server.request("windowsSandbox/readiness", {}).then((r) => r.status), "ready", "restarted process sees it");
    } finally {
      await engine.close();
    }
    const err2 = sink();
    const again = await startHarnessEngine({ cwd: root, home, command, err: err2, platform: "win32", store: { get: () => null } });
    await again.engine.close();
    assert.ok(!/set up the Windows sandbox/.test(err2.text), "only the first run configures it");
  }));

test("startHarnessEngine reports not-logged-in without leaving a process behind", () =>
  withRoot(async (root) => {
    process.env.FAKE_LOGGED_OUT = "1";
    try {
      const r = await startHarnessEngine({ cwd: root, home: join(root, "home"), command, err: sink(), store: { get: () => null } });
      assert.equal(r.engine, null);
      assert.equal(r.code, 2);
      assert.match(r.error, /ad auth login chatgpt/);
    } finally {
      delete process.env.FAKE_LOGGED_OUT;
    }
  }));
