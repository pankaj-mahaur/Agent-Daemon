// L3 Decision 26: install keeps a reserved, empty step for L4b's consented rule import,
// after setup and only in a terminal, so L4b adds no new install screen. Temp homes only.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { makeContext, install, consentedImport } = await import("../src/memory-install/install.mjs");

const made = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function home({ tty = true } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "ad-import-step-"));
  made.push(h);
  const codex = path.join(h, ".codex");
  fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(codex, "config.toml"), 'model = "gpt-5"\n');
  const adRoot = path.join(h, ".agent-daemon");
  const env = { HOME: h, USERPROFILE: h, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(h, ".claude-none"), AD_ROOT: adRoot, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const lines = [];
  const ctx = makeContext({
    env, home: h, root: adRoot, viaLauncher: false, platform: "linux",
    resolve: () => null, out: (l) => lines.push(String(l)), ask: async () => "y",
    isTTY: () => tty, claudeVersion: async () => "2.1.319", rulesExist: () => false, confirmReview: async () => false, lockWaitMs: 50,
  });
  const calls = [];
  ctx.consentedImport = () => calls.push(lines.length);
  return { ctx, lines, calls };
}

test("the import step runs once, after setup has written its items", async () => {
  const t = home();
  await install({ ctx: t.ctx, hosts: ["codex"], yes: true });
  assert.equal(t.calls.length, 1, t.lines.join("\n"));
  const lastSetupLine = t.lines.findLastIndex((l) => /^✓ Codex: /.test(l));
  assert.ok(lastSetupLine >= 0 && t.calls[0] > lastSetupLine, "after setup's lines");
  // Again with nothing left for setup: still offered, once.
  t.calls.length = 0;
  await install({ ctx: t.ctx, hosts: ["codex"], yes: true });
  assert.equal(t.calls.length, 1);
});

test("a setup that did nothing (Codex's config can't be read): the import step waits", async () => {
  const t = home();
  fs.writeFileSync(path.join(t.ctx.env.CODEX_HOME, "config.toml"), "this is = not [valid toml\n");
  await install({ ctx: t.ctx, hosts: ["codex"], yes: true });
  assert.equal(t.calls.length, 0, t.lines.join("\n"));
});

test("no terminal: install stops at 'finish in a terminal' and the import step waits too", async () => {
  const t = home({ tty: false });
  assert.equal(await install({ ctx: t.ctx, hosts: ["codex"], yes: true }), 2, t.lines.join("\n"));
  assert.equal(t.calls.length, 0);
  assert.equal(await consentedImport({}, {}), null, "no terminal, no import");
});
