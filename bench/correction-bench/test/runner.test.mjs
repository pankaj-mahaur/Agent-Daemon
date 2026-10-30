// The episode flow with a fake driver (no engine, no model), the Claude Code
// driver against a fake `claude`, and the runner's isolation and path scrubbing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BENCH_DIR, loadSplit } from "../lib/family.mjs";
import { writeFiles } from "../lib/fixture.mjs";
import { runEpisode } from "../runner/episode.mjs";
import { episodeEnv } from "../runner/run.mjs";
import { scrubPaths } from "../lib/scrub.mjs";
import { analyze } from "../lib/analysis.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const logger = loadSplit("dev").find((s) => s.family.id === "logger");
let n = 0;

// A fake host: writes the violating example unless its "memory" (the rules file
// or a remembered correction) mentions logInfo; records what it was asked.
function fakeDriver({ remembers = false, failTurn = null, hooks = true } = {}) {
  const seen = { turns: [], rules: [], closed: 0, memory: "" };
  return {
    seen,
    name: "fake",
    rulesFile: "AGENTS.md",
    settings: () => ({}),
    async prepare({ condition }) {
      return { adHooks: condition.adHooks };
    },
    async open(ctx, { cwd }) {
      const rulesPath = path.join(cwd, "AGENTS.md");
      seen.rules.push(fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf8") : null);
      return {
        async turn(text) {
          seen.turns.push(text);
          if (failTurn && failTurn(seen.turns.length)) return { status: "crash", error: "fake crash" };
          if (text.startsWith("In src/") || text.startsWith("Add ")) {
            const knows = /logInfo/.test(seen.rules.at(-1) ?? "") || (remembers && /logInfo/.test(seen.memory));
            writeFiles(cwd, knows ? logger.family.examples.compliant : logger.family.examples.violating);
          } else seen.memory += text;
          return { status: "ok", error: null };
        },
        async close() {
          seen.closed++;
        },
      };
    },
    sessionCount: async () => 0,
    // ad's hooks run only where the condition installed them (and `hooks` says they work).
    hookEvidence: async (ctx) => ({ promptHook: hooks && ctx.adHooks, sessionEnd: hooks && ctx.adHooks }),
    captured: async (ctx, { text }) => ({ captured: remembers, stored: remembers ? [text] : [] }),
  };
}

async function episode(condition, driver, { sessions = 3 } = {}) {
  const root = path.join(TMP, `ep${++n}`);
  fs.mkdirSync(root, { recursive: true });
  const out = path.join(root, "episodes.jsonl");
  const phrasing = { id: "p1", text: "Actually we use logInfo for logging, not console output.", writer: "author" };
  await runEpisode({ runId: "t", driver: "fake", episode: { familyId: "logger", familyDir: logger.dir, condition, model: "m", seed: 1, phrasing }, root, configToml: "", sessions, out }, { driver });
  return fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("an episode: session 1 teaches, later sessions are scored before any correction, every session ends", async () => {
  const d = fakeDriver();
  const rs = await episode("off", d);
  assert.deepEqual(rs.map((r) => [r.session, r.status, r.opportunity, r.violated, r.corrected]), [[1, "ok", true, true, true], [2, "ok", true, true, true], [3, "ok", true, true, true]]);
  // task, correction per session; the scored oracle ran before the correction turn
  assert.equal(d.seen.turns.length, 6);
  assert.equal(d.seen.closed, 3);
  assert.ok(rs.every((r) => r.family === "logger" && r.condition === "off" && r.phrasing === "p1"));
});

test("static-rules: the correction is in the rules file of every later session, and it works", async () => {
  const d = fakeDriver();
  const rs = await episode("static-rules", d);
  assert.equal(d.seen.rules[0], null, "session 1 has no rules file");
  assert.match(d.seen.rules[1], /^# Project notes\n\n- Actually we use logInfo for logging, not console output\.\n$/);
  assert.deepEqual(rs.map((r) => r.violated), [true, false, false]);
});

test("on-hooks: capture is recorded for session 1; a session whose hooks didn't run is excluded, not scored", async () => {
  const good = await episode("on-hooks", fakeDriver({ remembers: true }));
  assert.equal(good[0].captured, true);
  assert.deepEqual(good.slice(1).map((r) => [r.status, r.violated]), [["ok", false], ["ok", false]]);
  const missing = await episode("on-hooks", fakeDriver({ remembers: true, hooks: false }));
  assert.ok(missing.every((r) => r.status === "hooks-missing"));
  const [g] = analyze(missing, { resamples: 100 });
  assert.equal(g.conditions["on-hooks"].opportunities, 0);
  assert.equal(g.conditions["on-hooks"].excluded, 2);
});

test("a crashed turn is recorded as a crash and the episode goes on", async () => {
  const rs = await episode("off", fakeDriver({ failTurn: (i) => i === 3 }));
  assert.deepEqual(rs.map((r) => r.status), ["ok", "crash", "ok"]);
  assert.equal(rs[1].error, "fake crash");
});

test("one family is too few for a p-value", async () => {
  const rs = [...(await episode("off", fakeDriver())), ...(await episode("on-hooks", fakeDriver({ remembers: true })))];
  const [g] = analyze(rs, { resamples: 100 });
  const h1 = g.hypotheses.find((h) => h.id === "H1");
  assert.equal(h1.p, null);
  assert.match(h1.comparisons[0].reason, /at least 5/);
});

test("the episode's environment: its own home, nothing of the user's engine or Claude settings", () => {
  const env = episodeEnv(path.join(TMP, "root"), { PATH: "x", HOME: "/real", AD_CODEX_HOME: "/real/.x", CODEX_HOME: "/real/.x", CLAUDE_CONFIG_DIR: "/real/.claude", AD_TOOL_SHELL: "1", AD_PROFILE: "security" });
  assert.equal(env.HOME, path.join(TMP, "root", "home"));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.AD_ROOT, path.join(env.HOME, ".agent-daemon"));
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(env.HOME, ".claude"));
  for (const k of ["AD_CODEX_HOME", "CODEX_HOME", "AD_TOOL_SHELL", "AD_PROFILE"]) assert.equal(env[k], undefined, k);
  assert.equal(env.PATH, "x");
});

test("errors in results carry no machine paths", () => {
  const root = path.join(os.tmpdir(), "correction-bench-x", "ep3");
  const s = scrubPaths(`ENOENT ${root}${path.sep}work and ${os.homedir()}${path.sep}.ssh and ${root.replace(/\\/g, "/")}/x`, [root]);
  assert.ok(!s.includes(os.homedir()) && !s.includes(os.tmpdir()), s);
  assert.match(s, /<episode>/);
});

test("the Claude Code driver: temp settings with ad's hooks, a strict MCP list, --resume for the follow-up", async () => {
  const drv = await import("../runner/driver-claude.mjs");
  const root = path.join(TMP, "claude-ep");
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const log = path.join(root, "argv.jsonl");
  const fake = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "result", is_error: false, session_id: "sess-1", result: "ok" }) + "\\n");\n`);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "elsewhere");
    await assert.rejects(drv.prepare({ root, condition: { adHooks: true, adTools: true, hostMemory: false } }), /inside the episode/);
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "home", ".claude");
    const ctx = await drv.prepare({ root, condition: { adHooks: true, adTools: true, hostMemory: false }, hostCommand: [process.execPath, fake] });
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    assert.equal(settings[drv.AUTO_MEMORY_SETTING], false);
    for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) assert.ok(settings.hooks[ev]?.length, ev);
    assert.match(settings.hooks.UserPromptSubmit.map((h) => h.hooks[0].command).join("\n"), /cli\.mjs" hook user-prompt-extract/);
    assert.ok(JSON.parse(fs.readFileSync(ctx.mcpFile, "utf8")).mcpServers["agent-daemon-memory"]);
    const s = await drv.open(ctx, { cwd, model: "m-1" });
    assert.equal((await s.turn("task one")).status, "ok");
    assert.equal((await s.turn("the correction")).status, "ok");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls[0].slice(0, 2), ["-p", "task one"]);
    assert.ok(calls[0].includes("--strict-mcp-config") && calls[0].includes("acceptEdits") && !calls[0].includes("--resume"));
    assert.deepEqual(calls[1].slice(calls[1].indexOf("--resume"), calls[1].indexOf("--resume") + 2), ["--resume", "sess-1"]);
    // off: no hooks, no servers
    const off = await drv.prepare({ root, condition: { adHooks: false, adTools: false, hostMemory: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).hooks, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(off.mcpFile, "utf8")).mcpServers, {});
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("a killed episode: its partial line is skipped and its missing sessions are filled in", async () => {
  const { fillMissing, readRecords } = await import("../runner/run.mjs");
  const file = path.join(TMP, "partial.jsonl");
  const e = { familyId: "logger", condition: "off", model: "m", seed: 1, phrasing: { id: "p1" } };
  fs.writeFileSync(file, JSON.stringify({ run: "r", family: "logger", condition: "off", model: "m", seed: 1, session: 1, status: "ok" }) + "\n" + '{"run":"r","family":"logg');
  assert.equal(readRecords(file).length, 1);
  assert.equal(fillMissing(file, { runId: "r", driver: "ad", episode: e, total: 3, timedOut: true, error: "x" }), 2);
  const rs = readRecords(file);
  assert.deepEqual(rs.map((r) => [r.session, r.status]), [[1, "ok"], [2, "timeout"], [3, "timeout"]]);
  assert.equal(fillMissing(file, { runId: "r", driver: "ad", episode: e, total: 3, timedOut: false }), 0);
});

test("--split test refuses archives that differ from the fixed hashes, or no hashes at all", async () => {
  const { checkTestSplit } = await import("../runner/run.mjs");
  const { writeHashFile } = await import("../lib/archive.mjs");
  const bench = path.join(TMP, "bench-copy");
  const tasks = path.join(TMP, "test-tasks");
  const phr = path.join(TMP, "test-phrasings");
  for (const d of [path.join(bench, "tasks"), path.join(bench, "phrasings"), path.join(bench, "repos", "app"), tasks, phr]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(tasks, "a.json"), "{}");
  fs.writeFileSync(path.join(phr, "a.json"), "{}");
  fs.writeFileSync(path.join(bench, "repos", "app", "x.js"), "x");
  assert.throws(() => checkTestSplit({ tasks, phrasings: phr, benchDir: bench }), /is missing/);
  writeHashFile(tasks, path.join(bench, "tasks", "test.sha256"));
  writeHashFile(phr, path.join(bench, "phrasings", "test.sha256"));
  writeHashFile(path.join(bench, "repos"), path.join(bench, "repos.sha256"));
  checkTestSplit({ tasks, phrasings: phr, benchDir: bench });
  fs.writeFileSync(path.join(bench, "repos", "app", "x.js"), "y");
  assert.throws(() => checkTestSplit({ tasks, phrasings: phr, benchDir: bench }), /repos.*changed after/);
  assert.throws(() => checkTestSplit({ tasks, benchDir: bench }), /--tasks and --phrasings/);
});

test("an inherited GIT_DIR never sends the fixture's commit to another repository", async () => {
  const { resetFixture } = await import("../lib/fixture.mjs");
  const { spawnSync } = await import("node:child_process");
  const victim = path.join(TMP, "victim");
  fs.mkdirSync(victim, { recursive: true });
  const g = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  g(["init", "-q"], victim);
  g(["commit", "-q", "--allow-empty", "-m", "mine"], victim);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = path.join(victim, ".git");
    process.env.GIT_WORK_TREE = victim;
    resetFixture(path.join(BENCH_DIR, "repos", "shop-app"), path.join(TMP, "gitdir-fixture"));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  assert.equal(g(["rev-list", "--count", "HEAD"], victim).stdout.trim(), "1", "the victim repository gained no commit");
  assert.ok(fs.existsSync(path.join(TMP, "gitdir-fixture", ".git")));
  assert.equal(episodeEnv(TMP, { GIT_DIR: "/x", git_work_tree: "/y", PATH: "p" }).GIT_DIR, undefined);
});

test("a condition that isn't what it says is excluded: ad's hooks in off, host memory where it's off", async () => {
  const leaky = { ...fakeDriver(), hookEvidence: async () => ({ promptHook: true, sessionEnd: true }) };
  const rs = await episode("off", leaky);
  assert.ok(rs.every((r) => r.status === "condition-broken"), JSON.stringify(rs));
  const mem = { ...fakeDriver(), hostMemoryEvidence: async () => ({ present: true }) };
  const rs2 = await episode("off", mem);
  assert.ok(rs2.every((r) => r.status === "condition-broken" && r.hostMemory === true));
  const rs3 = await episode("native", { ...fakeDriver(), hostMemoryEvidence: async () => ({ present: true }) });
  assert.ok(rs3.every((r) => r.status === "ok"));
});

test("the instructions: ad's block in every condition, its Memory section only with ad's memory; the hash is recorded", async () => {
  const { withoutMemorySection, writeInstructions } = await import("../runner/driver-ad.mjs");
  const block = "<!-- s -->\n# Agent Daemon harness\n\nid\n\n## Memory\n- memory line\n- more\n\n## Skills\n- skills line\n\nrules\n<!-- e -->";
  const plain = withoutMemorySection(block);
  assert.ok(!plain.includes("## Memory") && !plain.includes("memory line") && plain.includes("## Skills") && plain.includes("rules"));
  const dir = path.join(TMP, "eh");
  fs.mkdirSync(dir, { recursive: true });
  const off = writeInstructions(dir, block, { memory: false });
  const on = writeInstructions(dir, block, { memory: true });
  assert.deepEqual([off.memorySection, on.memorySection], [false, true]);
  assert.notEqual(off.sha256, on.sha256);
  const withIns = { ...fakeDriver(), async prepare() {
    return { instructions: { sha256: "abc", memorySection: false } };
  } };
  const rs = await episode("off", withIns);
  assert.deepEqual(rs[0].instructions, { sha256: "abc", memorySection: false });
  assert.equal(rs[1].instructions, undefined);
});

test("Claude Code's own memory is seen when its config folder has some", async () => {
  const drv = await import("../runner/driver-claude.mjs");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(TMP, "cc");
    assert.equal((await drv.hostMemoryEvidence()).present, false);
    fs.mkdirSync(path.join(TMP, "cc", "projects", "p", "memory"), { recursive: true });
    assert.equal((await drv.hostMemoryEvidence()).present, false, "an empty folder is no memory");
    fs.writeFileSync(path.join(TMP, "cc", "projects", "p", "memory", "MEMORY.md"), "x");
    assert.equal((await drv.hostMemoryEvidence()).present, true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("the fixture is generic: no personal names, paths or real projects", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const personal = new RegExp(["[A-Z]:\\\\Users\\\\", "/home/[a-z]", ["my", "projects"].join("-")].join("|"));
  for (const f of walk(BENCH_DIR).filter((f) => !f.includes(`${path.sep}results${path.sep}`))) assert.ok(!personal.test(fs.readFileSync(f, "utf8")), f);
});
