// The EngineManager (P3.4): one engine per id per ad process, leases, idle stop, stale
// restarts. Against a stub factory: what is under test is the bookkeeping.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createEngineManager } from "../src/engine/manager.mjs";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function stubFactory({ closeMs = 0, failFirst = false } = {}) {
  const made = [];
  let n = 0;
  const factory = async ({ engineId, home, args, env }) => {
    n++;
    if (failFirst && n === 1) throw Object.assign(new Error("spawn failed"), { code: "ENGINE_SPAWN_FAILED" });
    const e = new EventEmitter();
    Object.assign(e, { engineId, home, args, env, n, running: true });
    e.close = async () => {
      await tick(closeMs);
      e.running = false;
      e.emit("exit", {});
    };
    made.push(e);
    return e;
  };
  return { factory, made, live: () => made.filter((e) => e.running) };
}

test("two acquires → one spawn; list shows the leases", async () => {
  const s = stubFactory();
  const m = createEngineManager({ factory: s.factory, homeFor: (id) => (id === "api" ? "api-home" : id), idleMs: 10_000 });
  const [a, b] = await Promise.all([m.acquire("api"), m.acquire("api")]);
  assert.equal(s.made.length, 1);
  assert.equal(a.engine, b.engine);
  assert.equal(a.engine.home, "api-home");
  assert.deepEqual(m.list().map((x) => [x.engineId, x.leases]), [["api", 2]]);
  await m.closeAll();
  assert.equal(s.live().length, 0);
});

test("idle stop after idleMs unless pinned", async () => {
  const s = stubFactory();
  const m = createEngineManager({ factory: s.factory, idleMs: 30 });
  const a = await m.acquire("api");
  a.release();
  a.release(); // twice is harmless
  await tick(80);
  assert.equal(s.live().length, 0, "stopped when idle");
  assert.deepEqual(m.list(), []);
  const p = await m.acquire("acct_1", { pin: true });
  p.release();
  await tick(80);
  assert.equal(p.engine.running, true, "a pinned engine stays with no lease");
  await m.closeAll();
  assert.equal(s.live().length, 0);
});

test("stale + busy → no restart; idle → one restart, and leases follow the new engine", async () => {
  const s = stubFactory();
  let args = ["-c", "model_providers.a={…}"];
  const m = createEngineManager({ factory: s.factory, argsFor: () => args, idleMs: 10_000 });
  const lease = await m.acquire("api");
  assert.equal(await m.stale("api"), false);
  args = ["-c", "model_providers.a={…}", "-c", "model_providers.b={…}"];
  assert.equal(await m.stale("api"), true);
  lease.busy(true);
  assert.equal(await m.restartIfStale("api"), false);
  assert.equal(s.made.length, 1);
  lease.busy(false);
  assert.equal(await m.restartIfStale("api"), true);
  assert.equal(s.made.length, 2);
  assert.equal(s.live().length, 1);
  assert.equal(lease.engine, s.made[1]);
  assert.deepEqual(lease.engine.args, args);
  assert.equal(await m.restartIfStale("api"), false, "no longer stale");
  await m.closeAll();
});

test("acquire during an idle stop waits for the exit, then respawns; never two engines on one id", async () => {
  const s = stubFactory({ closeMs: 60 });
  const m = createEngineManager({ factory: s.factory, idleMs: 10 });
  const a = await m.acquire("api");
  a.release();
  await tick(25); // the idle stop has begun; close takes 60 ms
  assert.equal(s.made[0].running, true, "still closing");
  let overlap = false;
  const watch = setInterval(() => {
    if (s.live().length > 1) overlap = true;
  }, 2);
  const b = await m.acquire("api");
  clearInterval(watch);
  assert.equal(overlap, false);
  assert.equal(s.made.length, 2);
  assert.equal(s.made[0].running, false);
  assert.equal(b.engine, s.made[1]);
  await m.closeAll();
});

test("a failing spawn rejects acquire and leaves no process; the next acquire tries again", async () => {
  const s = stubFactory({ failFirst: true });
  const m = createEngineManager({ factory: s.factory, idleMs: 10_000 });
  await assert.rejects(m.acquire("api"), { code: "ENGINE_SPAWN_FAILED" });
  assert.deepEqual(m.list(), []);
  assert.equal(s.live().length, 0);
  const a = await m.acquire("api");
  assert.equal(a.engine.running, true);
  await m.closeAll();
});

test("an engine that exits on its own leaves the table: the next acquire starts a new one", async () => {
  const s = stubFactory();
  const m = createEngineManager({ factory: s.factory, idleMs: 10_000 });
  const a = await m.acquire("api");
  a.release();
  await s.made[0].close();
  const b = await m.acquire("api");
  assert.equal(s.made.length, 2);
  assert.equal(b.engine.running, true);
  await m.closeAll();
});

test("homeFor, envFor and argsFor reach the factory; closeAll refuses later acquires", async () => {
  const s = stubFactory();
  const m = createEngineManager({ factory: s.factory, homeFor: () => "H", envFor: () => ({ AD_GATEWAY_TOKEN: "t" }), argsFor: () => ["-c", "x=1"] });
  const a = await m.acquire("api");
  assert.equal(a.engine.home, "H");
  assert.deepEqual(a.engine.env, { AD_GATEWAY_TOKEN: "t" });
  assert.deepEqual(a.engine.args, ["-c", "x=1"]);
  await m.closeAll();
  await assert.rejects(m.acquire("api"), { code: "MANAGER_CLOSED" });
});

test("restart keeps the cwd of the first acquire", async () => {
  const cwds = [];
  const s = stubFactory();
  const m = createEngineManager({ factory: (o) => (cwds.push(o.cwd), s.factory(o)), idleMs: 10_000 });
  await m.acquire("api", { cwd: "/proj" });
  await m.restart("api");
  assert.deepEqual(cwds, ["/proj", "/proj"]);
  await m.closeAll();
});

test("restart during an idle stop waits for it and never leaves an engine running past closeAll", async () => {
  const s = stubFactory({ closeMs: 60 });
  const m = createEngineManager({ factory: s.factory, idleMs: 10 });
  const a = await m.acquire("api");
  a.release();
  await tick(25); // the idle stop is closing
  await assert.rejects(m.restart("api"), { code: "ENGINE_UNKNOWN" });
  await m.closeAll();
  assert.equal(s.live().length, 0);
});

test("closeAll during a start: the starting engine is closed and the acquire rejects", async () => {
  const made = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const factory = async () => {
    await gate;
    const e = new EventEmitter();
    e.running = true;
    e.close = async () => {
      e.running = false;
    };
    made.push(e);
    return e;
  };
  const m = createEngineManager({ factory });
  const p = m.acquire("api");
  await tick(5);
  const closing = m.closeAll();
  release();
  await assert.rejects(p, { code: "MANAGER_CLOSED" });
  await closing;
  assert.equal(made.length, 1);
  assert.equal(made[0].running, false);
});
