// Regression tests for the Part 5–8 re-reviews: crashes and freezes from
// model text, items that must (not) settle, the pager vs a request, the
// clipboard, effort keys, /export paths, diffs and the skills mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/tui/app.mjs";
import { copyText } from "../src/tui/commands.mjs";
import { createMarkdownStream, inline, renderMarkdown } from "../src/tui/view/markdown.mjs";
import { diffRows } from "../src/tui/view/cells.mjs";
import { syncSkills } from "../src/harness/codex-ui.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Markdown from a hostile model                                       */
/* ------------------------------------------------------------------ */

test("model text can't crash or freeze rendering: long runs and deep nesting", () => {
  for (const md of ["a " + "*".repeat(40000), "a " + "_".repeat(40000) + "b", "[".repeat(12000) + "a" + "](u)".repeat(12000), ">".repeat(20000) + " x", "*a ".repeat(5000) + "x" + " b*".repeat(5000), "- ".repeat(5000) + "x"]) {
    const t0 = performance.now();
    assert.doesNotThrow(() => renderMarkdown(md, { width: 80 }));
    assert.ok(performance.now() - t0 < 3000, JSON.stringify(md.slice(0, 20)));
  }
});

test("emphasis follows CommonMark's flanking rules, and a span skipped by a link doesn't hide later emphasis", () => {
  const italic = (s) => inline(s).filter((x) => x.style?.italic).map((x) => x.text);
  assert.deepEqual(italic("*x [ref](http://e/`a) is *important* and `b`"), ["important"]);
  assert.deepEqual(italic("a*`` and *this* plus `c`"), ["this"]);
  assert.deepEqual(italic("2*3*4"), ["3"], "intraword * emphasis, as in CommonMark");
  assert.deepEqual(italic("2 * 3 * 4"), [], "spaced * is never emphasis");
  assert.deepEqual(italic("*`code`*"), ["code"], "emphasis around a code span, as in CommonMark");
});

