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
import { createChecklist, createPicker, renderFooter, renderShortcuts, renderStatus } from "./view/chrome.mjs";
import { ARM_MS, createChoice, createConfirm, createRequestModal } from "./view/modals.mjs";
import { CODEX_PLAN_CLEAR_CONTEXT_PREFIX } from "../hooks/generated-prompts.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { lineWidth, truncate } from "./terminal/text.mjs";
import { INIT_PROMPT } from "./init-prompt.mjs";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copyText, exportMarkdown, imagePath, lastAgentText, renderHooks, renderMcp, renderSkills, renderUsage, terminalSetup, transcriptLines } from "./commands.mjs";
import CODEX_SLASH from "./codex-slash.json" with { type: "json" };
import { T } from "./view/theme.mjs";
import { createKeymap } from "./keymap.mjs";
import { DEFAULT_STATUS, DEFAULT_TITLE, STATUS_IDS, TITLE_IDS, canonical, contextUsedLabel, statusSegments, titleText, unsupported } from "./status.mjs";

export const FORCE_QUIT_MS = 1500;
const FRAME_MS = 33;
const LIVE_SHARE = 0.6; // at most this much of the screen for streaming cells

const DIM = T.dim;
const WARN = T.warning;

// source "codex": the same command as Codex's (its name must stay one of
// Codex's); "ad": ad's own (its name must never be one of Codex's). The
// collision test checks both against codex-slash.json from the pinned tag.
export const SLASH_COMMANDS = [
  { name: "help", source: "ad", desc: "what you can do here" },
  { name: "new", source: "codex", desc: "start a new conversation" },
  { name: "resume", source: "codex", desc: "continue an earlier conversation (/resume archived)" },
  { name: "clear", source: "codex", desc: "clear the terminal and start a new conversation" },
  { name: "archive", source: "codex", desc: "archive this conversation (/resume archived brings it back)" },
  { name: "delete", source: "codex", desc: "delete this conversation for good" },
  { name: "pwd", source: "codex", desc: "show the current working directory" },
  { name: "model", source: "codex", desc: "choose the model and reasoning effort" },
  { name: "permissions", source: "codex", desc: "what Codex may do without asking" },
  { name: "status", source: "codex", desc: "account, model, sandbox, tokens, limits" },
  { name: "goal", source: "codex", desc: "set a goal for this conversation (/goal clear)" },
  { name: "plan", source: "codex", desc: "switch to Plan mode (/plan <prompt> sends it there)" },
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
  { name: "statusline", source: "codex", desc: "choose what the status line shows" },
  { name: "title", source: "codex", desc: "choose what the terminal window's title shows" },
  { name: "image", source: "ad", desc: "attach an image file to the next prompt" },
  { name: "undo", source: "ad", desc: "put back the files the last turn changed, and rewind it (/undo force)" },
  { name: "terminal-setup", source: "ad", desc: "how to make Shift+Enter add a newline here" },
  { name: "quit", source: "codex", desc: "exit ad" },
  { name: "exit", source: "codex", desc: "exit ad" },
];

// Codex's commands at the pinned tag, by every spelling (scripts/codex-slash.mjs):
// what ad mirrors follows Codex's rules (during a task, popup visibility).
const CODEX_COMMANDS = new Map(CODEX_SLASH.commands.flatMap((c) => [c.name, ...c.aliases].map((n) => [n, c])));

// Codex commands ad doesn't run (yet), and what it says instead: `true` is
// "not in ad yet, /codex has it"; a string is the whole answer (where the stock
// UI can't help either, or there's something better to say). Every Codex
// command is either in SLASH_COMMANDS or here: a test fails when a Codex
// release adds one, so the upgrade PR has to decide.
const STOCK_UI = "/codex opens the stock Codex UI on this conversation.";
const ELSEWHERE = (what) => `(The stock UI's ${what} sees only its own engine, not ad's.)`;
// Codex's "Implement this plan?" (tui/src/chatwidget/plan_implementation.rs at the pinned tag).
export const PLAN_IMPLEMENTATION_CODING_MESSAGE = "Implement the plan.";
export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = CODEX_PLAN_CLEAR_CONTEXT_PREFIX; // ad's prompt hooks skip it

export const NOT_IN_AD = {
  ide: "/ide reads your editor's selection over Codex's private IDE link, which ad doesn't have.",
  keymap: true,
  vim: true,
  "setup-default-sandbox": "/setup-default-sandbox isn't in ad yet. `ad sandbox setup --elevated` sets up the elevated sandbox (machine-wide: it also affects your own Codex).",
  experimental: true,
  approve: true,
  memories: `/memories (Codex's own memories) isn't in ad yet; ad's memory is /memory. ${STOCK_UI}`,
  import: true,
  worktree: true,
  app: "/app opens the Codex Desktop app, which uses your own Codex home, not ad's, so it can't continue this conversation.",
  recap: true,
  voice: true,
  agents: true,
  side: true,
  btw: true,
  tui: "/tui chooses the stock Codex UI's mode; ad has only its inline mode so far.",
  mention: "Type @ in the prompt to mention a file.",
  daemon: "/daemon manages Codex's background server; ad runs its own engine and never uses it.",
  cd: true,
  "debug-config": true,
  theme: true,
  pets: "ad doesn't draw terminal pets (they need Kitty or Sixel images).",
  apps: true,
  plugins: true,
  feedback: "For ad problems: https://github.com/pankaj-mahaur/Agent-Daemon/issues. The stock UI's /feedback (in /codex) uploads this whole conversation to OpenAI, including ad's memory context and /private prompts.",
  rollout: true,
  ps: `/ps isn't in ad yet. ${ELSEWHERE("/ps")}`,
  stop: `/stop isn't in ad yet. ${ELSEWHERE("/stop")}`,
  "test-approval": "/test-approval is a Codex debug command.",
  subagents: true,
  "debug-m-drop": "/debug-m-drop is a Codex debug command.",
  "debug-m-update": "/debug-m-update is a Codex debug command.",
};

