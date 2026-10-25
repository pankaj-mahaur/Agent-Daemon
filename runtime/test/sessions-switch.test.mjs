// P4.2: the switch's pure parts: how a target is reached, when it is safe, and the steps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SWITCH_TEXTS, safePoint, step, switchHow } from "../src/sessions/switch.mjs";

const A = { modelProvider: "ad-or-a", homeKey: "api", provider: "openrouter", model: "qwen3-coder", passthrough: true };

test("switchHow: the same account is the next turn; a same-provider direct same-model target forks; anything else continues", () => {
  assert.equal(switchHow({ from: A, to: { ...A, model: "other" } }), "nextTurn", "another model on the same account");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b" } }), "fork");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b", passthrough: false } }), "continuation", "bridged target");
  assert.equal(switchHow({ from: { ...A, passthrough: false }, to: { ...A, modelProvider: "ad-or-b" } }), "continuation", "bridged source");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b", model: "other" } }), "continuation", "a model change with the account");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-oa-c", provider: "openai" } }), "continuation", "another provider");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b", homeKey: "a/7q2k" } }), "continuation", "another home");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b" }, goal: true, canDefer: false }), "continuation", "a goal without the deferGoal gate");
  assert.equal(switchHow({ from: A, to: { ...A, modelProvider: "ad-or-b" }, goal: true, canDefer: true }), "fork");
});

const idle = { activeTurnId: null, starting: false, threadStarting: false, goal: null, requests: 0, foregroundTools: 0, subagents: 0, unknownNonRead: [], idle: true };

test("safePoint: idle is safe; a running turn, an unpaused goal or a thread still starting waits", () => {
  assert.deepEqual(safePoint(idle, { mode: "wait" }), { ok: true });
  assert.equal(safePoint({ ...idle, activeTurnId: "t" }, { mode: "wait" }).wait, "turn");
  assert.equal(safePoint({ ...idle, starting: true }, { mode: "wait" }).wait, "turn");
  assert.equal(safePoint({ ...idle, goal: "active" }, { mode: "now" }).wait, "goal", "a goal not yet paused blocks the safe point");
  assert.deepEqual(safePoint({ ...idle, goal: "paused" }, { mode: "now" }), { ok: true });
  assert.equal(safePoint({ ...idle, idle: false }, { mode: "now" }).wait, "turn", "the engine says the thread isn't idle");
});

test("safePoint: an open request: now withdraws it, wait asks for an answer first", () => {
  assert.deepEqual(safePoint({ ...idle, requests: 1 }, { mode: "now" }), { decline: true });
  assert.deepEqual(safePoint({ ...idle, requests: 1 }, { mode: "wait" }), { wait: "request", text: SWITCH_TEXTS.ANSWER_FIRST });
});

test("safePoint: a subagent waits, then (after its time) pauses; an unknown non-read tool pauses unless the user said switch anyway", () => {
  assert.equal(safePoint({ ...idle, subagents: 1 }, { mode: "now" }).wait, "subagent");
  assert.deepEqual(safePoint({ ...idle, subagents: 1 }, { mode: "now", subagentWaitOver: true }), { pause: "subagent", text: SWITCH_TEXTS.SUBAGENT });
  const p = safePoint({ ...idle, unknownNonRead: ["npm run deploy"] }, { mode: "now" });
  assert.equal(p.pause, "unknown");
  assert.equal(p.text, SWITCH_TEXTS.UNKNOWN("npm run deploy"));
  assert.deepEqual(safePoint({ ...idle, unknownNonRead: ["npm run deploy"] }, { mode: "now", anyway: true }), { ok: true });
  assert.equal(safePoint({ ...idle, foregroundTools: 1 }, { mode: "now" }).wait, "turn");
});

test("safePoint: a background terminal never blocks a manual switch", () => {
  assert.deepEqual(safePoint({ ...idle, terminals: 2 }, { mode: "now" }), { ok: true });
});

// The machine, driven event by event: effects name what the coordinator does next.
const kinds = (r) => r.effects.map((e) => e.type);

test("step: request → quiescing (hold, pause the goal; now also interrupts) → safe point → target → bound → committed", () => {
  let r = step({ state: "RUNNING" }, { type: "request", target: { label: "B" }, mode: "now", how: "fork" });
  assert.equal(r.state.state, "QUIESCING");
  assert.deepEqual(kinds(r), ["ledger", "hold", "pauseGoal", "interrupt", "checkSafe"]);
  assert.equal(r.effects[0].event.type, "switchRequested");
  r = step(r.state, { type: "safe", check: { ok: true } });
  assert.equal(r.state.state, "SAFE_POINT");
  assert.deepEqual(kinds(r), ["checkpoint", "prepareTarget"]);
  r = step(r.state, { type: "targetReady" });
  assert.equal(r.state.state, "TARGET_READY");
  assert.deepEqual(kinds(r), ["confirmIdle"]);
  r = step(r.state, { type: "idleConfirmed" });
  assert.equal(r.state.state, "BINDING_STARTED");
  assert.deepEqual(kinds(r), ["bind"]);
  assert.equal(r.effects[0].how, "fork");
  r = step(r.state, { type: "bound", threadId: "new" });
  assert.equal(r.state.state, "RUNNING");
  assert.deepEqual(kinds(r), ["commit", "ledger", "hold", "notice"]);
  assert.equal(r.effects[1].event.type, "switchCommitted");
  assert.equal(r.effects[2].on, false);
});