test("a long open code fence in the live view shows only its uncommitted lines, as code", () => {
  const s = createMarkdownStream({ width: 80 });
  const lines = Array.from({ length: 400 }, (_, i) => `# comment ${i} **kw** ${"x".repeat(20)}`);
  s.push("```python\n" + lines.join("\n") + "\n# partial **x");
  const live = s.live();
  assert.ok(live.length <= 3, `live rows: ${live.length}`);
  assert.ok(live.every((l) => l.every((sp) => !sp.style?.bold)), "code, not headings or bold");
  assert.match(live.map((l) => l.map((x) => x.text).join("")).join("\n"), /# partial \*\*x/);
});

/* ------------------------------------------------------------------ */
/* Diffs and the skills mirror                                         */
/* ------------------------------------------------------------------ */

test("a malformed diff shows its extra lines marked ?, never hides them", () => {
  const rows = diffRows({ kind: "update", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n+EXTRA\n" });
  assert.deepEqual(rows.map((r) => r.sign + r.text), ["-a", "+b", "?+EXTRA"]);
});

test("a skill that fails to copy keeps its old mirrored copy", () => {
  const root = mkdtempSync(join(tmpdir(), "ad-skills-fail-"));
  try {
    const from = join(root, "from");
    const home = join(root, "home");
    mkdirSync(join(from, "s"), { recursive: true });
    writeFileSync(join(from, "s", "SKILL.md"), "v1");
    syncSkills({ home, from });
    // A broken link inside the skill must not stop the sync or lose the old copy.
    writeFileSync(join(from, "s", "SKILL.md"), "v2");
    try {
      symlinkSync(join(root, "missing"), join(from, "s", "dangling"), "junction");
    } catch {
      // no link rights: the rest of the test still holds
    }
    const r = syncSkills({ home: home, from });
    assert.ok(r.copied + (r.failed ?? 0) >= 1);
    assert.ok(existsSync(join(home, "skills", "s", "SKILL.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The clipboard                                                       */
/* ------------------------------------------------------------------ */

test("copyText: a tool that closes stdin early is a 'no', not a crash", async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
    return child;
  };
  assert.deepEqual(await copyText("x".repeat(200_000), { platform: "linux", spawnFn, osc52: false }), { ok: false, via: null });
});

/* ------------------------------------------------------------------ */
/* The app                                                             */
/* ------------------------------------------------------------------ */

function stub(state = {}, { models = [] } = {}) {
  const listeners = new Set();
  const calls = [];
  const st = {
    thread: { id: "t" }, turns: [], items: new Map(), echoes: new Map(), activeTurnId: null, starting: false, requests: [], queue: [],
    config: { model: "m", effort: null, sandbox: "workspace-write", approvalPolicy: "on-request", cwd: "/x" },
    account: null, goal: null, agents: new Map(), mcp: new Map(), tokens: null, plan: null, diff: null, rateLimits: null, notices: [],
    engine: { state: "ready", exitCode: null, restarts: 0 },
    ...state,
  };
  return {
    state: st,
    calls,
    engine: { server: { request: async (m) => (m === "model/list" ? { data: models } : {}) } },
    on: (ev, fn) => (ev === "change" && listeners.add(fn), () => listeners.delete(fn)),
    emit: (what) => listeners.forEach((f) => f({ what, state: st })),
    submit: (text) => (calls.push(["submit", text]), { clientUserMessageId: "c", accepted: Promise.resolve({ turnId: "u" }), done: Promise.resolve({}) }),
    resolve: (id, a) => (calls.push(["resolve", id, a]), true),
    setNextTurn: (o) => calls.push(["setNextTurn", o]),
    shell: async () => ({}), queue: () => 0, editQueued: () => true, interrupt: async () => true, newThread: () => {},
  };
}

async function withStub(session, fn, { actions = {}, cwd = "/x" } = {}) {
  const scr = modelScreen({ cols: 80, rows: 22 });
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
  const app = createApp({ io, renderer, session, cwd, armMs: 0, actions });
  try {
    await fn({ app, type: (s) => decoder.feed(s), text: () => scr.lines().join("\n"), committed: () => scrollback.join("\n") });
  } finally {
    app.dispose();
    renderer.dispose();
  }
}

test("a running ! command (no turn) stays live while Codex is up; a resumed turn still 'inProgress' in history doesn't wedge", async () => {
  const s = stub({ turns: [{ id: "old", status: "inProgress", itemIds: ["h1"] }] });
  s.state.items.set("h1", { id: "h1", kind: "agentMessage", text: "half an answer", streaming: true, turnId: "old", threadId: "t" });
  s.state.items.set("sh", { id: "sh", kind: "commandExecution", command: "make test", status: "inProgress", source: "userShell", actions: [], turnId: null, threadId: "t" });
  await withStub(s, async ({ app, text, committed }) => {
    app.draw();
    assert.match(committed(), /half an answer/, "the old turn's item is history, committed");
    assert.match(text(), /Running \(unsandboxed\) make test/);
    assert.ok(!/Stopped/.test(committed()), "the shell command isn't settled early");
    s.state.items.get("sh").status = "completed";
    s.state.items.get("sh").exitCode = 7;
    app.draw();
    assert.match(committed(), /Failed \(unsandboxed\) make test \(exit 7\)/);
  });
});

test("a request opening while the pager is up: the pager closes and keys answer the request", async () => {
  const s = stub({ turns: [{ id: "u", status: "inProgress", itemIds: [] }], activeTurnId: "u" });
  await withStub(s, async ({ app, type }) => {
    type("\x14");
    s.state.requests.push({ request: { id: 5, kind: "approval-exec", options: ["accept", "cancel"], display: { title: "Run command?", command: "ls" } } });
    app.draw();
    type("y");
    await sleep(10);
    assert.deepEqual(s.calls.find((c) => c[0] === "resolve"), ["resolve", 5, "accept"]);
  });
});

test("/copy: the payload is sanitized, and a failing copy is a warning, not a crash", async () => {
  const s = stub();
  s.state.items.set("m", { id: "m", kind: "agentMessage", text: "run\x1b[201~ this\u{202e}", threadId: "t" });
  const copied = [];
  await withStub(s, async ({ type, committed }) => {
    type("/copy\r");
    await sleep(20);
    assert.deepEqual(copied, ["run this"]);
  }, { actions: { copy: async (t) => (copied.push(t), { ok: true, via: "stub" }) } });
  await withStub(s, async ({ type, committed }) => {
    type("/copy\r");
    await sleep(20);
    assert.match(committed(), /no clipboard here/);
  }, { actions: { copy: async () => { throw new Error("no clipboard here"); } } });
});

test("effort keys step through the model's own levels from where it is now", async () => {
  const models = [{ model: "m", supportedReasoningEfforts: [{ reasoningEffort: "minimal" }, { reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }], defaultReasoningEffort: "medium" }];
  const s = stub({}, { models });
  s.state.config.effort = "high";
  await withStub(s, async ({ type }) => {
    type("\x1b,");
    await sleep(20);
    assert.deepEqual(s.calls.at(-1), ["setNextTurn", { effort: "medium" }]);
    s.state.config.effort = "high";
    type("\x1b.");
    await sleep(20);
    assert.deepEqual(s.calls.at(-1), ["setNextTurn", { effort: "high" }], "no xhigh this model lacks");
    s.state.config.effort = "xhigh";
    type("\x1b,");
    await sleep(20);
    assert.deepEqual(s.calls.at(-1), ["setNextTurn", { effort: "high" }], "from a level the model lacks, down goes to the next one below");
  });
});

test("/export: ..name is fine; device names, streams and links out of the folder are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "ad-export-hard-"));
  const outside = mkdtempSync(join(tmpdir(), "ad-export-out-"));
  try {
    const s = stub();
    s.state.items.set("m", { id: "m", kind: "agentMessage", text: "hi", threadId: "t" });
    let linked = false;
    try {
      symlinkSync(outside, join(root, "link"), "junction");
      linked = true;
    } catch {
      // no link rights
    }
    await withStub(s, async ({ type, committed }) => {
      type("/export ..notes.md\r");
      await sleep(20);
      assert.ok(existsSync(join(root, "..notes.md")));
      for (const bad of ["con.md", "nul", "notes.md:stream", ...(linked ? ["link/escaped.md"] : [])]) {
        type(`/export ${bad}\r`);
        await sleep(20);
      }
      assert.equal((committed().match(/plain file inside this folder only/g) ?? []).length, linked ? 4 : 3);
      if (linked) assert.ok(!existsSync(join(outside, "escaped.md")));
      type("/export missing/x.md\r");
      await sleep(20);
      assert.match(committed(), /That folder doesn't exist/);
    }, { cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
