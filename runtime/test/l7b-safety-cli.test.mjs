// L7b parts 3–4: `safety on|off|status`, its refusals, the copy, and doctor's coexistence lines.
//   - on and off are refused from the agent's shell (AD_TOOL_SHELL=1), with no terminal, and
//     nothing an MCP tool or a hook runs reaches the policy's writers (import graphs);
//   - off needs the typed code; on needs a guard copy that knows the policy (review H1);
//   - status says on/off per family, and when the store and the rules file disagree;
//   - the copy asks before, never "protects you from" (the claims lint's guard rule);
//   - dcg and claude-code-safety-net are found in host config, with the families both check.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7b-cli-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "AD_MEMORY_PROJECT", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[k];

const { open } = await import("../src/memory/sqlite.mjs");
const policy = await import("../src/memory/starter-policy.mjs");
const { safetyMain, guardNotReady } = await import("../src/memory/safety-cli.mjs");
const { findOtherGuards, coexistLines, guardOfCommand } = await import("../src/memory/policy-coexist.mjs");
const { checkClaims } = await import("../scripts/check-claims.mjs");
const { testReviewToken } = await import("../testkit/memory-trust.mjs");

const RUNTIME = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(RUNTIME, "src", "memory-install", "cli.mjs");
const opened = [];
after(async () => {
  for (const h of opened) {
    try {
      h.close();
    } catch {
      // closed already
    }
  }
  (await import("../src/memory/episodic.mjs")).closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let n = 0;
async function store() {
  const dir = path.join(ROOT, `s-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const h = await open({ dbPath: path.join(dir, "episodic.db") });
  opened.push(h);
  return { h, root: path.join(dir, "ad") };
}

/** safetyMain in "the user's own terminal", with what it would ask injected. */
async function run(argv, { h, root }, extra = {}) {
  const lines = [];
  const code = await safetyMain(argv, { out: (l) => lines.push(l), env: {}, isTTY: () => true, handle: h, root, token: async () => ({ token: testReviewToken() }), command: (v) => `ad ${v}`, version: null, others: async () => [], ...extra });
  return { code, text: lines.join("\n") };
}

function spawnCli(args, env) {
  const e = { ...process.env, ...env };
  for (const k of ["AD_ROOT", "AD_MEMORY_DB", "CLAUDE_PROJECT_DIR"]) delete e[k];
  return spawnSync(process.execPath, [CLI, ...args], { env: e, encoding: "utf8", timeout: 60_000 });
}

test("spawned: on and off are refused from the agent's shell and without a terminal; nothing changes; no command is named", () => {
  const home = fs.mkdtempSync(path.join(ROOT, "h-"));
  for (const env of [{ HOME: home, USERPROFILE: home, AD_TOOL_SHELL: "1" }, { HOME: home, USERPROFILE: home }]) {
    for (const sub of ["on", "off"]) {
      const r = spawnCli(["safety", sub], env);
      assert.equal(r.status, 1, `${sub} ${JSON.stringify(env)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /by the user, in their own terminal\. Nothing changed/);
      assert.doesNotMatch(r.stdout, /safety (?:on|off)`|npx|rules /, "S4: no command from the agent's shell");
    }
  }
  const st = spawnCli(["safety", "status"], { HOME: home, USERPROFILE: home, AD_TOOL_SHELL: "1" });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /starter safety policy: off/);
  assert.doesNotMatch(st.stdout, /safety off|safety on`/, "status from the agent's shell names no command");
  // Nothing was written: a fresh status still says off.
  assert.match(spawnCli(["safety", "status"], { HOME: home, USERPROFILE: home, AD_TOOL_SHELL: "1" }).stdout, /policy: off/);
});

test("the package's usage never lists the lowering verb", () => {
  const r = spawnCli(["--help"], { HOME: ROOT, USERPROFILE: ROOT, AD_TOOL_SHELL: "1" });
  assert.match(r.stdout, /safety \[on\|status\]/);
  assert.doesNotMatch(r.stdout, /safety off|safety \[[^\]]*\boff\b/);
});

test("on needs the token; off needs the token and the typed code", async () => {
  const s = await store();
  const refused = await run(["on"], s, { token: async () => ({ refused: "no terminal" }) });
  assert.equal(refused.code, 1);
  assert.equal(policy.policyState(s.h).state, "off");
  const on = await run(["on"], s);
  assert.equal(on.code, 0, on.text);
  assert.match(on.text, /policy: on \(4 rules added\)/);
  assert.match(on.text, /Turn it off: `ad safety off`/);
  assert.doesNotMatch(on.text, /protects? you/i);
  assert.equal(policy.policyState(s.h).state, "on");
  const wrong = await run(["off"], s, { code: () => "kqtw", tty: { ask: async () => "kqtx" } });
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /code didn't match/);
  assert.equal(policy.policyState(s.h).state, "on");
  const noTok = await run(["off"], s, { token: async () => ({ refused: "agent" }), code: () => "kqtw", tty: { ask: async () => "kqtw" } });
  assert.equal(noTok.code, 1);
  assert.equal(policy.policyState(s.h).state, "on");
  // The code is read from the terminal, never from stdin's answer (L7 D16).
  const stdin = await run(["off"], s, { code: () => "kqtw", ask: async () => "kqtw", tty: null });
  assert.equal(stdin.code, 1);
  assert.match(stdin.text, /code typed in your terminal/);
  assert.equal(policy.policyState(s.h).state, "on");
  let prompt = "";
  const off = await run(["off"], s, { code: () => "kqtw", tty: { ask: async (q) => ((prompt = q), "KQTW") } });
  assert.equal(off.code, 0, off.text);
  assert.match(prompt, /Turn off the starter safety policy \(4 rules\) — type kqtw/);
  assert.equal(policy.policyState(s.h).state, "off");
});

test("on refuses while the launcher's guard copy can't know the policy (missing, or older)", async () => {
  const s = await store();
  const launch = path.join(s.root, "memory", "launch");
  fs.mkdirSync(launch, { recursive: true });
  fs.writeFileSync(path.join(launch, "run.mjs"), "// launcher\n");
  assert.match(await guardNotReady(s.root), /no guard copy/);
  const r = await run(["on"], s);
  assert.equal(r.code, 1);
  assert.match(r.text, /Update it first: `ad repair`/);
  assert.equal(policy.policyState(s.h).state, "off");
  // A clone-route record whose tree has no policy matcher: older than the policy.
  const old = path.join(ROOT, `old-${++n}`);
  fs.mkdirSync(path.join(old, "src", "rules"), { recursive: true });
  fs.writeFileSync(path.join(launch, "guard.json"), JSON.stringify({ version: 1, route: "clone", path: old, distVersion: "3.0.0" }));
  assert.match(await guardNotReady(s.root), /older than the starter safety policy/);
  fs.writeFileSync(path.join(old, "src", "rules", "policy.mjs"), "export {};\n");
  assert.match(await guardNotReady(s.root, { version: "3.1.0" }), /older than this package/);
  assert.equal(await guardNotReady(s.root, { version: "3.0.0" }), null);
  // No launcher at all: the hook runs from this install.
  const bare = await store();
  assert.equal(await guardNotReady(bare.root), null);
});

test("status: per family, paused, and the store against the rules file", async () => {
  const s = await store();
  const t = testReviewToken();
  await policy.setPolicy(s.h, t, true, { root: s.root });
  const st = await run(["status"], s);
  assert.match(st.text, /policy: on/);
  assert.match(st.text, /rule \d+ +asks before reading a \.env file/);
  assert.match(st.text, /Turn it off: `ad safety off`/);
  // The store says off, the rules file still has them (a rebuild that failed).
  policy.policyOff(s.h, t);
  const mid = await run(["status"], s);
  assert.match(mid.text, /policy: off/);
  assert.match(mid.text, /off in your store, but the rules file still asks until it is rebuilt \(`ad review`\)/);
  const lines = [];
  await safetyMain(["status"], { out: (l) => lines.push(l), env: { AD_TOOL_SHELL: "1" }, isTTY: () => false, handle: s.h, root: s.root, others: async () => [] });
  assert.doesNotMatch(lines.join("\n"), /`/, "from the agent's shell: no command");
});

test("nothing an MCP tool or a hook runs can reach the policy's writers (import graphs)", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import\s*(?:[\w*{}\s,]+from\s*)?|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(RUNTIME, "bin", "hook.mjs"));
  walk(path.join(RUNTIME, "src", "mcp", "memory-server.mjs"));
  assert.ok(seen.size > 10, "the graphs were walked");
  const reached = [...seen].map((f) => path.relative(RUNTIME, f).replace(/\\/g, "/"));
  for (const writer of ["src/memory/starter-policy.mjs", "src/memory/safety-cli.mjs"]) assert.ok(!reached.includes(writer), `${writer} is reachable from a hook or the MCP server`);
});

test("claims lint: a guard sold as protection is a finding; 'asks before' isn't", () => {
  assert.deepEqual(checkClaims("The starter safety policy asks before four kinds of catastrophic commands.").map((f) => f.rule), []);
  for (const bad of ["It protects you from rm -rf ~.", "The policy keeps you safe.", "This prevents any destructive command.", "Rules protect you against mistakes."]) assert.deepEqual(checkClaims(bad).map((f) => f.rule), ["guard"], bad);
});

test("coexistence: dcg and claude-code-safety-net found in host config, with what both check", () => {
  const home = fs.mkdtempSync(path.join(ROOT, "co-"));
  const cwd = path.join(home, "proj");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  assert.deepEqual(findOtherGuards({ home, cwd, env: {} }), [], "none");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|PowerShell|Monitor", hooks: [{ type: "command", command: path.join(home, ".local", "bin", "dcg") }] }] } }));
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "cc-safety-net@cc-marketplace": true, "other@x": true } }));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "cc-safety-net hook --codex" }] }] } }));
  const found = findOtherGuards({ home, cwd, env: {} });
  assert.deepEqual(found.map((g) => `${g.tool}:${g.host}`).sort(), ["cc-safety-net:claude-code", "cc-safety-net:codex", "dcg:claude-code"]);
  const lines = coexistLines({ home, cwd, env: {} });
  assert.ok(lines.some((l) => /^dcg .* both check recursive deletes of home, a root or the project, force pushes\. You can keep one\.$/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /claude-code-safety-net .*\.env reads/.test(l)));
  for (const l of lines) assert.doesNotMatch(l, /protect/i);
  // Look-alikes aren't these tools; a disabled plugin isn't running.
  for (const c of ["node /x/dcgx.js", "echo dcg", "/usr/bin/abcdcg"]) assert.equal(guardOfCommand(c), null, c);
  assert.equal(guardOfCommand('"C:\\tools\\dcg.exe"'), "dcg");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "cc-safety-net@cc-marketplace": false } }));
  assert.ok(!findOtherGuards({ home, cwd, env: {} }).some((g) => g.host === "claude-code" && g.tool === "cc-safety-net"));
});