test("step: mode wait doesn't interrupt; it checks again at each turn's end", () => {
  let r = step({ state: "RUNNING" }, { type: "request", target: { label: "B" }, mode: "wait", how: "continuation" });
  assert.deepEqual(kinds(r), ["ledger", "hold", "pauseGoal", "checkSafe"]);
  r = step(r.state, { type: "safe", check: { wait: "turn" } });
  assert.equal(r.state.state, "QUIESCING");
  assert.deepEqual(kinds(r), []);
  r = step(r.state, { type: "turnCompleted" });
  assert.deepEqual(kinds(r), ["checkSafe"]);
});

test("step: an open request in mode now is withdrawn, then checked again", () => {
  const r = step({ state: "QUIESCING", mode: "now", target: {}, how: "fork", restarts: 0 }, { type: "safe", check: { decline: true } });
  assert.deepEqual(kinds(r), ["declineRequests", "checkSafe"]);
});

test("step: a turn the engine starts after the idle check goes back to quiescing; the third time it pauses", () => {
  let s = { state: "TARGET_READY", mode: "now", target: { label: "B" }, how: "fork", restarts: 0 };
  for (let i = 1; i <= 2; i++) {
    const r = step(s, { type: "turnStarted" });
    assert.equal(r.state.state, "QUIESCING", `restart ${i}`);
    assert.deepEqual(kinds(r), ["pauseGoal", "interrupt", "checkSafe"]);
    s = { ...r.state, state: "TARGET_READY" };
  }
  const r = step(s, { type: "turnStarted" });
  assert.equal(r.state.state, "PAUSED_NEEDS_USER");
  assert.equal(r.state.reason, "selfStarting");
});

test("step: an unknown effect pauses; 'Switch anyway' goes on, Cancel aborts", () => {
  let r = step({ state: "QUIESCING", mode: "now", target: { label: "B" }, how: "fork", restarts: 0 }, { type: "safe", check: { pause: "unknown", text: "x" } });
  assert.equal(r.state.state, "PAUSED_NEEDS_USER");
  assert.deepEqual(kinds(r), ["ask"]);
  const on = step(r.state, { type: "anyway" });
  assert.equal(on.state.state, "QUIESCING");
  assert.equal(on.state.anyway, true);
  assert.deepEqual(kinds(on), ["checkSafe"]);
  const off = step(r.state, { type: "cancel" });
  assert.equal(off.state.state, "RUNNING");
  assert.deepEqual(kinds(off), ["ledger", "releaseTarget", "resumeGoal", "hold", "notice"]);
  assert.equal(off.effects[0].event.type, "switchAborted");
});

test("step: a failure before commit aborts: the goal resumes on the old thread, hold ends, the user is told why", () => {
  const r = step({ state: "BINDING_STARTED", mode: "now", target: { label: "OpenRouter · work · qwen3-coder" }, from: { label: "OpenAI · me · gpt-5" }, how: "fork", restarts: 0 }, { type: "fail", reason: "kept" });
  assert.equal(r.state.state, "RUNNING");
  assert.deepEqual(kinds(r), ["ledger", "releaseTarget", "resumeGoal", "hold", "notice"]);
  assert.equal(r.effects.at(-1).text, SWITCH_TEXTS.ABORT("OpenRouter · work · qwen3-coder", SWITCH_TEXTS.REASONS.kept, "OpenAI · me · gpt-5"));
});

test("step: a second request while one runs is refused; events outside a switch change nothing", () => {
  const busy = step({ state: "QUIESCING", mode: "now", target: {}, how: "fork", restarts: 0 }, { type: "request", target: {}, mode: "now", how: "fork" });
  assert.equal(busy.state.state, "QUIESCING");
  assert.deepEqual(kinds(busy), ["notice"]);
  const quiet = step({ state: "RUNNING" }, { type: "turnCompleted" });
  assert.deepEqual(quiet, { state: { state: "RUNNING" }, effects: [] });
});

test("step: a quiesce timeout pauses for the user", () => {
  const r = step({ state: "QUIESCING", mode: "now", target: {}, how: "fork", restarts: 0 }, { type: "timeout" });
  assert.equal(r.state.state, "PAUSED_NEEDS_USER");
  assert.equal(r.state.reason, "timeout");
});

test("recoverSwitch: crash windows: requested only → abort; a new binding without a commit → commit; committed → nothing", async () => {
  const { recoverSwitch } = await import("../src/sessions/switch.mjs");
  const req = { type: "switchRequested", target: "k" };
  assert.deepEqual(recoverSwitch([{ type: "created" }, req]), { abort: "crash" });
  assert.deepEqual(recoverSwitch([req, { type: "bindingEnded", gen: 1 }, { type: "bindingStarted", gen: 2, binding: { gen: 2 } }]), { commit: { gen: 2 } });
  assert.equal(recoverSwitch([req, { type: "bindingStarted", gen: 2 }, { type: "switchCommitted" }]), null);
  assert.equal(recoverSwitch([req, { type: "switchAborted" }]), null);
  assert.equal(recoverSwitch([{ type: "bindingStarted", gen: 1 }]), null);
});

test("step: Cancel while the new thread is being bound doesn't abort: the switch finishes", () => {
  const r = step({ state: "BINDING_STARTED", mode: "now", target: {}, how: "continuation", restarts: 0 }, { type: "cancel" });
  assert.equal(r.state.state, "BINDING_STARTED");
  assert.deepEqual(r.effects, [{ type: "notice", level: "info", text: SWITCH_TEXTS.FINISHING }]);
});
