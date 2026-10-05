// The terminal app (plan Part 6): input → intents, session state → frames.
// Finished cells go into the terminal's scrollback (renderer.commit); the
// live region holds what is still changing, the status line, a modal or
// popup, the composer and the footer.
//
//   createApp({io, renderer, session, cwd, header, newline, history, actions, …})
//     → {done: Promise<{reason}>, draw(), notice(level, text), commit(lines), dispose()}
//
// Terminal-free apart from `io` (size, input) and `renderer`, so it runs
// against the test screens. Everything slow or outside the session (git,
// file search, handing the terminal to another program) comes in `actions`.

import { createComposer } from "./view/composer.mjs";
import { createMarkdownStream } from "./view/markdown.mjs";
import { isExploring, renderAdRow, renderCell, renderDiff, renderExploring, renderNotice, renderPlan } from "./view/cells.mjs";
import { createPicker, renderFooter, renderShortcuts, renderStatus } from "./view/chrome.mjs";
import { ARM_MS, createRequestModal } from "./view/modals.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { truncate } from "./terminal/text.mjs";
import { INIT_PROMPT } from "./init-prompt.mjs";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copyText, exportMarkdown, imagePath, lastAgentText, renderHooks, renderMcp, renderSkills, renderUsage, terminalSetup, transcriptLines } from "./commands.mjs";

export const FORCE_QUIT_MS = 1500;
const FRAME_MS = 33;
const LIVE_SHARE = 0.6; // at most this much of the screen for streaming cells

const DIM = { dim: true };
const WARN = { fg: "yellow" };

// source "codex": the same command as Codex's (its name must stay one of
// Codex's); "ad": ad's own (its name must never be one of Codex's). The
// collision test checks both against codex-slash.json from the pinned tag.
export const SLASH_COMMANDS = [
  { name: "help", source: "ad", desc: "what you can do here" },
  { name: "new", source: "codex", desc: "start a new conversation" },
  { name: "resume", source: "codex", desc: "continue an earlier conversation" },
  { name: "model", source: "codex", desc: "choose the model and reasoning effort" },
  { name: "permissions", source: "codex", desc: "what Codex may do without asking" },
  { name: "status", source: "codex", desc: "account, model, sandbox, tokens, limits" },
  { name: "goal", source: "codex", desc: "set a goal for this conversation (/goal clear)" },
  { name: "review", source: "codex", desc: "review your uncommitted changes" },
  { name: "diff", source: "codex", desc: "show git changes, untracked files included" },
  { name: "compact", source: "codex", desc: "summarize the conversation to free context" },
  { name: "init", source: "codex", desc: "create an AGENTS.md for this repo (Codex's prompt)" },
  { name: "warnings", source: "codex", desc: "notices kept from this session, and unknown events" },
  { name: "remember", source: "ad", desc: "save a note to ad's project memory" },
  { name: "memory", source: "ad", desc: "ad's memory: search, recent, forget, profile (not Codex's /memories)" },
  { name: "private", source: "ad", desc: "toggle: prompts are wrapped in <private> (ad never learns from them)" },
  { name: "proposals", source: "ad", desc: "skill changes ad proposes (review with /ad review)" },
  { name: "loop", source: "ad", desc: "work toward an objective in the background (/loop stop)" },
  { name: "team", source: "ad", desc: "the team board" },
  { name: "schedule", source: "ad", desc: "scheduled jobs (/schedule run <id>)" },
  { name: "tools", source: "ad", desc: "optional agent tools (/tools enable browser)" },
  { name: "login", source: "ad", desc: "sign in (ChatGPT, OpenAI key, OpenRouter)" },
  { name: "logout", source: "codex", desc: "sign out of Codex in ad's home" },
  { name: "codex", source: "ad", desc: "open the stock Codex UI on this conversation" },
  { name: "ad", source: "ad", desc: "run an ad command, e.g. /ad doctor" },
  { name: "fork", source: "codex", desc: "continue in a copy of this conversation" },
  { name: "rename", source: "codex", desc: "name this conversation" },
  { name: "copy", source: "codex", desc: "copy the last answer to the clipboard" },
  { name: "raw", source: "codex", desc: "print the last answer as plain text (for selecting)" },
  { name: "export", source: "codex", desc: "save the conversation as markdown in this folder" },
  { name: "mcp", source: "codex", desc: "MCP servers and their status" },
  { name: "hooks", source: "codex", desc: "hooks and whether they are trusted" },
  { name: "skills", source: "codex", desc: "skills Codex can use here" },
  { name: "usage", source: "codex", desc: "usage limits and tokens" },
  { name: "image", source: "ad", desc: "attach an image file to the next prompt" },
  { name: "terminal-setup", source: "ad", desc: "how to make Shift+Enter add a newline here" },
  { name: "quit", source: "codex", desc: "exit ad" },
  { name: "exit", source: "codex", desc: "exit ad" },
];

