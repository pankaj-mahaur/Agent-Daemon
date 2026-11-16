// L7 part 1d-1: tool.before's latency through the launcher and the guard copy, against
// 02 §3's budgets (150 / 200 / 400 ms on Linux / macOS / Windows), measured as L2 does
// (test/hook-latency.test.mjs): the hook's time minus `node -e 0`'s, spawned alike and
// alternated, against the budget minus node's reference start, scaled up (never down) on
// a slower runner. In the suite: p50, the limit doubled. Strict (the CI "hook budgets"
// step, AD_HOOK_LATENCY=strict): p95 over 41 runs.
//
// Cases: rules the call doesn't match; a 64 KB command a rule stops; a call from an
// `ad sp` worker's git worktree (the main worktree's rules apply).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ad-l7-latency-")));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
for (const k of ["AD_ROOT", "AD_MEMORY_DB", "CLAUDE_PROJECT_DIR", "AD_TOOL_SHELL", "AD_HOOK_HOST"]) delete process.env[k];
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));

const D = await import("../src/memory/launch/dists.mjs");
const { installLauncher, makeContext } = await import("../src/memory-install/install.mjs");
const { build } = await import("../scripts/build-memory-package.mjs");
const { writeGuards, activePath } = await import("../src/hooks/guards.mjs");

const OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const BUDGET_MS = { linux: 150, macos: 200, windows: 400 };
const FLOOR_REF_MS = { linux: 45, macos: 60, windows: 220 };
const STRICT = process.env.AD_HOOK_LATENCY === "strict";
const RUNS = STRICT ? 41 : 11;

const pick = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

function time(args, input, env) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { input, env, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 1 << 26 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return { ms, out: r.stdout };
}

function setup() {
  const out = path.join(TMP, "pkg");
  build({ out });
  const home = path.join(TMP, "home");
  const root = path.join(home, ".agent-daemon");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "AD_WORKER", "AD_HOOK_HOST", "AD_MEMORY_DB", "AD_ROOT", "AD_TOOL_SHELL", "AD_SQLITE_DRIVER"]) delete env[k];
  installLauncher(makeContext({ env: { ...env, AD_ROOT: root }, home, root, packageRoot: path.join(out, "dist"), viaLauncher: true, out: () => {} }));
  // The main worktree and a worker's linked one (`.git` file → gitdir → commondir).
  const main = path.join(home, "work", "app");
  const worker = path.join(home, "work", "app-worker-1");
  const gitdir = path.join(main, ".git", "worktrees", "w1");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(worker, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/w1\n");
  fs.writeFileSync(path.join(main, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(worker, ".git"), `gitdir: ${gitdir}\n`);
  const rules = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: "command", decision: "ask", reason: `rule ${i}`, scope: "project", rule: { type: "command", program: `tool${i}`, subcommands: ["run"], flags: null } }));
  rules.push({ id: 99, kind: "command", decision: "deny", reason: "never force push", scope: "project", rule: { type: "command", program: "git", subcommands: ["push"], flags: ["--force", "-f"] } });
  writeGuards({ projects: { p1: { roots: [main], rules } }, global: { rules: [] }, pausedAll: null, allowOnce: [], ruleCount: rules.length, rules_rev: 1, store_id: "a".repeat(32), cmd: "ad" }, { root });
  fs.writeFileSync(activePath(root), JSON.stringify({ ruleCount: rules.length, store_id: "a".repeat(32) }));
  return { root, env, main, worker };
}

const payload = (command, cwd) => JSON.stringify({ session_id: "s", hook_event_name: "PreToolUse", cwd, tool_name: "Bash", tool_input: { command }, permission_mode: "default" });

test("tool.before through the launcher and the guard copy stays within 02 §3's budget", { timeout: 600_000 }, () => {
  const s = setup();
  const hookArgs = [D.launcherFile(s.root), "hook", "tool.before", "--host", "claude-code"];
  const cases = [
    ["rules, no match", payload("ls -la", s.main), null],
    ["64 KB command a rule stops", payload(`git push --force origin ${"x".repeat(64 * 1024)}`, s.main), "deny"],
    ["a worker's worktree", payload("git push -f origin w1", s.worker), "deny"],
  ];
  const lines = [];
  for (const [label, input, want] of cases) {
    // Correct first: the case decides what it should.
    const first = time(hookArgs, input, s.env);
    const got = first.out.trim() ? JSON.parse(first.out).hookSpecificOutput?.permissionDecision ?? null : null;
    assert.equal(got, want, `${label}: ${first.out.slice(0, 300)}`);
    const h = [];
    const f = [];
    for (let i = 0; i <= RUNS; i++) {
      const a = time(hookArgs, input, s.env).ms;
      const b = time(["-e", "0"], "", s.env).ms;
      if (i) h.push(a), f.push(b);
    }
    const q = STRICT ? 0.95 : 0.5;
    const hook = pick(h, q);
    const floor = pick(f, q);
    const work = hook - floor;
    const scale = Math.max(1, pick(f, 0.5) / FLOOR_REF_MS[OS]) * (STRICT ? 1 : 2);
    const limit = (BUDGET_MS[OS] - FLOOR_REF_MS[OS]) * scale;
    lines.push(`${label}: p${q * 100} ${hook.toFixed(0)} ms, floor ${floor.toFixed(0)} ms, work ${work.toFixed(0)} ms, limit ${limit.toFixed(0)} ms`);
    assert.ok(work <= limit, lines.join("\n"));
  }
  process.stdout.write(`# ${lines.join("\n# ")}\n`);
});
