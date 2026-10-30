// Tests for `ad run` (harness/run.mjs) against the fake app-server.
// Property that matters: with nobody at the keyboard, approvals are declined
// and said so on stderr; stdout carries only the agent's text (pipeable).

import { test } from "node:test";
import { projectConfigFolder } from "../src/engine/attribution.mjs";
const DOT = projectConfigFolder; // the engine's per-project folder name
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdRun, describeItem } from "../src/harness/run.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));

function sink() {
  const s = { text: "", write: (chunk) => { s.text += chunk; return true; } };
  return s;
}

async function run(prompt, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "ad-run-home-"));
  const stdout = sink();
  const stderr = sink();
  try {
    const code = await cmdRun(prompt, { home, command: { cmd: process.execPath, prefix: [FAKE] }, stdout, stderr, ...extra });
    return { code, stdout: stdout.text, stderr: stderr.text };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("ad run streams agent text to stdout and declines approvals on stderr", async () => {
  const r = await run("do the thing");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "pong[decline]\n");
  assert.match(r.stderr, /declined command/);
});

test("ad run --json prints one JSON result line", async () => {
  const r = await run("do the thing", { json: true });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "completed");
  assert.equal(out.output, "pong[decline]");
});

test("ad run exits 1 on a failed turn", async () => {
  const r = await run("fail-turn");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[turn failed\]/);
  assert.match(r.stderr, /ad run: The engine reported a problem\.\n  details: model refused\n/);
});

test("ad run with no prompt prints usage", async () => {
  const r = await run("   ");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: ad run/);
});

test("describeItem summarizes tool activity", () => {
  assert.equal(describeItem({ type: "commandExecution", command: "npm test" }), "$ npm test");
  assert.equal(describeItem({ type: "fileChange", changes: [{ path: "a.js" }, { path: "b.js" }] }), "~ a.js, b.js");
  assert.equal(describeItem({ type: "mcpToolCall", server: "memory", tool: "search" }), "⚙ memory.search");
  assert.equal(describeItem({ type: "reasoning" }), null);
});

test("ad run prints a message that arrives whole (no deltas)", async () => {
  const r = await run("edit-file");
  assert.equal(r.stdout, "edit[decline]\n");
});

// P0.2a: in a folder that would load the user's own ~/.codex, ad run keeps
// working during 3.0.x with a note; the override says what loads.
async function inFakeHome(fn) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "ad-run-userhome-"));
  mkdirSync(join(home, DOT, "skills", "mine"), { recursive: true });
  writeFileSync(join(home, DOT, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: x\n---\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("P0.2a: a non-interactive run in a refused folder prints the 3.0.x note and runs", async () => {
  await inFakeHome(async (home) => {
    const r = await run("do the thing", { cwd: home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /From 3\.1 this needs --allow-home-folder/);
    assert.equal(r.stdout, "pong[decline]\n");
  });
});

test("P0.2a: --allow-home-folder runs there with the note that says what loads", async () => {
  await inFakeHome(async (home) => {
    const r = await run("do the thing", { cwd: home, allowHomeFolder: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /Working in your home folder: your own \S+ skills from ~\/\.\w+ load in this session/);
    assert.doesNotMatch(r.stderr, /From 3\.1/);
  });
});

test("P0.2a: a trusted folder under a git home with only home settings gets the 3.0.x grace too (judged with ad's trust)", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const user = mkdtempSync(join(tmpdir(), "ad-run-githome-"));
  mkdirSync(join(user, ".git"), { recursive: true });
  writeFileSync(join(user, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(user, DOT), { recursive: true });
  writeFileSync(join(user, DOT, "config.toml"), 'model = "mine"\n');
  const work = join(user, "work");
  mkdirSync(work, { recursive: true });
  const engineHome = join(user, "engine-home");
  mkdirSync(engineHome, { recursive: true });
  writeFileSync(join(engineHome, "fake-config.json"), JSON.stringify({ projects: { [work]: { trust_level: "trusted" } } }));
  writeFileSync(join(engineHome, ".agent-daemon-managed"), "test\n");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = user;
  process.env.USERPROFILE = user;
  try {
    const r = await run("do the thing", { cwd: work, home: engineHome });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /From 3\.1 this needs --allow-home-folder/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(user, { recursive: true, force: true });
  }
});

test("ad run records a session with its target (P4.1)", async () => {
  const adRoot = mkdtempSync(join(tmpdir(), "ad-run-root-"));
  try {
    const r = await run("apply-edit", { adRoot, json: true });
    assert.equal(r.code, 0, r.stderr);
    const { lastSessionId, summarizeSession } = await import("../src/sessions/show.mjs");
    const id = lastSessionId({ root: adRoot });
    assert.match(id ?? "", /^ses_/);
    const s = summarizeSession(id, { root: adRoot });
    assert.equal(s.origin, "run");
    assert.equal(s.state, "closed");
    assert.equal(s.bindings.length, 1);
    assert.equal(s.bindings[0].endReason, "close", "released after the record closed: not a lost engine");
    assert.ok(s.bindings[0].target?.key, JSON.stringify(s.bindings[0]));
    assert.equal(s.turns.length, 1);
    assert.equal(s.turns[0].trigger, "user");
    assert.ok(s.turns[0].tools.length >= 1, JSON.stringify(s.turns[0]));
  } finally {
    rmSync(adRoot, { recursive: true, force: true });
  }
});

test("ad run with a home a command chose and no ad root records nothing", async () => {
  const adRoot = mkdtempSync(join(tmpdir(), "ad-run-root-"));
  const saved = process.env.AD_ROOT;
  process.env.AD_ROOT = adRoot;
  try {
    const r = await run("do the thing");
    assert.equal(r.code, 0);
    const { lastSessionId } = await import("../src/sessions/show.mjs");
    assert.equal(lastSessionId({ root: adRoot }), null);
  } finally {
    if (saved === undefined) delete process.env.AD_ROOT;
    else process.env.AD_ROOT = saved;
    rmSync(adRoot, { recursive: true, force: true });
  }
});
