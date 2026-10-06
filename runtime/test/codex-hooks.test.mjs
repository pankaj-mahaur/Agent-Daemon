// Tests for running Agent Daemon hooks inside Codex (Part 4):
// hooks.json rendering, host adaptation in hooks/io.mjs, harness setup, and
// the detached SessionEnd digest. Payload shapes mirror what codex 0.159.2
// sent in a live probe (SessionStart / UserPromptSubmit / SessionEnd) and
// the documented Bash / apply_patch tool payloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHooksForProfile, psQuote, shQuote, SESSION_END_SCRIPT } from "../src/engine/codex/hooks-config.mjs";
import { normalizeCodexInput, patchPaths, renderDecision } from "../src/hooks/io.mjs";
import { ensureHarnessSetup, installedProfile, MEMORY_SERVER_ID, mergeManagedBlock, renderHarnessBlock } from "../src/harness/setup.mjs";
import { detachedDigestArgs, spawnDetachedDigest } from "../src/hooks/session-end-digest.mjs";
import { digestArgs } from "../src/hooks/codex-session-end.mjs";
import { createEngine } from "../src/engine/index.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));

function runNode(args, stdinObj) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => res({ code, out }));
    child.stdin.end(JSON.stringify(stdinObj));
  });
}

test("hooks.json: Codex events only, Edit|Write matcher, ≥10 s timeouts, --host codex", async () => {
  const { hooks } = await codexHooksForProfile("developer", { node: "C:\\Program Files\\nodejs\\node.exe", cli: "D:\\Program Files\\ad\\cli.mjs" });
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
  const nonEnd = Object.entries(hooks).filter(([e]) => e !== "SessionEnd").flatMap(([, g]) => g).flatMap((g) => g.hooks);
  assert.ok(nonEnd.every((h) => h.command.includes("--host codex") && h.commandWindows.includes("--host codex")));
  assert.ok(nonEnd.every((h) => h.commandWindows.startsWith("& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\Program Files\\ad\\cli.mjs' ")));
  assert.ok(nonEnd.every((h) => h.timeout >= 10), "node + PowerShell cold start needs headroom");
  assert.ok(!JSON.stringify(hooks).includes("skill-use"), "Claude-only hooks are skipped");
  assert.deepEqual(hooks.PostToolUse.map((g) => g.matcher).sort(), ["Bash", "Edit|Write"]);
  assert.equal(hooks.SessionStart[0].hooks[0].additionalContextLimit, 3000);
});

