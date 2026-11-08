// L2 part 4: hook latency budgets (02 §3). Each hook is spawned as the host
// spawns it and timed against `node -e 0` spawned the same way, alternating,
// so both see the same machine load; the check is on p50s.
//
//   budget (ms)                    Linux  macOS  Windows
//   tool.before                     150    200    400
//   session.start, prompt.submit    250    350    900
//
// A budget is node's start (the reference floor below) plus the hook's own
// work. What is checked is that work: the hook's p50 minus the floor's p50,
// against budget − reference floor, scaled up by measured floor / reference
// floor on a slower runner (never down: a hook's fixed costs, SQLite and git,
// don't shrink with a fast node start). Codex on Windows runs every hook
// through `pwsh -NoProfile -Command`, which alone costs over a second (S-PERF),
// so there the floor is `pwsh -NoProfile -Command "& node -e 0"`, and the same
// allowance applies to the hook's work on top of it.
//
// Strict (the CI "hook budgets" step, run serially): AD_HOOK_LATENCY=strict.
// Inside the parallel suite the limit is doubled: other test files load the
// machine in bursts the alternation can't fully cancel.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOOK_PATH } from "../src/hooks/routes.mjs";
import { writeGuards } from "../src/hooks/guards.mjs";
import { open } from "../src/memory/sqlite.mjs";

const OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const BUDGET_MS = {
  "tool.before": { linux: 150, macos: 200, windows: 400 },
  "session.start": { linux: 250, macos: 350, windows: 900 },
  "prompt.submit": { linux: 250, macos: 350, windows: 900 },
};
// `node -e 0` p50 on the machines the budgets were set for (S-PERF: Windows 188–252 ms).
const FLOOR_REF_MS = { linux: 45, macos: 60, windows: 220 };
const STRICT = process.env.AD_HOOK_LATENCY === "strict";
const RUNS = STRICT ? 21 : 11;

const p50 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function time(cmd, args, input, env) {
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { input, env, encoding: "utf8", timeout: 60_000, windowsHide: true });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return ms;
}

/** Alternate the hook and the floor RUNS times; the first pair warms the file cache and is dropped. */
function measure(hook, floor) {
  const h = [];
  const f = [];
  for (let i = 0; i <= RUNS; i++) {
    const a = time(...hook);
    const b = time(...floor);
    if (i) h.push(a), f.push(b);
  }
  return { hook: p50(h), floor: p50(f) };
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-latency-"));
  const root = path.join(home, "ad-root");
  const project = path.join(home, "work", "app");
  fs.mkdirSync(path.join(project, ".agent-daemon", "memory"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agent-daemon", "memory", "activeContext.md"), "# Active context\n\n- uses pnpm\n");
  // A git repository, as real projects are: session.start asks git for the working set.
  spawnSync("git", ["init", "-q"], { cwd: project, windowsHide: true });
  fs.writeFileSync(path.join(project, "index.js"), "export {};\n");
  // Rules the matcher has to read through: the call matches none (the common case).
  const rules = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: "command", decision: "ask", reason: `rule ${i}`, rule: { type: "command", program: `tool${i}`, subcommands: ["run"], flags: null } }));
  writeGuards({ projects: { p1: { roots: [project], rules } } }, { root });
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "AD_WORKER", "AD_HOOK_HOST", "AD_MEMORY_DB"]) delete env[k];
  return { home, root, project, env };
}