const PERMISSION_PRESETS = [
  { label: "Read only", hint: "asks before any change", value: { sandboxPolicy: { type: "readOnly" }, approvalPolicy: "on-request" } },
  { label: "Auto", hint: "edits this folder, asks for the rest (default)", value: { sandboxPolicy: { type: "workspaceWrite" }, approvalPolicy: "on-request" } },
  { label: "Full access", hint: "no sandbox, never asks; use with care", value: { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" } },
];

const clean = (t) => sanitize(String(t ?? ""), "transcript");

/** The first bold phrase of a reasoning summary ("**Checking tests**"), for the status line. */
export function reasoningHeadline(text) {
  const m = /\*\*([^*\n]{1,80})\*\*/.exec(String(text ?? ""));
  return m ? clean(m[1]).trim() : null;
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function createApp({
  io,
  renderer,
  session,
  cwd = process.cwd(),
  header = [],
  newline = "ctrl+j",
  history = null,
  actions = {},
  meters = () => [],
  chips = () => [],
  info = {},
  now = () => Date.now(),
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
  armMs = ARM_MS,
}) {
  const st = session.state;
  const composer = createComposer({ history });
  const width = () => Math.max(10, io.size().cols - 2);
  const height = () => Math.max(4, io.size().rows);

  // What is already in the scrollback.
  let committed = new Set(); // item ids
  let streams = new Map(); // agentMessage id → {md, fed}
  let echoesShown = new Set(); // clientUserMessageIds committed as typed
  let turnsSeen = new Map(); // turnId → status reported
  const noticesSeen = new WeakSet();
  let lastWasCell = false;

  let modal = null; // {id, view}
  let popup = null; // {kind, view, onSelect}
  let overlay = false; // the ? shortcuts
  let note = null; // one transient line above the composer
  let lastCtrlC = -Infinity;
  let lastEsc = -Infinity;
  let attachments = []; // image paths for the next prompt
  let pager = null; // {lines, top} while Ctrl+T shows the transcript
  let privateMode = false; // prompts wrapped in <private>…</private>
  const learnedShown = new Set(); // learning ids already shown as a row
  let loopWasRunning = false;
  let turnStartedAt = null; // the running turn's start (for "Worked for")
  const turnStarts = new Map(); // turnId → when this app first saw it running
  let drawTimer = null;
  let ticker = null;
  let searchTimer = null;
  let searchSeq = 0;
  let quitResolve;
  let quitting = false;
  const done = new Promise((r) => (quitResolve = r));

  /* -------------------------------------------------------------- */
  /* Scrollback                                                      */
  /* -------------------------------------------------------------- */

  function commit(lines) {
    if (lines.length) renderer.commit(lines);
  }

  // A cell gets a blank line before it, as in Codex.
  function commitCell(lines) {
    if (!lines.length) return;
    commit(lastWasCell ? [[], ...lines] : lines);
    lastWasCell = true;
  }

  function resetThreadView() {
    committed = new Set();
    streams = new Map();
    echoesShown = new Set();
    turnsSeen = new Map();
    turnStartedAt = null;
  }

  const rootItems = () => [...st.items.values()].filter((it) => !st.thread || it.threadId === st.thread.id || it.threadId == null);
  const turnActive = () => Boolean(st.activeTurnId || st.starting);

  // An item whose turn has ended can't change any more, even if Codex never
  // completed it (a crash, a declined patch): it must not hold back the
  // scrollback behind it.
  function turnOver(it) {
    const t = it.turnId ? st.turns.find((x) => x.id === it.turnId) : null;
    if (t) return t.status !== "inProgress";
    return !turnActive();
  }
  const open = (it) => (it.streaming || it.status === "inProgress") && !turnOver(it);
  const settledView = (it) => (it.streaming || it.status === "inProgress" ? { ...it, streaming: false, incomplete: true } : it);

  /**
   * Commits every item that can no longer change, in order. Stops at the
   * first one still streaming (an agent message commits its finished lines
   * as it goes); what is left is drawn live.
   */
  function flush() {
    const items = rootItems().filter((it) => !committed.has(it.id));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "userMessage") {
        committed.add(it.id);
        if (it.clientId && echoesShown.has(it.clientId)) continue;
        commitCell(renderCell(it, { width: width() }));
        continue;
      }
      if (it.kind === "agentMessage") {
        let s = streams.get(it.id);
        if (!s) {
          s = { md: createMarkdownStream({ width: width() - 2 }), fed: 0, started: false };
          streams.set(it.id, s);
        }
        const text = String(it.text ?? "");
        const fresh = s.md.push(text.slice(s.fed));
        s.fed = text.length;
        const live = open(it);
        const out = live ? fresh : [...fresh, ...s.md.finish()];
        if (out.length) {
          const lines = out.map((l) => [{ text: s.started ? "  " : "\u{2022} ", style: DIM }, ...l]);
          if (!s.started) commitCell(lines);
          else commit(lines);
          s.started = true;
        }
        if (live) return items.slice(i);
        committed.add(it.id);
        streams.delete(it.id);
        continue;
      }
      if (isExploring(it)) {
        let j = i;
        while (j < items.length && isExploring(items[j])) j++;
        const group = items.slice(i, j);
        const settled = group.every((g) => !open(g));
        // A run of exploring commands is one cell: it ends at the next other item or the turn's end.
        if (!settled || (j === items.length && turnActive())) return items.slice(i);
        commitCell(renderExploring(group.map(settledView), { width: width() }));
        for (const g of group) committed.add(g.id);
        i = j - 1;
        continue;
      }
      if (open(it)) return items.slice(i);
      committed.add(it.id);
      commitCell(renderCell(settledView(it), { width: width() }));
    }
    return [];
  }

  function reportTurns() {
    for (const t of st.turns) {
      if (t.status === "inProgress") {
        if (!turnStarts.has(t.id)) turnStarts.set(t.id, turnStartedAt ?? now());
        continue;
      }
      if (turnsSeen.get(t.id) === t.status) continue;
      turnsSeen.set(t.id, t.status);
      actions.bell?.({ unfocusedOnly: true });
      showLearned(turnStarts.get(t.id) ?? turnStartedAt);
      if (t.status === "failed" && t.error) commitCell(renderNotice({ level: "error", message: `The turn failed: ${t.error.message ?? "unknown error"}` }, { width: width() }));
      else if (t.status === "interrupted") commitCell(renderNotice({ level: "warn", message: "Interrupted. Tell Codex what to do differently." }, { width: width() }));
      const started = turnStarts.get(t.id) ?? turnStartedAt;
      turnStarts.delete(t.id);
      if (started != null) {
        const label = ` Worked for ${elapsed(now() - started)} `;
        const w = width();
        const side = Math.max(1, Math.floor((w - label.length) / 2));
        commit([[], [{ text: `${"\u{2500}".repeat(side)}${label}${"\u{2500}".repeat(Math.max(1, w - side - label.length))}`, style: DIM }]]);
        lastWasCell = false;
        turnStartedAt = null;
      }
    }
  }

  // "Learned:" rows for what ad's hooks recorded during the turn (keyed by thread id).
  function showLearned(since) {
    const ad = actions.ad;
    if (!ad?.learnedSince || !st.thread || since == null) return;
    const iso = new Date(since - 1000).toISOString().replace("T", " ").slice(0, 19);
    Promise.resolve(ad.learnedSince(st.thread.id, iso))
      .then((rows) => {
        for (const r of rows ?? []) {
          if (learnedShown.has(r.id)) continue;
          learnedShown.add(r.id);
          commitCell(renderAdRow("learned", r.text, { width: width() }));
        }
        if (rows?.length) drawSoon();
      })
      .catch(() => {});
  }

  // Background loop: one ad row per iteration, and one when it ends.
  function pollLoop() {
    const loop = actions.ad?.loop;
    if (!loop) return;
    for (const r of loop.poll()) {
      commitCell(renderAdRow("loop", `iteration ${r.iteration} ${r.turnStatus}${r.progress ? ` \u{b7} ${r.progress}` : ""}`, { width: width() }));
    }
    const state = loop.state;
    if (loopWasRunning && !state.running) commitCell(renderAdRow("loop", `finished after ${state.iterations} iteration${state.iterations === 1 ? "" : "s"} (exit ${state.exit})`, { width: width() }));
    loopWasRunning = state.running;
  }

  function reportNotices() {
    for (const n of st.notices) {
      if (noticesSeen.has(n)) continue;
      noticesSeen.add(n);
      commitCell(renderNotice(n, { width: width() }));
    }
  }

  /* -------------------------------------------------------------- */
  /* Requests                                                        */
  /* -------------------------------------------------------------- */

  function syncModal() {
    const head = st.requests[0]?.request ?? null;
    if (modal && modal.id !== head?.id) {
      // Answered here, or resolved elsewhere (another client, the turn ended).
      if (!modal.answered) commit([[{ text: "  The request was withdrawn.", style: DIM }]]);
      modal = null;
    }
    if (!modal && head) {
      const diff = head.kind === "approval-patch" ? (st.items.get(head.itemId)?.changes ?? null) : null;
      const view = createRequestModal(head, { now, armMs, diff });
      if (!view) {
        // Nothing here can answer it (a tool call): decline, and say how to get it.
        session.resolve(head.id, null);
        note = { level: "warn", text: "This needs the stock UI: /codex" };
        return;
      }
      modal = { id: head.id, view, answered: false };
      commitCell(view.history({ width: width() }));
      actions.bell?.();
    }
  }

  function answerLabel(value) {
    if (value == null || value === "decline" || value === "cancel" || value?.action === "decline" || value?.action === "cancel") return null;
    if (value === "accept" || value === "turn") return "approved";
    if (value === "acceptForSession" || value === "session") return "approved for this session";
    if (value?.acceptWithExecpolicyAmendment) return "approved; won't ask again for this prefix";
    if (value?.applyNetworkPolicyAmendment) return "approved; this host is always allowed";
    return "answered";
  }

  function answer(value) {
    const m = modal;
    m.answered = true;
    const label = answerLabel(value);
    commit([[{ text: label ? `  \u{2714} ${label}` : "  \u{2717} declined", style: label ? DIM : WARN }]]);
    session.resolve(m.id, value);
  }

  /* -------------------------------------------------------------- */
  /* Drawing                                                         */
  /* -------------------------------------------------------------- */

  function liveItems(pending) {
    const out = [];
    const w = width();
    for (let i = 0; i < pending.length; i++) {
      const it = pending[i];
      if (it.kind === "agentMessage") {
        const s = streams.get(it.id);
        if (!s) {
          out.push(...renderCell(it, { width: w }));
          continue;
        }
        out.push(...s.md.live().map((l, k) => [{ text: k === 0 && !s.started ? "\u{2022} " : "  ", style: DIM }, ...l]));
      } else if (isExploring(it)) {
        let j = i;
        while (j < pending.length && isExploring(pending[j])) j++;
        out.push(...renderExploring(pending.slice(i, j), { width: w }));
        i = j - 1;
      } else if (it.kind !== "userMessage") out.push(...renderCell(it, { width: w }));
    }
    // Prompts sent but not yet echoed by Codex.
    for (const [cid, text] of st.echoes) if (!echoesShown.has(cid)) out.push(...renderCell({ kind: "userMessage", text }, { width: w }));
    return out;
  }

  function statusLines() {
    if (!turnActive()) return [];
    let label = "Working";
    for (const it of rootItems()) if (it.kind === "reasoning") label = reasoningHeadline(it.summaryText ?? (it.summary ?? []).join("\n")) ?? label;
    const since = (st.activeTurnId && turnStarts.get(st.activeTurnId)) ?? turnStartedAt ?? now();
    return renderStatus({ label, elapsedMs: now() - since, frame: Math.floor(now() / 600), queued: st.queue.map((q) => q.text) }, { width: width() });
  }

  function footer() {
    const running = turnActive();
    const hints = running ? ["enter steer", "tab queue", `${newline} newline`] : ["? shortcuts", "@ files", `${newline} newline`];
    const own = [];
    if (privateMode) own.push({ full: "private", short: "P" });
    const loop = actions.ad?.loop?.state;
    if (loop?.running) own.push({ full: `loop ${loop.iterations}`, short: `L${loop.iterations}` });
    return renderFooter({ hints, chips: [...chips(), ...own], meters: meters(st) }, { width: width() });
  }

  function draw() {
    clearT(drawTimer);
    drawTimer = null;
    if (quitting) return;
    const pending = flush();
    reportNotices();
    reportTurns();
    syncModal();
    const w = width();
    const rows = height();
    const lines = [];
    if (pager && !modal) {
      // Ctrl+T: the whole transcript, paged inside the live region.
      const view = Math.max(1, rows - 2);
      pager.top = Math.max(0, Math.min(pager.top, pager.lines.length - view));
      lines.push(truncate([{ text: `Transcript ${pager.top + 1}\u{2013}${Math.min(pager.lines.length, pager.top + view)} of ${pager.lines.length}  `, style: { bold: true } }, { text: "\u{2191}\u{2193} pgup pgdn home end \u{b7} q or esc closes", style: DIM }], w));
      lines.push(...pager.lines.slice(pager.top, pager.top + view));
      renderer.frame({ lines, cursor: { row: 0, col: 0 } });
      return;
    }
    let live = liveItems(pending);
    const cap = Math.max(3, Math.floor(rows * LIVE_SHARE));
    if (live.length > cap) live = [[{ text: `  \u{2026} ${live.length - cap + 1} more lines above`, style: DIM }], ...live.slice(-(cap - 1))];
    lines.push(...live);
    if (st.plan && turnActive()) lines.push(...renderPlan(st.plan.steps, { width: w, explanation: st.plan.explanation }));
    lines.push(...statusLines());
    if (st.engine.state === "crashed") {
      const code = Number.isInteger(st.engine.exitCode) ? ` (exit ${st.engine.exitCode})` : "";
      lines.push(truncate([{ text: `\u{25a0} Codex stopped${code}. Your text is kept. Enter restarts and resumes.`, style: WARN }], w));
    } else if (st.engine.state === "restarting") lines.push(truncate([{ text: "\u{25e6} Restarting Codex\u{2026}", style: DIM }], w));
    let cursor = null;
    if (modal) {
      if (lines.length) lines.push([]);
      const budget = Math.max(4, rows - lines.length - 2);
      lines.push(...modal.view.render({ width: w, height: budget }));
      cursor = { row: lines.length - 1, col: 0 };
    } else {
      if (note) lines.push(truncate([{ text: clean(note.text), style: note.level === "warn" || note.level === "error" ? WARN : DIM }], w));
      if (attachments.length) lines.push(truncate([{ text: `  \u{1f4ce} ${attachments.map((a) => clean(path.basename(a))).join(", ")}`, style: { fg: "cyan" } }], w));
      if (lines.length) lines.push([]);
      const top = lines.length;
      const c = composer.render({ width: w, prompt: "\u{203a} ", placeholder: turnActive() ? "Steer the turn, or tab to queue" : "Ask ad to do anything" });
      lines.push(...c.lines);
      cursor = { row: top + c.cursor.row, col: c.cursor.col };
      if (popup) lines.push(...popup.view.render({ width: w, height: Math.min(10, Math.max(3, rows - lines.length - 1)) }));
      else if (overlay) lines.push(...renderShortcuts({ newline }, { width: w }));
      else if (rows >= 10) lines.push(footer());
    }
    // The live region never takes the whole screen.
    const max = Math.max(1, rows - 1);
    const cut = lines.length > max ? lines.length - max : 0;
    renderer.frame({ lines: lines.slice(cut), cursor: cursor ? { row: Math.max(0, cursor.row - cut), col: cursor.col } : undefined });
  }

  function drawSoon() {
    if (drawTimer) return;
    drawTimer = setT(draw, FRAME_MS);
  }

  /* -------------------------------------------------------------- */
  /* Popups                                                          */
  /* -------------------------------------------------------------- */

  function openPicker(kind, items, onSelect, opts = {}) {
    popup = { kind, view: createPicker({ items, ...opts }), onSelect };
    draw();
  }

  // @ and / complete from what is being typed in the composer.
  function syncTokenPopup() {
    const tok = composer.token();
    if (!tok) {
      if (popup?.kind === "command" || popup?.kind === "mention") popup = null;
      return;
    }
    if (tok.kind === "command") {
      const q = tok.text.slice(1).toLowerCase();
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ label: `/${c.name}`, hint: c.desc, value: c.name }));
      popup = items.length ? { kind: "command", view: createPicker({ items, showQuery: false }), tok, onSelect: (name) => composer.replace(tok.start, tok.end, `/${name} `) } : null;
      return;
    }
    if (!actions.searchFiles) return;
    const q = tok.text.slice(1);
    clearT(searchTimer);
    const seq = ++searchSeq;
    searchTimer = setT(async () => {
      const files = await actions.searchFiles(q).catch(() => []);
      if (seq !== searchSeq) return;
      const t = composer.token();
      if (!t || t.kind !== "mention") return;
      const items = files.slice(0, 50).map((f) => ({ label: clean(f), value: f }));
      popup = items.length ? { kind: "mention", view: createPicker({ items, showQuery: false }), onSelect: (f) => composer.replace(t.start, t.end, `@${/\s/.test(f) ? `"${f}"` : f} `) } : null;
      draw();
    }, 120);
  }

  // Keys for a completion popup: ↑/↓ pick, Tab/Enter accept, Esc closes; typing goes to the composer.
  function popupKey(ev) {
    if (popup.kind === "command" || popup.kind === "mention") {
      if (ev.type === "key" && ["up", "down", "tab"].includes(ev.name)) {
        const r = popup.view.handle(ev.name === "tab" ? { ...ev, name: "enter" } : ev);
        if (r?.select !== undefined) {
          const p = popup;
          popup = null;
          p.onSelect(r.select);
        }
        return true;
      }
      if (ev.type === "key" && ev.name === "escape") {
        popup = null;
        return true;
      }
      if (ev.type === "key" && ev.name === "enter" && !ev.shift && !ev.ctrl && !ev.alt) {
        const r = popup.view.handle(ev);
        const p = popup;
        popup = null;
        if (r?.select === undefined) return false;
        if (p.kind === "mention") p.onSelect(r.select);
        else {
          // Enter on the command list runs the highlighted command.
          composer.clear();
          dispatch(`/${r.select}`);
        }
        return true;
      }
      return false; // typing goes to the composer
    }
    const r = popup.view.handle(ev);
    if (r?.cancel) popup = null;
    else if (r?.select !== undefined) {
      const p = popup;
      popup = null;
      p.onSelect(r.select, r.item);
    }
    return true;
  }

  /* -------------------------------------------------------------- */
  /* Commands                                                        */
  /* -------------------------------------------------------------- */

  const info0 = (text) => commitCell(renderNotice({ level: "info", message: text }, { width: width() }));
  const warn = (text) => commitCell(renderNotice({ level: "warn", message: text }, { width: width() }));
  const fail = (err) => warn(err?.message ?? String(err));

  async function slash(name, arg) {
    switch (name) {
      case "help":
        return commitCell([
          [{ text: "Commands", style: { bold: true } }],
          ...SLASH_COMMANDS.filter((c) => c.name !== "exit").map((c) => truncate([{ text: `  /${c.name.padEnd(12)}`, style: { fg: "cyan" } }, { text: c.desc, style: DIM }], width())),
          [],
          ...renderShortcuts({ newline }, { width: width() }),
        ]);
      case "new":
        session.newThread();
        resetThreadView();
        return info0("New conversation.");
      case "quit":
      case "exit":
        return quit("command");
      case "compact":
        if (!st.thread) return warn("Nothing to compact yet.");
        info0("Compacting…");
        return session.compact().catch(fail);
      case "goal":
        if (!arg) return info0(st.goal ? `Goal: ${clean(typeof st.goal === "string" ? st.goal : (st.goal.objective ?? JSON.stringify(st.goal)))}` : "No goal. /goal <objective> sets one.");
        return session.setGoal(arg === "clear" ? null : arg).then((g) => info0(g ? "Goal set." : "Goal cleared."), fail);
      case "review":
        if (turnActive()) return warn("Wait for the turn to finish (or esc), then /review.");
        return session.review().catch(fail);
      case "init":
        return send(INIT_PROMPT, "/init");
      case "status":
        return commitCell(statusReport());
      case "warnings":
        return commitCell(warningsReport());
      case "model":
        return pickModel();
      case "permissions":
        return openPicker("permissions", PERMISSION_PRESETS.map((p) => ({ label: p.label, hint: p.hint, value: p.value })), (value, item) => {
          session.setNextTurn(value);
          info0(`Permissions: ${item.label} (from the next turn).`);
        });
      case "resume":
        return pickThread();
      case "logout":
        return Promise.resolve(session.engine.logout())
          .then(() => warn("Signed out. /login to sign in again."))
          .catch(fail);
      case "diff":
        if (!actions.gitDiff) return warn("/diff isn't available here.");
        return actions
          .gitDiff()
          .then((d) => {
            if (d.error) return warn(d.error);
            if (!d.changes.length) return info0("No changes.");
            commitCell(renderDiff(d.changes, { width: width(), verb: "Changes:", maxLines: 200 }));
          })
          .catch(fail);
      case "fork":
        if (turnActive()) return warn("Wait for the turn to finish (or esc), then /fork.");
        return session.fork().then(() => info0("Forked: you are in the copy now; the original is unchanged."), fail);
      case "rename":
        if (!arg) return warn("/rename <name>");
        return session.rename(arg).then((n) => info0(`Named: ${clean(n)}`), fail);
      case "copy": {
        const t = lastAgentText(st);
        if (!t) return warn("No answer to copy yet.");
        return (actions.copy ?? copyText)(t, { write: (d) => io.write(d) }).then((r) => (r.ok ? info0(`Copied the last answer${r.via && r.via !== "terminal" ? ` (${r.via})` : ""}.`) : warn("Couldn't reach a clipboard. /raw prints it for selecting.")));
      }
      case "raw": {
        const t = lastAgentText(st);
        if (!t) return warn("No answer yet.");
        return commitCell(sanitize(t, "transcript").replace(/\t/g, "    ").split("\n").map((l) => [{ text: l }]));
      }
      case "export": {
        if (!st.thread) return warn("Nothing to export yet.");
        const name = arg || `ad-conversation-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
        const file = path.resolve(cwd, name);
        if (path.relative(cwd, file).startsWith("..") || path.isAbsolute(path.relative(cwd, file))) return warn("/export writes inside this folder only.");
        if (existsSync(file)) return warn(`${clean(name)} exists already: pick another name.`);
        try {
          writeFileSync(file, exportMarkdown(st), { flag: "wx" });
          return info0(`Saved ${clean(path.relative(cwd, file))}`);
        } catch (err) {
          return fail(err);
        }
      }
      case "mcp":
        return session.engine.server.request("mcpServerStatus/list", {}).then((r) => commitCell(renderMcp(r?.data, { width: width() })), fail);
      case "hooks":
        return Promise.resolve(session.engine.listHooks([cwd])).then((h) => commitCell(renderHooks(h, { width: width(), hooksFile: session.engine.home ? path.join(session.engine.home, "hooks.json") : null })), fail);
      case "skills":
        return session.engine.server.request("skills/list", { cwds: [cwd] }).then((r) => commitCell(renderSkills(r?.data, { width: width() })), fail);
      case "usage": {
        const rl = await session.engine.server.request("account/rateLimits/read", {}).catch(() => st.rateLimits);
        const usage = await session.engine.server.request("account/usage/read", {}).catch(() => null);
        return commitCell(renderUsage({ rateLimits: rl ?? st.rateLimits, usage, tokens: st.tokens }, { width: width() }));
      }
      case "image": {
        const img = imagePath(arg, cwd);
        if (!img) return warn("/image <path to a .png, .jpg, .gif, .webp or .bmp file>");
        attachments.push(img);
        return info0(`Attached ${clean(path.basename(img))} to the next prompt (esc on an empty prompt removes it).`);
      }
      case "terminal-setup":
        return commitCell(terminalSetup(info.terminal).map((l) => truncate([{ text: l }], width())));
      case "remember":
        if (!arg) return warn("/remember <what to remember>");
        if (!actions.remember) return warn("Memory isn't available here.");
        return Promise.resolve(actions.remember(arg)).then(() => commitCell(renderAdRow("learned", arg, { width: width() })), fail);
      case "memory": {
        if (!actions.ad?.memory) return warn("Memory isn't available here.");
        const [sub, ...rest] = arg.split(/\s+/);
        return Promise.resolve(actions.ad.memory(sub ?? "", rest.join(" "))).then((lines) => commitCell(lines.map((l) => truncate([{ text: clean(l), style: DIM }], width()))), fail);
      }
      case "private":
        privateMode = !privateMode;
        return info0(privateMode ? "Private: your prompts are wrapped in <private>, so ad never learns from them. /private again turns it off." : "Private is off.");
      case "proposals":
        if (!actions.ad?.proposals) return warn("Proposals aren't available here.");
        return commitCell(actions.ad.proposals().map((l) => truncate([{ text: clean(l) }], width())));
      case "loop": {
        const loop = actions.ad?.loop;
        if (!loop) return warn("Loops aren't available here.");
        if (!arg) {
          const s = loop.state;
          return info0(s.running ? `A loop is running: iteration ${s.iterations}${s.last?.progress ? ` (${s.last.progress})` : ""}. /loop stop ends it after this turn.` : '/loop "<objective>" works toward it in the background, with ad loop\'s brakes.');
        }
        if (arg === "stop") {
          const r = loop.stop();
          return r.error ? warn(r.error) : info0("Stopping the loop after its current turn.");
        }
        const r = loop.start(arg.replace(/^"(.*)"$/s, "$1"));
        if (r.error) return warn(r.error);
        loopWasRunning = true;
        return commitCell(renderAdRow("loop", `started: ${arg}`, { width: width() }));
      }
      case "team":
        if (!actions.ad?.team) return warn("Teams aren't available here.");
        return Promise.resolve(actions.ad.team(arg || null)).then((lines) => commitCell(lines.map((l) => truncate([{ text: clean(l) }], width()))), fail);
      case "schedule": {
        if (!actions.ad?.schedules) return warn("Schedules aren't available here.");
        const m = /^run\s+(\S+)$/.exec(arg);
        if (m) return slash("ad", `schedule run ${m[1]}`);
        return Promise.resolve(actions.ad.schedules()).then((lines) => commitCell(lines.map((l) => truncate([{ text: clean(l) }], width()))), fail);
      }
      case "tools":
        return slash("ad", `tools ${arg || "list"}`);
      case "login":
      case "codex":
      case "ad": {
        const run = { login: actions.login, codex: actions.openCodex, ad: actions.runAd }[name];
        if (!run) return warn(`/${name} isn't available here.`);
        if (turnActive()) return warn(`Wait for the turn to finish (or esc), then /${name}.`);
        // /codex lets go of the thread and resumes it afterwards: what is
        // already in the scrollback stays committed; only new turns show.
        const known = new Set(committed);
        const seen = new Map(turnsSeen);
        return Promise.resolve(run(arg, { threadId: st.thread?.id ?? null }))
          .then((msg) => {
            if (name === "codex") {
              for (const id of known) committed.add(id);
              for (const [k, v] of seen) turnsSeen.set(k, v);
            }
            if (msg) info0(msg);
            renderer.redraw?.();
          })
          .catch(fail);
      }
      default:
        return warn(`Unknown command /${clean(name)}. /help lists them.`);
    }
  }

  function warningsReport() {
    const kept = st.notices.filter((n) => n.level !== "info");
    const unknown = Object.entries(session.engine?.unknownCounts?.() ?? {});
    if (!kept.length && !unknown.length) return renderNotice({ level: "info", message: "No warnings in this session." }, { width: width() });
    const out = [[{ text: "Warnings", style: { bold: true } }]];
    for (const n of kept.slice(-20)) out.push(...renderNotice(n, { width: width() }));
    if (unknown.length) {
      out.push([{ text: "Events this ad doesn't know (a newer Codex?):", style: DIM }]);
      for (const [method, n] of unknown.slice(0, 20)) out.push(truncate([{ text: `  ${clean(method)} ×${n}`, style: DIM }], width()));
    }
    return out;
  }

  function statusReport() {
    const c = st.config;
    const acct = st.account?.type ? (st.account.type === "chatgpt" ? `ChatGPT ${st.account.planType ?? ""}`.trim() : st.account.type) : st.account?.requiresOpenaiAuth ? "not signed in" : "provider key";
    const tokens = st.tokens?.total?.total ? `${st.tokens.total.total.toLocaleString("en-US")} tokens used` : "no tokens used yet";
    const rows = [
      ["account", acct],
      ["model", `${c.model ?? "(default)"}${c.effort ? ` ${c.effort}` : ""}`],
      ["sandbox", `${c.sandbox} \u{b7} ${c.approvalPolicy}`],
      ["directory", c.cwd ?? cwd],
      ["conversation", st.thread?.id ?? "(new)"],
      ["tokens", tokens],
    ];
    const rl = st.rateLimits?.primary;
    if (rl?.usedPercent != null) rows.push(["usage", `${Math.round(rl.usedPercent)}% of the ${rl.windowDurationMins ? `${Math.round(rl.windowDurationMins / 60)}h` : "current"} window`]);
    if (info.compat) rows.push(["codex", info.compat]);
    return [[{ text: "Status", style: { bold: true } }], ...rows.map(([k, v]) => truncate([{ text: `  ${k.padEnd(13)}`, style: DIM }, { text: clean(v) }], width()))];
  }

  // Esc Esc: pick an earlier prompt; the thread is rewound to just before it
  // and the prompt comes back into the composer to edit. Files stay as they are.
  function openBacktrack() {
    if (!st.thread || st.thread.ephemeral) return warn("Nothing to rewind here.");
    if (turnActive()) return warn("Wait for the turn to finish (or esc), then rewind.");
    const prompts = [];
    for (const t of st.turns) {
      const um = t.itemIds.map((id) => st.items.get(id)).find((i) => i?.kind === "userMessage");
      if (um) prompts.push({ turnId: t.id, text: String(um.text ?? "") });
    }
    if (!prompts.length) return info0("No earlier prompts in this conversation.");
    openPicker(
      "backtrack",
      prompts.reverse().map((p, i) => ({ label: clean(p.text).slice(0, 200) || "(empty)", hint: i === 0 ? "last" : `${i + 1} back`, value: p })),
      (p) => {
        session
          .revert(p.turnId)
          .then(() => {
            composer.set(p.text);
            info0(`Rewound to before \u{201c}${clean(p.text).slice(0, 60)}\u{201d}. Files on disk weren't changed.`);
            draw();
          })
          .catch(fail);
      },
      { title: "Rewind to" },
    );
  }

  async function pickModel() {
    let models = [];
    try {
      const r = await session.engine.server.request("model/list", {});
      models = r?.data ?? [];
    } catch (err) {
      return fail(err);
    }
    if (!models.length) return warn("No models listed for this account.");
    openPicker("model", models.map((m) => ({ label: clean(m.displayName || m.model), hint: clean(m.description ?? ""), value: m })), (m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e).filter(Boolean);
      if (!efforts.length) {
        session.setNextTurn({ model: m.model });
        return info0(`Model: ${clean(m.model)} (from the next turn).`);
      }
      openPicker("effort", efforts.map((e) => ({ label: clean(e), hint: e === m.defaultReasoningEffort ? "default" : "", value: e })), (effort) => {
        session.setNextTurn({ model: m.model, effort });
        info0(`Model: ${clean(m.model)} ${clean(effort)} (from the next turn).`);
      });
    });
  }

  async function pickThread() {
    let threads = [];
    try {
      const r = await session.engine.server.request("thread/list", { cwd, limit: 30, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"] });
      threads = (r?.data ?? []).filter((t) => t.id !== st.thread?.id);
    } catch (err) {
      return fail(err);
    }
    if (!threads.length) return info0("No earlier conversations in this folder.");
    openPicker(
      "resume",
      threads.map((t) => ({ label: clean(t.name || t.preview || t.id).slice(0, 200), hint: t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : "", value: t.id })),
      (id) => {
        // The view isn't reset: the resumed thread's items are new ids, and if
        // resume fails (locked elsewhere) what is in the scrollback stays committed.
        session
          .resume(id)
          .then(() => {
            info0("Resumed.");
            draw();
          })
          .catch(fail);
      },
      { title: "Resume" },
    );
  }

  /* -------------------------------------------------------------- */
  /* Input                                                           */
  /* -------------------------------------------------------------- */

  function send(text, shown = null) {
    turnStartedAt ??= now();
    try {
      const images = attachments;
      attachments = [];
      if (privateMode && !shown) text = `<private>${text}</private>`;
      const r = session.submit(images.length ? [{ type: "text", text }, ...images.map((p) => ({ type: "localImage", path: p }))] : text);
      if (shown) {
        echoesShown.add(r.clientUserMessageId);
        commitCell(renderCell({ kind: "userMessage", text: shown }, { width: width() }));
      }
      r.accepted.then(
        (a) => {
          if (a?.turnId && !a.steered) turnStartedAt ??= now();
          if (a?.queued) note = { level: "info", text: "Queued: it runs when this turn ends (tab edits it)." };
          drawSoon();
        },
        (err) => {
          warn(`Not sent: ${err.message}`);
          if (!composer.text && !shown) composer.set(text);
          drawSoon();
        },
      );
    } catch (err) {
      warn(`Not sent: ${err.message}`);
    }
  }

  // After a crash the automatic restarts gave up on: Enter tries once more.
  function restartEngine() {
    note = { level: "info", text: "Restarting Codex\u{2026}" };
    Promise.resolve(session.restartEngine?.())
      .then((ok) => {
        note = ok ? null : { level: "warn", text: "Codex didn't come back. Enter tries again; /quit and `ad tui --last` start fresh." };
        drawSoon();
      })
      .catch((err) => {
        note = null;
        fail(err);
        drawSoon();
      });
  }

  function dispatch(text) {
    note = null;
    if (st.engine.state === "crashed") restartEngine(); // the prompt waits in the queue meanwhile
    const t = text.trim();
    const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(t);
    if (m && SLASH_COMMANDS.some((c) => c.name === m[1].toLowerCase())) return void slash(m[1].toLowerCase(), (m[2] ?? "").trim());
    // A one-line "!cmd" runs in the shell; a multi-line paste that starts with "!" (an image link…) is a prompt.
    if (t.startsWith("!") && t.length > 1 && !t.includes("\n")) {
      if (turnActive()) return warn("Wait for the turn to finish (or esc) before running a shell command.");
      return void session.shell(t.slice(1).trim()).catch(fail);
    }
    if (/^\/[a-z]/i.test(t) && !/\s/.test(t.split("\n")[0].slice(0, 40)) && t.length < 40) return warn(`Unknown command ${clean(t.split(/\s/)[0])}. /help lists them.`);
    send(text);
  }

  function quit(reason = "quit") {
    if (quitting) return;
    quitting = true;
    if (modal && !modal.answered) session.resolve(modal.id, null);
    quitResolve({ reason });
  }

  function onCtrlC() {
    const t = now();
    if (t - lastCtrlC < FORCE_QUIT_MS) return quit("ctrl-c");
    // Declining, closing or clearing doesn't arm the quit: only an interrupt or an idle press does.
    lastCtrlC = -Infinity;
    if (modal) {
      answer(null);
      return;
    }
    if (popup || overlay) {
      popup = null;
      overlay = false;
      return;
    }
    if (composer.text) {
      composer.clear();
      return;
    }
    lastCtrlC = t;
    if (turnActive()) {
      session.interrupt();
      note = { level: "warn", text: "Interrupting. Ctrl+C again quits." };
      return;
    }
    note = { level: "info", text: "Ctrl+C again quits." };
  }

  function onInput(ev) {
    if (quitting) return;
    if (ev.type === "key" && ev.ctrl && ev.name === "c") {
      onCtrlC();
      return draw();
    }
    if (ev.type === "key" && ev.ctrl && ev.name === "l") return void renderer.redraw();
    if (pager) {
      const view = Math.max(1, height() - 2);
      if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "t"))) pager = null;
      else if (ev.type === "text" && ev.text === "q") pager = null;
      else if (ev.type === "key" && ev.name === "up") pager.top--;
      else if (ev.type === "key" && ev.name === "down") pager.top++;
      else if (ev.type === "key" && ev.name === "pageup") pager.top -= view;
      else if (ev.type === "key" && (ev.name === "pagedown" || ev.name === "space")) pager.top += view;
      else if (ev.type === "key" && ev.name === "home") pager.top = 0;
      else if (ev.type === "key" && ev.name === "end") pager.top = Infinity;
      if (pager) pager.top = Math.max(0, Math.min(pager.top, pager.lines.length - view));
      return draw();
    }
    if (ev.type === "key" && ev.ctrl && ev.name === "t" && !modal) {
      pager = { lines: transcriptLines(st, { width: width() }), top: Infinity };
      return draw();
    }
    if (modal) {
      const r = modal.view.handle(ev);
      if (r && "answer" in r) answer(r.answer);
      return draw();
    }
    if (overlay && (ev.type === "key" || ev.type === "text")) {
      overlay = false;
      if (ev.type === "key" && ev.name === "escape") return draw();
    }
    if (popup && popupKey(ev)) return draw();
    if (ev.type === "paste-empty") {
      note = { level: "warn", text: "The clipboard holds an image: save it as a file, then /image <path> (or paste the file's path)." };
      return draw();
    }
    // A pasted or dragged image file path attaches the image.
    if (ev.type === "paste") {
      const img = imagePath(ev.text, cwd);
      if (img) {
        attachments.push(img);
        note = { level: "info", text: `Attached ${path.basename(img)} to the next prompt.` };
        return draw();
      }
    }
    if (ev.type === "key" && ev.ctrl && ev.name === "g" && actions.editText) {
      const before = composer.expanded();
      Promise.resolve(actions.editText(before))
        .then((after) => {
          if (typeof after === "string") composer.set(after.replace(/\r\n/g, "\n").replace(/\n$/, ""));
          renderer.redraw?.();
          draw();
        })
        .catch(fail);
      return;
    }
    if (ev.type === "key" && ev.alt && (ev.name === "," || ev.name === ".")) {
      const levels = ["low", "medium", "high", "xhigh"];
      const cur = levels.indexOf(st.config.effort ?? "medium");
      const next = levels[Math.max(0, Math.min(levels.length - 1, (cur < 0 ? 1 : cur) + (ev.name === "." ? 1 : -1)))];
      session.setNextTurn({ effort: next });
      note = { level: "info", text: `Reasoning effort: ${next} (from the next turn). alt+, lower \u{b7} alt+. higher` };
      return draw();
    }
    if (ev.type === "text" && ev.text === "?" && !composer.text) {
      overlay = true;
      return draw();
    }
    if (ev.type === "key" && ev.name === "escape" && !ev.ctrl) {
      if (turnActive()) {
        session.interrupt();
        note = { level: "warn", text: "Interrupting…" };
        return draw();
      }
      if (composer.text) return draw();
      if (attachments.length) {
        attachments = [];
        note = { level: "info", text: "Attachments removed." };
        return draw();
      }
      // Esc twice on an empty prompt: rewind to an earlier prompt.
      const t = now();
      if (t - lastEsc < 1000) {
        lastEsc = -Infinity;
        note = null;
        openBacktrack();
      } else {
        lastEsc = t;
        note = st.thread ? { level: "info", text: "Esc again to rewind to an earlier prompt." } : null;
      }
      return draw();
    }
    if (ev.type === "key" && ev.name === "tab" && !ev.ctrl && !ev.alt) {
      if (composer.text.trim() && turnActive()) {
        session.queue(composer.expanded());
        composer.clear();
      } else if (!composer.text && st.queue.length) {
        const last = st.queue.length - 1;
        const text = st.queue[last].text;
        session.editQueued(last, null);
        composer.set(text);
      }
      return draw();
    }
    if (ev.type === "key" && ev.name === "enter" && !ev.alt && st.engine.state === "crashed" && !composer.text.trim()) {
      restartEngine();
      return draw();
    }
    const r = composer.handle(ev);
    if (r?.submit != null) dispatch(r.submit);
    syncTokenPopup();
    draw();
  }

  /* -------------------------------------------------------------- */
  /* Wiring                                                          */
  /* -------------------------------------------------------------- */

  const offChange = session.on("change", ({ what }) => {
    if (what === "thread" && !st.thread) resetThreadView();
    // A resumed conversation's turns are history, not news: never reported as just ended.
    if (what === "thread" && st.thread) for (const t of st.turns) if (t.status !== "inProgress" && !turnsSeen.has(t.id)) turnsSeen.set(t.id, t.status);
    if ((what === "turn" || what === "starting" || what === "turn.started") && st.activeTurnId) turnStartedAt ??= now();
    drawSoon();
  });
  const offHook = session.on("hook", (run) => {
    for (const row of actions.hookRows?.(run) ?? []) commitCell(renderAdRow(row.kind, row.text, { width: width() }));
    drawSoon();
  });
  const offInput = io.onInput(onInput);
  const offResize = renderer.onResize?.(() => draw()) ?? (() => {});
  ticker = setI(() => {
    pollLoop();
    if (turnActive() || modal || loopWasRunning) draw();
  }, 1000);
  ticker.unref?.();

  commit(header);
  draw();

  return {
    done,
    draw,
    commit: commitCell,
    notice(level, text) {
      commitCell(renderNotice({ level, message: text }, { width: width() }));
      draw();
    },
    get state() {
      return { composer: composer.text, modal: modal?.view.kind ?? null, popup: popup?.kind ?? null, overlay, note: note?.text ?? null, committed: committed.size };
    },
    dispose() {
      clearT(drawTimer);
      clearT(searchTimer);
      clearI(ticker);
      offChange();
      offHook();
      offInput();
      offResize();
    },
  };
}

/**
 * Collisions between ad's slash commands and Codex's (plan Part 7): an ad
 * command must not take a Codex name, and a mirrored one must still exist.
 */
export function slashCollisions(commands, codexNames) {
  const codex = new Set(codexNames);
  const out = [];
  for (const c of commands) {
    if (c.source === "ad" && codex.has(c.name)) out.push(`/${c.name} is ad's own but Codex now has it too`);
    if (c.source === "codex" && !codex.has(c.name)) out.push(`/${c.name} mirrors Codex but Codex no longer has it`);
  }
  return out;
}
