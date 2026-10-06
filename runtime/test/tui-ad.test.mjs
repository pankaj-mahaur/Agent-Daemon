// ad's capabilities in the terminal UI (tui/ad-layer.mjs, plan Part 9), on
// fakes and temp folders: never ad's real memory, loops or schedules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdLayer } from "../src/tui/ad-layer.mjs";
import { createEngine } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { createApp } from "../src/tui/app.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeMemory() {
  const sql = [];
  const handle = {
    run: (q, p) => (sql.push([q, p]), { changes: p?.[0] === 7 ? 1 : 0 }),
    all: (q, p) => (sql.push([q, p]), [{ id: 41, text: "login.spec uses fake timers" }]),
  };
  return {
    sql,
    projectSlug: (p) => `slug:${p}`,
    db: async () => handle,
    searchLearnings: async (q, o) => (sql.push(["search", q, o]), [{ id: 7, category: "gotcha", text: "fake \x1b[31mtimers\nbreak refresh" }]),
    listRecentLearnings: async (o) => [{ id: 9, category: "pattern", text: "run tests first" }],
    buildUserRepresentation: async () => ({}),
    representationToMarkdown: () => "## You\n- prefer short replies",
    stats: async () => ({ driver: true, counts: { learnings: 142, sessions: 9 } }),
  };
}

