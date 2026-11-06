// L2 part 4: what each hook event loads at start-up (02 §3). The rules check
// (tool.before) and the record-only events must never load the memory store
// (SQLite), the project registry, the store lock or the full CLI; the
// dispatcher's own static imports stay at the stdin reader. Traced with
// module.registerHooks in the spawned dispatcher (Node 22.15+).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { HOOK_PATH } from "../src/hooks/routes.mjs";
import { writeGuards } from "../src/hooks/guards.mjs";
import { specifiers } from "../scripts/build-memory-package.mjs";

const canTrace = typeof (await import("node:module")).registerHooks === "function";
const BANNED = ["/cli-full.mjs", "/cli.mjs", "/memory/sqlite.mjs", "/memory/driver.mjs", "/memory/episodic.mjs", "/memory/projects.mjs", "/lock.mjs", "better-sqlite3", "node:sqlite"];

function traced(event, payload, args = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-startup-"));
  try {
    const root = path.join(home, "ad-root");
    const project = path.join(home, "work", "app");
    fs.mkdirSync(project, { recursive: true });
    writeGuards({ projects: { p1: { roots: [project], rules: [{ id: 1, kind: "command", decision: "ask", reason: "r", rule: { type: "command", program: "npm", subcommands: ["install"], flags: null } }] } } }, { root });
    const preload = path.join(home, "trace.mjs");
    fs.writeFileSync(preload, 'import { registerHooks } from "node:module";\nregisterHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); if (r?.url) process.stderr.write("LOADED " + r.url + "\\n"); return r; } });\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, AD_ROOT: root };
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR", "AD_HOOK_HOST"]) delete env[k];
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, HOOK_PATH, event, ...args], { input: JSON.stringify({ cwd: project, session_id: "s", ...payload }), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return { loaded: r.stderr.split("\n").filter((l) => l.startsWith("LOADED ")).map((l) => l.slice(7).trim()), stdout: r.stdout };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const cases = [
  ["tool.before", { tool_name: "Bash", tool_input: { command: "npm install left-pad" }, permission_mode: "default" }, [], "a rule matched"],
  ["tool.before", { tool_name: "Bash", tool_input: { command: "npm install left-pad" }, turn_id: "t" }, ["--host", "ad"], "Codex"],
  ["tool.before", { tool_name: "Write", tool_input: { file_path: "x.txt", content: "y" } }, [], "a write"],
  ["tool.after", { tool_name: "ScheduleWakeup", tool_input: { prompt: "check again" } }, [], "a scheduled prompt recorded"],
  ["subagent.stop", { last_assistant_message: "done" }, [], "a subagent's report recorded"],
  ["session.end", {}, [], "no transcript: nothing to spawn"],
];

for (const [event, payload, args, why] of cases) {
  test(`${event} (${why}) never loads the memory store, the project registry, the lock or the full CLI`, { skip: !canTrace && "needs module.registerHooks (Node 22.15+)" }, () => {
    const { loaded, stdout } = traced(event, payload, args);
    if (event === "tool.before") {
      assert.ok(loaded.some((u) => u.endsWith("/rules/match.mjs")), "the matcher is loaded");
      // The npm rule matches the Bash calls (a decision); no rule covers the write (nothing).
      assert.equal(stdout.length > 0, payload.tool_name === "Bash", "the decision is printed only on a match");
    }
    for (const banned of BANNED) assert.ok(!loaded.some((u) => u.includes(banned)), `${event} loaded ${banned}`);
  });
}

test("the dispatcher's static imports are only the stdin reader; everything else is loaded per event", () => {
  const src = fs.readFileSync(HOOK_PATH, "utf8");
  const statics = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ["../src/hooks/io.mjs"]);
  // The stdin reader's own graph is small and has no store.
  const io = fs.readFileSync(new URL("../src/hooks/io.mjs", import.meta.url), "utf8");
  assert.ok(specifiers(io).every((s) => s.startsWith("node:") || s === "../memory/host-ids.mjs"), "io.mjs imports");
  // host-ids.mjs is constants only: it imports nothing.
  const ids = fs.readFileSync(new URL("../src/memory/host-ids.mjs", import.meta.url), "utf8");
  assert.deepEqual(specifiers(ids), []);
});
