// End-to-end routing loop: advice → invocation → correlation → stats.
// Subprocess pattern (HOME=tmp isolates the episodic DB per test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/memory/sqlite.mjs";
import { writeRouteMap, globalRouteMapPath } from "../src/route-map.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function run(args, payload, home) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", c => stdout += c.toString());
    child.on("close", code => resolve({ code, stdout }));
    child.stdin.end(payload ? JSON.stringify(payload) : "");
  });
}

// Query and CLOSE before asserting — a throwing assert on an open handle
// leaves the tmp DB locked by this process and cleanup retry-spirals.
async function readRouteEvent(home, sessionId) {
  const db = await open({ dbPath: path.join(home, ".agent-daemon", "episodic.db") });
  try {
    return db.get("SELECT * FROM skill_route_events WHERE session_id = ?", [sessionId]);
  } finally {
    db.close();
  }
}

async function withTmp(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ad-route-corr-"));
  const project = path.join(root, "proj");
  await fs.mkdir(project, { recursive: true });
  try {
    await fn(root, project);
  } finally {
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* tmp */ }
  }
}

test("advice → matching invocation correlates as followed; stats report it", async () => {
  await withTmp(async (root, project) => {
    // 1. Route advice fires on a debug prompt (builtin map)
    let r = await run(["hook", "capability-route-advice"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "corr-1",
      cwd: project,
      prompt: "this page is broken, the search crashes with an error"
    }, root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /debug-triage/);

    let row = await readRouteEvent(root, "corr-1");
    assert.equal(row.recommended_capability, "debug-triage");
    assert.equal(row.recommendation_source, "builtin-map");
    assert.match(row.prompt_intent, /^builtin:/);
    assert.equal(row.invoked_skill, null);

    // 2. The recommended skill gets invoked → followed
    r = await run(["hook", "skill-use"], {
      hook_event_name: "PreToolUse",
      session_id: "corr-1",
      cwd: project,
      tool_input: { skill: "debug-triage", prompt: "debugging" }
    }, root);
    assert.equal(r.code, 0);

    row = await readRouteEvent(root, "corr-1");
    assert.equal(row.invoked_skill, "debug-triage");
    assert.ok(row.invoked_at, "invoked_at stamped");

    // 3. Stats reflect followed=1
    r = await run(["route", "stats", "--json"], null, root);
    assert.equal(r.code, 0);
    const stats = JSON.parse(r.stdout);
    const dt = stats.rows.find(x => x.skill === "debug-triage");
    assert.equal(dt.advised, 1);
    assert.equal(dt.followed, 1);
    assert.equal(dt.ignored, 0);
  });
});

test("divergent invocation marks the advice as diverged", async () => {
  await withTmp(async (root, project) => {
    await run(["hook", "capability-route-advice"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "corr-2",
      cwd: project,
      prompt: "review this audit of the page properly and deeply"
    }, root);

    await run(["hook", "skill-use"], {
      hook_event_name: "PreToolUse",
      session_id: "corr-2",
      cwd: project,
      tool_input: { skill: "implement-feature", prompt: "doing something else" }
    }, root);

    const row = await readRouteEvent(root, "corr-2");
    assert.equal(row.recommended_capability, "review-slice");
    assert.equal(row.invoked_skill, "implement-feature", "divergence recorded");
  });
});

test("compiled route map: a fake installed skill gets recommended by its trigger phrase", async () => {
  await withTmp(async (root, project) => {
    await writeRouteMap([
      { skill: "fake-routed-skill", triggers: ["resize the hologram"], tier: "substantial", note: "fake skill for routing test", lane: "global" }
    ], globalRouteMapPath(root));

    const r = await run(["hook", "capability-route-advice"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "corr-3",
      cwd: project,
      prompt: "please resize the hologram on the landing page so it fits"
    }, root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /fake-routed-skill/);

    const row = await readRouteEvent(root, "corr-3");
    assert.equal(row.recommended_capability, "fake-routed-skill");
    assert.equal(row.recommendation_source, "compiled-map");
    assert.equal(row.prompt_intent, "resize the hologram");
  });
});

test("explicit constraint suppresses advice; corrupt route map fails safe", async () => {
  await withTmp(async (root, project) => {
    // Constraint
    let r = await run(["hook", "capability-route-advice"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "corr-4",
      cwd: project,
      prompt: "fix this broken bug but do not use skills"
    }, root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "{}");

    const row = await readRouteEvent(root, "corr-4");
    assert.equal(row.explicit_capability_constraint, 1);

    // Corrupt map → builtin routing still works, valid JSON out
    await fs.mkdir(path.dirname(globalRouteMapPath(root)), { recursive: true });
    await fs.writeFile(globalRouteMapPath(root), "][ corrupt", "utf8");
    r = await run(["hook", "capability-route-advice"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "corr-5",
      cwd: project,
      prompt: "the dashboard is broken and throws an error on load"
    }, root);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.match(parsed.additionalContext, /debug-triage/);
  });
});
