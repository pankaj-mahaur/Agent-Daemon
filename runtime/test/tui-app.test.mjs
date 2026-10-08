// The terminal app (tui/app.mjs, plan Part 6) on a test screen, driven by
// the session controller on the fake Codex app-server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { createApp, reasoningHeadline } from "../src/tui/app.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withApp(fn, { cols = 70, rows = 20, actions = {}, armMs = 60, sessionOpts = {}, restartable = false, settings = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-app-"));
  const engines = [];
  const make = async () => {
    const e = await createEngine({ home: join(root, "home"), command });
    engines.push(e);
    return e;
  };
  const engine = await make();
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks"), ...(restartable ? { restart: make } : {}), ...sessionOpts });
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const type = (s) => decoder.feed(s);
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  // What went into the scrollback (as opposed to the live region).
  const scrollback = [];
  const commit = renderer.commit.bind(renderer);
  renderer.commit = (lines) => {
    for (const l of lines) scrollback.push((typeof l === "string" ? l : l.map((s) => s.text).join("")).replace(/ +$/, ""));
    return commit(lines);
  };
  const committed = () => scrollback.join("\n");
  const bells = [];
  const app = createApp({ io, renderer, session, cwd: root, header: [[{ text: "HEADER" }]], armMs, settings, actions: { bell: (o) => bells.push(o), ...actions } });
  const text = () => scr.lines().join("\n");
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${text()}`);
  };
  try {
    await fn({ app, scr, type, until, engine, session, text, bells, root, committed, engines });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    for (const e of engines) await e.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test("a prompt runs: the prompt, the answer and the turn's end go to scrollback", async () => {
  await withApp(async ({ type, until, text, bells, committed }) => {
    assert.match(text(), /HEADER/);
    type("early-complete\r");
    await until(() => /Worked for/.test(committed()), "the turn's end in scrollback");
    assert.match(committed(), /› early-complete/);
    assert.match(committed(), /• early/);
    type("fail-turn\r");
    await until(() => /The turn failed/.test(committed()), "the failure in scrollback");
    assert.ok(bells.length >= 1, "a bell when a turn ends");
  });
});

test("a crash mid-stream doesn't wedge the scrollback: the next answer still shows", async () => {
  await withApp(
    async ({ app, type, until, committed, engines, session }) => {
      type("hello\r");
      await until(() => app.state.modal, "the approval");
      engines[0].server.request("test/crash", {}).catch(() => {});
      await until(() => engines.length === 2 && session.state.engine.state === "ready", "the restart");
      type("early-complete\r");
      await until(() => /• early/.test(committed()), "the next answer in scrollback");
    },
    { restartable: true },
  );
});

test("a declined patch whose item never completes doesn't hold back the next turn", async () => {
  await withApp(async ({ app, type, until, committed }) => {
    type("edit-file\r");
    await until(() => app.state.modal === "approval-patch", "the patch approval");
    type("\x1b");
    await until(() => /Worked for/.test(committed()), "the turn's end");
    type("early-complete\r");
    await until(() => /• early/.test(committed()), "the next answer");
  });
});

test("Codex stopped and not restarted: a banner; Enter restarts and the kept prompt runs", async () => {
  await withApp(
    async ({ type, until, text, committed, engines, session }) => {
      type("fail-turn\r");
      await until(() => /Worked for/.test(committed()), "a first turn");
      engines[0].server.request("test/crash", {}).catch(() => {});
      await until(() => /Codex stopped \(exit 3\)\. Your text is kept\. Enter restarts/.test(text()), "the banner");
      type("early-complete\r");
      await until(() => session.state.engine.state === "ready" && /• early/.test(committed()), "the restart and the prompt");
    },
    { restartable: true, sessionOpts: { maxRestarts: 0 } },
  );
});

test("/resume of a thread another ad holds changes nothing in the scrollback", async () => {
  await withApp(async ({ app, type, until, committed, root }) => {
    type("fail-turn\r");
    await until(() => /The turn failed/.test(committed()), "a turn");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(join(root, "locks", "thread-old.lock"), JSON.stringify({ pid: process.ppid, threadId: "thread-old" }));
    type("/resume\r");
    await until(() => app.state.popup === "resume", "the picker");
    type("\r");
    await until(() => /open in another ad/.test(committed()), "the refusal");
    await sleep(200);
    assert.equal(committed().split("› fail-turn").length - 1, 1, "the conversation isn't committed twice");
  });
});

test("an approval opens as a modal; arming holds early keys; y approves and the turn completes", async () => {
  await withApp(async ({ app, type, until, text, session }) => {
    type("hello\r");
    await until(() => app.state.modal === "approval-exec", "the approval modal");
    assert.match(text(), /Run command\?/);
    type("y"); // too soon: ignored
    assert.equal(session.state.requests.length, 1);
    await sleep(600);
    type("y");
    await until(() => /✔ approved/.test(text()), "the answer");
    await until(() => /Worked for/.test(text()), "the turn's end");
    assert.match(text(), /pong/);
  }, { armMs: 500 }); // long enough that a loaded machine can't make the first "y" late
});

test("Esc in an approval declines; Ctrl+C twice quits", async () => {
  await withApp(async ({ app, type, until, text }) => {
    type("hello\r");
    await until(() => app.state.modal, "the modal");
    type("\x1b");
    await until(() => /✗ declined/.test(text()), "declined");
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    type("\x03");
    await sleep(20);
    assert.equal(quit, true);
  });
});

test("Enter while a turn runs steers; Tab queues and Tab on an empty composer pulls it back", async () => {
  await withApp(async ({ type, until, text, session, engine }) => {
    type("hang\r");
    await until(() => session.state.activeTurnId, "the running turn");
    type("also this\r");
    await until(() => /steered: also this/.test(text()), "the steer");
    const st = await engine.server.request("debug/state", {});
    assert.ok(st.calls.includes("turn/steer"));
    await until(() => !session.state.activeTurnId, "the steered turn's end");
    type("hang\r");
    await until(() => session.state.activeTurnId, "another running turn");
    type("later please\t");
    await until(() => session.state.queue.length === 1, "the queue");
    await until(() => /queued: later please/.test(text()), "the queued line");
    type("\t");
    await until(() => session.state.queue.length === 0 && /› later please/.test(text()), "pulled back into the composer");
  });
});

test("Ctrl+C: clears the composer, then interrupts, then a second press quits", async () => {
  await withApp(async ({ app, type, until, session }) => {
    type("hang\r");
    await until(() => session.state.activeTurnId, "the running turn");
    type("draft");
    await until(() => app.state.composer === "draft", "typed");
    type("\x03");
    assert.equal(app.state.composer, "");
    type("\x03"); // clearing didn't arm the quit: this one interrupts
    await until(() => /Interrupting/.test(app.state.note ?? ""), "interrupting");
    await until(() => !session.state.activeTurnId, "the interrupt");
    let quit = false;
    app.done.then(() => (quit = true));
    type("\x03");
    await sleep(20);
    assert.equal(quit, true);
  });
});

test("slash commands: the popup completes, /status reports, /new resets, unknown ones warn", async () => {
  await withApp(async ({ app, type, until, text, session }) => {
    type("/sta");
    await until(() => app.state.popup === "command", "the command popup");
    assert.match(text(), /\/status/);
    type("\r");
    await until(() => /Status/.test(text()) && /sandbox/.test(text()), "the status report");
    type("fail-turn\r");
    // /new waits for the task to end (Codex's rule), so wait for the turn too.
    await until(() => /The turn failed/.test(text()) && !session.state.activeTurnId && !session.state.starting, "a thread, its turn over");
    type("/new\r");
    await until(() => !session.state.thread && /New conversation/.test(text()), "a new conversation");
    type("/nope\r");
    await until(() => /Unknown command \/nope/.test(text()), "the warning");
    type("?");
    await until(() => app.state.overlay, "the shortcuts overlay");
    assert.match(text(), /Shortcuts/);
    type("\x1b");
    await until(() => !app.state.overlay, "closed");
  });
});

test("Codex commands ad doesn't run never reach the model; busy ones wait, and the draft stays", async () => {
  await withApp(async ({ app, type, until, text, session, engine }) => {
    const sent = async () => {
      const st = await engine.server.request("debug/state", {});
      return st.calls.filter((c) => c === "turn/start" || c === "turn/steer").length;
    };
    type("/plan fix the bug\r");
    await until(() => /\/plan isn't in ad yet\. \/codex opens the stock Codex UI/.test(text()), "the answer");
    assert.equal(app.state.composer, "/plan fix the bug", "the draft goes back into the composer");
    assert.equal(await sent(), 0);
    type("\x15/clean\r"); // an alias answers under the name typed
    await until(() => /\/clean isn't in ad yet/.test(text()), "the alias answer");
    type("\x15/MENTION\r");
    await until(() => /Type @ in the prompt to mention a file/.test(text()), "a custom answer, any case");
    type("\x15hang\r");
    await until(() => session.state.activeTurnId, "the running turn");
    const before = await sent();
    type("/new\r");
    await until(() => /'\/new' is disabled while a task is in progress\./.test(text()), "the busy answer");
    assert.equal(app.state.composer, "/new");
    type("\x15/side what about tests?\r");
    await until(() => /\/side isn't in ad yet/.test(text()), "not steered into the turn");
    assert.equal(await sent(), before, "nothing was steered into the running turn");
    assert.ok(session.state.thread, "the conversation is untouched");
    type("\x15/status\r"); // allowed during a task, as in Codex
    await until(() => /sandbox/.test(text()), "the status report mid-turn");
  });
});

test("ad's own dialogs in the app: a confirm takes the keys and waits for its arm delay; a checklist saves or cancels", async () => {
  await withApp(async ({ app, type, until, text }) => {
    let answer = null;
    app.confirm({ title: "Archive this conversation?", yes: "Yes, archive" }).then((a) => (answer = a));
    await until(() => app.state.confirm && /Archive this conversation\?/.test(text()), "the question");
    type("y"); // typed at once: too soon
    await sleep(30);
    assert.equal(answer, null);
    assert.equal(app.state.composer, "", "the composer didn't get the key");
    await sleep(80);
    type("y");
    await until(() => answer === true, "yes, once armed");
    assert.equal(app.state.confirm, false);
    app.confirm({ title: "Delete?" }).then((a) => (answer = a));
    await until(() => app.state.confirm, "the second question");
    type("\x1b");
    await until(() => answer === false, "esc is no");

    let saved = null;
    let cancelled = false;
    const previews = [];
    app.checklist("statusline", [{ label: "model", value: "model", checked: true }, { label: "git-branch", value: "git-branch" }], (v) => (saved = v), { title: "Status line", reorder: true, onChange: (v) => previews.push(v.join(",")), onCancel: () => (cancelled = true) });
    await until(() => app.state.popup === "statusline", "the checklist");
    type("\x1b[B ");
    await until(() => previews.length === 1, "a live preview");
    type("\r");
    await until(() => saved, "saved");
    assert.deepEqual(saved, ["model", "git-branch"]);
    app.checklist("statusline", [{ label: "model", value: "model" }], () => {}, { onCancel: () => (cancelled = true) });
    await until(() => app.state.popup === "statusline", "again");
    type("\x1b");
    await until(() => cancelled && app.state.popup === null, "cancelled");
  });
});

// The key routing table (codex-parity-2 1d; docs/tui-architecture.md): the
// topmost layer takes the key. Each row opens a layer, presses one key, and
// checks what happened, so a key can't reach a layer underneath by accident.
const ESC = "\x1b";
const KEYS = { esc: ESC, ctrlC: "\x03", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", pgup: "\x1b[5~" };
const LAYERS = {
  async idle() {},
  async text({ type, until, app }) {
    type("draft");
    await until(() => app.state.composer === "draft", "typed");
  },
  async running({ type, until, session, app }) {
    type("hang\r");
    await until(() => session.state.activeTurnId, "a running turn");
    type("steer me");
    await until(() => app.state.composer === "steer me", "typed");
  },
  async approval({ type, until, app }) {
    type("needs approval\r");
    await until(() => app.state.modal, "the approval");
  },
  async confirm({ app, until, box }) {
    app.confirm({ title: "Sure?" }).then((a) => (box.answer = a));
    await until(() => app.state.confirm, "the question");
  },
  async popup({ type, until, app }) {
    type("/");
    await until(() => app.state.popup === "command", "the command list");
  },
  async checklist({ app, until, box }) {
    app.checklist("statusline", [{ label: "model", value: "model" }], (v) => (box.saved = v), { onCancel: () => (box.cancelled = true) });
    await until(() => app.state.popup === "statusline", "the checklist");
  },
  async pager({ type, until, app }) {
    type("\x14"); // Ctrl+T
    await until(() => app.state.pager, "the pager");
  },
  async overlay({ type, until, app }) {
    type("?");
    await until(() => app.state.overlay, "the shortcuts");
  },
};
const sent = async (engine, method) => (await engine.server.request("debug/state", {})).calls.filter((c) => c === method).length;
const ROUTES = [
  ["idle", "ctrlC", async ({ app }) => assert.match(app.state.note ?? "", /Ctrl\+C again quits/)],
  ["idle", "shiftTab", async ({ app, engine }) => (assert.equal(app.state.composer, ""), assert.equal(await sent(engine, "turn/start"), 0))],
  ["idle", "enter", async ({ engine }) => assert.equal(await sent(engine, "turn/start"), 0, "an empty prompt sends nothing")],
  ["text", "esc", async ({ app }) => assert.equal(app.state.composer, "draft", "Esc doesn't throw the draft away")],
  ["text", "ctrlC", async ({ app }) => (assert.equal(app.state.composer, ""), assert.doesNotMatch(app.state.note ?? "", /again quits/, "clearing doesn't arm the quit"))],
  ["text", "shiftTab", async ({ app }) => assert.equal(app.state.composer, "draft")],
  ["text", "enter", async ({ until, engine }) => until(async () => (await sent(engine, "turn/start")) === 1, "sent")],
  ["running", "esc", async ({ until, engine }) => until(async () => (await sent(engine, "turn/interrupt")) === 1, "interrupted")],
  ["running", "ctrlC", async ({ app }) => assert.equal(app.state.composer, "", "the draft goes first; the turn runs on")],
  ["running", "tab", async ({ until, session }) => until(() => session.state.queue.length === 1, "queued")],
  ["running", "shiftTab", async ({ app, session }) => (assert.equal(session.state.queue.length, 0, "Shift+Tab never queues"), assert.equal(app.state.composer, "steer me"))],
  ["running", "enter", async ({ until, engine }) => until(async () => (await sent(engine, "turn/steer")) === 1, "steered")],
  ["approval", "esc", async ({ until, app }) => until(() => !app.state.modal, "declined")],
  ["approval", "ctrlC", async ({ until, app }) => until(() => !app.state.modal, "declined")],
  ["approval", "tab", async ({ app }) => assert.ok(app.state.modal, "still open")],
  ["approval", "shiftTab", async ({ app }) => assert.ok(app.state.modal, "still open")],
  ["confirm", "esc", async ({ until, box }) => until(() => box.answer === false, "no")],
  ["confirm", "ctrlC", async ({ until, box, app }) => (await until(() => box.answer === false, "no"), assert.equal(app.state.confirm, false))],
  ["confirm", "enter", async ({ app, box }) => (assert.equal(box.answer, undefined, "too soon to answer"), assert.ok(app.state.confirm))],
  ["confirm", "tab", async ({ app }) => assert.ok(app.state.confirm)],
  ["popup", "esc", async ({ app }) => (assert.equal(app.state.popup, null), assert.equal(app.state.composer, "/"))],
  ["popup", "ctrlC", async ({ app }) => (assert.equal(app.state.popup, null), assert.equal(app.state.composer, "/", "closing the popup comes before clearing"))],
  ["popup", "tab", async ({ app }) => assert.match(app.state.composer, /^\/\w+ $/, "fills the highlighted command")],
  ["popup", "shiftTab", async ({ app }) => (assert.equal(app.state.composer, "/"), assert.equal(app.state.popup, "command"))],
  ["checklist", "esc", async ({ app, box }) => (assert.equal(app.state.popup, null), assert.equal(box.cancelled, true))],
  ["checklist", "ctrlC", async ({ app, box }) => (assert.equal(app.state.popup, null), assert.equal(box.cancelled, true, "Ctrl+C undoes a live preview too"))],
  ["checklist", "tab", async ({ app, box }) => (assert.equal(app.state.popup, "statusline"), assert.equal(box.saved, undefined))],
  ["checklist", "enter", async ({ box }) => assert.deepEqual(box.saved, [])],
  ["pager", "esc", async ({ app }) => assert.equal(app.state.pager, false)],
  ["pager", "ctrlC", async ({ app }) => (assert.equal(app.state.pager, false), assert.doesNotMatch(app.state.note ?? "", /again quits/))],
  ["pager", "pgup", async ({ app }) => assert.equal(app.state.pager, true, "it scrolls, and stays open")],
  ["pager", "tab", async ({ app }) => (assert.equal(app.state.pager, true), assert.equal(app.state.composer, ""))],
  ["overlay", "esc", async ({ app }) => (assert.equal(app.state.overlay, false), assert.equal(app.state.composer, ""))],
  ["overlay", "ctrlC", async ({ app }) => assert.equal(app.state.overlay, false)],
];

test("key routing table: the topmost layer takes Esc, Ctrl+C, Tab, Shift+Tab, Enter and PgUp", async () => {
  for (const [layer, k, check] of ROUTES) {
    await withApp(async (h) => {
      const box = {};
      await LAYERS[layer]({ ...h, box });
      h.type(KEYS[k]);
      await sleep(60);
      try {
        await check({ ...h, box });
      } catch (err) {
        err.message = `${layer} + ${k}: ${err.message}`;
        throw err;
      }
    }, { armMs: 500 }); // "too soon" stays too soon on a loaded machine
  }
});

test("/clear, /archive, /resume archived, /delete and /pwd", async () => {
  const forgotten = [];
  await withApp(
    async ({ app, type, until, text, session, engine }) => {
      const debug = () => engine.server.request("debug/state", {});
      type("/pwd\r");
      await until(() => /Current working directory:\s+\S/.test(text()), "/pwd"); // a long temp path wraps
      type("/pwd now\r");
      await until(() => /Usage: \/pwd/.test(text()), "its usage");
      type("\x15/archive\r");
      await until(() => /Nothing to archive yet/.test(text()), "nothing to archive");
      type("early-complete\r");
      await until(() => /Worked for/.test(text()), "a turn");
      const first = session.state.thread.id;

      // /clear: the screen and scrollback go; a new, named conversation starts.
      type("/clear login fix\r");
      await until(() => /New conversation: login fix\. The one before: \/resume, or ad tui --resume/.test(text()), "cleared");
      assert.doesNotMatch(text(), /Worked for|early/, "the old scrollback is gone");
      assert.match(text(), /HEADER/, "the header again");
      assert.equal(session.state.thread.name, "login fix");
      assert.notEqual(session.state.thread.id, first);
      assert.equal((await debug()).lastParams["thread/start"].sessionStartSource, "clear");

      // /archive asks first; "y" before the arm delay is ignored.
      type("/archive\r");
      await until(() => app.state.confirm, "the question");
      type("n");
      await sleep(10);
      assert.ok(app.state.confirm, "too soon");
      await sleep(80);
      type("y");
      await until(() => /Archived\. \/resume archived brings it back\./.test(text()), "archived");
      assert.ok((await debug()).calls.includes("thread/archive"));
      assert.equal(session.state.thread, null);

      // /resume archived unarchives and resumes.
      type("/resume archived\r");
      await until(() => app.state.popup === "resume" && /an archived one/.test(text()), "the archived list");
      type("\r");
      await until(() => /Unarchived and resumed\./.test(text()), "resumed");
      assert.equal(session.state.thread.id, "thread-archived");
      assert.ok((await debug()).calls.includes("thread/unarchive"));

      // /delete: "no" keeps it; "yes" deletes it and its /undo snapshots.
      type("/delete\r");
      await until(() => app.state.confirm && /Cannot be undone/.test(text()), "the question");
      await sleep(80);
      type("n");
      await until(() => /Kept\./.test(text()), "kept");
      assert.equal(session.state.thread.id, "thread-archived");
      type("/delete\r");
      await until(() => app.state.confirm, "asked again");
      await sleep(80);
      type("y");
      await until(() => /Deleted\./.test(text()), "deleted");
      assert.deepEqual(forgotten, ["thread-archived"]);
      assert.equal(session.state.thread, null);
    },
    // Wide enough that the long answers (a temp path, a resume hint) stay on one row.
    { cols: 160, actions: { forgetCheckpoints: async (id) => forgotten.push(id) } },
  );
});

test("/permissions and /model set the next turn's overrides through pickers", async () => {
  await withApp(async ({ app, type, until, text, session, engine }) => {
    type("/permissions\r");
    await until(() => app.state.popup === "permissions", "the permissions picker");
    type("read\r");
    await until(() => /Permissions: Read only/.test(text()), "set");
    type("fail-turn\r");
    await until(() => /Worked for/.test(text()), "the turn");
    const st = await engine.server.request("debug/state", {});
    assert.deepEqual(st.lastParams["turn/start"].sandboxPolicy, { type: "readOnly" });
    assert.equal(session.state.config.sandbox, "read-only");
  });
});

test("! runs a shell command; its output is labelled unsandboxed", async () => {
  await withApp(async ({ type, until, text }) => {
    type("!echo hi\r");
    await until(() => /unsandboxed/.test(text()), "the shell cell");
  });
});

test("@ opens a file picker from actions.searchFiles; Tab inserts the path", async () => {
  await withApp(
    async ({ app, type, until }) => {
      type("look at @mai");
      await until(() => app.state.popup === "mention", "the mention popup");
      type("\t");
      await until(() => app.state.composer === "look at @src/main.mjs ", "the inserted path");
    },
    { actions: { searchFiles: async (q) => ["src/main.mjs", "src/maintain.mjs"].filter((f) => f.includes(q)) } },
  );
});

test("reasoningHeadline picks the first bold phrase", () => {
  assert.equal(reasoningHeadline("**Checking tests**\n\nmore"), "Checking tests");
  assert.equal(reasoningHeadline("no bold"), null);
  assert.equal(reasoningHeadline("**\x1b[31mred**"), "red");
});

test("a tiny screen still shows the composer; no footer under 10 rows", async () => {
  await withApp(
    async ({ type, until, text }) => {
      type("abc");
      await until(() => /› abc/.test(text()), "the composer");
      assert.ok(!/shortcuts/.test(text()));
    },
    { rows: 8, cols: 30 },
  );
});

test("/warnings lists kept notices and events from a newer Codex", async () => {
  await withApp(async ({ type, until, text }) => {
    type("/warnings\r");
    await until(() => /No warnings in this session/.test(text()), "the empty report");
    type("future\r");
    await until(() => /Worked for/.test(text()), "the future turn");
    assert.match(text(), /not shown: hologramProjection/);
    type("/warnings\r");
    await until(() => /thread\/hologram\/updated ×1/.test(text()), "the unknown event");
  });
});

// A scripted session: just enough of the controller's surface for the app.
function stubSession(state) {
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
    on: (ev, fn) => (ev === "change" && listeners.add(fn), () => listeners.delete(fn)),
    emit: (what) => listeners.forEach((f) => f({ what, state: st })),
    submit: (text) => (calls.push(["submit", text]), { clientUserMessageId: "c", accepted: Promise.resolve({ turnId: "u" }), done: Promise.resolve({}) }),
    shell: (cmd) => (calls.push(["shell", cmd]), Promise.resolve({})),
    queue: () => 0, editQueued: () => true, interrupt: async () => true, resolve: () => true, setNextTurn: () => {}, newThread: () => {},
  };
}

async function withStub(session, fn, { cols = 70, rows = 20 } = {}) {
  const scr = modelScreen({ cols, rows });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const app = createApp({ io, renderer, session, cwd: "/x", armMs: 0 });
  try {
    await fn({ app, type: (s) => decoder.feed(s), text: () => scr.lines().join("\n") });
  } finally {
    app.dispose();
    renderer.dispose();
  }
}

test("an agent message behind a still-running item is drawn live", async () => {
  const s = stubSession({ activeTurnId: "u", turns: [{ id: "u", status: "inProgress", itemIds: [] }] });
  s.state.items.set("c1", { id: "c1", kind: "commandExecution", command: "npm test", status: "inProgress", streaming: true, actions: [], turnId: "u", threadId: "t" });
  s.state.items.set("m1", { id: "m1", kind: "agentMessage", text: "meanwhile, a note", streaming: true, turnId: "u", threadId: "t" });
  await withStub(s, async ({ app, text }) => {
    app.draw();
    assert.match(text(), /Running npm test/);
    assert.match(text(), /meanwhile, a note/);
  });
});

test("a pasted multi-line prompt that starts with ! is a prompt, not a shell command", async () => {
  const s = stubSession({});
  await withStub(s, async ({ type }) => {
    type("\x1b[200~![diagram](img.png)\nwhat does this show?\x1b[201~");
    type("\r");
    await sleep(20);
    assert.deepEqual(s.calls.map((c) => c[0]), ["submit"]);
    type("!git status\r");
    await sleep(20);
    assert.deepEqual(s.calls.at(-1), ["shell", "git status"]);
  });
});

test("/status shows the tokens used", async () => {
  const s = stubSession({ tokens: { total: { total: 1234 }, last: { total: 10 }, contextWindow: 1000 } });
  await withStub(s, async ({ type, text }) => {
    type("/status\r");
    await sleep(20);
    assert.match(text(), /1,234 tokens used/);
  });
});

test("/undo: files back and the prompt returns; typing takes the next turn's snapshot early", async () => {
  const s = stubSession({});
  let typed = 0;
  const undo = async ({ force }) => (force ? { message: "forced" } : { message: "Undid the last turn: 2 files put back.", prompt: "fix the bug" });
  const scr = modelScreen({ cols: 70, rows: 20 });
  const listeners = new Set();
  const io = { ...scr.io, onInput: (f) => (listeners.add(f), () => listeners.delete(f)) };
  const decoder = createInputDecoder({ onEvent: (e) => listeners.forEach((f) => f(e)), escTimeoutMs: 5 });
  const renderer = createRenderer({ io, reflow: "none" });
  await renderer.start();
  const app = createApp({ io, renderer, session: s, cwd: "/x", armMs: 0, actions: { undo, onTyping: () => typed++ } });
  try {
    decoder.feed("/undo\r");
    await sleep(30);
    assert.equal(app.state.composer, "fix the bug");
    assert.match(scr.lines().join("\n"), /Undid the last turn: 2 files put back/);
    assert.ok(typed > 0, "typing asked for a snapshot");
  } finally {
    app.dispose();
    renderer.dispose();
  }
  // Without checkpoints (not a git repo) /undo says why.
  await withStub(stubSession({}), async ({ type, text }) => {
    type("/undo\r");
    await sleep(20);
    assert.match(text(), /\/undo needs a git repo/);
  });
});

test("Codex's keys for /copy, /raw and /warnings: Ctrl+O, Alt+R, F2", async () => {
  await withApp(
    async ({ type, until, committed }) => {
      type("early-complete\r");
      await until(() => /Worked for/.test(committed()), "a turn");
      type("\x0f"); // Ctrl+O
      await until(() => /Copied the last answer \(stub\)/.test(committed()), "copied");
      type("\x1br"); // Alt+R
      await until(() => /^early$/m.test(committed()), "the raw answer");
      type("\x1bOQ"); // F2
      await until(() => /No warnings in this session|Warnings/.test(committed()), "the warnings");
    },
    { actions: { copy: async () => ({ ok: true, via: "stub" }) } },
  );
});

// Codex's settings as the app sees them (prefs.mjs's createCodexSettings), in memory.
function memorySettings(initial = {}) {
  const store = structuredClone(initial);
  const at = (k) => k.split(".").reduce((o, x) => o?.[x], store);
  return {
    store,
    codex: {
      get: at,
      async set(k, v) {
        const keys = k.split(".");
        let o = store;
        for (const x of keys.slice(0, -1)) o = o[x] ??= {};
        if (v === null) delete o[keys.at(-1)];
        else o[keys.at(-1)] = v;
      },
    },
    ad: { get: (_k, d) => d },
  };
}

test("status line: Codex's items under the composer; /statusline previews, saves, and keeps ids ad can't show", async () => {
  const settings = memorySettings({ tui: { status_line: ["model", "pull-request-number", "current-dir"] } });
  await withApp(
    async ({ app, type, until, text }) => {
      type("early-complete\r"); // the model is known once the conversation starts
      await until(() => /fake-model · \S/.test(text()), "the configured items");
      type("/statusline\r");
      await until(() => app.state.popup === "status" && /\[x\] model/.test(text()), "the checklist");
      type(" "); // model off: the row changes at once (a preview)
      await until(() => !/fake-model ·/.test(text()), "the preview");
      type("\r");
      await until(() => /Status line: current-dir\. Saved for \/codex too\./.test(text()), "saved");
      assert.deepEqual(settings.store.tui.status_line, ["current-dir", "pull-request-number"], "Codex's item ad can't show is kept");
      // Esc puts the row back as it was.
      type("/statusline\r");
      await until(() => app.state.popup === "status", "again");
      type("\x1b[B \x1b");
      await until(() => app.state.popup === null, "cancelled");
      assert.deepEqual(settings.store.tui.status_line, ["current-dir", "pull-request-number"]);
      type("/warnings\r");
      await until(() => /ad doesn't show "pull-request-number"/.test(text()), "the warning about it");
    },
    { settings, cols: 100 },
  );
});

test("status line: off with [] and under 12 rows", async () => {
  await withApp(async ({ text }) => {
    await sleep(100);
    assert.doesNotMatch(text(), /ctx \d+%/, "[] turns it off");
  }, { settings: memorySettings({ tui: { status_line: [] } }) });
  // The default row shows the folder (ad-app-…); at 11 rows it isn't drawn.
  await withApp(async ({ text, until }) => until(() => /ad-app-/.test(text()), "the row at 20 rows"), { settings: memorySettings() });
  await withApp(async ({ text }) => {
    await sleep(100);
    assert.doesNotMatch(text(), /ad-app-/);
  }, { rows: 11, settings: memorySettings() });
});

test("window title: saved first, set by OSC 0, /private keeps the conversation's name out, put back around handoffs", async () => {
  await withApp(
    async ({ app, scr, type, until }) => {
      const titles = () => scr.writes.filter((w) => w.includes("\x1b]0;"));
      await until(() => titles().length, "a title");
      assert.ok(titles()[0].startsWith("\x1b[22;0t\x1b]0;"), "the terminal's own title is saved first");
      type("early-complete\r");
      await until(() => /Worked for/.test(scr.lines().join("\n")), "a turn");
      type("/rename early bird\r");
      await until(() => titles().some((w) => /\x1b\]0;early bird/.test(w)), "the conversation's name in the title");
      type("/private\r");
      await until(() => titles().at(-1).includes("\x1b]0;\x07") || !/early/.test(titles().at(-1)), "the name gone in /private");
      assert.doesNotMatch(titles().at(-1), /early/);
      app.holdTitle(true);
      assert.ok(scr.writes.at(-1).endsWith("\x1b]0;\x07\x1b[23;0t"), "put back for a handoff");
    },
    { settings: memorySettings({ tui: { terminal_title: ["thread-name"] } }) },
  );
});

test("/title saves Codex's tui.terminal_title; [] leaves the title alone", async () => {
  const settings = memorySettings({ tui: { terminal_title: [] } });
  await withApp(
    async ({ app, scr, type, until }) => {
      await sleep(100);
      assert.ok(!scr.writes.some((w) => w.includes("\x1b]0;")), "[]: no title written at all");
      type("/title\r");
      await until(() => app.state.popup === "title", "the checklist");
      type(" \r"); // the first item (activity) on
      await until(() => Array.isArray(settings.store.tui.terminal_title) && settings.store.tui.terminal_title.length === 1, "saved");
      assert.deepEqual(settings.store.tui.terminal_title, ["activity"]);
    },
    { settings },
  );
});

test("window title: nothing is written while another program has the terminal", async () => {
  await withApp(
    async ({ app, scr, type, until }) => {
      await until(() => scr.writes.some((w) => w.includes("\x1b]0;")), "a title");
      app.holdTitle(true);
      const n = scr.writes.length;
      type("/rename while away\r");
      await sleep(400);
      assert.ok(!scr.writes.slice(n).some((w) => w.includes("\x1b]0;")), "no title during the handoff");
      app.holdTitle(false);
      await until(() => scr.writes.slice(n).some((w) => w.includes("\x1b]0;")), "the title again after it");
    },
    { settings: memorySettings({ tui: { terminal_title: ["app-name", "thread-name"] } }) },
  );
});