test("SessionEnd uses the dependency-free launcher within Codex's 3 s cap", async () => {
  const { hooks } = await codexHooksForProfile("developer");
  const h = hooks.SessionEnd[0].hooks[0];
  assert.equal(h.timeout, 3);
  assert.ok(h.command.includes(SESSION_END_SCRIPT.replace(/'/g, "'\\''")));
  assert.ok(!h.command.includes("cli.mjs"), "must not load the full CLI");
  const src = readFileSync(SESSION_END_SCRIPT, "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.every((i) => i.startsWith("node:")), `only node builtins, got ${imports}`);
});

test("security profile adds the Bash guard and MCP audit as PreToolUse hooks", async () => {
  const { hooks } = await codexHooksForProfile("security");
  assert.deepEqual(hooks.PreToolUse.map((g) => g.matcher).sort(), ["Bash", "mcp__.*"]);
});

test("shell quoting survives ASCII and typographic quotes in paths", () => {
  assert.equal(psQuote("C:\\O'Brien\\node.exe"), "'C:\\O''Brien\\node.exe'");
  assert.equal(psQuote("C:\\Sam\u2019s\\x"), "'C:\\Sam\u2019\u2019s\\x'");
  assert.equal(psQuote("C:\\$HOME `x"), "'C:\\$HOME `x'", "$ and backtick are literal in single quotes");
  assert.equal(shQuote("/home/o'brien/node"), "'/home/o'\\''brien/node'");
});

test("renderDecision adapts output per host", () => {
  const codex = (kind, v, event) => renderDecision(kind, v, { host: "codex", event });
  assert.deepEqual(codex("approve"), {}, "Codex marks decision:approve as a failed hook");
  assert.deepEqual(codex("block", "no", "PreToolUse"), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
  });
  assert.deepEqual(codex("block", "no", "UserPromptSubmit"), { decision: "block", reason: "no" });
  assert.deepEqual(codex("advise", "ctx", "UserPromptSubmit"), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" } });
  const claude = (kind, v) => renderDecision(kind, v, { host: "claude" });
  assert.deepEqual(claude("approve"), { decision: "approve" });
  assert.deepEqual(claude("advise", "ctx"), { additionalContext: "ctx" });
});

test("apply_patch input is normalized to file paths", () => {
  const cwd = resolve(tmpdir(), "repo");
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.js",
    "@@",
    "-x",
    "+y",
    "*** Add File: b.ts",
    "+new",
    "*** Update File: old.js",
    "*** Move to: moved/new.js",
    "*** Delete File: gone.js",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(patchPaths(patch, cwd), ["src/a.js", "b.ts", "old.js", "moved/new.js", "gone.js"].map((p) => resolve(cwd, p)));
  const n = normalizeCodexInput({ tool_name: "apply_patch", cwd, tool_input: { command: patch } });
  assert.equal(n.tool_input.file_path, resolve(cwd, "src/a.js"));
  assert.equal(n.tool_input.file_paths.length, 5);
  assert.deepEqual(normalizeCodexInput({ tool_name: "Bash", tool_response: "ok\n" }).tool_response, { output: "ok\n" });
});

test("bash-pre under --host codex denies with the PreToolUse shape", async () => {
  const { code, out } = await runNode([CLI, "hook", "bash-pre", "--host", "codex"], {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push --no-verify" },
    session_id: "s",
    cwd: tmpdir(),
  });
  assert.equal(code, 0);
  const d = JSON.parse(out);
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /--no-verify/);
});

test("bash-pre under --host codex allows harmless commands with an empty object", async () => {
  const { out } = await runNode([CLI, "hook", "bash-pre", "--host", "codex"], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(JSON.parse(out), {});
});

test("codex-session-end launcher prints {} and builds the digest command", async () => {
  const { code, out } = await runNode([SESSION_END_SCRIPT], { hook_event_name: "SessionEnd" });
  assert.equal(code, 0);
  assert.equal(out, "{}");
  assert.equal(digestArgs({}), null);
  const args = digestArgs({ transcript_path: "/t/rollout.jsonl", session_id: "s1", cwd: "/w" });
  assert.deepEqual(args.slice(1), ["digest", "--transcript", "/t/rollout.jsonl", "--cwd", "/w", "--session-id", "s1"]);
});

test("session-end-digest --host codex also hands the digest to a detached process", () => {
  const calls = [];
  spawnDetachedDigest({ transcript: "/t/rollout.jsonl", sessionId: "s1", cwd: "/w" }, (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  });
  assert.equal(calls[0].cmd, process.execPath);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(detachedDigestArgs({ transcript: "t", cwd: "c" }).includes("--session-id"), false);
});

test("the managed AGENTS.md block is merged, never clobbering user text", () => {
  const block = renderHarnessBlock();
  assert.match(block, /^<!-- agent-daemon:start -->/);
  assert.match(block, /<!-- agent-daemon:end -->$/);
  assert.match(block, /memory_search/);
  assert.ok(Buffer.byteLength(block) < 16 * 1024, "stay well under Codex's 32 KiB instruction cap");
  const user = "# My notes\nprefer pnpm\n";
  const merged = mergeManagedBlock(user, block);
  assert.ok(merged.startsWith(user.trimEnd()));
  const updated = mergeManagedBlock(merged.replace("prefer pnpm", "prefer bun"), "<!-- agent-daemon:start -->\nNEW\n<!-- agent-daemon:end -->");
  assert.match(updated, /prefer bun/);
  assert.match(updated, /NEW/);
  assert.ok(!updated.includes("memory_search"), "old block replaced");
  assert.equal(mergeManagedBlock("", "B"), "B\n");
});

test("installedProfile follows the Claude Code install and AD_PROFILE", () => {
  const home = mkdtempSync(join(tmpdir(), "ad-prof-"));
  try {
    assert.equal(installedProfile({ env: {}, home }), "developer");
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "ad hook bash-pre" }] }] } }));
    assert.equal(installedProfile({ env: {}, home }), "security");
    assert.equal(installedProfile({ env: { AD_PROFILE: "minimal" }, home }), "minimal");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function withEngine(fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-setup-"));
  const engine = await createEngine({ home: join(root, "home"), command: { cmd: process.execPath, prefix: [FAKE] } });
  try {
    await fn(engine, root);
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("ensureHarnessSetup wires hooks, AGENTS.md, memory MCP and env filters, and trusts only our hooks", async () => {
  await withEngine(async (engine) => {
    const r = await ensureHarnessSetup(engine, { cwd: tmpdir(), roots: [], profile: "developer" });
    assert.equal(r.managed, true);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.hooksWritten, true);
    assert.equal(r.agentsWritten, true);
    assert.equal(r.configWritten, true);
    const hooksFile = join(engine.home, "hooks.json");
    const all = await engine.listHooks([tmpdir()]);
    const ours = all.filter((h) => h.sourcePath === hooksFile);
    assert.ok(ours.length >= 4);
    assert.equal(r.trusted, ours.length);
    assert.ok(ours.every((h) => h.trustStatus === "trusted"));
    assert.equal(all.find((h) => h.sourcePath.includes("repo")).trustStatus, "untrusted", "a repo's hooks are never auto-trusted");

    const cfg = await engine.readConfig();
    assert.equal(cfg.mcp_servers[MEMORY_SERVER_ID].command, process.execPath);
    assert.match(cfg.mcp_servers[MEMORY_SERVER_ID].args[0], /memory-server\.mjs$/);
    assert.equal(cfg.mcp_servers[MEMORY_SERVER_ID].default_tools_approval_mode, "approve", "ad's own memory tools don't ask each time");
    assert.equal(cfg.shell_environment_policy.filters.OPENROUTER_API_KEY, "exclude");

    const again = await ensureHarnessSetup(engine, { cwd: tmpdir(), roots: [], profile: "developer" });
    assert.deepEqual([again.hooksWritten, again.agentsWritten, again.configWritten, again.trusted], [false, false, false, 0], "idempotent");
  });
});

test("a user's own fields on the memory server survive setup", async () => {
  await withEngine(async (engine) => {
    await engine.writeConfig([[`mcp_servers.${MEMORY_SERVER_ID}.enabled`, false], [`mcp_servers.${MEMORY_SERVER_ID}.default_tools_approval_mode`, "prompt"]]);
    await ensureHarnessSetup(engine, { cwd: tmpdir(), roots: [], profile: "developer" });
    assert.equal((await engine.readConfig()).mcp_servers[MEMORY_SERVER_ID].enabled, false);
    assert.equal((await engine.readConfig()).mcp_servers[MEMORY_SERVER_ID].default_tools_approval_mode, "prompt", "a mode the user chose is kept");
  });
});

test("a failing config step still leaves our hooks trusted, and is reported", async () => {
  await withEngine(async (engine) => {
    const flaky = Object.create(engine, { readConfig: { value: async () => { throw new Error("unknown key after upgrade"); } } });
    const r = await ensureHarnessSetup(flaky, { cwd: tmpdir(), roots: [], profile: "developer" });
    assert.ok(r.trusted >= 4);
    assert.ok(r.warnings.some((w) => /config: unknown key after upgrade/.test(w)));
  });
});

test("ensureHarnessSetup leaves a home it did not create alone", async () => {
  await withEngine(async (engine) => {
    rmSync(join(engine.home, ".agent-daemon-managed"));
    const r = await ensureHarnessSetup(engine, { cwd: tmpdir(), roots: [] });
    assert.equal(r.managed, false);
    assert.equal(existsSync(join(engine.home, "hooks.json")), false);
  });
});
