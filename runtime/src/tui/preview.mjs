// `ad tui --preview` — the walking skeleton (plan Part 2). Throwaway glue:
// the Part 1 terminal layer (io, input, renderer) driving the existing chat
// session (harness/chat.mjs) on the real engine. Plain text streaming, a
// multi-line composer, approvals with y / a / n, Esc to interrupt, Ctrl+C to
// quit. The real app (Parts 3-6) replaces everything here except the terminal
// layer.

import { createChatSession, serializedAsk } from "../harness/chat.mjs";
import { startHarnessEngine } from "../harness/start.mjs";
import { createIo } from "./terminal/io.mjs";
import { createRenderer } from "./terminal/renderer.mjs";
import { isNewline } from "./terminal/input.mjs";
import { colorDepth, truncate, wrap } from "./terminal/text.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { setWidthProfile, stringWidth } from "./terminal/width.mjs";
import { probeWidthProfile, reflowModel, terminalName } from "./terminal/detect.mjs";

const DIM = { dim: true };
const ACCENT = { fg: "cyan", bold: true };
const WARN = { fg: "yellow" };

/**
 * Turns streamed text (chunks that may split lines and escape sequences) into
 * history lines. Complete lines are committed; the unfinished line is shown
 * live. Two kinds share one stream: "out" (answers) and "err" (activity rows,
 * shown dim). Switching kinds ends the other kind's unfinished line.
 */
export function createTranscript({ commit, width }) {
  let kind = "out";
  let buf = "";
  const style = (k) => (k === "err" ? DIM : undefined);
  const toLines = (raw, k) => {
    const text = sanitize(raw, "transcript");
    return wrap([style(k) ? { text, style: style(k) } : { text }], Math.max(4, width() - 1));
  };
  function flushComplete() {
    const nl = buf.lastIndexOf("\n");
    if (nl < 0) return;
    const done = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    commit(toLines(done, kind));
  }
  return {
    write(k, chunk) {
      if (k !== kind && buf) {
        commit(toLines(buf, kind));
        buf = "";
      }
      kind = k;
      const text = String(chunk);
      buf += text;
      // Only a chunk with a newline can complete a line (keeps long lines linear).
      if (text.includes("\n")) flushComplete();
    },
    /** End the unfinished line (end of a turn). */
    end() {
      if (buf) commit(toLines(buf, kind));
      buf = "";
    },
    /**
     * Wrapped rows of the unfinished line, for the live region. Only its tail:
     * the live region shows a few rows anyway, and re-wrapping a huge line on
     * every delta would block the event loop (Esc must stay responsive).
     */
    live(maxRows = 6) {
      if (!buf) return [];
      // Enough text for maxRows full rows (twice over, for wide characters).
      const limit = Math.min(LIVE_TAIL_CHARS, Math.max(200, maxRows * width() * 2));
      const tail = buf.length > limit ? buf.slice(-limit) : buf;
      return toLines(tail, kind).slice(-maxRows);
    },
  };
}

/** y / a / n / Esc / Ctrl+C → the words chat.mjs's parseApprovalAnswer understands, or null. */
export function approvalKey(ev) {
  if (ev.type !== "key" && ev.type !== "text") return null;
  if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) return "n";
  // Exactly one character: padded or multi-character text (a burst, a repeat
  // arriving in one chunk) is never an answer.
  const ch = ev.type === "text" ? ev.text : ev.ctrl || ev.alt ? "" : ev.name;
  const c = ch.length === 1 ? ch.toLowerCase() : "";
  if (c === "y" || c === "a" || c === "n") return c;
  return null;
}

// A prompt only takes an answer this long after it appeared, so a key typed
// for something else (type-ahead, a double tap, a held key) can't answer it.
export const APPROVAL_ARM_MS = 400;
// A second Ctrl+C this soon after an interrupt quits even if the turn is stuck.
export const FORCE_QUIT_MS = 1500;
const LIVE_TAIL_CHARS = 4000;

