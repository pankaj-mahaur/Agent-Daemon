// Session controller (harness/session.mjs, plan Part 4) driven by a headless
// subscriber on the fake engine: no UI anywhere, which is the point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";
import { createSession, lockThread, SessionLockedError } from "../src/harness/session.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };

const until = async (pred, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function withSession(opts, fn, { engineOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-session-"));
  const lockDir = join(root, "locks");
  const engines = [];
  const make = async (extra = {}) => {
    const e = await createEngine({ home: join(root, "home"), command, ...engineOpts, ...extra });
    engines.push(e);
    return e;
  };
  const engine = await make();
  const changes = [];
  const session = createSession({ engine, cwd: root, lockDir, ...opts(make) });
  session.on("change", ({ what }) => changes.push(what));
  try {
    await fn({ session, engine, root, lockDir, changes, make, engines });
  } finally {
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
const none = () => ({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugState = (engine) => engine.server.request("debug/state", {});
const agentTexts = (s) => [...s.state.items.values()].filter((i) => i.kind === "agentMessage").map((i) => i.text);

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

test("lazy: no thread, no lock until the first prompt; quitting leaves no trace", async () => {
  await withSession(none, async ({ session, engine, lockDir }) => {
    await session.init();
    assert.equal(session.state.thread, null);
    const st = await debugState(engine);
    assert.ok(!st.calls.includes("thread/start"), "no thread was started");
    assert.ok(session.state.account, "account read at startup");
    session.close();
    assert.ok(!existsSync(lockDir) || readdirSync(lockDir).length === 0);
  });
});

test("a prompt echoes at once, starts a thread and a turn; the request waits for resolve()", async () => {
  await withSession(none, async ({ session, lockDir }) => {
    const { clientUserMessageId, accepted, done } = session.submit("hello");
    assert.equal(session.state.echoes.get(clientUserMessageId), "hello", "local echo before Codex answers");
    const { turnId } = await accepted;
    assert.match(turnId, /^turn-/);
    assert.equal(readdirSync(lockDir).length, 1, "the thread is locked");
    await until(() => session.state.requests.length === 1, "the approval");
    const { request } = session.state.requests[0];
    assert.equal(request.kind, "approval-exec");
    assert.ok(session.resolve(request.id, "accept"));
    const r = await done;
    assert.equal(r.status, "completed");
    assert.ok(agentTexts(session).includes("pong[accept]"));
    assert.equal(session.state.echoes.size, 0, "Codex's copy replaced the echo");
    const echo = [...session.state.items.values()].find((i) => i.kind === "userMessage");
    assert.equal(echo.clientId, clientUserMessageId);
    assert.equal(session.state.activeTurnId, null);
    assert.equal(session.state.turns.length, 1);
  });
});

test("requests are kept in arrival order and answered individually", async () => {
  await withSession(none, async ({ session }) => {
    const { done } = session.submit("two-approvals");
    await until(() => session.state.requests.length === 2, "two approvals");
    const [a, b] = session.state.requests.map((r) => r.request);
    assert.ok(String(a.id) < String(b.id), "FIFO by JSON-RPC id");
    session.resolve(b.id, "accept");
    session.resolve(a.id, "decline");
    await done;
    assert.ok(agentTexts(session).includes("two[decline,accept]"));
  });
});

test("subagent requests carry the agent's label; the agent is listed", async () => {
  await withSession(none, async ({ session }) => {
    const { done } = session.submit("subagent");
    await until(() => session.state.requests.length === 1, "the subagent's approval");
    const { request } = session.state.requests[0];
    assert.equal(request.agentLabel, "explorer");
    session.resolve(request.id, "accept");
    await done;
    const [[childId, agent]] = [...session.state.agents];
    assert.match(childId, /^child-of-/);
    assert.equal(agent.label, "explorer");
    assert.ok([...session.state.items.values()].some((i) => i.threadId === childId && i.text === "child says hi"));
  });
});

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

test("a thread held by a live process can't be opened; a stale lock is taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-lock-"));
  try {
    const release = lockThread("t1", { dir, pid: 111, isAlive: () => true });
    assert.throws(() => lockThread("t1", { dir, pid: 222, isAlive: () => true }), SessionLockedError);
    const takeover = lockThread("t1", { dir, pid: 222, isAlive: () => false });
    release(); // the old holder's release doesn't remove the new holder's lock
    assert.equal(readdirSync(dir).length, 1);
    takeover();
    assert.equal(readdirSync(dir).length, 0);
    // Unreadable: someone mid-write (busy) until it is older than staleMs.
    writeFileSync(join(dir, "t2.lock"), "not json");
    assert.throws(() => lockThread("t2", { dir, pid: 333, isAlive: () => true }), SessionLockedError);
    lockThread("t2", { dir, pid: 333, isAlive: () => true, now: () => Date.now() + 200_000 })();
    // A live pid whose heartbeat stopped (a reused pid) doesn't keep the lock.
    lockThread("t3", { dir, pid: 444, isAlive: () => true });
    assert.throws(() => lockThread("t3", { dir, pid: 555, isAlive: () => true }), SessionLockedError);
    lockThread("t3", { dir, pid: 555, isAlive: () => true, now: () => Date.now() + 200_000 })();
    // The same process can't hold one thread twice.
    const mine = lockThread("t4", { dir });
    assert.throws(() => lockThread("t4", { dir }), SessionLockedError);
    // A stale-lock takeover by the same pid: the old holder's release leaves it.
    const later = lockThread("t4", { dir, now: () => Date.now() + 200_000, isAlive: () => false });
    mine();
    assert.ok(existsSync(join(dir, "t4.lock")));
    later();
    assert.ok(!existsSync(join(dir, "t4.lock")));
    // Someone else is mid-takeover (fresh guard): busy. A guard left by a crash expires.
    writeFileSync(join(dir, "t5.lock"), JSON.stringify({ pid: 999999, threadId: "t5" }));
    writeFileSync(join(dir, "t5.lock.takeover"), "1");
    assert.throws(() => lockThread("t5", { dir, isAlive: () => false }), SessionLockedError);
    lockThread("t5", { dir, isAlive: () => false, now: () => Date.now() + 200_000 })();
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("t5")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming a thread another session holds fails with SessionLockedError", async () => {
  await withSession(none, async ({ session, engine, root, lockDir }) => {
    await session.submit("fail-turn").done;
    const threadId = session.state.thread.id;
    session.close(); // this process lets go
    // Another live ad (our parent process stands in for it) holds the thread.
    writeFileSync(join(lockDir, `${threadId}.lock`), JSON.stringify({ pid: process.ppid, threadId }));
    const other = createSession({ engine, cwd: root, lockDir });
    await assert.rejects(other.resume(threadId), SessionLockedError);
    other.close();
  });
});

/* ------------------------------------------------------------------ */
/* Steer, queue, interrupt                                             */
/* ------------------------------------------------------------------ */

test("Enter while a turn runs steers it", async () => {
  await withSession(none, async ({ session }) => {
    const first = session.submit("hang");
    await first.accepted;
    const second = session.submit("also check the docs");
    assert.deepEqual(await second.accepted, { steered: true, turnId: (await first.accepted).turnId });
    const r = await first.done;
    assert.equal(r.status, "completed");
    assert.ok(agentTexts(session).includes("steered: also check the docs"));
  });
});

test("a turn that can't be steered (review) takes the prompt as a queued one, run when it ends", async () => {
  await withSession(none, async ({ session }) => {
    await session.review({ type: "custom", instructions: "hang" });
    await until(() => session.state.activeTurnId, "the review turn");
    const s = session.submit("fail-turn");
    const a = await s.accepted;
    assert.equal(a.queued, true);
    assert.equal(session.state.queue.length, 1);
    await session.interrupt();
    await until(() => session.state.turns.length === 2 && session.state.turns[1].status === "failed", "the queued prompt to run");
    assert.equal(session.state.queue.length, 0);
  });
});

test("a steer that races the turn's completion becomes a queued prompt and still runs", async () => {
  await withSession(none, async ({ session, engine }) => {
    const first = session.submit("hang");
    const { turnId } = await first.accepted;
    // The turn ends just as the steer goes out.
    const request = engine.server.request.bind(engine.server);
    engine.server.request = async (method, params) => {
      if (method === "turn/steer") {
        await request("turn/interrupt", { threadId: params.threadId, turnId });
        await new Promise((r) => setTimeout(r, 20));
      }
      return request(method, params);
    };
    const s = session.submit("fail-turn");
    const a = await s.accepted;
    assert.equal(a.queued, true);
    await until(() => session.state.turns.length === 2 && session.state.turns[1].status === "failed", "the prompt to run as its own turn");
  });
});

test("queue and editQueued: visible, editable, drained in order", async () => {
  await withSession(none, async ({ session }) => {
    const running = session.submit("hang");
    await running.accepted;
    session.queue("first");
    session.queue("second");
    session.queue("third");
    assert.ok(session.editQueued(1, "early-complete"));
    assert.ok(session.editQueued(0, null));
    assert.ok(session.editQueued(1, "fail-turn"));
    assert.ok(!session.editQueued(9, "x"));
    assert.deepEqual(session.state.queue.map((q) => q.text), ["early-complete", "fail-turn"]);
    await sleep(100);
    assert.equal(session.state.queue.length, 2, "nothing runs while a turn does");
    await session.interrupt();
    await until(() => session.state.queue.length === 0 && session.state.turns.length === 3 && session.state.turns.every((t) => t.status !== "inProgress"), "the queue to drain");
    const prompts = [...session.state.items.values()].filter((i) => i.kind === "userMessage").map((i) => i.text);
    assert.deepEqual(prompts, ["hang", "early-complete", "fail-turn"]);
    // Queued while idle: runs at once.
    session.queue("fail-turn");
    await until(() => session.state.turns.length === 4, "an idle queue to run");
  });
});

test("interrupt before Codex accepted the turn interrupts it as soon as it is accepted", async () => {
  await withSession(none, async ({ session }) => {
    const s = session.submit("slow-start");
    assert.equal(await session.interrupt(), true);
    const r = await s.done;
    assert.equal(r.status, "interrupted");
  });
});

test("setNextTurn overrides go on the next turn/start", async () => {
  await withSession(none, async ({ session, engine }) => {
    session.setNextTurn({ model: "m2", effort: "high" });
    await session.submit("fail-turn").done;
    const st = await debugState(engine);
    assert.equal(st.lastParams["turn/start"].model, "m2");
    assert.equal(st.lastParams["turn/start"].effort, "high");
    assert.equal(session.state.config.model, "m2");
    await session.submit("fail-turn").done;
    const st2 = await debugState(engine);
    assert.equal(st2.lastParams["turn/start"].model, undefined, "once: Codex keeps it for later turns itself");
  });
});

/* ------------------------------------------------------------------ */
/* Review, shell, goal, revert, resume                                 */
/* ------------------------------------------------------------------ */

test("review, shell, goal and revert", async () => {
  const started = [];
  const completed = [];
  await withSession(() => ({ hooks: { turnStarted: ({ turn }) => started.push(turn.id), turnCompleted: ({ status }) => completed.push(status) } }), async ({ session }) => {
    await session.review();
    await until(() => completed.length === 1, "the review turn");
    assert.equal(started.length, 1, "turnStarted fires for a turn the server started");
    await session.shell("git status");
    await until(() => [...session.state.items.values()].some((i) => i.kind === "commandExecution" && i.source === "userShell" && i.exitCode === 0), "the shell command");
    const goal = await session.setGoal("ship it");
    assert.equal(goal.objective, "ship it");
    assert.equal(await session.setGoal(null), null);
    await session.submit("fail-turn").done;
    assert.equal(session.state.turns.length, 2);
    const reverted = session.state.turns[1].id;
    assert.ok([...session.state.items.values()].some((i) => i.turnId === reverted), "the turn had items");
    await session.revert(reverted);
    assert.equal(session.state.turns.length, 1);
    assert.ok(![...session.state.items.values()].some((i) => i.turnId === reverted), "no items left from the reverted turn");
  });
});

test("itemStarted / itemCompleted fire for the thread's items, with their turn (for /undo)", async () => {
  const seen = [];
  const started = [];
  await withSession(() => ({ hooks: { itemStarted: ({ item }) => started.push({ ...item }), itemCompleted: ({ item }) => seen.push(item) } }), async ({ session }) => {
    await session.submit("apply-edit").done;
    const fc = seen.find((i) => i.kind === "fileChange");
    assert.ok(fc, "the applied edit");
    assert.equal(fc.status, "completed");
    assert.equal(fc.turnId, session.state.turns.at(-1).id);
    assert.equal(fc.changes[0].path, "src/app.js");
    const st = started.find((i) => i.kind === "fileChange");
    assert.equal(st?.status, "inProgress", "itemStarted fires before the edit lands");
    assert.equal(st.turnId, fc.turnId);
  });
});

test("turnStartFailed fires when turn/start fails (so a prepared 'before' isn't left for a later turn)", async () => {
  const failed = [];
  await withSession(() => ({ hooks: { turnStartFailed: ({ error }) => failed.push(error.message) } }), async ({ session }) => {
    await assert.rejects(session.submit("reject-start").accepted, /turn\/start rejected/);
    assert.equal(failed.length, 1);
    assert.match(failed[0], /turn\/start rejected/);
    await session.submit("same-id ok").done;
    assert.equal(failed.length, 1, "not for a turn that starts");
  });
});

test("an item id a later turn reuses is a new item there: no merging, nothing hidden", async () => {
  await withSession(() => ({}), async ({ session }) => {
    await session.submit("same-id one").done;
    await session.submit("same-id two").done;
    const [t1, t2] = session.state.turns.slice(-2);
    const msg = (t) => t.itemIds.map((id) => session.state.items.get(id)).find((i) => i?.kind === "agentMessage");
    assert.equal(msg(t1).text, "reply to same-id one", "the first turn's item is untouched");
    assert.equal(msg(t2).text, "reply to same-id two", "the delta didn't append to the old text");
    assert.notEqual(msg(t1).id, msg(t2).id, "two items, two keys");
    assert.equal(msg(t2).turnId, t2.id);
    assert.equal(session.itemFor("msg-same", t2.id), msg(t2), "Codex's id within its turn finds it");
    assert.equal(session.itemFor("msg-same", t1.id), msg(t1));
  });
});

test("resume loads the thread's history in order, with full items", async () => {
  await withSession(none, async ({ session, engine, root, lockDir }) => {
    const a = session.submit("early-complete");
    await a.done;
    await session.submit("fail-turn").done;
    const threadId = session.state.thread.id;
    session.newThread();
    assert.equal(session.state.thread, null);
    session.close(); // one session per engine
    const other = createSession({ engine, cwd: root, lockDir });
    try {
      await other.resume(threadId);
      const st = await debugState(engine);
      assert.equal(st.lastParams["thread/resume"].excludeTurns, true);
      assert.equal(st.lastParams["thread/turns/list"].itemsView, "full");
      assert.equal(other.state.turns.length, 2);
      assert.ok([...other.state.items.values()].some((i) => i.kind === "agentMessage" && i.text === "early"));
      assert.ok([...other.state.items.values()].some((i) => i.kind === "userMessage" && i.text === "early-complete"));
    } finally {
      other.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Hooks and crashes                                                   */
/* ------------------------------------------------------------------ */

test("beforeTurn can change what is sent", async () => {
  await withSession(() => ({ hooks: { beforeTurn: ({ input }) => [...input, { type: "text", text: "(context)" }] } }), async ({ session, engine }) => {
    await session.submit("fail-turn").done;
    const st = await debugState(engine);
    assert.deepEqual(st.lastParams["turn/start"].input.map((i) => i.text), ["fail-turn", "(context)"]);
  });
});

test("an engine crash ends the running turn as failed, then the engine restarts and the thread resumes", async () => {
  await withSession((make) => ({ restart: make, maxRestarts: 2 }), async ({ session, engines }) => {
    const s = session.submit("hang");
    await s.accepted;
    const threadId = session.state.thread.id;
    engines[0].server.request("test/crash", {}).catch(() => {});
    const r = await s.done;
    assert.equal(r.status, "failed");
    await until(() => session.state.engine.state === "ready" && session.state.engine.restarts === 1, "the restart");
    assert.equal(session.state.thread.id, threadId);
    assert.ok(session.state.notices.some((n) => n.code === "engine.restarted"));
    const again = session.submit("fail-turn");
    assert.equal((await again.done).status, "failed", "the restarted engine runs turns");
    const st = await debugState(engines[1]);
    assert.ok(st.calls.includes("thread/resume"));
  });
});

test("without restart, a crash leaves the session in a crashed state", async () => {
  await withSession(none, async ({ session, engine }) => {
    await session.submit("fail-turn").done;
    engine.server.request("test/crash", {}).catch(() => {});
    await until(() => session.state.engine.state === "crashed", "crashed");
  });
});

test("close declines open requests and resolves waiting turns", async () => {
  await withSession(none, async ({ session }) => {
    const s = session.submit("hello");
    await until(() => session.state.requests.length === 1, "the approval");
    session.close();
    const r = await s.done;
    assert.equal(r.status, "closed");
    assert.throws(() => session.submit("x"), /closed/);
  });
});

/* ------------------------------------------------------------------ */
/* Part 4 re-review: thread switches, close and restart races          */
/* ------------------------------------------------------------------ */

test("release: ad leaves the thread and waits until Codex has unloaded it (for /codex)", async () => {
  await withSession(none, async ({ session, engine }) => {
    await session.submit("fail-turn").done;
    const id = session.state.thread.id;
    assert.equal(await session.release(id), true);
    assert.equal(session.state.thread, null, "ad left the thread");
    const st = await debugState(engine);
    assert.deepEqual(st.lastParams["thread/unsubscribe"], { threadId: id });
    // A thread Codex doesn't have loaded is free already.
    assert.equal(await session.release("not-loaded"), true);
    // No thread/closed in time: false, so the caller can fall back (restart ad's engine).
    await session.submit("fail-turn").done;
    assert.equal(await session.release(session.state.thread.id, { timeoutMs: 1 }), false);
    // ad resumes it afterwards as usual.
    assert.equal(await session.resume(id), id);
  });
});

test("newThread during a running turn interrupts it and settles its waiters as abandoned", async () => {
  await withSession(none, async ({ session, engine }) => {
    const a = session.submit("hang");
    await a.accepted;
    session.newThread();
    assert.equal((await a.done).status, "abandoned");
    await sleep(50);
    const st = await debugState(engine);
    assert.ok(st.calls.includes("turn/interrupt"));
    // A request from the thread left behind is declined, never shown as the new thread's.
    await session.submit("fail-turn").done;
    assert.equal(await engine.onRequest({ id: 99, kind: "approval-exec", threadId: "thread-1" }), null);
    assert.equal(session.state.requests.length, 0);
  });
});

test("newThread while turn/start is in flight: the late turn is stopped, the session stays usable", async () => {
  await withSession(none, async ({ session, engine }) => {
    const a = session.submit("slow-start");
    await sleep(50);
    await session.interrupt();
    session.newThread();
    assert.equal(session.state.starting, false);
    // The old start lands while the new one is still starting: it neither
    // becomes the active turn nor clears "starting".
    const b = session.submit("slow-start");
    await assert.rejects(a.accepted, /moved on/);
    assert.equal(session.state.activeTurnId, null);
    assert.deepEqual(session.state.turns, []);
    assert.equal(session.state.starting, true);
    const { turnId } = await b.accepted;
    assert.equal(session.state.activeTurnId, turnId);
    await session.interrupt();
    assert.equal((await b.done).status, "interrupted");
    assert.notEqual(session.state.thread, null);
    const st = await debugState(engine);
    assert.equal(st.calls.filter((c) => c === "thread/start").length, 2);
  });
});

test("a prompt queued behind a start that dies with the engine runs on the restarted one", async () => {
  await withSession((make) => ({ restart: make }), async ({ session, engines }) => {
    const a = session.submit("slow-start");
    session.queue("fail-turn");
    await sleep(50);
    engines[0].server.request("test/crash", {}).catch(() => {});
    await assert.rejects(a.accepted);
    await until(() => engines.length === 2 && session.state.engine.state === "ready", "the restart");
    await until(() => session.state.queue.length === 0, "the queue to drain");
    await sleep(100);
    const st = await debugState(engines[1]);
    assert.deepEqual(st.lastParams["turn/start"]?.input?.map((i) => i.text), ["fail-turn"]);
  });
});

test("close while the thread is being created leaves no lock and sends no turn", async () => {
  await withSession(none, async ({ session, engine, lockDir }) => {
    const a = session.submit("hang");
    session.close();
    await assert.rejects(a.accepted);
    await sleep(300);
    assert.deepEqual(existsSync(lockDir) ? readdirSync(lockDir) : [], []);
    assert.ok(!(await debugState(engine)).calls.includes("turn/start"));
  });
});

test("one thread/start for concurrent first calls (goal + prompt)", async () => {
  await withSession(none, async ({ session, engine }) => {
    const g = session.setGoal("ship it");
    const s = session.submit("fail-turn");
    await g;
    await s.done;
    const st = await debugState(engine);
    assert.equal(st.calls.filter((c) => c === "thread/start").length, 1);
    assert.equal(st.lastParams["thread/goal/set"].threadId, session.state.thread.id);
  });
});

test("one session per engine; a request for another thread is declined", async () => {
  await withSession(none, async ({ session, engine, root, lockDir }) => {
    assert.throws(() => createSession({ engine, cwd: root, lockDir }), /already has a session/);
    // The failed second session didn't take the first one's request handler.
    const s = session.submit("hello");
    await until(() => session.state.requests.length === 1, "the approval");
    session.resolve(session.state.requests[0].request.id, "accept");
    assert.equal((await s.done).status, "completed");
  });
});

test("sandbox overrides map to the thread's sandbox mode and carry to a new thread", async () => {
  await withSession(none, async ({ session, engine }) => {
    session.setNextTurn({ sandboxPolicy: { type: "readOnly" }, effort: "high" });
    await session.submit("fail-turn").done;
    session.newThread();
    await session.submit("fail-turn").done;
    const st = await debugState(engine);
    assert.equal(st.lastParams["thread/start"].sandbox, "read-only");
    assert.equal(st.lastParams["turn/start"].effort, "high");
    assert.equal(session.state.config.sandbox, "read-only");
  });
});

test("after a crash, a queued prompt waits for the restarted engine and then runs", async () => {
  await withSession((make) => ({ restart: make }), async ({ session, engines }) => {
    const a = session.submit("hang");
    await a.accepted;
    session.queue("fail-turn");
    engines[0].server.request("test/crash", {}).catch(() => {});
    await a.done;
    await until(() => engines.length === 2 && session.state.engine.state === "ready", "the restart");
    await until(() => session.state.queue.length === 0, "the queue to drain");
    await sleep(50);
    const st = await debugState(engines[1]);
    assert.ok(st.calls.includes("turn/start"), "the queued prompt ran on the new engine");
  });
});

test("close during a restart closes the new engine", async () => {
  await withSession((make) => ({ restart: make }), async ({ session, engines }) => {
    await session.submit("fail-turn").done;
    engines[0].server.request("test/crash", {}).catch(() => {});
    await until(() => session.state.engine.state === "restarting", "restarting", 5000);
    session.close();
    await until(() => engines.length === 2, "the new engine");
    await until(() => engines[1].server?.child?.exitCode !== null || engines[1].server?.closed, "the new engine closed", 5000).catch(() => {});
    assert.equal(engines[1].onRequest, null);
    assert.equal(engines[1].subscribers.size, 0);
  });
});

test("two processes racing for a stale lock: exactly one wins", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "ad-lockrace-"));
  const mod = new URL("../src/harness/session.mjs", import.meta.url).href;
  const child = `const { lockThread } = await import(${JSON.stringify(mod)});
    const at = Number(process.argv[1]); while (Date.now() < at) {}
    try { lockThread("t", { dir: ${JSON.stringify(dir)} }); console.log("OWNER"); await new Promise((r) => setTimeout(r, 300)); }
    catch (e) { console.log(e.code); }`;
  try {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, "t.lock"), JSON.stringify({ pid: 999999, threadId: "t" }));
      const at = String(Date.now() + 600);
      const outs = await Promise.all(
        [0, 1].map(
          () =>
            new Promise((resolve) => {
              const p = spawn(process.execPath, ["--input-type=module", "-e", child, at], { stdio: ["ignore", "pipe", "inherit"] });
              let out = "";
              p.stdout.on("data", (d) => (out += d));
              p.on("exit", () => resolve(out.trim()));
            }),
        ),
      );
      assert.equal(outs.filter((o) => o === "OWNER").length, 1, `trial ${i}: ${outs}`);
      rmSync(join(dir, "t.lock"), { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Part 4 second re-review                                             */
/* ------------------------------------------------------------------ */

test("a prompt queued behind a turn that ends before turn/start answers still runs", async () => {
  await withSession(none, async ({ session, engine }) => {
    const a = session.submit("early-complete");
    const b = session.submit("fail-turn");
    assert.equal((await b.accepted).queued, true);
    await a.accepted;
    await until(() => session.state.queue.length === 0 && session.state.turns.length === 2, "the queued prompt");
    const st = await debugState(engine);
    assert.equal(st.calls.filter((c) => c === "turn/start").length, 2);
  });
});

const delayTurnsList = (engine, ms) => {
  const orig = engine.server.request.bind(engine.server);
  engine.server.request = async (m, p, o) => {
    const r = await orig(m, p, o);
    if (m === "thread/turns/list") await sleep(ms);
    return r;
  };
};

test("leaving a thread while its history loads: nothing of it leaks into the next", async () => {
  await withSession(none, async ({ session, engine }) => {
    await session.submit("early-complete").done;
    const A = session.state.thread.id;
    session.newThread();
    await session.submit("early-complete").done;
    const B = session.state.thread.id;
    session.newThread();
    delayTurnsList(engine, 300);
    const pa = session.resume(A);
    await sleep(100);
    session.newThread();
    await assert.rejects(pa, /moved on/);
    assert.equal(session.state.thread, null);
    assert.deepEqual(session.state.turns, []);
    assert.equal(session.state.items.size, 0);
    const pa2 = session.resume(A);
    await sleep(100);
    const pb = session.resume(B);
    await Promise.allSettled([pa2, pb]);
    assert.equal(session.state.thread.id, B);
    assert.deepEqual([...new Set([...session.state.items.values()].map((i) => i.threadId))], [B]);
    assert.equal(await session.resume(B), B, "resuming the current thread is a no-op");
  });
});

test("restarts are capped even when every new engine dies while resuming", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  await withSession(
    (make) => ({
      maxRestarts: 3,
      restart: async () => {
        calls++;
        if (calls > 6) throw new Error("runaway");
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const e = await make().finally(() => inFlight--);
        const orig = e.resumeThread.bind(e);
        e.resumeThread = async (...a) => {
          e.server.request("test/crash", {}).catch(() => {});
          return orig(...a);
        };
        return e;
      },
    }),
    async ({ session, engine }) => {
      await session.submit("early-complete").done;
      engine.server.request("test/crash", {}).catch(() => {});
      await until(() => session.state.engine.state === "crashed" && session.state.engine.restarts === 3, "the cap", 8000);
      await sleep(300);
      assert.equal(calls, 3);
      assert.equal(maxInFlight, 1, "one restart at a time");
    },
  );
});

test("a thread the restarted engine can't resume is dropped; the engine is ready and the queue runs", async () => {
  await withSession(
    (make) => ({
      restart: async () => {
        const e = await make();
        e.resumeThread = async () => {
          throw new Error("no rollout found");
        };
        return e;
      },
    }),
    async ({ session, engine, engines }) => {
      await session.submit("early-complete").done;
      engine.server.request("test/crash", {}).catch(() => {});
      await until(() => engines.length === 2 && session.state.engine.state === "ready", "ready");
      assert.equal(session.state.thread, null);
      assert.ok(session.state.notices.some((n) => n.code === "thread.notResumed"));
      session.queue("fail-turn");
      await until(() => session.state.queue.length === 0 && session.state.thread !== null, "the queue on a new thread");
    },
  );
});

test("during a restart, a prompt is queued and runs once the engine is back, with the overrides", async () => {
  await withSession(
    (make) => ({
      restart: async () => {
        await sleep(300);
        return make();
      },
    }),
    async ({ session, engine, engines }) => {
      session.setNextTurn({ model: "m-override", effort: "high" });
      await session.submit("early-complete").done;
      engine.server.request("test/crash", {}).catch(() => {});
      await until(() => session.state.engine.state === "restarting", "restarting");
      const s = session.submit("fail-turn");
      assert.equal((await s.accepted).queued, true);
      await until(() => session.state.engine.state === "ready" && session.state.queue.length === 0, "the queue after the restart");
      await sleep(100);
      const st = await debugState(engines[1]);
      assert.deepEqual(st.lastParams["turn/start"].input.map((i) => i.text), ["fail-turn"]);
      assert.equal(st.lastParams["turn/start"].model, "m-override");
      assert.equal(st.lastParams["turn/start"].effort, "high");
    },
  );
});

test("a crash ends the running turn's items too: none is left streaming", async () => {
  await withSession(none, async ({ session, engine }) => {
    session.submit("hello");
    await until(() => session.state.requests.length === 1, "the approval");
    const turnId = session.state.activeTurnId;
    engine.server.request("test/crash", {}).catch(() => {});
    await until(() => session.state.engine.state === "crashed", "crashed");
    const items = [...session.state.items.values()].filter((i) => i.turnId === turnId);
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => !i.streaming && i.status !== "inProgress"), JSON.stringify(items));
  });
});

test("a crash also settles items that have no turn (a running ! command)", async () => {
  await withSession(none, async ({ session, engine }) => {
    await session.submit("fail-turn").done;
    session.state.items.set("sh-x", { id: "sh-x", kind: "commandExecution", command: "make", status: "inProgress", streaming: true, turnId: null, threadId: session.state.thread.id });
    engine.server.request("test/crash", {}).catch(() => {});
    await until(() => session.state.engine.state === "crashed", "crashed");
    const it = session.state.items.get("sh-x");
    assert.equal(it.streaming, false);
    assert.equal(it.status, "failed");
  });
});

/* ------------------------------------------------------------------ */
/* Collaboration modes (Codex's plan mode, codex-parity-2 Part 4)      */
/* ------------------------------------------------------------------ */

const withModes = (opts, fn, extra = {}) => withSession((make) => ({ modes: true, ...opts(make) }), fn, { engineOpts: { experimental: true, ...(extra.env ? { env: extra.env } : {}) } });
const turnMask = async (engine) => (await debugState(engine)).lastParams["turn/start"].collaborationMode;

test("modes: presets load at start; every turn/start carries the mask; Default has the user's model and effort", async () => {
  await withModes(none, async ({ session, engine }) => {
    await session.modesReady;
    assert.deepEqual(session.state.mode.presets.map((p) => [p.name, p.mode, p.effort]), [["Plan", "plan", "medium"], ["Default", "default", null]]);
    assert.equal(session.state.mode.kind, "default");
    session.setNextTurn({ model: "m-user", effort: "high" });
    await session.submit("fail-turn").done;
    assert.deepEqual(await turnMask(engine), { mode: "default", settings: { model: "m-user", reasoning_effort: "high", developer_instructions: null } });
  });
});

test("modes: Plan uses plan_mode_reasoning_effort, else the preset's; switching tells the thread and says when the effort changes", async () => {
  let planEffort = null;
  await withModes(() => ({ planEffort: () => planEffort }), async ({ session, engine }) => {
    await session.modesReady;
    session.setNextTurn({ model: "m-user", effort: "low" });
    await session.submit("fail-turn").done;
    assert.deepEqual(session.setMode("plan"), { ok: true });
    await sleep(50);
    const st = await debugState(engine);
    assert.deepEqual(st.lastParams["thread/settings/update"], { threadId: session.state.thread.id, collaborationMode: { mode: "plan", settings: { model: "m-user", reasoning_effort: "medium", developer_instructions: null } } });
    assert.ok(session.state.notices.some((n) => n.message === "Model changed to m-user medium for Plan mode."), JSON.stringify(session.state.notices));
    planEffort = "xhigh";
    await session.submit("fail-turn").done;
    assert.equal((await turnMask(engine)).settings.reasoning_effort, "xhigh");
    // Back to Default: the user's own effort, never the plan turn's.
    session.setMode("default");
    await session.submit("fail-turn").done;
    assert.deepEqual((await turnMask(engine)).settings, { model: "m-user", reasoning_effort: "low", developer_instructions: null });
    assert.equal(session.state.config.effort, "low");
  });
});

test("modes: before a thread exists a switch is local; the first turn carries it", async () => {
  await withModes(none, async ({ session, engine }) => {
    await session.modesReady;
    assert.equal(session.cycleMode().ok, true, "Shift+Tab: Plan is first");
    assert.equal(session.state.mode.kind, "plan");
    await session.submit("fail-turn").done;
    const st = await debugState(engine);
    assert.equal(st.lastParams["thread/settings/update"], undefined);
    assert.equal(st.lastParams["turn/start"].collaborationMode.mode, "plan");
    assert.equal(session.cycleMode().ok, true);
    assert.equal(session.state.mode.kind, "default", "cycles back in Codex's order");
  });
});

test("modes: thread/settings/updated (here, /codex or a turn's mask) drives the mode; resume restores it; a new conversation starts in Default", async () => {
  await withModes(none, async ({ session, engine }) => {
    await session.modesReady;
    await session.submit("fail-turn").done;
    const id = session.state.thread.id;
    // As if the stock UI had switched the thread to Plan.
    await engine.server.request("thread/settings/update", { threadId: id, collaborationMode: { mode: "plan", settings: { model: "fake-model", reasoning_effort: "medium", developer_instructions: null } } });
    await until(() => session.state.mode.kind === "plan", "the mode from thread/settings/updated");
    session.newThread();
    assert.equal(session.state.mode.kind, "default");
    await session.resume(id);
    assert.equal(session.state.mode.kind, "plan", "resume reports the thread's mode");
  });
});

test("modes: the mask goes with a queued prompt and with the re-sent prompt after an engine restart", async () => {
  await withModes(
    (make) => ({ restart: async () => { await sleep(200); return make(); } }),
    async ({ session, engine, engines }) => {
      await session.modesReady;
      session.setMode("plan");
      await session.review({ type: "custom", instructions: "hang" });
      await until(() => session.state.activeTurnId, "the review turn");
      const q = session.submit("fail-turn");
      assert.equal((await q.accepted).queued, true, "a review can't be steered: queued");
      await session.interrupt();
      await until(() => session.state.queue.length === 0 && session.state.turns.length === 2, "the queued prompt");
      assert.equal((await turnMask(engine)).mode, "plan");
      engine.server.request("test/crash", {}).catch(() => {});
      await until(() => session.state.engine.state === "restarting", "restarting");
      const s = session.submit("fail-turn");
      assert.equal((await s.accepted).queued, true);
      await until(() => session.state.engine.state === "ready" && session.state.queue.length === 0, "the queue after the restart");
      await sleep(100);
      assert.equal((await turnMask(engines[1])).mode, "plan", "still Plan on the new engine");
      assert.ok((await debugState(engines[1])).calls.includes("collaborationMode/list"), "presets asked again");
    },
  );
});

test("modes: Codex without presets → unavailable, with a notice; a slow list gives up after 2 s", async () => {
  await withModes(none, async ({ session, engine }) => {
    await session.modesReady;
    assert.deepEqual(session.state.mode.presets, []);
    assert.ok(session.state.notices.some((n) => n.code === "modes.unavailable"));
    assert.deepEqual(session.setMode("plan"), { ok: false, message: "Plan mode unavailable right now." });
    assert.deepEqual(session.cycleMode(), { ok: false, message: "Plan mode unavailable right now." });
    await session.submit("fail-turn").done;
    assert.equal(await turnMask(engine), undefined, "no mask without presets");
  }, { env: { FAKE_NO_MODES: "1" } });
  await withModes(none, async ({ session }) => {
    const t = Date.now();
    await session.modesReady;
    assert.ok(Date.now() - t >= 1500, "Codex's 2 s wait");
    assert.deepEqual(session.state.mode.presets, []);
  }, { env: { FAKE_MODES_SLOW: "1" } });
});

test("modes off (every front end but ad tui): no list, no mask, stable requests only", async () => {
  await withSession(none, async ({ session, engine }) => {
    await session.modesReady;
    assert.equal(session.state.mode.presets, null);
    await session.submit("fail-turn").done;
    const st = await debugState(engine);
    assert.ok(!st.calls.includes("collaborationMode/list"));
    assert.equal(st.lastParams["turn/start"].collaborationMode, undefined);
  });
});

test("modes (review #1): with no effort picked, Default carries Codex's configured model_reasoning_effort, not null", async () => {
  await withModes(() => ({ configEffort: () => "high" }), async ({ session, engine }) => {
    await session.modesReady;
    await session.submit("fail-turn").done;
    assert.equal((await turnMask(engine)).settings.reasoning_effort, "high", "a null effort would drop the configured one");
    session.setMode("plan");
    assert.ok(session.state.notices.some((n) => n.message === "Model changed to fake-model medium for Plan mode."));
    session.setNextTurn({ effort: "low" }); // the user's own pick wins over the config
    session.setMode("default");
    await session.submit("fail-turn").done;
    assert.equal((await turnMask(engine)).settings.reasoning_effort, "low");
  });
  await withModes(() => ({ configEffort: () => "medium" }), async ({ session }) => {
    await session.modesReady;
    session.setMode("plan");
    assert.ok(!session.state.notices.some((n) => n.code === "mode.model"), "no notice when Plan's effort is the configured one");
  });
});

test("modes (review #2): the echoes of quick switches never flip the mode back", async () => {
  await withModes(none, async ({ session }) => {
    await session.modesReady;
    await session.submit("fail-turn").done;
    const seen = [];
    session.on("change", () => seen.push(session.state.mode.kind));
    session.setMode("plan");
    session.setMode("default");
    session.setMode("plan");
    const from = seen.length;
    await sleep(300);
    assert.deepEqual([...new Set(seen.slice(from))], seen.slice(from).length ? ["plan"] : [], `the mode went: ${seen.join(" ")}`);
    assert.equal(session.state.mode.kind, "plan");
  });
});

test("modes (review #4): a restart whose engine has no presets leaves Plan for Default", async () => {
  await withModes(
    (make) => ({ restart: () => make({ env: { FAKE_NO_MODES: "1" } }) }),
    async ({ session, engine }) => {
      await session.modesReady;
      session.setMode("plan");
      await session.submit("fail-turn").done;
      engine.server.request("test/crash", {}).catch(() => {});
      await until(() => session.state.engine.state === "ready" && session.state.mode.presets?.length === 0, "the restart without presets");
      assert.equal(session.state.mode.kind, "default");
    },
  );
});