// L5 P3: prompt.submit also with a correction (the capture library writes to the store)
// and with a large paste (the screen and the extractor run over 60 KB).
const PASTE = `here is the log, look at it:\n${Array.from({ length: 900 }, (_, i) => `2026-11-08T10:${String(i % 60).padStart(2, "0")}:00Z worker-${i % 7} processed batch ${i} in ${(i * 37) % 997} ms (queue ${i % 13})`).join("\n")}\nwhy is batch 512 slow?`;
const payloads = (project) => [
  ["", "tool.before", { session_id: "s", cwd: project, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status --short" }, permission_mode: "default" }],
  ["", "prompt.submit", { session_id: "s", cwd: project, hook_event_name: "UserPromptSubmit", prompt: "can you look at why the build output is missing the css files" }],
  [" (correction)", "prompt.submit", { session_id: "s", cwd: project, hook_event_name: "UserPromptSubmit", prompt: "no, actually we use pnpm in this repo, never npm" }],
  [" (large paste)", "prompt.submit", { session_id: "s", cwd: project, hook_event_name: "UserPromptSubmit", prompt: PASTE }],
  ["", "session.start", { session_id: "s", cwd: project, hook_event_name: "SessionStart", source: "startup" }],
];

/**
 * The hook's own work (p50 over its floor) within its allowance.
 * @param {number} nodeFloor  `node -e 0` p50 on this runner, which scales the allowance
 */
function check(event, { hook, floor }, nodeFloor, label) {
  const scale = Math.max(1, nodeFloor / FLOOR_REF_MS[OS]) * (STRICT ? 1 : 2);
  const allowed = (BUDGET_MS[event][OS] - FLOOR_REF_MS[OS]) * scale;
  const work = hook - floor;
  const line = `${label} ${event}: p50 ${hook.toFixed(0)} ms, floor ${floor.toFixed(0)} ms, work ${work.toFixed(0)} ms (allowed ${allowed.toFixed(0)} ms: node floor ${nodeFloor.toFixed(0)} ms, ${STRICT ? "strict" : "in-suite"})`;
  return { ok: work <= allowed, line };
}

test("hook latency (Claude Code, exec form): p50 within the budget's ratio to node -e 0", { timeout: 600_000 }, async (t) => {
  const fx = fixture();
  try {
    // A store at this ad's version, as after any session: the hooks open it.
    (await open({ dbPath: path.join(fx.root, "episodic.db"), noMigrate: false }))?.close();
    const floor = [process.execPath, ["-e", "0"], "", fx.env];
    const failed = [];
    for (const [label, event, payload] of payloads(fx.project)) {
      const m = measure([process.execPath, [HOOK_PATH, event], JSON.stringify(payload), fx.env], floor);
      const res = check(event, m, m.floor, `claude${label}`);
      t.diagnostic(res.line);
      if (!res.ok) failed.push(res.line);
    }
    assert.deepEqual(failed, []);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("hook latency through the stable launcher (L3): the same budgets, the extra module load included", { timeout: 600_000 }, async (t) => {
  const fx = fixture();
  try {
    (await open({ dbPath: path.join(fx.root, "episodic.db"), noMigrate: false }))?.close();
    // The launcher folder as install writes it, with this checkout registered as the clone dist.
    const { installLauncher, makeContext } = await import("../src/memory-install/install.mjs");
    const runtime = path.resolve(path.dirname(HOOK_PATH), "..");
    installLauncher(makeContext({ env: fx.env, home: fx.home, root: fx.root, packageRoot: runtime, viaLauncher: false, out: () => {} }));
    const launcher = path.join(fx.root, "memory", "launch", "run.mjs");
    const floor = [process.execPath, ["-e", "0"], "", fx.env];
    const failed = [];
    for (const [label, event, payload] of payloads(fx.project)) {
      const m = measure([process.execPath, [launcher, "hook", event, "--host", "claude-code"], JSON.stringify(payload), fx.env], floor);
      const res = check(event, m, m.floor, `launcher${label}`);
      t.diagnostic(res.line);
      if (!res.ok) failed.push(res.line);
    }
    assert.deepEqual(failed, []);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const hasPwsh = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0;

test("hook latency (Codex on Windows, through pwsh): p50 within the budget's ratio to pwsh running node -e 0", { skip: !hasPwsh && "Windows with pwsh only", timeout: 900_000 }, async (t) => {
  const fx = fixture();
  try {
    (await open({ dbPath: path.join(fx.root, "episodic.db"), noMigrate: false }))?.close();
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const floor = ["pwsh", ["-NoProfile", "-Command", `& ${q(process.execPath)} -e 0`], "", fx.env];
    const node = [process.execPath, ["-e", "0"], "", fx.env];
    const nodeFloor = measure(node, node).floor;
    const failed = [];
    for (const [label, event, payload] of payloads(fx.project)) {
      const hook = ["pwsh", ["-NoProfile", "-Command", `& ${q(process.execPath)} ${q(HOOK_PATH)} ${event} --host ad`], JSON.stringify({ ...payload, turn_id: "t" }), fx.env];
      const res = check(event, measure(hook, floor), nodeFloor, `codex${label}`);
      t.diagnostic(res.line);
      if (!res.ok) failed.push(res.line);
    }
    assert.deepEqual(failed, []);
  } finally {
    fs.rmSync(fx.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