/**
 * The app: input → composer / approvals / interrupts; session output →
 * transcript → renderer. Terminal-free apart from `io` and `renderer`, so it
 * runs against test screens.
 */
export function createPreviewApp({ io, renderer, makeSession, header = [], hints = {}, now = () => Date.now(), armMs = APPROVAL_ARM_MS }) {
  const width = () => io.size().cols;
  const transcript = createTranscript({ commit: (lines) => renderer.commit(lines), width });
  let composer = "";
  let busy = false;
  let turnStarted = 0;
  let approval = null; // {lines, resolve}
  let notice = null;
  let tick = null;
  let drawTimer = null;
  let lastInterruptAt = -Infinity;
  let quitResolve;
  const done = new Promise((r) => (quitResolve = r));

  const sinks = {
    out: { write: (c) => (transcript.write("out", c), drawSoon(), true) },
    err: { write: (c) => (transcript.write("err", c), drawSoon(), true) },
  };
  const askOnce = (question) =>
    new Promise((resolve) => {
      // Approval text hides nothing: controls, bidi and zero-width characters are shown.
      const text = sanitize(question, "approval").replace(/\s*\[y\]es[^\n]*$/, "");
      const lines = text.split("\n");
      if (!busy) {
        // Queued behind a prompt of a turn that has ended: decline it.
        renderer.commit([[{ text: "  declined (the turn ended): ", style: WARN }, { text: lines[0] ?? "", style: DIM }]]);
        return resolve("n");
      }
      // The whole request goes into history first, so a long one can be read in
      // full (scroll up) even when the prompt below only shows its start and end.
      transcript.end();
      renderer.commit([[], ...lines.map((l, i) => [{ text: `  ${l}`, style: i === 0 ? { bold: true } : undefined }])]);
      approval = { lines, resolve, armedAt: now() };
      draw();
    });
  const session = makeSession({ out: sinks.out, err: sinks.err, ask: serializedAsk(askOnce) });

  function answer(key) {
    const a = approval;
    approval = null;
    const label = key === "y" ? "approved" : key === "a" ? "approved for this session" : "declined";
    // The request itself is already in history, right above.
    renderer.commit([[{ text: `  ${label}: `, style: key === "n" ? WARN : DIM }, { text: a.lines[0] ?? "", style: DIM }]]);
    a.resolve(key);
    draw();
  }

  async function submit() {
    const text = composer;
    if (!text.trim()) return;
    if (busy) {
      notice = "A turn is running: Esc interrupts it.";
      return draw();
    }
    composer = "";
    notice = null;
    const rows = [];
    text.split("\n").forEach((l, i) => rows.push([{ text: i === 0 ? "\u{203a} " : "  ", style: ACCENT }, { text: l }]));
    renderer.commit([...rows, []]);
    busy = true;
    turnStarted = now();
    tick = setInterval(draw, 1000);
    draw();
    try {
      const r = await session.handleLine(text);
      if (r?.exit) return quit();
    } finally {
      // A prompt still open when the turn ends (engine gone, turn failed) is declined.
      if (approval) answer("n");
      lastInterruptAt = -Infinity;
      clearInterval(tick);
      tick = null;
      busy = false;
      transcript.end();
      renderer.commit([[]]);
      draw();
    }
  }

  function quit() {
    if (approval) approval.resolve("n");
    approval = null;
    quitResolve();
  }

  // Coalesces redraws from streamed output (~30 fps); input redraws at once.
  function drawSoon() {
    if (drawTimer) return;
    drawTimer = setTimeout(() => {
      drawTimer = null;
      draw();
    }, 33);
  }

  // Esc / Ctrl+C during a turn. A second Ctrl+C soon after quits even if the
  // turn never stops (raw mode has no SIGINT, so there would be no way out).
  function interruptOrQuit(force) {
    if (!force) return void session.interrupt(); // Esc: interrupt only
    if (now() - lastInterruptAt < FORCE_QUIT_MS) return quit();
    lastInterruptAt = now();
    notice = "Interrupting. Ctrl+C again quits.";
    session.interrupt();
    draw();
  }

  function onInput(ev) {
    if (approval) {
      const key = approvalKey(ev);
      // Declining is always safe; approving needs a pause of armMs since the
      // prompt appeared and since the last key, so typing, a held key or its
      // auto-repeat never approves.
      if (key === "n") answer(key);
      else if (key && now() - approval.armedAt >= armMs) answer(key);
      else if (ev.type === "key" || ev.type === "text") approval.armedAt = now();
      return;
    }
    if (ev.type === "paste") composer += sanitize(ev.text, "transcript");
    else if (ev.type === "paste-empty") notice = "Image paste isn't supported in the preview.";
    else if (ev.type === "text") composer += sanitize(ev.text, "transcript");
    else if (ev.type === "key") {
      if (isNewline(ev)) composer += "\n";
      else if (ev.name === "enter" && !ev.alt) return void submit();
      else if (ev.name === "backspace") composer = ev.ctrl || ev.alt ? composer.replace(/\S+\s*$|\s+$/, "") : [...composer].slice(0, -1).join("");
      else if (ev.name === "escape") {
        if (busy) interruptOrQuit(false);
      } else if (ev.ctrl && ev.name === "c") {
        if (composer) composer = "";
        else if (busy) return void interruptOrQuit(true);
        else return void quit();
      } else if (ev.ctrl && ev.name === "l") return void renderer.redraw();
    }
    draw();
  }

  function draw() {
    const lines = [];
    const cols = width();
    for (const row of transcript.live()) lines.push(row);
    if (busy && !approval) {
      const secs = Math.floor((now() - turnStarted) / 1000);
      lines.push([{ text: "\u{25e6} ", style: { fg: "cyan" } }, { text: `Working (${secs}s \u{b7} esc to interrupt)`, style: DIM }]);
    }
    if (approval) {
      lines.push([]);
      const rows = [];
      for (const l of approval.lines) for (const w of wrap([{ text: l }], Math.max(4, cols - 3))) rows.push([{ text: "  " }, ...w]);
      const room = Math.max(4, io.size().rows - 8);
      if (rows.length <= room) lines.push(...rows);
      else {
        const head = room - 3;
        lines.push(...rows.slice(0, head));
        lines.push([{ text: `  \u{2026} ${rows.length - head - 2} more lines: the full request is in the scrollback above`, style: WARN }]);
        lines.push(...rows.slice(-2));
      }
      lines.push([{ text: "  y", style: ACCENT }, { text: " yes  " }, { text: "a", style: ACCENT }, { text: " always this session  " }, { text: "n", style: ACCENT }, { text: " no (esc)" }]);
    }
    if (notice) lines.push([{ text: notice, style: WARN }]);
    lines.push([]);
    const body = composer.split("\n");
    const top = lines.length;
    body.forEach((l, i) => lines.push([{ text: i === 0 ? "\u{203a} " : "  ", style: ACCENT }, { text: l }]));
    if (!composer) lines[lines.length - 1].push({ text: busy ? "Wait for the turn, or esc" : "Ask ad to do anything", style: DIM });
    const keys = `enter send \u{b7} ${hints.newline ?? "ctrl+j"} newline \u{b7} esc interrupt \u{b7} ctrl+c quit`;
    lines.push([{ text: `  ${keys}`, style: DIM }]);
    const last = body[body.length - 1];
    renderer.frame({ lines, cursor: approval ? { row: lines.length - 1, col: 0 } : { row: top + body.length - 1, col: 2 + stringWidth(last) } });
  }

  const offInput = io.onInput(onInput);
  const offResize = renderer.onResize(() => draw());
  renderer.commit(header);
  draw();

  return {
    done,
    session,
    get state() {
      return { composer, busy, approval: approval ? approval.lines : null, notice };
    },
    /** The engine exited: decline an open prompt and say so. */
    engineStopped(code) {
      if (approval) answer("n");
      renderer.commit([[{ text: `Codex stopped (exit ${Number.isInteger(code) ? code : "?"}). Ctrl+C quits; run ad tui --preview again to restart.`, style: WARN }]]);
      draw();
    },
    dispose() {
      clearInterval(tick);
      clearTimeout(drawTimer);
      offInput();
      offResize();
    },
  };
}

