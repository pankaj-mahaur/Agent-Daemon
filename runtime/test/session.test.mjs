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

async function withSession(opts, fn) {
  const root = mkdtempSync(join(tmpdir(), "ad-session-"));
  const lockDir = join(root, "locks");
  const engines = [];
  const make = async () => {
    const e = await createEngine({ home: join(root, "home"), command });
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
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t2.lock"), "not json");
    lockThread("t2", { dir, pid: 333, isAlive: () => true })();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming a thread another session holds fails with SessionLockedError", async () => {
  await withSession(none, async ({ session, engine, root, lockDir }) => {
    await session.submit("fail-turn").done;
    const threadId = session.state.thread.id;
    session.newThread(); // this process lets go
    // Another live ad (our parent process stands in for it) holds the thread.
    writeFileSync(join(lockDir, `${threadId}.lock`), JSON.stringify({ pid: process.ppid, startedAt: 0, threadId }));
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
    session.queue("first");
    session.queue("second");
    session.queue("third");
    assert.ok(session.editQueued(1, "fail-turn"));
    assert.ok(session.editQueued(0, null));
    assert.ok(!session.editQueued(9, "x"));
    assert.deepEqual(session.state.queue.map((q) => q.text), ["fail-turn", "third"]);
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

test("resume loads the thread's history in order, with full items", async () => {
  await withSession(none, async ({ session, engine, root, lockDir }) => {
    const a = session.submit("early-complete");
    await a.done;
    await session.submit("fail-turn").done;
    const threadId = session.state.thread.id;
    session.newThread();
    assert.equal(session.state.thread, null);
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
    assert.ok(["closed", "completed"].includes(r.status));
    assert.throws(() => session.submit("x"), /closed/);
  });
});