test("memory: search, recent, forget (archived, not deleted), profile, summary; text sanitized", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ad-mem-"));
  try {
    const memory = fakeMemory();
    const ad = createAdLayer({ cwd, memory });
    const found = await ad.memory("search", "timers");
    assert.match(found[1], /^#7 \[gotcha\] fake timers break refresh$/);
    assert.deepEqual(memory.sql[0], ["search", "timers", { limit: 10, projectSlug: `slug:${cwd}` }]);
    assert.match((await ad.memory("recent"))[1], /#9 \[pattern\] run tests first/);
    assert.deepEqual(await ad.memory("forget", "#7"), ["Forgot #7: it won't be recalled again."]);
    assert.match(memory.sql.at(-1)[0], /UPDATE learnings SET status = 'archived' WHERE id = \? AND status = 'active' AND \(project_slug = \? OR project_slug IS NULL\)/);
    assert.deepEqual(memory.sql.at(-1)[1], [7, `slug:${cwd}`], "only this project's (or global) learnings");
    assert.deepEqual(await ad.memory("forget", "8"), ["No active learning #8."]);
    assert.match((await ad.memory("forget", "x; DROP"))[0], /forget <id>/);
    assert.deepEqual(await ad.memory("profile"), ["## You", "- prefer short replies"]);
    assert.match((await ad.memory(""))[0], /142 learnings, 9 sessions/);
    assert.deepEqual(await ad.learnedSince("thread-1", "2026-10-06 10:00:00"), [{ id: 41, text: "login.spec uses fake timers" }]);
    assert.deepEqual(memory.sql.at(-1)[1], ["thread-1", "2026-10-06 10:00:00"]);
    assert.deepEqual(await createAdLayer({ cwd }).memory("recent"), ["ad memory isn't available here."]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("learned rows and /memory include what the hooks captured this session (the journal, saved at the next start)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ad-journal-"));
  try {
    const memory = fakeMemory();
    const ad = createAdLayer({ cwd, memory });
    mkdirSync(join(cwd, ".agent-daemon"), { recursive: true });
    const entry = (ts, sessionId, text, type = "correction") => JSON.stringify({ ts, type, text, sessionId });
    writeFileSync(join(cwd, ".agent-daemon", "learning-journal.jsonl"), [
      entry("2026-10-06T10:00:05.000Z", "thread-1", "pnpm, not npm"),
      entry("2026-10-06T10:00:06.000Z", "thread-1", "login.spec uses fake timers"), // also saved: shown once
      entry("2026-10-06T09:59:00.000Z", "thread-1", "from an earlier turn"),
      entry("2026-10-06T10:00:07.000Z", "thread-2", "another conversation's"),
      "{\"ts\":\"2026-10-06T10:00:08", // a line still being written
    ].join("\n"));
    const rows = await ad.learnedSince("thread-1", "2026-10-06 10:00:00");
    assert.deepEqual(rows.map((r) => r.text), ["login.spec uses fake timers", "pnpm, not npm"]);
    assert.equal(new Set(rows.map((r) => r.id)).size, 2, "distinct ids, so each row shows once");
    const recent = (await ad.memory("recent")).join("\n");
    assert.match(recent, /#9 \[pattern\] run tests first/);
    assert.match(recent, /Captured, saved to memory when ad next starts:\n {2}\[correction\] another conversation's/);
    assert.match((await ad.memory(""))[0], /142 learnings, 9 sessions, 4 captured \(saved when ad next starts\)/);
    // Without memory at all, the captured ones still show after a turn.
    assert.deepEqual((await createAdLayer({ cwd }).learnedSince("thread-2", "2026-10-06 10:00:00")).map((r) => r.text), ["another conversation's"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("proposals list what waits in .agent-daemon/proposed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ad-prop-"));
  try {
    const ad = createAdLayer({ cwd });
    assert.deepEqual(ad.proposals(), ["No skill proposals waiting."]);
    mkdirSync(join(cwd, ".agent-daemon", "proposed"), { recursive: true });
    writeFileSync(join(cwd, ".agent-daemon", "proposed", "debug-triage.md"), "# Tighten the triage order\nbody");
    assert.deepEqual(ad.proposals(), ["1 proposal waiting (review them with /ad review):", "  debug-triage.md — Tighten the triage order"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function fakeLoopSpawn(cwd) {
  const calls = [];
  let child;
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    child = new EventEmitter();
    // As `ad loop` does: its thread id goes to stdout (the TUI's log file).
    writeSync(opts.stdio[1], "ad loop — thread thread-9\nlog: …\n");
    return child;
  };
  const log = join(cwd, ".agent-daemon", "loops", "thread-9.jsonl");
  const iterate = (i, progress) => {
    mkdirSync(join(cwd, ".agent-daemon", "loops"), { recursive: true });
    appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), iteration: i, turnStatus: "completed", status: { progress } }) + "\n");
  };
  return { spawnFn, calls, iterate, exit: (code) => child.emit("exit", code) };
}

test("loop: starts ad loop in the background, tails its log, STOP stops it; its own STOP never blocks the next one", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ad-loop-"));
  try {
    const f = fakeLoopSpawn(cwd);
    const ad = createAdLayer({ cwd, home: cwd, cli: "/ad/cli.mjs", spawnFn: f.spawnFn });
    // An older run's log, with multi-byte text: the new run is found by byte offset.
    mkdirSync(join(cwd, ".agent-daemon"), { recursive: true });
    writeFileSync(join(cwd, ".agent-daemon", "loop-tui.log"), `ad loop — thread old-1 ${"✓".repeat(10)}\n`);
    assert.match(ad.loop.start("").error, /objective/);
    assert.deepEqual(ad.loop.start("make the docs build"), { ok: true });
    const c = f.calls[0];
    assert.deepEqual(c.args.slice(-4), ["--cwd", cwd, "--", "make the docs build"]);
    assert.equal(c.opts.env.AD_WORKER, "1");
    assert.equal(c.opts.detached, true, "the loop outlives the TUI");
    // Another loop writing in the same folder isn't mistaken for this one.
    mkdirSync(join(cwd, ".agent-daemon", "loops"), { recursive: true });
    writeFileSync(join(cwd, ".agent-daemon", "loops", "other.jsonl"), JSON.stringify({ iteration: 7, turnStatus: "completed" }) + "\n");
    assert.match(ad.loop.start("again").error, /already running/);
    f.iterate(1, "docs \x1b[2Jbuild failing");
    f.iterate(2, "fixed links");
    const rows = ad.loop.poll();
    assert.deepEqual(rows.map((r) => [r.iteration, r.progress]), [[1, "docs build failing"], [2, "fixed links"]]);
    assert.deepEqual(ad.loop.poll(), [], "each record once");
    assert.equal(ad.loop.state.iterations, 2);
    assert.deepEqual(ad.loop.stop(), { ok: true });
    assert.ok(existsSync(join(cwd, ".agent-daemon", "STOP")));
    f.exit(0);
    assert.equal(ad.loop.state.running, false);
    assert.ok(!existsSync(join(cwd, ".agent-daemon", "STOP")), "its STOP is gone once it stopped");
    assert.deepEqual(ad.loop.start("next objective"), { ok: true }, "the STOP it wrote itself is removed");
    assert.ok(!existsSync(join(cwd, ".agent-daemon", "STOP")));
    f.exit(0);
    writeFileSync(join(cwd, ".agent-daemon", "STOP"), "the user's own");
    assert.match(ad.loop.start("x").error, /A STOP file exists/, "someone else's STOP is respected");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("scheduler warning: an enabled job overdue by more than 5 minutes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ad-sched-"));
  try {
    const ad = createAdLayer({ cwd: home, home, now: () => Date.parse("2026-10-06T12:00:00Z") });
    assert.equal(await ad.schedulerWarning(), null);
    mkdirSync(join(home, ".agent-daemon"), { recursive: true });
    const job = (id, nextRun, enabled = true) => ({ id, cron: "0 9 * * *", kind: "run", prompt: "p", cwd: home, enabled, nextRun, lastStatus: null });
    writeFileSync(join(home, ".agent-daemon", "schedules.json"), JSON.stringify({ jobs: [job("a", "2026-10-06T11:00:00Z"), job("b", "2026-10-06T11:58:00Z"), job("c", "2026-10-06T08:00:00Z", false)] }));
    assert.match(await ad.schedulerWarning(), /^1 scheduled job is overdue: the scheduler isn't running/);
    assert.match((await ad.schedules()).join("\n"), /a {2}0 9 \* \* \* {2}run “p” {2}last: never/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* In the app                                                          */
/* ------------------------------------------------------------------ */

async function withApp(fn, ad) {
  const root = mkdtempSync(join(tmpdir(), "ad-adapp-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks") });
  const scr = modelScreen({ cols: 90, rows: 24 });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const scrollback = [];
  const commit = renderer.commit.bind(renderer);
  renderer.commit = (lines) => {
    for (const l of lines) scrollback.push((typeof l === "string" ? l : l.map((s) => s.text).join("")).replace(/ +$/, ""));
    return commit(lines);
  };
  const app = createApp({ io, renderer, session, cwd: root, armMs: 0, actions: { ad } });
  const committed = () => scrollback.join("\n");
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${scr.lines().join("\n")}`);
  };
  try {
    await fn({ app, type: (s) => decoder.feed(s), until, committed, engine, session, screen: () => scr.lines().join("\n"), root });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("in the app: /memory, /private wraps prompts, learned rows after a turn, /loop rows and chip, /proposals", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ad-adapp-loop-"));
  const f = fakeLoopSpawn(cwd);
  const ad = createAdLayer({ cwd, home: cwd, memory: fakeMemory(), cli: "/ad/cli.mjs", spawnFn: f.spawnFn });
  try {
    await withApp(async ({ app, type, until, committed, engine, screen }) => {
      type("/memory search timers\r");
      await until(() => /#7 \[gotcha\] fake timers break refresh/.test(committed()), "memory rows");
      type("/private\r");
      await until(() => /Private: your prompts are wrapped/.test(committed()), "private on");
      await until(() => /private/.test(screen()), "the footer chip");
      type("hello\r");
      await until(() => app.state.modal, "the approval (the wrapped prompt is the fake's default turn)");
      type("y");
      await until(() => /Learned: login\.spec uses fake timers/.test(committed()), "the learned row");
      const st = await engine.server.request("debug/state", {});
      assert.equal(st.lastParams["turn/start"].input[0].text, "<private>hello</private>");
      assert.match(committed(), /› hello {2}\(private\)/, "shown as typed, marked private");
      assert.doesNotMatch(committed(), /› <private>/);
      type("/loop fix the docs\r");
      await until(() => /Loop: started: fix the docs/.test(committed()), "loop started");
      f.iterate(1, "links fixed");
      await until(() => /Loop: iteration 1 completed · links fixed/.test(committed()), "an iteration row", 5000);
      await until(() => /loop 1/.test(screen()), "the loop chip");
      f.exit(0);
      await until(() => /Loop: finished after 1 iteration \(exit 0\)/.test(committed()), "the end row", 5000);
      type("/proposals\r");
      await until(() => /No skill proposals waiting/.test(committed()), "proposals");
    }, ad);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a reply whose id a rewound turn used still shows", async () => {
  await withApp(async ({ type, until, committed, session }) => {
    type("same-id one\r");
    await until(() => /reply to same-id one/.test(committed()), "the first reply");
    await session.revert(session.state.turns.at(-1).id); // Esc Esc or /undo rewinds that turn
    type("same-id two\r");
    await until(() => /reply to same-id two/.test(committed()), "the reply reusing the id");
  });
});