export function boxed(rows, cols) {
  const inner = Math.max(20, Math.min(76, cols - 3));
  // Folder names, model names and account fields are not ours: sanitize them.
  // A long folder path is cut so the box stays closed.
  const row = (raw) => {
    const text = truncate([{ text: sanitize(raw, "transcript") }], inner - 2).map((s) => s.text).join("");
    return [{ text: "\u{2502} ", style: DIM }, { text }, { text: " ".repeat(Math.max(0, inner - 2 - stringWidth(text))) + " \u{2502}", style: DIM }];
  };
  return [
    [{ text: "\u{256d}" + "\u{2500}".repeat(inner) + "\u{256e}", style: DIM }],
    ...rows.map(row),
    [{ text: "\u{2570}" + "\u{2500}".repeat(inner) + "\u{256f}", style: DIM }],
    [],
  ];
}

export async function cmdTuiPreview(opts = {}) {
  const err = opts.stderr ?? process.stderr;
  const cwd = opts.cwd ?? process.cwd();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    err.write("ad tui needs an interactive terminal. Use `ad chat` for pipes and scripts.\n");
    return 2;
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (process.platform === "win32" && !((major === 22 && minor >= 17) || (major === 24 && minor >= 2) || major >= 25)) {
    err.write(`ad tui needs Node 22.17+ or 24.2+ on Windows (this is ${process.version}): older versions turn a multi-line paste into one message per line. Upgrade Node within 22.x, or use \`ad chat\`.\n`);
    return 2;
  }
  let engine;
  let io;
  let renderer;
  let app;
  try {
    const started = await startHarnessEngine({ cwd, home: opts.home, command: opts.command, clientVersion: opts.clientVersion, store: opts.store, err, detached: true });
    if (!started.engine) {
      err.write(started.error + "\n");
      return started.code;
    }
    engine = started.engine;
    const acct = await engine.account().catch(() => ({}));
    const config = await engine.readConfig().catch(() => ({}));
    io = createIo();
    const caps = await io.enter();
    setWidthProfile(await probeWidthProfile({ io }));
    renderer = createRenderer({ io, caps, depth: colorDepth({ isTTY: true }), reflow: reflowModel(), resizeSource: process.stdout });
    await renderer.start();
    const term = terminalName();
    const login = acct.account ? (acct.account.type === "chatgpt" ? `ChatGPT ${acct.account.planType ?? ""}`.trim() : acct.account.type) : "provider key";
    const header = boxed(
      [
        `>_ Agent Daemon (v${opts.clientVersion ?? "?"}) \u{b7} terminal UI preview`,
        "",
        `model:     ${opts.model ?? config.model ?? "(Codex default)"} \u{b7} ${login}`,
        `directory: ${cwd}`,
        `sandbox:   ${opts.sandbox ?? "workspace-write"} \u{b7} asks first`,
      ],
      io.size().cols,
    );
    const newline = term === "zed" || caps.kitty ? "shift+enter" : term === "windows-terminal" ? "ctrl+enter" : "ctrl+j";
    app = createPreviewApp({
      io,
      renderer,
      header,
      hints: { newline },
      makeSession: ({ out, err: errSink, ask }) => createChatSession({ engine, cwd, out, err: errSink, ask, model: opts.model, sandbox: opts.sandbox }),
    });
    engine.on("exit", (info) => app.engineStopped(info?.code));
    await app.done;
    return 0;
  } catch (e) {
    io?.restore();
    err.write(`ad tui: ${e.message}\n`);
    return 1;
  } finally {
    app?.dispose();
    renderer?.frame({ lines: [] });
    renderer?.dispose();
    await io?.close();
    await engine?.close();
  }
}
