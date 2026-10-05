// Codex parity++ (plan Part 8): tui/commands.mjs, the auto-review notices,
// and the new commands and keys in the app on the fake engine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGolden } from "../testkit/golden.mjs";
import { copyText, exportMarkdown, imagePath, lastAgentText, renderHooks, renderMcp, renderSkills, renderUsage, terminalSetup, transcriptLines } from "../src/tui/commands.mjs";
import { editInEditor, editorCommand } from "../src/tui/main.mjs";
import { adaptNotification } from "../src/engine/codex/events.mjs";
import { createEngine } from "../src/engine/index.mjs";
import { createSession } from "../src/harness/session.mjs";
import { createApp } from "../src/tui/app.mjs";
import { createRenderer } from "../src/tui/terminal/renderer.mjs";
import { createInputDecoder } from "../src/tui/terminal/input.mjs";
import { lineWidth } from "../src/tui/terminal/text.mjs";
import { modelScreen } from "../testkit/screen.mjs";

const FAKE = fileURLToPath(new URL("../testkit/fake-codex-app-server.mjs", import.meta.url));
const command = { cmd: process.execPath, prefix: [FAKE] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (lines) => lines.map((l) => l.map((s) => s.text).join("").replace(/ +$/, "")).join("\n");

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

const MCP = [
  { name: "memory", runtimeStatus: "ready", httpOrigin: null },
  { name: "broken", runtimeStatus: "failed", httpOrigin: "https://mcp.example" },
];
const HOOKS = [
  { eventName: "UserPromptSubmit", sourcePath: "/home/ad/hooks.json", trustStatus: "trusted" },
  { eventName: "PreToolUse", sourcePath: "/repo/.codex/hooks.json", trustStatus: "untrusted" },
];
const SKILLS = [{ skills: [{ name: "debug-triage", description: "Find the cause of a bug", enabled: true }, { name: "old", description: "disabled one", enabled: false }] }];
const USAGE = { rateLimits: { primary: { usedPercent: 38.4, windowDurationMins: 300 }, secondary: { usedPercent: 85, windowDurationMins: 10080 } }, usage: { summary: { lifetimeTokens: 123456, currentStreakDays: 3, longestStreakDays: 7 } }, tokens: { total: { total: 4321 } } };

function sheet(width) {
  return [
    "── mcp ──", text(renderMcp(MCP, { width })),
    "── hooks ──", text(renderHooks(HOOKS, { width, hooksFile: "/home/ad/hooks.json" })),
    "── skills ──", text(renderSkills(SKILLS, { width })),
    "── usage ──", text(renderUsage(USAGE, { width })),
    "── usage (none) ──", text(renderUsage({}, { width })),
  ].join("\n");
}

for (const width of [40, 80, 120]) {
  test(`parity golden at width ${width}`, () => assertGolden(`tui/parity-${width}.txt`, sheet(width)));
}

test("renderers fit the width and sanitize names", () => {
  for (const width of [12, 40, 80]) {
    for (const l of [...renderMcp([{ name: "a\x1b[2Jb".repeat(20), runtimeStatus: "ready\nx" }], { width }), ...renderSkills(SKILLS, { width }), ...renderHooks(HOOKS, { width })]) {
      assert.ok(lineWidth(l) <= width);
      assert.ok(!l.some((s) => /[\x00-\x1f]/.test(s.text)));
    }
  }
  assert.match(text(renderMcp([])), /No MCP servers/);
});

test("terminal-setup is print-only advice per terminal", () => {
  assert.match(terminalSetup("windows-terminal").join("\n"), /sendInput.*\\u001b\[13;2u/);
  assert.match(terminalSetup("vscode").join("\n"), /sendSequence/);
  assert.match(terminalSetup("zed").join("\n"), /Nothing to set up/);
  assert.match(terminalSetup("unknown").join("\n"), /Ctrl\+J/);
});

/* ------------------------------------------------------------------ */
/* Transcript, clipboard, images, editor                               */
/* ------------------------------------------------------------------ */

const ST = {
  thread: { id: "t1", name: "fix \x1b[31mlogin" },
  items: new Map([
    ["u1", { id: "u1", kind: "userMessage", text: "fix it", threadId: "t1" }],
    ["c1", { id: "c1", kind: "commandExecution", command: "npm test", output: "ok\n", status: "completed", exitCode: 0, actions: [], threadId: "t1" }],
    ["m1", { id: "m1", kind: "agentMessage", text: "Done: **fixed**\x1b]0;x\x07", threadId: "t1" }],
    ["x1", { id: "x1", kind: "agentMessage", text: "child", threadId: "child" }],
  ]),
};

test("export: markdown of the conversation, sanitized; the last answer for /copy and /raw", () => {
  const md = exportMarkdown(ST);
  assert.match(md, /^# fix login/);
  assert.match(md, /## You\n\nfix it/);
  assert.match(md, /\$ npm test\nok/);
  assert.match(md, /## Codex\n\nDone: \*\*fixed\*\*/);
  assert.ok(!/\x1b/.test(md));
  assert.ok(!md.includes("child"), "subagent threads are not the conversation");
  assert.match(lastAgentText(ST), /Done/);
  assert.match(text(transcriptLines(ST, { width: 60 })), /› fix it[\s\S]*Ran npm test/);
  assert.ok(!text(transcriptLines(ST, { width: 60 })).includes("child"), "the pager shows this thread only");
});

test("copyText: OSC 52 to the terminal, then the platform's tool (clip.exe gets UTF-16 with a BOM)", async () => {
  const writes = [];
  const fed = [];
  const spawnFn = (cmd) => {
    const child = new EventEmitter();
    child.stdin = { end: (b) => (fed.push([cmd, b]), setImmediate(() => child.emit("exit", 0))) };
    return child;
  };
  const r = await copyText("héllo", { write: (d) => writes.push(d), platform: "win32", spawnFn });
  assert.deepEqual(r, { ok: true, via: "clip.exe" });
  assert.equal(writes[0], `\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
  assert.deepEqual([...fed[0][1].subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(fed[0][1].subarray(2).toString("utf16le"), "héllo");
  const failing = () => {
    const child = new EventEmitter();
    child.stdin = { end: () => setImmediate(() => child.emit("error", new Error("ENOENT"))) };
    return child;
  };
  assert.deepEqual(await copyText("x", { write: () => {}, platform: "linux", spawnFn: failing }), { ok: true, via: "terminal" });
  assert.deepEqual(await copyText("x", { platform: "linux", spawnFn: failing, osc52: false }), { ok: false, via: null });
});

test("imagePath: an existing image file, quotes and file:// removed; anything else is not an image", () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-img-"));
  try {
    writeFileSync(join(dir, "shot one.png"), "x");
    assert.equal(imagePath(`"${join(dir, "shot one.png")}"`, dir), join(dir, "shot one.png"));
    assert.equal(imagePath("shot one.png", dir), null, "a bare name pasted into a sentence stays text");
    assert.equal(imagePath(`./shot one.png`, dir), join(dir, "shot one.png"));
    const url = "file:///" + join(dir, "shot one.png").replace(/\\/g, "/").replace(/^\//, "").replace(/ /g, "%20");
    assert.equal(imagePath(url, dir), join(dir, "shot one.png"), "file:// URLs, %20 decoded, the drive letter kept");
    assert.equal(imagePath("//server/share/x.png", dir), null, "no network lookups for UNC paths");
    assert.equal(imagePath("missing.png", dir), null);
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.equal(imagePath("notes.txt", dir), null);
    assert.equal(imagePath("a.png\nb.png", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editor: $VISUAL, then $EDITOR (with its arguments), else notepad / vi; a failed editor changes nothing", async () => {
  assert.deepEqual(editorCommand({ VISUAL: "code --wait", EDITOR: "vim" }, "linux"), { cmd: "code", args: ["--wait"] });
  assert.deepEqual(editorCommand({ EDITOR: "nano" }, "linux"), { cmd: "nano", args: [] });
  assert.deepEqual(editorCommand({}, "win32"), { cmd: "notepad", args: [] });
  let seenFile = null;
  const out = await editInEditor("draft", {
    env: { EDITOR: "fake-ed -x" },
    platform: "linux",
    run: async (cmd, args) => {
      assert.equal(cmd, "fake-ed");
      seenFile = args.at(-1);
      assert.equal(readFileSync(seenFile, "utf8"), "draft");
      writeFileSync(seenFile, "edited\n");
      return 0;
    },
  });
  assert.equal(out, "edited\n");
  assert.ok(!existsSync(seenFile), "the temp file is removed");
  assert.equal(await editInEditor("draft", { env: { EDITOR: "x" }, platform: "linux", run: async () => 1 }), null);
  // An editor that returns at once with nothing changed didn't wait: the prompt is kept, with a reason.
  await assert.rejects(editInEditor("draft", { env: { EDITOR: "notepad" }, platform: "win32", run: async () => 0 }), /didn't wait|without waiting/);
  // .cmd shims (code, subl) go through cmd.exe with every argument quoted.
  let seen = null;
  await editInEditor("d", {
    env: { EDITOR: "code --wait" },
    platform: "win32",
    now: (() => {
      let t = 0;
      return () => (t += 5000);
    })(),
    run: async (cmd, args, verbatim) => ((seen = { cmd, args, verbatim }), 0),
  });
  assert.match(seen.cmd, /cmd(\.exe)?$/i);
  assert.equal(seen.verbatim, true);
  assert.match(seen.args.at(-1), /^""code" "--wait" ".*prompt\.md""$/);
  // An unquoted path with spaces is one command when it exists.
  assert.deepEqual(editorCommand({ EDITOR: "C:/Program Files/Ed/ed.exe" }, "win32", () => true), { cmd: "C:/Program Files/Ed/ed.exe", args: [] });
});

test("auto-review verdicts become notices; the start is silent", () => {
  assert.deepEqual(adaptNotification("item/autoApprovalReview/started", { threadId: "t" }), []);
  const ok = adaptNotification("item/autoApprovalReview/completed", { threadId: "t", review: { status: "approved" }, action: { type: "networkAccess", host: "pypi.org" } })[0];
  assert.equal(ok.level, "info");
  assert.match(ok.message, /approved: network access to pypi\.org/);
  const no = adaptNotification("item/autoApprovalReview/completed", { threadId: "t", review: { status: "denied", rationale: "deletes files" }, action: { type: "command", command: "rm -rf build" } })[0];
  assert.equal(no.level, "warn");
  assert.match(no.message, /denied `rm -rf build` \(deletes files\)/);
});

/* ------------------------------------------------------------------ */
/* In the app                                                          */
/* ------------------------------------------------------------------ */

async function withApp(fn, { actions = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ad-parity-"));
  const engine = await createEngine({ home: join(root, "home"), command });
  const session = createSession({ engine, cwd: root, lockDir: join(root, "locks") });
  const scr = modelScreen({ cols: 80, rows: 24 });
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
  const app = createApp({ io, renderer, session, cwd: root, armMs: 0, actions: { copy: async () => ({ ok: true, via: "stub" }), ...actions } });
  const screen = () => scr.lines().join("\n");
  const committed = () => scrollback.join("\n");
  const until = async (pred, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}:\n${screen()}`);
  };
  try {
    await fn({ app, type: (s) => decoder.feed(s), until, screen, committed, session, engine, root });
  } finally {
    app.dispose();
    renderer.dispose();
    session.close();
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("/rename, /fork, /mcp, /hooks, /skills, /usage, /copy, /raw, /export", async () => {
  await withApp(async ({ type, until, committed, session, root }) => {
    type("early-complete\r");
    await until(() => /Worked for/.test(committed()), "a turn");
    const first = session.state.thread.id;
    type("/rename login fix\r");
    await until(() => /Named: login fix/.test(committed()), "renamed");
    assert.equal(session.state.thread.name, "login fix");
    type("/fork\r");
    await until(() => /Forked/.test(committed()), "forked");
    assert.notEqual(session.state.thread.id, first);
    assert.equal(session.state.turns.length, 1, "the copy has the history");
    for (const [cmd, shows] of [["/mcp", /broken +failed/], ["/hooks", /Hooks/], ["/skills", /debug-triage/], ["/usage", /lifetime: 123,456 tokens/], ["/copy", /Copied the last answer \(stub\)/], ["/raw", /^early$/m]]) {
      type(`${cmd}\r`);
      await until(() => shows.test(committed()), cmd);
    }
    type("/export notes.md\r");
    await until(() => /Saved notes\.md/.test(committed()), "export");
    assert.match(readFileSync(join(root, "notes.md"), "utf8"), /## Codex\n\nearly/);
    type("/export ../outside.md\r");
    await until(() => /inside this folder only/.test(committed()), "refused");
    type("/export notes.md\r");
    await until(() => /exists already/.test(committed()), "no overwrite");
  });
});

test("Esc Esc rewinds to an earlier prompt and puts it back in the composer", async () => {
  await withApp(async ({ app, type, until, committed, session, engine }) => {
    type("early-complete\r");
    await until(() => /Worked for/.test(committed()), "turn 1");
    type("fail-turn\r");
    await until(() => session.state.turns.length === 2 && !session.state.activeTurnId, "turn 2");
    await sleep(50);
    type("\x1b");
    await sleep(30);
    type("\x1b");
    await until(() => app.state.popup === "backtrack", "the rewind picker");
    type("\r"); // the last prompt
    await until(() => app.state.composer === "fail-turn", "the prompt back in the composer");
    assert.equal(session.state.turns.length, 1);
    assert.match(committed(), /Rewound to before .fail-turn.\. Files on disk weren't changed/);
    const st = await engine.server.request("debug/state", {});
    assert.ok(st.calls.includes("thread/revert"));
  });
});

test("Ctrl+T pages the transcript; Ctrl+G edits in the editor; alt+. raises the effort; a pasted image path attaches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ad-par-img-"));
  writeFileSync(join(dir, "shot.png"), "png");
  try {
    await withApp(
      async ({ app, type, until, screen, committed, engine }) => {
        type("early-complete\r");
        await until(() => /Worked for/.test(committed()), "a turn");
        type("\x14");
        await until(() => /Transcript 1–/.test(screen()), "the pager");
        type("q");
        await until(() => !/Transcript 1–/.test(screen()), "closed");
        type("draft");
        type("\x07");
        await until(() => app.state.composer === "edited draft", "the editor's text");
        type("\x15"); // ctrl+u clears the line
        type("\x1b.");
        await until(() => /Reasoning effort: high/.test(app.state.note ?? ""), "effort up");
        type(`\x1b[200~${join(dir, "shot.png")}\x1b[201~`);
        await until(() => /Attached shot\.png/.test(app.state.note ?? ""), "attached");
        type("fail-turn\r");
        await sleep(300);
        const st = await engine.server.request("debug/state", {});
        const tp = st.lastParams["turn/start"];
        assert.equal(tp.effort, "high");
        assert.deepEqual(tp.input.map((i) => i.type), ["text", "localImage"]);
        assert.equal(tp.input[1].path, join(dir, "shot.png"));
      },
      { actions: { editText: async (t) => `edited ${t}` } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
