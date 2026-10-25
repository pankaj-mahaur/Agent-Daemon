// P4.1: the coordinator turns a session's observer events into its ledger and index.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coord-"));
const saved = { AD_ROOT: process.env.AD_ROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.AD_ROOT = path.join(TMP, ".agent-daemon");
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const { createCoordinator } = await import("../src/sessions/coordinator.mjs");
const { readLedger } = await import("../src/sessions/ledger.mjs");
const { readIndex } = await import("../src/sessions/index.mjs");

const target = { accountId: "acct_1", provider: "openrouter", model: "m", effort: null, key: "acct_1/openrouter/m/-" };
const make = () => createCoordinator({ cwd: path.join(TMP, "work"), origin: "tui", homeKey: () => "engine", targetOf: () => target });
const types = (c) => readLedger(c.sessionId()).map((e) => e.type);
const cmd = (id, status, extra = {}) => ({ type: "commandExecution", id, command: "npm test", commandActions: [{ type: "unknown" }], status, ...extra });

test("a turn with a command and an approval writes its events in order, with the binding's target", async () => {
  const c = make();
  const o = c.observer;
  o({ type: "thread.attached", threadId: "th1", how: "new" });
  o({ type: "user.message", clientId: "c1", input: "run the tests", via: "submit" });
  o({ type: "turn.started", threadId: "th1", turnId: "t1" });
  o({ type: "item.started", threadId: "th1", turnId: "t1", item: cmd("i1", "inProgress") });
  o({ type: "request.answered", request: { kind: "commandApproval", itemId: "i1", turnId: "t1", threadId: "th1" }, decision: "accept" });
  o({ type: "item.completed", threadId: "th1", turnId: "t1", item: cmd("i1", "completed", { exitCode: 0 }) });
  o({ type: "turn.completed", threadId: "th1", turnId: "t1", status: "completed" });
  assert.deepEqual(types(c), ["created", "bindingStarted", "userMessage", "turnStarted", "toolIntent", "approvalDecision", "toolResult", "turnCompleted"]);
  const ev = readLedger(c.sessionId());
  assert.equal(ev[1].binding.target.key, target.key);
  assert.equal(ev[3].trigger, "user");
  assert.equal(ev[4].effect, "exec");
  assert.equal(ev[6].status, "succeeded");
  await c.close();
  const ix = readIndex();
  assert.equal(ix.sessions[c.sessionId()].state, "closed");
  assert.equal(ix.threads["engine|th1"], c.sessionId());
  assert.equal(ix.sessions[c.sessionId()].title, "run the tests");
});

test("an engine crash mid-command leaves the tool unknown, on disk", async () => {
  const c = make();
  c.observer({ type: "thread.attached", threadId: "th2", how: "new" });
  c.observer({ type: "user.message", clientId: "c", input: "go", via: "submit" });
  c.observer({ type: "turn.started", threadId: "th2", turnId: "t" });
  c.observer({ type: "item.started", threadId: "th2", turnId: "t", item: cmd("x", "inProgress") });
  c.observer({ type: "engine.exited", code: 1 });
  const last = readLedger(c.sessionId()).filter((e) => e.type === "toolResult");
  assert.equal(last.at(-1).status, "unknown");
  assert.ok(types(c).includes("bindingEnded"));
  await c.close();
});

test("a subagent's interrupted collab call: its child turn's running write becomes unknown at the root turn's end", async () => {
  const c = make();
  const o = c.observer;
  o({ type: "thread.attached", threadId: "root", how: "new" });
  o({ type: "user.message", clientId: "c", input: "fix it", via: "submit" });
  o({ type: "turn.started", threadId: "root", turnId: "rt" });
  o({ type: "item.started", threadId: "root", turnId: "rt", item: { type: "collabAgentToolCall", id: "co", tool: "spawnAgent", status: "inProgress", receiverThreadIds: ["kid"] } });
  o({ type: "turn.started", threadId: "kid", turnId: "kt" });
  o({ type: "item.started", threadId: "kid", turnId: "kt", item: { type: "fileChange", id: "fc", status: "inProgress", changes: [{ path: path.join(TMP, "work", "src", "a.js") }] } });
  o({ type: "item.completed", threadId: "root", turnId: "rt", item: { type: "collabAgentToolCall", id: "co", tool: "spawnAgent", status: "interrupted", receiverThreadIds: ["kid"] } });
  o({ type: "turn.completed", threadId: "root", turnId: "rt", status: "interrupted" });
  const ev = readLedger(c.sessionId());
  const kidStart = ev.find((e) => e.type === "turnStarted" && e.thread === "kid");
  assert.equal(kidStart.trigger, "subagent");
  assert.equal(kidStart.parentTurnId, "rt");
  const intent = ev.find((e) => e.type === "toolIntent" && e.itemId === "fc");
  assert.equal(intent.rootTurnId, "rt");
  assert.deepEqual(intent.paths, [path.join("src", "a.js")], "relative to the project");
  assert.equal(ev.find((e) => e.type === "toolResult" && e.itemId === "co").status, "unknown", "interrupted collab");
  assert.equal(ev.find((e) => e.type === "toolResult" && e.itemId === "fc").status, "unknown", "the child's write");
  await c.close();
});

test("a turn the engine starts by itself is logged with trigger engine; with a goal active, goal; ad's own, ad", async () => {
  const c = make();
  const o = c.observer;
  o({ type: "thread.attached", threadId: "th3", how: "new" });
  o({ type: "user.message", clientId: "c", input: "hi", via: "submit" });
  o({ type: "turn.started", threadId: "th3", turnId: "a" });
  o({ type: "turn.completed", threadId: "th3", turnId: "a", status: "completed" });
  o({ type: "turn.started", threadId: "th3", turnId: "b" });
  o({ type: "thread.goal", threadId: "th3", goal: { status: "active" } });
  o({ type: "turn.started", threadId: "th3", turnId: "c" });
  c.markAdTurn();
  o({ type: "turn.started", threadId: "th3", turnId: "d" });
  const trig = readLedger(c.sessionId()).filter((e) => e.type === "turnStarted").map((e) => e.trigger);
  assert.deepEqual(trig, ["user", "engine", "goal", "ad"]);
  assert.ok(types(c).includes("goalResumed"));
  await c.close();
});

test("resume of a thread ad never saw adopts it; zero turns write nothing", async () => {
  const quiet = make();
  quiet.observer({ type: "thread.attached", threadId: "nothing", how: "new" });
  assert.equal(quiet.sessionId(), null);
  await quiet.close();
  const c = make();
  c.observer({ type: "thread.attached", threadId: "old-thread", how: "resume" });
  c.observer({ type: "user.message", clientId: "c", input: "continue", via: "submit" });
  const ev = readLedger(c.sessionId());
  assert.equal(ev[0].origin, "adopted");
  assert.equal(ev[0].adoptedFrom, "old-thread");
  assert.equal(ev[1].binding.how, "adopted");
  await c.close();
});

test("a switch to another thread ends one binding and starts the next (gen 2); a turn on the old thread is a violation", async () => {
  const c = make();
  const o = c.observer;
  o({ type: "thread.attached", threadId: "first", how: "new" });
  o({ type: "user.message", clientId: "c", input: "a", via: "submit" });
  o({ type: "thread.attached", threadId: "second", how: "fork" });
  o({ type: "turn.started", threadId: "first", turnId: "late" });
  const ev = readLedger(c.sessionId());
  assert.deepEqual(ev.filter((e) => e.type.startsWith("binding")).map((e) => `${e.type}:${e.gen}`), ["bindingStarted:1", "bindingEnded:1", "bindingStarted:2"]);
  assert.equal(ev.find((e) => e.type === "bindingStarted" && e.gen === 2).binding.how, "fork");
  assert.equal(ev.at(-1).type, "violation");
  assert.equal(c.status().gen, 2);
  await c.close();
});

test("through a real session on the fake engine: one edit with its approval, private prompts kept private", async () => {
  const { createEngine } = await import("../src/engine/index.mjs");
  const { createSession } = await import("../src/harness/session.mjs");
  const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
  const root = fs.mkdtempSync(path.join(TMP, "s-"));
  const engine = await createEngine({ home: path.join(root, "home"), command: { cmd: process.execPath, prefix: [FAKE] } });
  const c = createCoordinator({ cwd: root, origin: "tui", homeKey: () => "engine", targetOf: () => target });
  const session = createSession({ engine, cwd: root, lockDir: path.join(root, "locks"), observer: c.observer });
  // Approvals are answered as they arrive (a change event names them).
  session.on("change", () => {
    for (const r of [...session.state.requests]) session.resolve(r.request.id, "accept");
  });
  try {
    await session.submit("<private>secret plan</private>").done;
    await session.submit("edit-file").done;
    const ev = readLedger(c.sessionId());
    const t = ev.map((e) => e.type);
    assert.ok(t.includes("toolIntent") && t.includes("approvalDecision"), t.join(","));
    assert.equal(ev.find((e) => e.type === "toolIntent").effect, "write");
    const priv = ev.find((e) => e.type === "userMessage" && e.private);
    assert.equal(priv.text, null);
    assert.ok(!fs.readFileSync(path.join(process.env.AD_ROOT, "sessions", `${c.sessionId()}.jsonl`), "utf8").includes("secret plan"));
  } finally {
    session.close();
    await engine.close();
    await c.close();
  }
});

test("a session open in another window: one notice, and this window records nothing", async () => {
  const a = make();
  a.observer({ type: "thread.attached", threadId: "shared", how: "new" });
  a.observer({ type: "user.message", clientId: "c", input: "one", via: "submit" });
  await a.flush();
  const b = make();
  b.observer({ type: "thread.attached", threadId: "shared", how: "resume" });
  assert.throws(() => b.observer({ type: "user.message", clientId: "d", input: "two", via: "submit" }), (e) => e.code === "SESSION_LEDGER_BUSY" && /another ad window/.test(e.notice));
  assert.equal(b.observer({ type: "user.message", clientId: "e", input: "three", via: "submit" }), undefined);
  assert.equal(b.sessionId(), null);
  await b.close();
  await a.close();
  assert.equal(readLedger(a.sessionId()).filter((e) => e.type === "userMessage").length, 1);
});

test("a torn tail found on reopen comes back as one notice", async () => {
  const a = make();
  a.observer({ type: "thread.attached", threadId: "torn", how: "new" });
  a.observer({ type: "user.message", clientId: "c", input: "one", via: "submit" });
  const id = a.sessionId();
  await a.close();
  fs.appendFileSync(path.join(process.env.AD_ROOT, "sessions", `${id}.jsonl`), '{"v":1,"seq":99,"type":"turnSta');
  const b = make();
  b.observer({ type: "thread.attached", threadId: "torn", how: "resume" });
  const r = b.observer({ type: "user.message", clientId: "d", input: "two", via: "submit" });
  assert.equal(b.sessionId(), id, "the known thread's session");
  assert.match(r?.notice?.message ?? "", /Repaired the session record/);
  await b.close();
});

test("ad sessions show: --last as text and --json; a bad id and an empty root say so", async () => {
  const { cmdSessions } = await import("../src/sessions/show.mjs");
  const c = make();
  c.observer({ type: "thread.attached", threadId: "shown", how: "new" });
  c.observer({ type: "user.message", clientId: "c", input: "show me", via: "submit" });
  c.observer({ type: "turn.started", threadId: "shown", turnId: "t" });
  c.observer({ type: "item.started", threadId: "shown", turnId: "t", item: { id: "i", kind: "commandExecution", command: "npm test", actions: [], status: "inProgress" } });
  c.observer({ type: "item.completed", threadId: "shown", turnId: "t", item: { id: "i", kind: "commandExecution", command: "npm test", actions: [], status: "completed", exitCode: 0 } });
  c.observer({ type: "turn.completed", threadId: "shown", turnId: "t", status: "completed" });
  await c.close();
  const sink = () => ({ text: "", write(s) { this.text += s; return true; } });
  const out = sink();
  assert.equal(await cmdSessions("show", { last: true, stdout: out, stderr: sink() }), 0);
  assert.match(out.text, new RegExp(`^${c.sessionId()}  show me`));
  assert.match(out.text, /binding 1 {2}openrouter m · engine · thread shown \(new\) · ended: close/);
  assert.match(out.text, /exec {2}succeeded {2}npm test/, "a normalized item, as a session sends it");
  const js = sink();
  assert.equal(await cmdSessions("show", { id: c.sessionId(), json: true, stdout: js, stderr: sink() }), 0);
  const s = JSON.parse(js.text);
  assert.equal(s.turns[0].tools[0].status, "succeeded");
  assert.equal(s.bindings[0].target.key, target.key);
  const err = sink();
  assert.equal(await cmdSessions("show", { id: "../etc", stdout: sink(), stderr: err }), 2);
  assert.match(err.text, /isn't a session id/);
  const none = sink();
  assert.equal(await cmdSessions("show", { root: path.join(TMP, "empty"), stdout: sink(), stderr: none }), 1);
  assert.match(none.text, /no sessions recorded yet/);
  assert.equal(await cmdSessions("list", { stdout: sink(), stderr: sink() }), 2);
});

// ---- Review P4.1 ----

const start = (c, thread, text = "go") => {
  c.observer({ type: "thread.attached", threadId: thread, how: "new" });
  c.observer({ type: "user.message", clientId: `c-${thread}`, input: text, via: "submit" });
};

test("after an engine restart the same thread is a new binding (continuation): its turns are no violation and settle", async () => {
  const c = make();
  const o = c.observer;
  start(c, "r1");
  o({ type: "turn.started", threadId: "r1", turnId: "a" });
  o({ type: "engine.exited", code: 1 });
  o({ type: "thread.attached", threadId: "r1", how: "continuation" });
  o({ type: "user.message", clientId: "c2", input: "again", via: "submit" });
  o({ type: "turn.started", threadId: "r1", turnId: "b" });
  o({ type: "item.started", threadId: "r1", turnId: "b", item: cmd("x", "inProgress") });
  o({ type: "turn.completed", threadId: "r1", turnId: "b", status: "completed" });
  const ev = readLedger(c.sessionId());
  assert.ok(!ev.some((e) => e.type === "violation"), ev.map((e) => e.type).join());
  assert.deepEqual(ev.filter((e) => e.type.startsWith("binding")).map((e) => `${e.type}:${e.gen}:${e.reason ?? e.binding.how}`), ["bindingStarted:1:new", "bindingEnded:1:engineLost", "bindingStarted:2:continuation"]);
  assert.equal(ev.find((e) => e.type === "turnStarted" && e.turnId === "b").trigger, "user");
  assert.equal(ev.filter((e) => e.type === "toolResult" && e.itemId === "x").at(-1).status, "unknown", "settled at the turn's end");
  await c.close();
});

test("a /private prompt with an image after it is stored without its text", async () => {
  const c = make();
  start(c, "p1", "<private>my plan</private>\n[image C:\\a.png]");
  const m = readLedger(c.sessionId()).find((e) => e.type === "userMessage");
  assert.equal(m.text, null);
  assert.equal(m.private, true);
  await c.close();
  assert.equal(readIndex().sessions[c.sessionId()].title, null, "nor its title");
});

test("a subagent's first turn before its spawn item names it is still a subagent turn, settled with the root", async () => {
  const c = make();
  const o = c.observer;
  start(c, "root2");
  o({ type: "turn.started", threadId: "root2", turnId: "rt" });
  o({ type: "turn.started", threadId: "kid2", turnId: "kt" });
  o({ type: "item.started", threadId: "kid2", turnId: "kt", item: { type: "fileChange", id: "w", status: "inProgress", changes: [] } });
  o({ type: "item.started", threadId: "root2", turnId: "rt", item: { type: "collabAgentToolCall", id: "co", tool: "spawnAgent", status: "inProgress", receiverThreadIds: ["kid2"] } });
  o({ type: "turn.completed", threadId: "root2", turnId: "rt", status: "interrupted" });
  const ev = readLedger(c.sessionId());
  assert.ok(!ev.some((e) => e.type === "violation"));
  assert.equal(ev.find((e) => e.type === "turnStarted" && e.turnId === "kt").parentTurnId, "rt");
  assert.equal(ev.find((e) => e.type === "toolResult" && e.itemId === "w").status, "unknown");
  await c.close();
});

test("reopening a closed session continues its generations, reopens it in the index and moves it to the top", async () => {
  const a = make();
  start(a, "again1", "first");
  const id = a.sessionId();
  await a.close();
  const other = make();
  start(other, "later", "a later one");
  await other.close();
  const b = make();
  b.observer({ type: "thread.attached", threadId: "again1", how: "resume" });
  b.observer({ type: "user.message", clientId: "d", input: "more", via: "submit" });
  await b.flush();
  assert.equal(b.sessionId(), id);
  const ev = readLedger(id).filter((e) => e.type === "bindingStarted");
  assert.deepEqual(ev.map((e) => `${e.gen}:${e.binding.how}`), ["1:new", "2:continuation"]);
  assert.equal(readIndex().sessions[id].state, "open");
  const { lastSessionId } = await import("../src/sessions/show.mjs");
  assert.equal(lastSessionId(), id);
  await b.close();
});

test("/resume of another session's thread mid-session closes this one; an unknown resume then /new is not adopted", async () => {
  const theirs = make();
  start(theirs, "theirs");
  const theirId = theirs.sessionId();
  await theirs.close();
  const c = make();
  const o = c.observer;
  start(c, "mine");
  const mine = c.sessionId();
  o({ type: "thread.detached", threadId: "mine", reason: "abandoned" });
  o({ type: "thread.attached", threadId: "theirs", how: "resume" });
  assert.equal(c.status(), null, "this session ended");
  await c.flush();
  assert.equal(readIndex().sessions[mine].state, "closed");
  assert.equal(readIndex().threads["engine|theirs"], theirId, "the other session keeps its thread");
  o({ type: "user.message", clientId: "e", input: "go on", via: "submit" });
  assert.equal(c.sessionId(), theirId);
  await c.close();
  const d = make();
  d.observer({ type: "thread.attached", threadId: "never-seen", how: "resume" });
  d.observer({ type: "thread.detached", threadId: "never-seen", reason: "abandoned" });
  d.observer({ type: "thread.attached", threadId: "fresh", how: "new" });
  d.observer({ type: "user.message", clientId: "f", input: "new work", via: "submit" });
  const created = readLedger(d.sessionId())[0];
  assert.equal(created.origin, "tui");
  assert.equal(created.adoptedFrom, undefined);
  await d.close();
});

test("/new ends the session (newThread); a switch keeps it (switch); not resumed after a restart ends it too", async () => {
  const c = make();
  const o = c.observer;
  start(c, "s1");
  const first = c.sessionId();
  o({ type: "thread.detached", threadId: "s1", reason: "switched" });
  o({ type: "thread.attached", threadId: "s2", how: "fork" });
  assert.equal(c.sessionId(), first);
  o({ type: "thread.detached", threadId: "s2", reason: "abandoned" });
  const ends = readLedger(first).filter((e) => e.type === "bindingEnded").map((e) => e.reason);
  assert.deepEqual(ends, ["switch", "newThread"]);
  start(c, "s3", "next");
  assert.notEqual(c.sessionId(), first);
  o({ type: "thread.detached", threadId: "s3", reason: "notResumed" });
  assert.deepEqual(readLedger(c.sessionId()).filter((e) => e.type === "bindingEnded").map((e) => e.reason), ["threadNotResumed"]);
  await c.close();
});

test("a command's summary: the wrapper's program, its first line, long quoted text cut, 200 at most", async () => {
  const c = make();
  const o = c.observer;
  start(c, "sum");
  o({ type: "turn.started", threadId: "sum", turnId: "t" });
  const secret = "x".repeat(60);
  const commands = [`bash -lc "cat > notes.txt <<'EOF'\nline with contents\nEOF"`, `Set-Content a.txt -Value '${secret}'`, `echo ${"y".repeat(300)}`];
  commands.forEach((command, i) => o({ type: "item.started", threadId: "sum", turnId: "t", item: { type: "commandExecution", id: `s${i}`, command, commandActions: [], status: "inProgress" } }));
  const s = readLedger(c.sessionId()).filter((e) => e.type === "toolIntent").map((e) => e.summary);
  assert.ok(!s[0].includes("line with contents") && s[0].startsWith("cat > notes.txt"), s[0]);
  assert.ok(!s[1].includes(secret), s[1]);
  assert.ok(s[2].length <= 200, String(s[2].length));
  await c.close();
});

test("decisions are the enum only; a turn that fails to start doesn't leave a pending user turn", async () => {
  const c = make();
  const o = c.observer;
  start(c, "dec");
  o({ type: "turn.startFailed", clientId: "c-dec" });
  o({ type: "turn.started", threadId: "dec", turnId: "self" });
  for (const d of ["accept", "session", "my free-text answer"]) o({ type: "request.answered", request: { kind: "commandApproval" }, decision: d });
  const ev = readLedger(c.sessionId());
  assert.equal(ev.find((e) => e.type === "turnStarted").trigger, "engine");
  assert.deepEqual(ev.filter((e) => e.type === "approvalDecision").map((e) => e.decision), ["accept", "acceptForSession", "answered"]);
  await c.close();
});

test("ad sessions show prints no control characters from a recorded command", async () => {
  const { renderSession } = await import("../src/sessions/show.mjs");
  const out = renderSession({ sessionId: "ses_X", title: "t\u{1b}[2J", origin: "tui", state: "open", cwd: "/w", bindings: [], turns: [{ turnId: "t", trigger: "user", status: "completed", tools: [{ effect: "exec", status: "succeeded", summary: "echo \u{1b}]0;pwned\u{7}" }] }] });
  assert.ok(!/\p{Cc}/u.test(out.replace(/\n/g, "")), JSON.stringify(out));
});

// ---- Re-review P4.1 ----

test("a session still waiting for its first thread that gets another session's thread by /resume closes and leaves it to its owner", async () => {
  const owner = make();
  start(owner, "owned");
  const ownerId = owner.sessionId();
  await owner.close();
  const c = make();
  c.observer({ type: "user.message", clientId: "x", input: "first", via: "submit" }); // the thread start then failed
  const waiting = c.sessionId();
  c.observer({ type: "thread.attached", threadId: "owned", how: "resume" });
  await c.flush();
  assert.equal(readIndex().threads["engine|owned"], ownerId);
  assert.equal(readIndex().sessions[waiting].state, "closed");
  await c.close();
});

test("a subagent turn that outlives its root turn settles its own running tools when it ends; its sibling's stay running", async () => {
  const c = make();
  const o = c.observer;
  start(c, "rootX");
  o({ type: "turn.started", threadId: "rootX", turnId: "r" });
  o({ type: "turn.started", threadId: "kidA", turnId: "ka" });
  o({ type: "turn.started", threadId: "kidB", turnId: "kb" });
  o({ type: "turn.completed", threadId: "rootX", turnId: "r", status: "completed" });
  o({ type: "item.started", threadId: "kidA", turnId: "ka", item: { type: "fileChange", id: "wa", status: "inProgress", changes: [] } });
  o({ type: "item.started", threadId: "kidB", turnId: "kb", item: { type: "fileChange", id: "wb", status: "inProgress", changes: [] } });
  o({ type: "turn.completed", threadId: "kidA", turnId: "ka", status: "interrupted" });
  const results = readLedger(c.sessionId()).filter((e) => e.type === "toolResult");
  assert.deepEqual(results.map((e) => `${e.itemId}:${e.status}`), ["wa:unknown"]);
  await c.close();
});

test("a reopened session: a subagent wake-up before any root turn is a subagent turn, not a violation", async () => {
  const a = make();
  start(a, "wake");
  await a.close();
  const b = make();
  b.observer({ type: "thread.attached", threadId: "wake", how: "resume" });
  b.observer({ type: "user.message", clientId: "y", input: "more", via: "submit" });
  b.observer({ type: "turn.started", threadId: "kidW", turnId: "kw" });
  const ev = readLedger(b.sessionId());
  assert.ok(!ev.some((e) => e.type === "violation"));
  assert.equal(ev.find((e) => e.turnId === "kw").trigger, "subagent");
  await b.close();
});

test("a subagent spawned in one root turn that works on during the next stays linked to the turn that spawned it", async () => {
  const c = make();
  const o = c.observer;
  start(c, "rootL");
  o({ type: "turn.started", threadId: "rootL", turnId: "r1" });
  o({ type: "item.started", threadId: "rootL", turnId: "r1", item: { type: "collabAgentToolCall", id: "sp", tool: "spawnAgent", status: "inProgress", receiverThreadIds: ["kidL"] } });
  o({ type: "turn.completed", threadId: "rootL", turnId: "r1", status: "completed" });
  o({ type: "user.message", clientId: "n", input: "next", via: "submit" });
  o({ type: "turn.started", threadId: "rootL", turnId: "r2" });
  o({ type: "turn.started", threadId: "kidL", turnId: "k" });
  assert.equal(readLedger(c.sessionId()).find((e) => e.turnId === "k").parentTurnId, "r1");
  await c.close();
});

test("a switch a crash left open says how it ended when the session reopens (P4.2)", async () => {
  const a = make();
  start(a, "crash1");
  a.record({ type: "switchRequested", target: "k", how: "continuation" });
  const id = a.sessionId();
  await a.close();
  const b = make();
  b.observer({ type: "thread.attached", threadId: "crash1", how: "resume" });
  b.observer({ type: "user.message", clientId: "z", input: "back", via: "submit" });
  const ev = readLedger(id);
  assert.ok(ev.some((e) => e.type === "switchAborted" && e.reason === "crash"), ev.map((e) => e.type).join());
  await b.close();
});