/** What ad says for a Codex command it doesn't run, by any of its spellings. */
export function notInAd(name) {
  const c = CODEX_COMMANDS.get(name);
  const said = c && NOT_IN_AD[c.name];
  if (said === undefined) return null;
  return said === true ? `/${name} isn't in ad yet. ${STOCK_UI}` : said.replace(`/${c.name}`, `/${name}`);
}

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
  settings = null, // {codex, ad} from prefs.mjs; null in tests that don't need them
  keymap = createKeymap(), // keys as Codex's actions, with tui.keymap applied (keymap.mjs)
  statusInfo = {}, // {codexVersion, hostname, home} for the status line and the title
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
  let committed = new Set(); // shownKey(item)s
  // An item as shown, per turn: an id a later turn reuses (after a rewind) is a new item.
  const shownKey = (it) => (it.turnId ? `${it.turnId}|${it.id}` : it.id);
  let streams = new Map(); // agentMessage id → {md, fed}
  let echoesShown = new Set(); // clientUserMessageIds committed as typed
  let turnsSeen = new Map(); // turnId → status reported
  const noticesSeen = new WeakSet();
  let lastWasCell = false;

  let modal = null; // {id, view}
  let popup = null; // {kind, view, onSelect}
  let confirm = null; // {view, resolve}: a question of ad's own (openConfirm, openChoice)
  let planReady = null; // {turnId, text}: a Plan-mode turn proposed a plan; "Implement this plan?" opens when nothing is in the way
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
  // A turn is live only while it is the running one (or one is being
  // started): a resumed turn still "inProgress" in history is over here.
  // An item with no known turn (a user's ! command) stays open while Codex
  // is up; a crash settles it.
  function turnOver(it) {
    const t = it.turnId ? st.turns.find((x) => x.id === it.turnId) : null;
    if (t) return t.status !== "inProgress" || (t.id !== st.activeTurnId && !st.starting);
    return st.engine.state !== "ready" && st.engine.state !== "restarting";
  }
  const open = (it) => (it.streaming || it.status === "inProgress") && !turnOver(it);
  const settledView = (it) => (it.streaming || it.status === "inProgress" ? { ...it, streaming: false, incomplete: true } : it);

  /**
   * Commits every item that can no longer change, in order. Stops at the
   * first one still streaming (an agent message commits its finished lines
   * as it goes); what is left is drawn live.
   */
  function flush() {
    const items = rootItems().filter((it) => !committed.has(shownKey(it)));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "userMessage") {
        committed.add(shownKey(it));
        if (it.clientId && echoesShown.has(it.clientId)) continue;
        commitCell(renderCell(it, { width: width() }));
        continue;
      }
      if (it.kind === "agentMessage") {
        let s = streams.get(shownKey(it));
        if (!s) {
          s = { md: createMarkdownStream({ width: width() - 2 }), fed: 0, started: false };
          streams.set(shownKey(it), s);
        }
        const text = String(it.text ?? "");
        const fresh = s.md.push(text.slice(s.fed));
        s.fed = text.length;
        const live = open(it);
        const out = live ? fresh : [...fresh, ...s.md.finish()];
        if (out.length) {
          // The bullet on the message's first line only; the rest (and later batches) indent.
          const lines = out.map((l, k) => [{ text: s.started || k > 0 ? "  " : "\u{2022} ", style: DIM }, ...l]);
          if (!s.started) commitCell(lines);
          else commit(lines);
          s.started = true;
        }
        if (live) return items.slice(i);
        committed.add(shownKey(it));
        streams.delete(shownKey(it));
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
        for (const g of group) committed.add(shownKey(g));
        i = j - 1;
        continue;
      }
      if (open(it)) return items.slice(i);
      committed.add(shownKey(it));
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
      notePlan(t);
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

  // Every checklist the model sets (update_plan → turn/plan/updated) goes into
  // the scrollback as Codex's "Updated Plan" cell, once per update.
  let planShown = null;
  function reportPlanUpdates() {
    if (!st.plan || st.plan === planShown) return;
    planShown = st.plan;
    commitCell(renderPlan(st.plan.steps, { width: width(), explanation: st.plan.explanation }));
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
      pager = null; // the request comes first
      lastCtrlC = -Infinity; // a Ctrl+C meant for the new prompt must not quit
      const diff = head.kind === "approval-patch" ? ((session.itemFor?.(head.itemId, head.turnId) ?? st.items.get(head.itemId))?.changes ?? null) : null;
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
        const s = streams.get(shownKey(it));
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
    // Codex's mode indicator, first so it's the last to go when the footer is narrow.
    const mode = st.mode?.kind === "plan" ? [{ full: "Plan mode (shift+tab to cycle)", short: "Plan mode", style: T.planMode }] : [];
    if (privateMode) own.push({ full: "private", short: "P" });
    const loop = actions.ad?.loop?.state;
    if (loop?.running) own.push({ full: `loop ${loop.iterations}`, short: `L${loop.iterations}` });
    return renderFooter({ hints, chips: [...mode, ...chips(), ...own] }, { width: width() });
  }

  /* -------------------------------------------------------------- */
  /* Status line and window title (Codex's tui.status_line, tui.terminal_title) */
  /* -------------------------------------------------------------- */

  let preview = { status: null, title: null }; // a checklist's live preview
  let git = { root: null, branch: null, changes: null };
  let gitAt = -Infinity;
  let titleFrame = 0;
  let titleShown = null; // what the window title says now (null: never set)
  let titleAt = -Infinity;
  let titleTimer = null;
  let titleHeld = false; // another program has the terminal (a handoff)
  const statusIds = () => preview.status ?? settings?.codex?.get("tui.status_line");
  const titleIds = () => preview.title ?? settings?.codex?.get("tui.terminal_title");
  function statusCtx() {
    const c = st.config;
    return {
      app: "ad",
      model: c.model,
      effort: c.effort,
      cwd,
      home: statusInfo.home,
      project: path.basename(git.root ?? cwd),
      hostname: statusInfo.hostname,
      branch: git.branch,
      changes: git.changes,
      running: turnActive(),
      waiting: Boolean(modal || confirm),
      sandbox: c.sandbox,
      approvalPolicy: c.approvalPolicy,
      tokens: st.tokens,
      rateLimits: st.rateLimits,
      codexVersion: statusInfo.codexVersion,
      threadId: st.thread?.id,
      // A /private conversation's name never reaches the window title or the status line.
      threadName: privateMode ? null : st.thread?.name || st.thread?.preview,
      plan: st.plan,
      frame: titleFrame,
    };
  }
  function statusRow(w) {
    const segs = statusSegments(statusIds(), statusCtx());
    if (!segs.length) return null;
    // Items drop from the end until the row fits; the last one left is cut.
    const sep = " \u{b7} ";
    const row = (k) => [{ text: "  " }, ...segs.slice(0, k).flatMap((s, i) => [...(i ? [{ text: sep, style: DIM }] : []), { text: s.text, style: s.warn ? WARN : DIM }])];
    let n = segs.length;
    while (n > 1 && lineWidth(row(n)) > w) n--;
    return truncate(row(n), w);
  }
  // Git's facts for the status line and title: at start, after each turn, and
  // at most every 30 s while idle; only when an item needs them.
  function refreshGit(force = false) {
    const needs = [...(statusIds() ?? []), ...(titleIds() ?? [])].map(canonical).some((id) => ["git-branch", "branch-changes", "project-name"].includes(id));
    const wanted = needs || statusIds() === undefined || titleIds() === undefined; // the defaults show the project
    if (!wanted || !actions.gitInfo || (!force && now() - gitAt < 30_000)) return;
    gitAt = now();
    Promise.resolve(actions.gitInfo())
      .then((g) => {
        if (g) git = g;
        drawSoon();
      })
      .catch(() => {});
  }
  // The window title, at most 4 changes a second, only when it changes; [] leaves the title alone.
  function syncTitle() {
    if (titleHeld) return;
    const ids = titleIds();
    if (Array.isArray(ids) && !ids.length) return;
    const text = titleText(ids, statusCtx());
    if (text === titleShown) return;
    const wait = titleAt + 250 - now();
    if (wait > 0) {
      titleTimer ??= setT(() => {
        titleTimer = null;
        syncTitle();
      }, wait);
      return;
    }
    // The terminal's own title is saved first (XTWINOPS 22) and put back on exit (23).
    io.write(`${titleShown === null ? "\x1b[22;0t" : ""}\x1b]0;${text}\x07`);
    titleShown = text;
    titleAt = now();
  }
  function restoreTitle() {
    clearT(titleTimer);
    titleTimer = null;
    if (titleShown === null) return;
    io.write("\x1b]0;\x07\x1b[23;0t");
    titleShown = null;
  }
  // /statusline and /title: a checklist of Codex's items (with what each shows now), live preview, saved to Codex's config.
  function pickItems(kind) {
    const isTitle = kind === "title";
    const key = isTitle ? "tui.terminal_title" : "tui.status_line";
    if (!settings?.codex) return warn("Settings aren't available here.");
    const current = (isTitle ? titleIds() : statusIds()) ?? null;
    const chosen = (current ?? (isTitle ? DEFAULT_TITLE : DEFAULT_STATUS)).map(canonical);
    const all = isTitle ? TITLE_IDS : STATUS_IDS;
    const keep = unsupported(current, kind); // Codex's items ad can't show stay in the setting
    const ctx = statusCtx();
    const now_ = (id) => (isTitle ? titleText([id], ctx) : statusSegments([id], ctx)[0]?.text) || "";
    const order = [...chosen.filter((id) => all.includes(id)), ...all.filter((id) => !chosen.includes(id))];
    openChecklist(
      kind,
      order.map((id) => ({ label: id, hint: now_(id), value: id, checked: chosen.includes(id) })),
      async (values) => {
        preview = { ...preview, [kind]: null };
        try {
          await settings.codex.set(key, [...values, ...keep]);
          info0(`${isTitle ? "Title" : "Status line"}: ${values.length ? values.join(", ") : "off"}. Saved for /codex too.`);
        } catch (err) {
          fail(err);
        }
        drawSoon();
      },
      { title: isTitle ? "Terminal title" : "Status line", reorder: true, onChange: (v) => (preview = { ...preview, [kind]: v }), onCancel: () => (preview = { ...preview, [kind]: null }) },
    );
  }


  function draw() {
    clearT(drawTimer);
    drawTimer = null;
    if (quitting) return;
    const pending = flush();
    reportPlanUpdates();
    reportNotices();
    reportTurns();
    syncModal();
    maybeOfferPlan();
    const w = width();
    const rows = height();
    const lines = [];
    if (pager && !modal) {
      // Ctrl+T: the whole transcript, paged inside the live region.
      const view = Math.max(1, rows - 2);
      pager.top = Math.max(0, Math.min(pager.top, pager.lines.length - view));
      const where = pager.lines.length ? `Transcript ${pager.top + 1}\u{2013}${Math.min(pager.lines.length, pager.top + view)} of ${pager.lines.length}  ` : "The transcript is empty  ";
      lines.push(truncate([{ text: where, style: T.bold }, { text: "\u{2191}\u{2193} pgup pgdn home end \u{b7} q or esc closes", style: DIM }], w));
      lines.push(...pager.lines.slice(pager.top, pager.top + view));
      renderer.frame({ lines, cursor: { row: 0, col: 0 } });
      return;
    }
    let live = liveItems(pending);
    const cap = Math.max(3, Math.floor(rows * LIVE_SHARE));
    if (live.length > cap) live = [[{ text: `  \u{2026} ${live.length - cap + 1} more lines above`, style: DIM }], ...live.slice(-(cap - 1))];
    lines.push(...live);
    lines.push(...statusLines());
    if (st.engine.state === "crashed") {
      const code = Number.isInteger(st.engine.exitCode) ? ` (exit ${st.engine.exitCode})` : "";
      lines.push(truncate([{ text: `\u{25a0} Codex stopped${code}. Your text is kept. Enter restarts and resumes.`, style: WARN }], w));
    } else if (st.engine.state === "restarting") lines.push(truncate([{ text: "\u{25e6} Restarting Codex\u{2026}", style: DIM }], w));
    let cursor = null;
    // The status line: from 12 rows; under a modal only in room the modal doesn't need.
    const status = rows >= 12 ? statusRow(w) : null;
    if (modal || confirm) {
      if (lines.length) lines.push([]);
      const budget = Math.max(4, rows - lines.length - 2);
      const box = (modal ?? confirm).view.render({ width: w, height: budget });
      lines.push(...box);
      cursor = { row: lines.length - 1, col: 0 };
      if (status && box.length < budget) lines.push(status);
    } else {
      if (note) lines.push(truncate([{ text: clean(note.text), style: note.level === "warn" || note.level === "error" ? WARN : DIM }], w));
      if (attachments.length) lines.push(truncate([{ text: `  \u{1f4ce} ${attachments.map((a) => clean(path.basename(a))).join(", ")}`, style: T.code }], w));
      if (lines.length) lines.push([]);
      const top = lines.length;
      const c = composer.render({ width: w, prompt: "\u{203a} ", promptStyle: st.mode?.kind === "plan" ? T.planMode : undefined, placeholder: turnActive() ? "Steer the turn, or tab to queue" : "Ask ad to do anything" });
      lines.push(...c.lines);
      cursor = { row: top + c.cursor.row, col: c.cursor.col };
      if (popup) lines.push(...popup.view.render({ width: w, height: Math.min(10, Math.max(3, rows - lines.length - 1)) }));
      else if (overlay) lines.push(...renderShortcuts({ newline, keymap }, { width: w }));
      else {
        if (status) lines.push(status);
        if (rows >= 10) lines.push(footer());
      }
    }
    syncTitle();
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

  // Options to switch on and reorder: onSave(values) on Enter, onCancel() on Esc
  // (undo a live preview there), onChange(values) on every change.
  function openChecklist(kind, items, onSave, { onCancel, onChange, ...opts } = {}) {
    popup = { kind, view: createChecklist({ items, ...opts, onChange: (v) => (onChange?.(v), drawSoon()) }), onSelect: onSave, onCancel };
    draw();
  }

  /* -------------------------------------------------------------- */
  /* "Implement this plan?" (Codex's plan mode, codex-parity-2 4e)     */
  /* -------------------------------------------------------------- */

  // A completed Plan-mode turn with a proposed plan: remembered until the choice can open.
  function notePlan(t) {
    if (t.status !== "completed" || st.mode?.kind !== "plan") return;
    const ids = new Set(t.itemIds ?? []);
    const plan = [...st.items.values()].findLast((i) => i.kind === "plan" && (i.turnId === t.id || ids.has(i.id)) && String(i.text ?? "").trim());
    if (plan) planReady = { turnId: t.id, threadId: st.thread?.id ?? null, text: String(plan.text) };
  }

  // Codex opens the choice only with nothing queued and nothing open; ad also
  // waits for an empty prompt (a draft is never thrown away) and says so.
  function maybeOfferPlan() {
    if (!planReady) return;
    if (st.mode?.kind !== "plan" || st.thread?.id !== planReady.threadId || turnActive() || st.queue.length) {
      planReady = null; // the moment passed: a new turn, a queued prompt, another mode or conversation
      return;
    }
    if (modal || confirm || pager || st.requests.length) return;
    if (composer.text.trim() || popup || overlay) {
      if (!note || note.plan) note = { level: "info", text: "A plan is ready: clear the prompt to choose.", plan: true };
      return;
    }
    if (note?.plan) note = null;
    const plan = planReady;
    planReady = null;
    // Outside the draw that noticed it: opening the choice draws again.
    queueMicrotask(() => void choosePlan(plan).catch(fail));
  }

  async function choosePlan(plan) {
    const hasDefault = st.mode?.presets?.some((p) => p.mode === "default");
    const used = contextUsedLabel(st.tokens);
    const options = [
      ...(hasDefault
        ? [
            { label: "Yes, implement this plan", hint: "Switch to Default and start coding", value: "implement" },
            { label: "Yes, clear context and implement", hint: used ? `Start a fresh thread (current context: ${used})` : "Fresh thread with this plan", value: "clear" },
          ]
        : []),
      { label: "No, stay in Plan mode", hint: hasDefault ? "Continue planning with the model" : "Default mode unavailable", value: "stay", safe: true },
    ];
    const answer = await openChoice({ title: "Implement this plan?", options });
    if (answer === "implement") {
      if (!session.setMode("default").ok) return warn("Default mode unavailable");
      return send(PLAN_IMPLEMENTATION_CODING_MESSAGE);
    }
    if (answer === "clear") {
      // A fresh conversation in Default whose first message is Codex's prefix and the plan.
      // The scrollback stays (a divider), unlike /clear.
      session.newThread();
      resetThreadView();
      commit([[{ text: "\u{2500}".repeat(Math.min(60, width())), style: DIM }]]);
      return send(`${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${plan.text}`);
    }
  }

  // One of a few answers (Codex's selection views) → the chosen value, or the safe one on Esc.
  function openChoice(opts) {
    confirm?.resolve(false);
    return new Promise((resolve) => {
      confirm = { view: createChoice(opts, { now, armMs }), resolve };
      draw();
    });
  }

  // A yes/no question ad asks before acting on its own (/archive, /delete…).
  // → Promise<boolean>. Codex's own requests come first: one that arrives
  // meanwhile is shown, and the question waits under it.
  function openConfirm(opts) {
    confirm?.resolve(false);
    return new Promise((resolve) => {
      confirm = { view: createConfirm(opts, { now, armMs }), resolve };
      draw();
    });
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
      // Codex hides some of its commands from the popup (debug ones always, aliases like /quit until typed).
      const hidden = (c) => c.source === "codex" && (CODEX_COMMANDS.get(c.name)?.popup === "hidden" || (CODEX_COMMANDS.get(c.name)?.popup === "unfiltered" && !q));
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(q) && !hidden(c)).map((c) => ({ label: `/${c.name}`, hint: c.desc, value: c.name }));
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
      if (ev.type === "key" && ev.name === "tab" && ev.shift) return true; // Shift+Tab does nothing here
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
    if (r?.cancel) {
      const p = popup;
      popup = null;
      p.onCancel?.();
    } else if (r?.select !== undefined) {
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
          [{ text: "Commands", style: T.bold }],
          ...SLASH_COMMANDS.filter((c) => c.name !== "exit").map((c) => truncate([{ text: `  /${c.name.padEnd(12)}`, style: T.code }, { text: c.desc, style: DIM }], width())),
          [],
          ...renderShortcuts({ newline, keymap }, { width: width() }),
        ]);
      case "new":
        session.newThread();
        resetThreadView();
        return info0("New conversation.");
      case "clear": {
        // Codex's /clear: clear the terminal, scrollback too, and start a new
        // conversation (named, if a name follows). The old one stays resumable.
        // clear.keepScrollback in prefs.json keeps the scrollback (a divider instead).
        const old = st.thread?.id ?? null;
        session.newThread();
        resetThreadView();
        const keep = settings?.ad?.get("clear.keepScrollback", false);
        if (keep || !renderer.clear?.(header)) commit([[{ text: "─".repeat(Math.min(60, width())), style: DIM }]]);
        await session.startThread({ sessionStartSource: "clear", name: arg || undefined });
        return info0(old ? `New conversation${arg ? `: ${clean(arg)}` : ""}. The one before: /resume, or ad tui --resume ${old}` : "New conversation.");
      }
      case "archive": {
        if (!st.thread) return info0("Nothing to archive yet: this conversation hasn't started.");
        if (!(await openConfirm({ title: "Archive this conversation?", body: clean(st.thread.name || st.thread.preview || st.thread.id), yes: "Yes, archive", no: "No, don't archive" }))) return info0("Not archived.");
        await session.archive();
        resetThreadView();
        return info0("Archived. /resume archived brings it back.");
      }
      case "delete": {
        if (!st.thread) return info0("Nothing to delete yet: this conversation hasn't started.");
        const t = st.thread;
        if (!(await openConfirm({ title: "Delete this conversation?", body: `${clean(t.name || t.preview || t.id)}\nCannot be undone. Subagent threads will also be deleted. ad's memory from it is kept.`, yes: "Yes, delete it", no: "No, keep it" }))) return info0("Kept.");
        const id = await session.deleteThread();
        resetThreadView();
        await actions.forgetCheckpoints?.(id)?.catch?.(() => {});
        return info0("Deleted.");
      }
      case "statusline":
        return pickItems("status");
      case "title":
        return pickItems("title");
      case "pwd":
        return arg ? warn("Usage: /pwd") : info0(`Current working directory: ${clean(cwd)}`);
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
          // Codex fixes a turn's permissions when it starts: say so if one is running.
          info0(`Permissions: ${item.label} (from the next turn${turnActive() ? "; the running turn keeps asking as before" : ""}).`);
        });
      case "resume":
        return pickThread({ archived: arg === "archived" });
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
        return session.fork().then(() => info0("Forked: you are in the copy now; the original is unchanged."), fail);
      case "plan": {
        // Codex's /plan: switch, then send the text there; unavailable, the text goes back to the composer.
        const r = session.setMode("plan");
        if (!r.ok) {
          if (arg) composer.set(`/plan ${arg}`);
          return info0(r.message);
        }
        if (arg) send(arg);
        return;
      }
      case "rename":
        if (!arg) return warn("/rename <name>");
        return session.rename(arg).then((n) => info0(`Named: ${clean(n)}`), fail);
      case "copy": {
        const t = lastAgentText(st);
        if (!t) return warn("No answer to copy yet.");
        // Sanitized like /raw: no escape sequence or bidi control rides along into a later paste.
        return (actions.copy ?? copyText)(sanitize(t, "transcript"), { write: (d) => io.write(d) }).then((r) => (r.ok ? info0(`Copied the last answer${r.via && r.via !== "terminal" ? ` (${r.via})` : ""}.`) : warn("Couldn't reach a clipboard. /raw prints it for selecting.")));
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
        const rel = path.relative(cwd, file);
        const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
        // No device names (con, nul, com1…), no alternate data streams, no path through a link that leads out.
        const device = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(path.basename(file));
        if (outside || device || rel.includes(":")) return warn("/export writes a plain file inside this folder only.");
        try {
          const parent = realpathSync(path.dirname(file));
          const root = realpathSync(cwd);
          if (parent !== root && !parent.startsWith(root + path.sep)) return warn("/export writes a plain file inside this folder only.");
        } catch {
          return warn("That folder doesn't exist.");
        }
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
      case "undo":
        if (!actions.undo) return warn("/undo needs a git repo (and ad tui running while the turn happened).");
        return Promise.resolve(actions.undo({ force: arg === "force" }))
          .then((r) => {
            if (r.error) return warn(r.error);
            if (r.prompt && !composer.text) composer.set(r.prompt);
            info0(r.message);
            draw();
          })
          .catch(fail);
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
    const unused = [
      ...(keymap.warnings ?? []),
      ...unsupported(settings?.codex?.get("tui.status_line"), "status").map((id) => `tui.status_line: ad doesn't show "${id}" (the stock UI may)`),
      ...unsupported(settings?.codex?.get("tui.terminal_title"), "title").map((id) => `tui.terminal_title: ad doesn't show "${id}" (the stock UI may)`),
    ];
    if (!kept.length && !unknown.length && !unused.length) return renderNotice({ level: "info", message: "No warnings in this session." }, { width: width() });
    const out = [[{ text: "Warnings", style: T.bold }]];
    for (const n of kept.slice(-20)) out.push(...renderNotice(n, { width: width() }));
    if (unknown.length) {
      out.push([{ text: "Events this ad doesn't know (a newer Codex?):", style: DIM }]);
      for (const [method, n] of unknown.slice(0, 20)) out.push(truncate([{ text: `  ${clean(method)} ×${n}`, style: DIM }], width()));
    }
    if (unused.length) {
      out.push([{ text: "Settings ad couldn't use:", style: DIM }]);
      for (const w of unused) out.push(...renderNotice({ level: "warn", message: w }, { width: width() }));
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
    return [[{ text: "Status", style: T.bold }], ...rows.map(([k, v]) => truncate([{ text: `  ${k.padEnd(13)}`, style: DIM }, { text: clean(v) }], width()))];
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
      prompts.reverse().map((p, i) => ({ label: clean(p.text).slice(0, 200) || "(empty)", hint: i === 0 ? "latest" : `${i} before it`, value: p })),
      (p) => {
        session
          .revert(p.turnId)
          .then(() => {
            if (!composer.text) composer.set(p.text);
            info0(`Rewound to before \u{201c}${clean(p.text).slice(0, 60)}\u{201d}. Files on disk weren't changed.`);
            draw();
          })
          .catch(fail);
      },
      { title: "Rewind to" },
    );
  }

  // Alt+, / Alt+.: the current model's own effort levels, from where it is now.
  const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh"];
  let modelsCache = null;
  async function stepEffort(dir) {
    modelsCache ??= await session.engine.server.request("model/list", {}).then((r) => r?.data ?? [], () => []);
    const model = st.config.model ?? null;
    const m = modelsCache.find((x) => x.model === model || x.id === model) ?? modelsCache.find((x) => x.isDefault);
    let levels = (m?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e).filter((e) => EFFORT_ORDER.includes(e));
    if (!levels.length) levels = ["low", "medium", "high"];
    levels.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
    const current = st.config.effort ?? m?.defaultReasoningEffort ?? "medium";
    // The next level above (or below) the current one, among the model's levels.
    const rank = EFFORT_ORDER.indexOf(current);
    const above = levels.filter((l) => EFFORT_ORDER.indexOf(l) > rank);
    const below = levels.filter((l) => EFFORT_ORDER.indexOf(l) < rank);
    const next = dir > 0 ? (above[0] ?? levels.at(-1)) : (below.at(-1) ?? levels[0]);
    session.setNextTurn({ effort: next });
    note = { level: "info", text: `Reasoning effort: ${next} (from the next turn). alt+, lower \u{b7} alt+. higher` };
    draw();
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

  // /resume: this folder's conversations, or the archived ones (resuming one unarchives it).
  async function pickThread({ archived = false } = {}) {
    let threads = [];
    try {
      const r = await session.engine.server.request("thread/list", { cwd, limit: 30, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"], ...(archived ? { archived: true } : {}) });
      threads = (r?.data ?? []).filter((t) => t.id !== st.thread?.id);
    } catch (err) {
      return fail(err);
    }
    if (!threads.length) return info0(archived ? "No archived conversations in this folder." : "No earlier conversations in this folder. /resume archived lists the archived ones.");
    const ARCHIVED = Symbol("archived");
    const items = threads.map((t) => ({ label: clean(t.name || t.preview || t.id).slice(0, 200), hint: t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : "", value: t.id }));
    if (!archived) items.push({ label: "Archived conversations" + String.fromCodePoint(0x2026), hint: "the ones /archive put away", value: ARCHIVED });
    openPicker(
      "resume",
      items,
      (id) => {
        if (id === ARCHIVED) return void pickThread({ archived: true }).catch(fail);
        // The view isn't reset: the resumed thread's items are new ids, and if
        // resume fails (locked elsewhere) what is in the scrollback stays committed.
        Promise.resolve(archived && session.engine.server.request("thread/unarchive", { threadId: id }))
          .then(() => session.resume(id))
          .then(() => {
            info0(archived ? "Unarchived and resumed." : "Resumed.");
            draw();
          })
          .catch(fail);
      },
      { title: archived ? "Resume an archived conversation" : "Resume" },
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
      const raw = text;
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
          if (!composer.text && !shown) composer.set(raw);
          if (images.length && !attachments.length) attachments = images;
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
    if (m) {
      const name = m[1].toLowerCase();
      const codex = CODEX_COMMANDS.get(name);
      const cmd = SLASH_COMMANDS.find((c) => c.name === name) ?? (codex && SLASH_COMMANDS.find((c) => c.source === "codex" && c.name === codex.name));
      if (cmd) {
        // Codex's rule for its commands: some wait for the task to end. The draft stays.
        if (cmd.source === "codex" && codex && !codex.duringTask && turnActive()) {
          composer.set(text);
          return warn(`'/${name}' is disabled while a task is in progress.`);
        }
        // Any failure inside a command (a rejected request, a renderer error) is shown, never left unhandled.
        return void Promise.resolve(slash(cmd.name, (m[2] ?? "").trim())).catch(fail);
      }
      // A Codex command ad doesn't run never goes to the model as a prompt, text or not.
      const said = notInAd(name);
      if (said) {
        composer.set(text);
        return info0(said);
      }
    }
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
    restoreTitle();
    if (modal && !modal.answered) session.resolve(modal.id, null);
    confirm?.resolve(false);
    confirm = null;
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
    // The topmost layer takes it: ad's own question (no), the pager, a popup or overlay.
    if (confirm) {
      const c = confirm;
      confirm = null;
      c.resolve(false);
      return;
    }
    if (pager) {
      pager = null;
      return;
    }
    if (popup || overlay) {
      const p = popup;
      popup = null;
      overlay = false;
      p?.onCancel?.(); // a checklist's live preview goes back
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
    if (keymap.is("global", "clear_terminal", ev)) return void renderer.redraw();
    if (pager && !modal) {
      const view = Math.max(1, height() - 2);
      const k = (action) => keymap.is("pager", action, ev);
      if ((ev.type === "key" && ev.name === "escape") || k("close") || k("close_transcript")) pager = null;
      else if (k("scroll_up")) pager.top--;
      else if (k("scroll_down")) pager.top++;
      else if (k("page_up")) pager.top -= view;
      else if (k("page_down")) pager.top += view;
      else if (k("half_page_up")) pager.top -= Math.ceil(view / 2);
      else if (k("half_page_down")) pager.top += Math.ceil(view / 2);
      else if (k("jump_top")) pager.top = 0;
      else if (k("jump_bottom")) pager.top = Infinity;
      if (pager) pager.top = Math.max(0, Math.min(pager.top, pager.lines.length - view));
      return draw();
    }
    if (keymap.is("global", "open_transcript", ev) && !modal) {
      pager = { lines: transcriptLines(st, { width: width() }), top: Infinity };
      return draw();
    }
    if (modal) {
      const r = modal.view.handle(ev);
      if (r && "answer" in r) answer(r.answer);
      return draw();
    }
    if (confirm) {
      const r = confirm.view.handle(ev);
      if (r && "answer" in r) {
        const c = confirm;
        confirm = null;
        c.resolve(r.answer);
      }
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
      const img = imagePath(ev.text, cwd, { pasted: true });
      if (img) {
        attachments.push(img);
        note = { level: "info", text: `Attached ${path.basename(img)} to the next prompt.` };
        return draw();
      }
    }
    if (keymap.is("global", "open_external_editor", ev) && actions.editText) {
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
    const up = keymap.is("chat", "increase_reasoning_effort", ev);
    if (up || keymap.is("chat", "decrease_reasoning_effort", ev)) {
      stepEffort(up ? 1 : -1).catch(fail);
      return;
    }
    // Codex's keys for /copy and /raw, and F2 for /warnings.
    // (straight to the command: a key never restarts a crashed engine, as sending a prompt does)
    const run = (name) => void Promise.resolve(slash(name, "")).catch(fail).finally(() => draw());
    if (keymap.is("global", "copy", ev)) return run("copy");
    if (keymap.is("global", "toggle_raw_output", ev)) return run("raw");
    if (ev.type === "key" && ev.name === "f2" && !ev.ctrl && !ev.alt && !ev.shift) return run("warnings");
    if (ev.type === "text" || ev.type === "paste") lastCtrlC = -Infinity; // new text: Ctrl+C clears it, not quit
    if ((ev.type === "text" || ev.type === "paste") && !turnActive()) actions.onTyping?.();
    if (keymap.is("composer", "toggle_shortcuts", ev) && !composer.text) {
      overlay = true;
      return draw();
    }
    if (keymap.is("chat", "interrupt_turn", ev) && turnActive()) {
      session.interrupt();
      note = { level: "warn", text: "Interrupting…" };
      return draw();
    }
    if (ev.type === "key" && ev.name === "escape" && !ev.ctrl) {
      if (turnActive()) return draw();
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
    // Shift+Tab: Codex's fixed key for the next collaboration mode (Plan ↔ Default), only with no task running.
    if (ev.type === "key" && ev.name === "tab" && ev.shift && !ev.ctrl && !ev.alt) {
      if (!turnActive()) {
        const r = session.cycleMode();
        if (!r.ok) info0(r.message);
      }
      return draw();
    }
    if (keymap.is("composer", "queue", ev)) {
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
    if (what === "turn" && !st.activeTurnId) refreshGit(true);
    // Each checklist as it comes (several can land before the next draw), after what finished before it.
    if (what === "turn.plan") {
      flush();
      reportPlanUpdates();
    }
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
    if (turnActive()) titleFrame++;
    else refreshGit();
    if (turnActive() || modal || loopWasRunning) draw();
  }, 1000);
  ticker.unref?.();

  commit(header);
  refreshGit(true);
  draw();

  return {
    done,
    draw,
    commit: commitCell,
    notice(level, text) {
      commitCell(renderNotice({ level, message: text }, { width: width() }));
      draw();
    },
    /** Asks a yes/no question (see openConfirm); for commands and tests. */
    confirm: (opts) => openConfirm(opts),
    /** Opens a checklist (see openChecklist); for commands and tests. */
    checklist: (kind, items, onSave, opts) => openChecklist(kind, items, onSave, opts),
    /** Sends a prompt as if typed (ad tui "<prompt>"). */
    send(text) {
      dispatch(String(text ?? ""));
      draw();
    },
    get state() {
      return { composer: composer.text, modal: modal?.view.kind ?? null, confirm: Boolean(confirm), pager: Boolean(pager), popup: popup?.kind ?? null, overlay, note: note?.text ?? null, committed: committed.size };
    },
    /** Around a handoff (/codex, the editor): the title goes back to the terminal's, then ours again. */
    holdTitle(hold) {
      titleHeld = Boolean(hold);
      if (hold) restoreTitle();
      else draw();
    },
    dispose() {
      restoreTitle();
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
