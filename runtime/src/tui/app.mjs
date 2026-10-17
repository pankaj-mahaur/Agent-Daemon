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
import { createMarkdownStream, renderMarkdown } from "./view/markdown.mjs";
import { isExploring, renderAdRow, renderBackgroundTerminals, renderCell, renderDiff, renderExploring, renderNotice, renderPlan, renderRecap } from "./view/cells.mjs";
import { parseRecap, RECAP_PROMPT_PREFIX, RECAP_SCHEMA, recapHistory, TEMPORARY_THREAD_CONFIG } from "./recap.mjs";
import { createChecklist, createPicker, renderFooter, renderShortcuts, renderStatus } from "./view/chrome.mjs";
import { formAutoCancel, LEGACY, ownEngineHomeRefusal, projectConfigFolder, sandboxConsentBody, tombstoneEngineUiSlash } from "../engine/attribution.mjs";
import { ARM_MS, createChoice, createConfirm, createRequestModal } from "./view/modals.mjs";
import { PLAN_CLEAR_CONTEXT_PREFIX } from "../hooks/generated-prompts.mjs";
import { sanitize } from "./terminal/sanitize.mjs";
import { lineWidth, truncate } from "./terminal/text.mjs";
import { INIT_PROMPT } from "./init-prompt.mjs";
import { setupWindowsSandbox } from "../harness/sandbox.mjs";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { engineCommands, engineHome, isEngineError, engineErrorText, engineErrorDetail } from "../engine/index.mjs";
import path from "node:path";
import { copyText, denialSummary, exportMarkdown, imagePath, lastAgentText, renderDebugConfig, renderHooks, renderKeyInspector, renderKeymap, renderMcp, renderSkills, renderUsage, terminalSetup, transcriptLines } from "./commands.mjs";

import { T } from "./view/theme.mjs";
import { createKeymap, eventSpec, keyLabel } from "./keymap.mjs";
import { setSyntaxTheme, SYNTAX_THEMES, syntaxTheme, withSyntaxTheme } from "./view/highlight.mjs";
import { DEFAULT_STATUS, DEFAULT_TITLE, STATUS_IDS, TITLE_IDS, canonical, contextUsedLabel, statusSegments, titleText, unsupported } from "./status.mjs";

export const FORCE_QUIT_MS = 1500;
const FRAME_MS = 33;
const LIVE_SHARE = 0.6; // at most this much of the screen for streaming cells

const DIM = T.dim;
const WARN = T.warning;

// source "upstream": the same command as the engine's own UI (its name must stay one of upstream's); "ad": ad's own (its name must never be one of upstream's). The collision test checks both against upstream-commands.json in the adapter.
export const SLASH_COMMANDS = [
  { name: "help", source: "ad", desc: "what you can do here" },
  { name: "new", source: "upstream", desc: "start a new conversation" },
  { name: "resume", source: "upstream", desc: "continue an earlier conversation (/resume archived)" },
  { name: "clear", source: "upstream", desc: "clear the terminal and start a new conversation" },
  { name: "archive", source: "upstream", desc: "archive this conversation (/resume archived brings it back)" },
  { name: "delete", source: "upstream", desc: "delete this conversation for good" },
  { name: "pwd", source: "upstream", desc: "show the current working directory" },
  { name: "keymap", source: "upstream", desc: "the keys in effect (/keymap debug shows what a key sends)" },
  { name: "vim", source: "upstream", desc: "toggle Vim mode for the composer" },
  { name: "theme", source: "upstream", desc: "choose a syntax highlighting theme" },
  { name: "cd", source: "upstream", desc: "change the working directory (the conversation continues there)" },
  { name: "model", source: "upstream", desc: "choose the model and reasoning effort" },
  { name: "permissions", source: "upstream", desc: "what the agent may do without asking" },
  { name: "status", source: "upstream", desc: "account, model, sandbox, tokens, limits" },
  { name: "goal", source: "upstream", desc: "set a goal for this conversation (/goal clear)" },
  { name: "plan", source: "upstream", desc: "switch to Plan mode (/plan <prompt> sends it there)" },
  { name: "side", source: "upstream", desc: "a side conversation in an ephemeral fork (/btw)" },
  { name: "btw", source: "upstream", desc: "a side chat (/side)" },
  { name: "ps", source: "upstream", desc: "list background terminals" },
  { name: "stop", source: "upstream", desc: "stop all background terminals (/clean)" },
  { name: "review", source: "upstream", desc: "review your uncommitted changes" },
  { name: "diff", source: "upstream", desc: "show git changes, untracked files included" },
  { name: "compact", source: "upstream", desc: "summarize the conversation to free context" },
  { name: "init", source: "upstream", desc: "create an AGENTS.md for this repo" },
  { name: "warnings", source: "upstream", desc: "notices kept from this session, and unknown events" },
  { name: "remember", source: "ad", desc: "save a note to ad's project memory" },
  { name: "memory", source: "ad", desc: "ad's memory: search, recent, forget, profile" },
  { name: "private", source: "ad", desc: "toggle: prompts are wrapped in <private> (ad never learns from them)" },
  { name: "proposals", source: "ad", desc: "skill changes ad proposes (review with /ad review)" },
  { name: "loop", source: "ad", desc: "work toward an objective in the background (/loop stop)" },
  { name: "team", source: "ad", desc: "the team board" },
  { name: "schedule", source: "ad", desc: "scheduled jobs (/schedule run <id>)" },
  { name: "tools", source: "ad", desc: "optional agent tools (/tools enable browser)" },
  { name: "login", source: "ad", desc: "sign in (ChatGPT, OpenAI key, OpenRouter)" },
  { name: "logout", source: "upstream", desc: "sign out" },
  { name: "ad", source: "ad", desc: "run an ad command, e.g. /ad doctor" },
  { name: "fork", source: "upstream", desc: "continue in a copy of this conversation" },
  { name: "rename", source: "upstream", desc: "name this conversation" },
  { name: "copy", source: "upstream", desc: "copy the last answer to the clipboard" },
  { name: "raw", source: "upstream", desc: "print the last answer as plain text (for selecting)" },
  { name: "mention", source: "upstream", desc: "mention a file" },
  { name: "agents", source: "upstream", desc: "an agent command center (not in ad: see /subagents, /team)" },
  { name: "rollout", source: "upstream", desc: "print the rollout file path" },
  { name: "debug-config", source: "upstream", desc: "show config layers and requirements, for debugging" },
  { name: "recap", source: "upstream", desc: "summarize the current conversation now" },
  { name: "approve", source: "upstream", desc: "approve one retry of a recent auto-review denial" },
  { name: "setup-default-sandbox", source: "upstream", desc: "set up the elevated agent sandbox (Windows)" },
  { name: "subagents", source: "upstream", desc: "watch this conversation's subagents (alt+\u{2190}/\u{2192})" },
  { name: "export", source: "upstream", desc: "save the conversation as markdown in this folder" },
  { name: "mcp", source: "upstream", desc: "MCP servers and their status" },
  { name: "hooks", source: "upstream", desc: "hooks and whether they are trusted" },
  { name: "skills", source: "upstream", desc: "skills the agent can use here" },
  { name: "usage", source: "upstream", desc: "usage limits and tokens" },
  { name: "statusline", source: "upstream", desc: "choose what the status line shows" },
  { name: "title", source: "upstream", desc: "choose what the terminal window's title shows" },
  { name: "image", source: "ad", desc: "attach an image file to the next prompt" },
  { name: "undo", source: "ad", desc: "put back the files the last turn changed, and rewind it (/undo force)" },
  { name: "terminal-setup", source: "ad", desc: "how to make Shift+Enter add a newline here" },
  { name: "quit", source: "upstream", desc: "exit ad" },
  { name: "exit", source: "upstream", desc: "exit ad" },
];

// Upstream's commands at the pinned tag, by every spelling (the generator script):
// what ad mirrors follows upstream's rules (during a task, popup visibility).
const UPSTREAM_COMMANDS = new Map(engineCommands.commands.flatMap((c) => [c.name, ...c.aliases].map((n) => [n, c])));
// Typeable but never listed: upstream's hidden commands, and those only its debug builds show.
const popupHidden = (c) => c.source === "upstream" && (UPSTREAM_COMMANDS.get(c.name)?.popup === "hidden" || UPSTREAM_COMMANDS.get(c.name)?.visible === "debug");

// Upstream commands ad doesn't run (yet), and what it says instead: `true`
// is "not in ad yet"; a string is the whole answer. Every upstream command
// is either in SLASH_COMMANDS or here: a test fails when an engine release
// adds one, so the upgrade PR has to decide.
// The engine's "Implement this plan?" (tui/src/chatwidget/plan_implementation.rs at the pinned tag).
export const PLAN_IMPLEMENTATION_CODING_MESSAGE = "Implement the plan.";
export const PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX = PLAN_CLEAR_CONTEXT_PREFIX; // ad's prompt hooks skip it

export const NOT_IN_AD = {
  ide: "/ide needs an editor link that ad doesn't have.",
  experimental: "/experimental isn't in ad. Features are set under [features] in the engine's settings file (ad about shows where); features you turned on keep working.",
  memories: "/memories isn't in ad; ad's memory is /memory.",
  import: "/import isn't planned for ad.",
  worktree: "/worktree isn't in ad. For parallel work in worktrees, use /team or ad sp.",
  app: "/app isn't in ad: the desktop app keeps its own folder, not ad's, so it can't continue this conversation.",
  voice: "/voice isn't planned for ad.",
  tui: "/tui isn't in ad: ad has only its inline mode.",
  daemon: "/daemon manages a background server ad never uses; ad runs its own engine.",
  pets: "ad doesn't draw terminal pets (they need Kitty or Sixel images).",
  apps: "/apps isn't planned for ad.",
  plugins: "/plugins isn't planned for ad. /mcp lists MCP servers; add one in the engine's settings file.",
  feedback: "For ad problems: https://github.com/pankaj-mahaur/Agent-Daemon/issues.",
  "test-approval": "/test-approval is a debug command of the engine's own UI.",
  "debug-m-drop": "/debug-m-drop is a debug command of the engine's own UI.",
  "debug-m-update": "/debug-m-update is a debug command of the engine's own UI.",
};

/** What ad says for an upstream command it doesn't run, by any of its spellings. */
export function notInAd(name) {
  const c = UPSTREAM_COMMANDS.get(name);
  const said = c && NOT_IN_AD[c.name];
  if (said === undefined) return null;
  return said === true ? `/${name} isn't in ad yet.` : said.replace(`/${c.name}`, `/${name}`);
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
  settings = null, // {engine, ad} from prefs.mjs; null in tests that don't need them
  keymap = createKeymap(), // keys as the engine's actions, with tui.keymap applied (keymap.mjs)
  statusInfo = {}, // {engineVersion, hostname, home} for the status line and the title
  chips = () => [],
  info = {},
  now = () => Date.now(),
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
  setInterval: setI = setInterval,
  clearInterval: clearI = clearInterval,
  armMs = ARM_MS,
  platform = process.platform,
}) {
  const st = session.state;
  const composer = createComposer({ history, now });
  // The engine's tui.theme: the syntax colours (a theme ad doesn't ship falls back to ansi; /warnings says so).
  setSyntaxTheme(settings?.engine?.get?.("tui.theme"));
  // The engine's tui.vim_mode_default: Vim on from the start, in Insert (as its code does).
  if (settings?.engine?.get?.("tui.vim_mode_default") === true) composer.setVim(true, { mode: "insert" });
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
  const commandErrors = []; // Raw command/turn diagnostics are shown only by /warnings.
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
  let pager = null; // {lines, top} while Ctrl+T shows the transcript; {agent, lines, top} watching a subagent
  let privateMode = false; // prompts wrapped in <private>…</private>
  let recapping = null; // {threadId}: a /recap on its way
  let sandboxSetup = false; // /setup-default-sandbox is running: prompts wait
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

  // A cell gets a blank line before it, as in the engine's own UI.
  function commitCell(lines) {
    if (!lines.length) return;
    commit(lastWasCell ? [[], ...lines] : lines);
    lastWasCell = true;
  }

  function resetThreadView() {
    recapping = null; // a recap of the conversation left behind is dropped
    committed = new Set();
    streams = new Map();
    echoesShown = new Set();
    turnsSeen = new Map();
    turnStartedAt = null;
  }

  const rootItems = () => [...st.items.values()].filter((it) => !st.thread || it.threadId === st.thread.id || it.threadId == null);
  const turnActive = () => Boolean(st.activeTurnId || st.starting);
  const agentRunning = () => [...st.agents.values()].some((a) => a.running && !a.closed); // a subagent's thread still at work

  // An item whose turn has ended can't change any more, even if the engine never
  // completed it (a crash, a declined patch): it must not hold back the
  // scrollback behind it.
  // A turn is live only while it is the running one (or one is being
  // started): a resumed turn still "inProgress" in history is over here.
  // An item with no known turn (a user's ! command) stays open while the engine
  // is up; a crash settles it.
  function turnOver(it) {
    const t = it.turnId ? st.turns.find((x) => x.id === it.turnId) : null;
    if (t) return t.status !== "inProgress" || (t.id !== st.activeTurnId && !st.starting);
    return st.engine.state !== "ready" && st.engine.state !== "restarting";
  }
  const open = (it) => (it.streaming || it.status === "inProgress") && !turnOver(it);
  // A command the engine runs through unified exec that is still running (every exec_command is one
  // while it runs; a dev server stays one after the turn).
  const backgroundTerminal = (it) => it.kind === "commandExecution" && it.source === "unifiedExecStartup" && it.status === "inProgress" && !isExploring(it);
  const runningShown = new Set(); // shownKeys committed while still running: their end is drawn too (during a task)
  const settledView = (it) => (it.streaming || it.status === "inProgress" ? { ...it, streaming: false, incomplete: true } : it);

  /**
   * Commits every item that can no longer change, in order. Stops at the
   * first one still streaming (an agent message commits its finished lines
   * as it goes); what is left is drawn live.
   */
  function flush() {
    const items = rootItems().filter((it) => !committed.has(shownKey(it)));
    lateEnds();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // The engine's rule for a command still running: it never holds back what comes
      // after it. Once something follows (or its turn is over) its cell goes into
      // the scrollback as it is: "Running" while the process lives (a background
      // terminal, see /ps), else stopped.
      if (backgroundTerminal(it) && (i < items.length - 1 || turnOver(it))) {
        const running = [...(st.terminals?.values() ?? [])].some((t) => t.itemId === it.id && t.turnId === it.turnId);
        committed.add(shownKey(it));
        if (running) runningShown.add(shownKey(it));
        commitCell(renderCell(running ? { ...it, streaming: false } : settledView(it), { width: width() }));
        continue;
      }
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

  // A command whose "Running" cell is already in the scrollback ended: during a
  // task its end is drawn as its own cell, as the engine's does; after it, only /ps changes.
  function lateEnds() {
    for (const key of runningShown) {
      const it = rootItems().find((x) => shownKey(x) === key);
      if (!it || it.status === "inProgress") continue;
      runningShown.delete(key);
      if (turnActive()) commitCell(renderCell(it, { width: width() }));
    }
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
      if (t.status === "failed" && t.error) commitCell(renderNotice({ level: "error", message: `The turn failed: ${errorText({ ...t.error, code: -32000 })}` }, { width: width() }));
      else if (t.status === "interrupted") commitCell(renderNotice({ level: "warn", message: "Interrupted. Say what to do differently." }, { width: width() }));
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
  // the scrollback as the engine's "Updated Plan" cell, once per update.
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
      if (head.kind === "elicitation" && head.form?.mode === "openaiForm") {
        // Only the engine's own UI can answer it, and ad doesn't ship that UI: cancel at once and say so.
        session.resolve(head.id, { action: "cancel" });
        note = { level: "warn", text: formAutoCancel };
        return;
      }
      const view = createRequestModal(head, { now, armMs, diff });
      if (!view) {
        // Nothing here can answer it (a tool call): decline it and say so.
        session.resolve(head.id, null);
        note = { level: "warn", text: "ad declined a request it can't show here." };
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
    // Prompts sent but not yet echoed by the engine.
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
    const vim = composer.vim;
    // The engine's gg chord hint replaces the hints while the second g is awaited.
    const hints = vim?.hint ? [vim.hint] : running ? ["enter steer", "tab queue", `${newline} newline`] : ["? shortcuts", "@ files", `${newline} newline`];
    const own = [];
    // The engine's mode indicator, first so it's the last to go when the footer is narrow.
    const mode = st.mode?.kind === "plan" ? [{ full: "Plan mode (shift+tab to cycle)", short: "Plan mode", style: T.planMode }] : [];
    // The Vim indicator comes before the collaboration mode.
    if (vim) {
      const name = { normal: "Normal", insert: "Insert", replace: "Replace" }[vim.mode];
      mode.unshift({ full: `Vim: ${name}`, style: { normal: T.vimNormal, insert: T.vimInsert, replace: T.vimReplace }[vim.mode] });
    }
    // The unified-exec footer: how many background terminals run, and how to see or stop them.
    const n = st.terminals?.size ?? 0;
    if (n) own.unshift({ full: `${n} background terminal${n === 1 ? "" : "s"} running \u{b7} /ps to view \u{b7} /stop to close`, short: `${n} background terminal${n === 1 ? "" : "s"}` });
    if (privateMode) own.push({ full: "private", short: "P" });
    const loop = actions.ad?.loop?.state;
    if (loop?.running) own.push({ full: `loop ${loop.iterations}`, short: `L${loop.iterations}` });
    return renderFooter({ hints, chips: [...mode, ...chips(), ...own] }, { width: width() });
  }

  /* -------------------------------------------------------------- */
  /* Status line and window title (the engine's tui.status_line, tui.terminal_title) */
  /* -------------------------------------------------------------- */

  let preview = { status: null, title: null }; // a checklist's live preview
  let git = { root: null, branch: null, changes: null };
  let gitAt = -Infinity;
  let titleFrame = 0;
  let titleShown = null; // what the window title says now (null: never set)
  let titleAt = -Infinity;
  let titleTimer = null;
  let titleHeld = false; // another program has the terminal (a handoff)
  const statusIds = () => preview.status ?? settings?.engine?.get("tui.status_line");
  const titleIds = () => preview.title ?? settings?.engine?.get("tui.terminal_title");
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
      engineVersion: statusInfo.engineVersion,
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
  // The cursor in Vim mode: a steady bar in Insert, the terminal's own shape otherwise (DECSCUSR).
  let cursorShape = null;
  let hintTimer = null;
  function syncCursorShape() {
    const want = composer.vim && !quitting && !titleHeld ? (composer.vim.mode === "insert" ? "bar" : "default") : null;
    if (want === cursorShape) return;
    if (want === "bar") io.write("\x1b[6 q");
    else if (cursorShape === "bar" || want === "default") io.write("\x1b[0 q");
    cursorShape = want;
  }

  function restoreTitle() {
    clearT(titleTimer);
    titleTimer = null;
    if (titleShown === null) return;
    io.write("\x1b]0;\x07\x1b[23;0t");
    titleShown = null;
  }
  // /statusline and /title: a checklist of the engine's items (with what each shows now), live preview, saved to the engine's config.
  function pickItems(kind) {
    const isTitle = kind === "title";
    const key = isTitle ? "tui.terminal_title" : "tui.status_line";
    if (!settings?.engine) return warn("Settings aren't available here.");
    const current = (isTitle ? titleIds() : statusIds()) ?? null;
    const chosen = (current ?? (isTitle ? DEFAULT_TITLE : DEFAULT_STATUS)).map(canonical);
    const all = isTitle ? TITLE_IDS : STATUS_IDS;
    const keep = unsupported(current, kind); // items ad can't show stay in the setting
    const ctx = statusCtx();
    const now_ = (id) => (isTitle ? titleText([id], ctx) : statusSegments([id], ctx)[0]?.text) || "";
    const order = [...chosen.filter((id) => all.includes(id)), ...all.filter((id) => !chosen.includes(id))];
    openChecklist(
      kind,
      order.map((id) => ({ label: id, hint: now_(id), value: id, checked: chosen.includes(id) })),
      async (values) => {
        preview = { ...preview, [kind]: null };
        try {
          await settings.engine.set(key, [...values, ...keep]);
          info0(`${isTitle ? "Title" : "Status line"}: ${values.length ? values.join(", ") : "off"}. Saved.`);
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
    syncCursorShape();
    // The gg hint goes when its second has passed: one redraw then.
    if (composer.vim?.hint && !hintTimer) hintTimer = setT(() => ((hintTimer = null), draw()), 1050);
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
      if (pager.agent) {
        // A subagent, live: at the end it follows what comes in.
        const atEnd = pager.top >= pager.lines.length - view;
        pager.lines = agentLines(pager.agent, w);
        if (atEnd) pager.top = Infinity;
      }
      pager.top = Math.max(0, Math.min(pager.top, pager.lines.length - view));
      if (pager.agent) {
        const ids = [...st.agents.keys()];
        const a = st.agents.get(pager.agent);
        const state = a?.closed ? "closed" : a?.running ? "running" : "idle";
        lines.push(truncate([{ text: `${clean(agentName(a))} \u{b7} ${state} \u{b7} ${ids.indexOf(pager.agent) + 1} of ${ids.length}  `, style: T.bold }, { text: `${AGENT_KEYS} other agents \u{b7} \u{2191}\u{2193} pgup pgdn \u{b7} q or esc closes`, style: DIM }], w));
      } else {
        const where = pager.lines.length ? `Transcript ${pager.top + 1}\u{2013}${Math.min(pager.lines.length, pager.top + view)} of ${pager.lines.length}  ` : "The transcript is empty  ";
        lines.push(truncate([{ text: where, style: T.bold }, { text: "\u{2191}\u{2193} pgup pgdn home end \u{b7} q or esc closes", style: DIM }], w));
      }
      lines.push(...pager.lines.slice(pager.top, pager.top + view));
      renderer.frame({ lines, cursor: { row: 0, col: 0 } });
      return;
    }
    let live = side?.focus === "side" ? [] : liveItems(pending); // a focused side panel: main shows only its status rows
    const cap = Math.max(3, Math.floor(rows * LIVE_SHARE));
    if (live.length > cap) live = [[{ text: `  \u{2026} ${live.length - cap + 1} more lines above`, style: DIM }], ...live.slice(-(cap - 1))];
    lines.push(...live);
    if (sandboxSetup) lines.push([{ text: "\u{2022} ", style: DIM }, { text: "Setting up sandbox...", style: T.bold }, { text: " Hang tight, this may take a few minutes. Input disabled until setup completes.", style: DIM }]);
    if (recapping) lines.push([{ text: "\u{2022} ", style: DIM }, { text: "Generating conversation recap", style: T.bold }, { text: "\u{2026}", style: DIM }]);
    lines.push(...statusLines());
    if (side && !modal && !confirm) lines.push(...sidePanel(w, rows));
    if (st.engine.state === "crashed") {
      const code = Number.isInteger(st.engine.exitCode) ? ` (exit ${st.engine.exitCode})` : "";
      lines.push(truncate([{ text: `\u{25a0} ad's engine stopped${code} (details: /warnings). Your text is kept; Enter restarts it and resumes.`, style: WARN }], w));
    } else if (st.engine.state === "restarting") lines.push(truncate([{ text: "\u{25e6} Restarting the engine\u{2026}", style: DIM }], w));
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
      if (popup?.kind === "theme") lines.push(...themePreview(w));
      const c = composer.render({ width: w, prompt: "\u{203a} ", promptStyle: st.mode?.kind === "plan" ? T.planMode : undefined, placeholder: turnActive() ? "Steer the turn, or tab to queue" : "Ask ad to do anything" });
      lines.push(...c.lines);
      cursor = { row: top + c.cursor.row, col: c.cursor.col };
      if (popup) lines.push(...popup.view.render({ width: w, height: Math.min(10, Math.max(3, rows - lines.length - 1)) }));
      else if (inspector) lines.push(...renderKeyInspector(inspector.last, { width: w }));
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

  function openPicker(kind, items, onSelect, { onCancel, ...opts } = {}) {
    popup = { kind, view: createPicker({ items, ...opts }), onSelect, onCancel };
    draw();
  }

  /* -------------------------------------------------------------- */
  /* /setup-default-sandbox: the elevated Windows sandbox (Part 10) */
  /* -------------------------------------------------------------- */

  // As the engine does: on Windows, from a sandbox that isn't elevated yet, where
  // requirements allow it. It is machine-wide (your own engine install uses it too),
  // so ad asks first. On success this conversation gets the engine's "auto"
  // permissions (edits here, asks for the rest), as the engine does.
  async function setupSandbox() {
    if (platform !== "win32") return info0("The engine uses the operating system's sandbox here (Seatbelt or Landlock): /setup-default-sandbox is only for Windows.");
    if (sandboxSetup) return info0("Windows sandbox setup is still running. Restart ad to try again.");
    // As `ad sandbox setup`: never in an engine home ad didn't make.
    if (session.engine.home && !engineHome.isManaged(session.engine.home)) return warn(`${clean(session.engine.home)} wasn't created by ad, so ad doesn't change its sandbox. \`ad sandbox setup --elevated --force\` does it anyway.`);
    let mode;
    let allowed;
    try {
      const [read, req] = await Promise.all([
        session.engine.config.read({ includeLayers: false, cwd }),
        session.engine.config.requirements(),
      ]);
      mode = read?.config?.windows?.sandbox ?? null;
      allowed = req?.allowedWindowsSandboxImplementations ?? null;
    } catch (err) {
      return commitCell(renderNotice({ level: "warn", message: "Could not read Windows sandbox configuration and requirements from the app server.", hint: errorText(err) }, { width: width() }));
    }
    if (mode === "elevated") return info0("The elevated sandbox is already set up.");
    if (allowed && !allowed.includes("elevated")) return info0("That Windows sandbox option is disallowed by requirements.");
    const yes = await openConfirm({
      title: "Set up the elevated sandbox?",
      body: `${sandboxConsentBody}\nThis conversation then edits in this folder and asks for the rest.`,
      yes: "Yes, set it up",
      no: "No, keep the current one",
    });
    if (!yes) return info0("Kept the current sandbox.");
    sandboxSetup = true;
    draw();
    try {
      await setupWindowsSandbox(session.engine, { mode: "elevated", cwd });
    } catch (err) {
      return commitCell(renderNotice({ level: "error", message: `Windows sandbox setup failed: ${errorText(err) || "unknown error"}`, hint: "`ad sandbox setup` sets up the non-admin sandbox instead." }, { width: width() }));
    } finally {
      sandboxSetup = false;
      drawSoon();
    }
    session.setNextTurn(PERMISSION_PRESETS[1].value);
    commitCell([[{ text: "\u{2022} ", style: DIM }, { text: "Sandbox ready" }], [{ text: "  The agent can now safely edit files and run commands on your computer", style: DIM }]]);
  }

  /* -------------------------------------------------------------- */
  /* /subagents: watch this conversation's subagents (Part 10)        */
  /* -------------------------------------------------------------- */

  // The engine's names for its rows: a path, "Nick [role]", "Nick", "[role]", else "Agent".
  const agentName = (a) => a?.path?.trim() || (a?.nickname && a?.role ? `${a.nickname} [${a.role}]` : a?.nickname || (a?.role ? `[${a.role}]` : "Agent"));
  const AGENT_KEYS = process.platform === "darwin" ? "\u{2325}\u{2190} \u{2325}\u{2192}" : "alt+\u{2190} alt+\u{2192}";
  const isAgentKey = (ev) => ev.type === "key" && ev.alt && !ev.ctrl && (ev.name === "left" || ev.name === "right");

  // A subagent's own transcript: what its thread did, as the main one draws it.
  // Drawn on every frame while watched, so each cell is rendered once until it
  // changes (the session replaces an item's object when it does; its streaming
  // flag, the width and the syntax theme are checked too).
  const agentCells = new WeakMap(); // item → {w, streaming, theme, lines}
  function agentLines(threadId, w) {
    const out = [];
    const theme = syntaxTheme();
    for (const it of st.items.values()) {
      if (it.threadId !== threadId) continue;
      let c = agentCells.get(it);
      if (!c || c.w !== w || c.streaming !== it.streaming || c.theme !== theme) {
        c = { w, streaming: it.streaming, theme, lines: renderCell(it, { width: w }) };
        agentCells.set(it, c);
      }
      if (!c.lines.length) continue;
      if (out.length) out.push([]);
      for (const l of c.lines) out.push(l);
    }
    return out.length ? out : [[{ text: "No activity yet.", style: T.italicDim }]];
  }

  // The Subagents picker: the main conversation first, then each subagent as first seen.
  function pickAgent() {
    if (!st.agents.size) {
      if (settings?.engine?.get?.("features.multi_agent") === false) return enableSubagents();
      return info0("No agents available yet.");
    }
    const items = [
      { label: "Main [default]", hint: st.thread?.id ?? "", value: null },
      ...[...st.agents].map(([id, a]) => ({ label: agentName(a), hint: `${id}${a.closed ? " \u{b7} closed" : a.running ? " \u{b7} running" : ""}`, value: id })),
    ];
    const keys = process.platform === "darwin" ? "\u{2325}\u{2190} previous, \u{2325}\u{2192} next" : "alt+\u{2190} previous, alt+\u{2192} next";
    openPicker("subagents", items, (id) => watchAgent(id), { title: "Subagents", placeholder: `Select an agent to watch. ${keys}.`, initial: pager?.agent ?? null });
  }

  // Watches a subagent in the pager (live); the main conversation closes it.
  function watchAgent(id) {
    pager = id ? { agent: id, lines: [], top: Infinity } : null;
    draw();
  }

  // The previous or next row (the main conversation included), round the ends.
  function cycleAgent(dir) {
    const rows = [null, ...st.agents.keys()];
    const i = rows.indexOf(pager?.agent ?? null);
    watchAgent(rows[(Math.max(0, i) + dir + rows.length) % rows.length]);
  }

  // The prompt when subagents are off and there are none.
  async function enableSubagents() {
    const yes = await openConfirm({ title: "Enable subagents?", body: "Subagents are disabled in this TUI session.\nYes saves it for new threads; this thread is unchanged.", yes: "Yes, enable", no: "Not now" });
    if (!yes) return;
    try {
      await settings.engine.set("features.multi_agent", true);
    } catch (err) {
      return warn(`Failed to save Subagents setting: ${errorText(err)}`);
    }
    warn("Subagents setting saved on the server for new threads. This thread is unchanged. Project or task settings may override it.");
  }

  /* -------------------------------------------------------------- */
  /* /recap: catch-up on this conversation (Part 10)                */
  /* -------------------------------------------------------------- */

  // What /recap reads: the prompts and the answers (a /private prompt never leaves this conversation).
  // Its answers stay out too: they would read as replies to the prompt before it.
  function recapMessages() {
    const out = [];
    let hidden = false;
    for (const it of rootItems()) {
      if (it.kind === "userMessage") {
        hidden = /<private>/.test(it.text ?? "");
        if (!hidden) out.push({ role: "user", text: it.text ?? "" });
      } else if (it.kind === "agentMessage" && !hidden) out.push({ role: "assistant", text: it.text ?? "" });
    }
    return out;
  }

  // The recap: a temporary read-only thread with no tools answers in its recap
  // schema. A prompt sent, or another conversation, meanwhile drops it.
  async function startRecap() {
    if (recapping) return warn("A recap is already being generated.");
    const history = st.thread ? recapHistory(recapMessages()) : "";
    if (!history) return info0("There is no conversation history to recap.");
    // As the engine does: a recap is stale once another turn ran (/compact, /review, a queued prompt…).
    const me = { threadId: st.thread.id, turns: st.turns.length };
    recapping = me;
    draw();
    let recap = null;
    let why = null;
    try {
      const text = await session.engine.structuredRequest({
        cwd,
        model: st.config.model ?? undefined,
        modelProvider: st.thread.modelProvider ?? undefined,
        text: RECAP_PROMPT_PREFIX + history,
        outputSchema: RECAP_SCHEMA,
        config: TEMPORARY_THREAD_CONFIG,
      });
      recap = parseRecap(text);
      if (!recap) why = "The answer wasn't a recap.";
    } catch (err) {
      why = errorText(err);
    }
    if (recapping !== me) return;
    recapping = null;
    if (st.thread?.id !== me.threadId || turnActive() || st.turns.length !== me.turns) return draw();
    if (!recap) commitCell(renderNotice({ level: "error", message: "Could not generate a recap. Please try again.", hint: why }, { width: width() }));
    else commitCell(renderRecap(recap, { width: width() }));
    draw(); // the loading line goes
  }

  /* -------------------------------------------------------------- */
  /* /theme: the syntax theme picker, with a live preview (Part 9) */
  /* -------------------------------------------------------------- */

  const THEME_HINTS = { ansi: "the terminal's own colours (default)", "catppuccin-mocha": "dark", "catppuccin-latte": "light" };
  // The preview: a short Rust function and a diff of it.
  const THEME_SAMPLE = ["```rust", "fn greet(name: &str) -> String {", "    // say hello", '    format!("Hello, {name}!")', "}", "```"].join("\n");
  const THEME_DIFF = [{ path: "src/greet.rs", kind: "update", diff: ["@@ -12,3 +12,3 @@", " fn greet(name: &str) -> String {", '-    format!("Hello, {}!", name)', '+    format!("Hello, {name}!")', " }"].join("\n") }];
  // The theme under the picker's cursor colours its preview only: what
  // commits meanwhile (a turn still streaming) keeps the current theme.
  let previewTheme = null;
  function themePreview(w) {
    return withSyntaxTheme(previewTheme ?? syntaxTheme(), () => [
      [{ text: "Move up/down to live preview themes", style: DIM }],
      ...renderMarkdown(THEME_SAMPLE, { width: w }),
      [],
      ...renderDiff(THEME_DIFF, { width: w, verb: "Edited" }),
      [],
    ]);
  }
  function pickTheme() {
    if (!settings?.engine) return warn("Settings aren't available here.");
    const before = syntaxTheme();
    previewTheme = null;
    const items = SYNTAX_THEMES.map((name) => ({ label: name, hint: `${THEME_HINTS[name] ?? ""}${name === before ? " \u{b7} current" : ""}`, value: name }));
    openPicker(
      "theme",
      items,
      async (name) => {
        previewTheme = null;
        setSyntaxTheme(name);
        try {
          await settings.engine.set("tui.theme", name);
          info0(`Syntax theme: ${name}. Saved.`);
        } catch (err) {
          setSyntaxTheme(before);
          fail(err);
        }
        drawSoon();
      },
      {
        title: "Select Syntax Theme",
        placeholder: "Type to filter themes...",
        initial: before,
        onChange: (name) => ((previewTheme = name), drawSoon()),
        onCancel: () => ((previewTheme = null), drawSoon()),
      },
    );
  }

  // Options to switch on and reorder: onSave(values) on Enter, onCancel() on Esc
  // (undo a live preview there), onChange(values) on every change.
  function openChecklist(kind, items, onSave, { onCancel, onChange, ...opts } = {}) {
    popup = { kind, view: createChecklist({ items, ...opts, onChange: (v) => (onChange?.(v), drawSoon()) }), onSelect: onSave, onCancel };
    draw();
  }

  /* -------------------------------------------------------------- */
  /* "Implement this plan?" (the plan mode, parity 4e)             */
  /* -------------------------------------------------------------- */

  // A completed Plan-mode turn with a proposed plan: remembered until the choice can open.
  function notePlan(t) {
    if (t.status !== "completed" || st.mode?.kind !== "plan") return;
    const ids = new Set(t.itemIds ?? []);
    const plan = [...st.items.values()].findLast((i) => i.kind === "plan" && (i.turnId === t.id || ids.has(i.id)) && String(i.text ?? "").trim());
    if (plan) planReady = { turnId: t.id, threadId: st.thread?.id ?? null, text: String(plan.text) };
  }

  // The engine opens the choice only with nothing queued and nothing open; ad also
  // waits for an empty prompt (a draft is never thrown away) and says so.
  function maybeOfferPlan() {
    if (!planReady) return;
    if (st.mode?.kind !== "plan" || st.thread?.id !== planReady.threadId || turnActive() || st.queue.length) {
      planReady = null; // the moment passed: a new turn, a queued prompt, another mode or conversation
      if (note?.plan) note = null;
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
      // A fresh conversation in Default whose first message is the plan prefix and the plan.
      // The scrollback stays (a divider), unlike /clear.
      session.newThread();
      resetThreadView();
      commit([[{ text: "\u{2500}".repeat(Math.min(60, width())), style: DIM }]]);
      return send(`${PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX}\n\n${plan.text}`);
    }
  }

  // The engine's /cd (app/event_dispatch.rs, app/working_directory.rs at the pinned tag):
  // the folder resolves against the current one ("~" alone or first is home),
  // must be a folder, the session idle with nothing queued, no background
  // terminal and no subagent at work; an untrusted folder is asked about first.
  // Then the conversation forks into it.
  async function changeDir(arg) {
    const BUSY = "Changing directories requires an idle primary session without queued input.";
    if (changingDir || turnActive() || st.queue.length || st.terminals?.size) return warn(BUSY);
    changingDir = true;
    try {
      return await changeDirNow(arg);
    } finally {
      changingDir = false;
    }
  }

  async function changeDirNow(arg) {
    const raw = arg || "~";
    const dir = path.resolve(cwd, raw === "~" || /^~[\\/]/.test(raw) ? path.join(homedir(), raw.slice(1)) : raw);
    let stat;
    try {
      stat = statSync(dir);
    } catch (err) {
      return warn(`Cannot access directory ${clean(dir)}: ${err.code ?? err.message}`);
    }
    if (!stat.isDirectory()) return warn(`Not a directory: ${clean(dir)}`);
    // Never into an engine home: the user's own install's, or ad's (compared as the home check does).
    const real = (p) => engineHome.canonical(p);
    const homes = [path.join(homedir(), projectConfigFolder), session.engine?.home].filter(Boolean).map(real);
    if (homes.some((h) => real(dir) === h || real(dir).startsWith(h + path.sep))) return warn(ownEngineHomeRefusal(clean(dir)));
    if (actions.ad?.loop?.state?.running) return warn("An ad loop is working in this folder: /loop stop first.");
    // The check at the app level: no other agent (a subagent's thread) may be at work.
    if (agentRunning()) return warn("Cannot change: another agent is running.");
    // Trust, as on ad's first start in a folder (kept in ad's engine home).
    const config = await session.engine.readConfig().catch(() => ({}));
    const known = Object.keys(config.projects ?? {}).some((k) => real(k) === real(dir));
    if (!known && real(dir) !== real(homedir())) {
      const trust = await openChoice({
        title: `Do you trust ${clean(dir)}?`,
        body: "Trusted folders can run their own hooks, skills and settings. Trust only projects you know.",
        options: [
          { label: "Yes, trust this folder", value: "trusted" },
          { label: "No", hint: "ignore its hooks and settings", value: "untrusted" },
          { label: "Cancel", hint: "stay here", value: null, safe: true },
        ],
      });
      if (!trust) return info0("Not changed.");
      await session.engine.writeConfig([["projects", { [dir]: { trust_level: trust } }, "upsert"]]);
    }
    // The awaits above can overlap work: the engine checks every thread again before the fork.
    if (turnActive() || agentRunning()) return warn("Cannot change: a task is running.");
    await session.changeDir(dir);
    cwd = dir;
    await Promise.resolve(actions.setCwd?.(dir)).catch((err) => warn(errorText(err)));
    refreshGit(true);
    return info0(`Working directory changed to: ${clean(dir)}`);
  }

  let changingDir = false; // a /cd on its way: prompts wait (they'd go to the old folder)

  /* -------------------------------------------------------------- */
  /* Side conversations (the engine's /side, parity Part 7)           */
  /* -------------------------------------------------------------- */

  let side = null; // {session, focus: "side" | "main", mainStatus, noticesSeen, off}
  let sideOpening = false; // a /side whose fork is on its way
  let inspector = null; // /keymap debug: {last}

  // What a key is to ad: its label, config spelling, raw bytes and the actions it presses.
  function inspectKey(ev) {
    const asKey = ev.type === "text" && [...ev.text].length === 1 ? { type: "key", name: ev.text.toLowerCase(), shift: ev.text !== ev.text.toLowerCase(), ctrl: false, alt: false, raw: ev.text } : ev;
    const spec = ev.type === "text" ? ([...ev.text].length === 1 ? ev.text : null) : eventSpec(ev);
    const actions = keymap.bindings().filter((b) => keymap.is(b.ctx, b.action, asKey)).map((b) => `${b.ctx}.${b.action}`);
    return { label: spec ? keyLabel(spec) : `text "${ev.text}"`, spec, raw: ev.raw ?? ev.text ?? "", actions };
  }

  const sideItems = (s) => [...s.items.values()].filter((it) => it.threadId === s.thread?.id || it.threadId == null);
  const reviewRunning = () => {
    const items = rootItems().filter((it) => it.turnId === st.activeTurnId);
    return Boolean(st.activeTurnId) && items.some((it) => it.kind === "enteredReviewMode") && !items.some((it) => it.kind === "exitedReviewMode");
  };

  // The side context row: "Side from main thread · <main's state> · ctrl+/ to switch · ctrl+c to close".
  function sideLabel() {
    const req = st.requests[0]?.request;
    const main = req ? (req.kind === "user-input" ? "main needs input" : "main needs approval") : side.mainStatus;
    const key = keymap.label("global", "toggle_side_conversation") || "ctrl+/";
    return ["Side from main thread", main, `${key} to switch`, "ctrl+c to close"].filter(Boolean).join(" \u{b7} ");
  }

  // The panel under main's status rows: half the rows at most (all but a few below 16 rows).
  function sidePanel(w, rows) {
    const s = side.session.state;
    const body = [];
    for (const it of sideItems(s)) if (!(it.kind === "userMessage" && it.clientId && s.echoes.has(it.clientId))) body.push(...renderCell(it, { width: w }));
    for (const [, text] of s.echoes) body.push(...renderCell({ kind: "userMessage", text }, { width: w }));
    if (!body.length) body.push([{ text: "  Ask a side question; nothing here goes back to the main conversation.", style: DIM }]);
    const budget = Math.max(3, rows < 16 ? rows - 8 : Math.floor(rows / 2));
    const shown = body.length > budget ? [[{ text: `  \u{2026} ${body.length - budget + 1} more lines above`, style: DIM }], ...body.slice(-(budget - 1))] : body;
    // What the main transcript would say about a turn or a notice, said in the panel.
    const last = s.turns.at(-1);
    if (last?.status === "failed" && last.error) body.push(...renderNotice({ level: "error", message: `The turn failed: ${errorText({ ...last.error, code: -32000 })}` }, { width: w }));
    else if (last?.status === "interrupted") body.push(...renderNotice({ level: "warn", message: "Interrupted." }, { width: w }));
    for (const n of s.notices.slice(side.noticesSeen ?? 0)) if (n.level !== "info") body.push(...renderNotice(n, { width: w }));
    for (const q of s.queue) body.push(truncate([{ text: `  \u{21b3} queued: ${clean(q.text)}`, style: DIM }], w));
    const working = s.activeTurnId || s.starting ? [truncate([{ text: "\u{25e6} Working (esc to interrupt)", style: DIM }], w)] : [];
    const head = truncate([{ text: sideLabel(), style: side.focus === "side" ? T.accent : DIM }], w);
    return [[], head, ...shown, ...working];
  }

  // Closing: the side transcript goes into the scrollback as one block; nothing merges back.
  function closeSide() {
    collectSideDiagnostics();
    const s = side;
    if (!s) return;
    side = null;
    s.off?.();
    const items = sideItems(s.session.state);
    if (items.length || s.session.state.echoes.size) {
      const lines = [[{ text: "Side conversation", style: T.bold }]];
      for (const it of items) lines.push(...renderCell(it.streaming || it.status === "inProgress" ? { ...it, streaming: false, incomplete: true } : it, { width: width() }));
      for (const [, text] of s.session.state.echoes) lines.push(...renderCell({ kind: "userMessage", text }, { width: width() }));
      commitCell(lines);
    }
    s.session.close(); // interrupts a running side turn and lets the fork go
    drawSoon();
  }

  // One of a few answers (the selection views) → the chosen value, or the safe one on Esc.
  function openChoice(opts) {
    confirm?.resolve(false);
    return new Promise((resolve) => {
      confirm = { view: createChoice(opts, { now, armMs }), resolve };
      draw();
    });
  }

  // A yes/no question ad asks before acting on its own (/archive, /delete…).
  // → Promise<boolean>. The engine's own requests come first: one that arrives
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
      // Upstream hides some of its commands from the popup (hidden and debug-build ones always, aliases like /quit until typed).
      const hidden = (c) => popupHidden(c) || (c.source === "upstream" && UPSTREAM_COMMANDS.get(c.name)?.popup === "unfiltered" && !q);
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

  const info0 = (text, hint) => commitCell(renderNotice({ level: "info", message: text, hint }, { width: width() }));
  const warn = (text) => commitCell(renderNotice({ level: "warn", message: text }, { width: width() }));
  function collectSideDiagnostics() {
    for (const n of side?.session.state.notices ?? []) {
      if (!n.detail || commandErrors.some((d) => d.message === n.message && d.detail === n.detail)) continue;
      commandErrors.push({ ...n });
      if (commandErrors.length > 50) commandErrors.shift();
    }
  }
  function errorText(err, options) {
    if (!isEngineError(err)) return err?.message ?? String(err);
    const message = engineErrorText(err);
    const detail = engineErrorDetail(err);
    if (detail && !commandErrors.some((n) => n.message === message && n.detail === String(detail))) {
      commandErrors.push({ level: "error", message, detail: String(detail), at: Date.now() });
      if (commandErrors.length > 50) commandErrors.shift();
    }
    return engineErrorText(err, options);
  }
  const fail = (err) => warn(errorText(err));

  async function slash(name, arg) {
    switch (name) {
      case "help":
        return commitCell([
          [{ text: "Commands", style: T.bold }],
          ...SLASH_COMMANDS.filter((c) => c.name !== "exit" && !popupHidden(c)).map((c) => truncate([{ text: `  /${c.name.padEnd(12)}`, style: T.code }, { text: c.desc, style: DIM }], width())),
          [],
          ...renderShortcuts({ newline, keymap }, { width: width() }),
        ]);
      case "new":
        session.newThread();
        resetThreadView();
        return info0("New conversation.");
      case "clear": {
        // The engine's /clear: clear the terminal, scrollback too, and start a new
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
      case "cd":
        return changeDir(arg);
      case "theme":
        return pickTheme();
      case "vim": {
        // The engine's /vim: a toggle for this session; turned on, it starts in Normal.
        const on = !composer.vim;
        composer.setVim(on, { mode: "normal" });
        return info0(on ? "Vim mode enabled." : "Vim mode disabled.");
      }
      case "keymap":
        // The engine's /keymap edits tui.keymap; ad reads it and never writes it (P3), so it shows them.
        if (arg === "debug") {
          inspector = { last: null };
          return draw();
        }
        if (arg) return warn("Usage: /keymap [debug]");
        return commitCell(renderKeymap(keymap, { width: width(), label: keyLabel, settingsPath: session.engine?.home ? path.join(session.engine.home, "config.toml") : null }));
      case "pwd":
        return arg ? warn("Usage: /pwd") : info0(`Current working directory: ${clean(cwd)}`);
      case "debug-config": {
        // The engine prints its in-process config; ad asks its engine for the same (layers, requirements).
        const [read, req] = await Promise.all([
          session.engine.config.read({ includeLayers: true, cwd }),
          session.engine.config.requirements(),
        ]);
        return commitCell(renderDebugConfig({ layers: read?.layers, requirements: req }, { width: width() }));
      }
      case "recap":
        return startRecap();
      case "subagents":
        return pickAgent();
      case "setup-default-sandbox":
        return setupSandbox();
      case "approve": {
        // The denials: the thread's recent auto-review denials; one picked is approved for one retry.
        if (!st.denials?.length) return info0("No recent auto-review denials in this thread.", "Denials are recorded after auto-review rejects an action.");
        const items = st.denials.map((d) => ({ label: denialSummary(d.action), hint: d.review?.rationale || "Auto-review did not include a rationale", value: d.reviewId }));
        return openPicker(
          "approve",
          items,
          async (id) => {
            try {
              await session.approveDenial(id);
            } catch (err) {
              return fail(err);
            }
            info0("Approval recorded for one retry of the selected auto-review denial.", "The model will see the approval context; the retry still goes through auto-review.");
            drawSoon();
          },
          { title: "Auto-review Denials", placeholder: "Select a denied action to approve." },
        );
      }
      case "rollout":
        // The debug-build command: the conversation's rollout file (none for an ephemeral one).
        return info0(st.thread?.path ? `Current rollout path: ${clean(st.thread.path)}` : "Rollout path is not available yet.");
      case "agents":
        // The engine's answer when it runs its own server, as ad does (ad never starts the shared one).
        return info0(
          "Shared agents unavailable",
          "This session isn\u{2019}t connected to a shared background server. /subagents switches between this conversation's subagents; /team shows ad's team board.",
        );
      case "mention": {
        // The engine's /mention: an "@" at the cursor, and the file picker for it.
        const { text, cursor } = composer;
        const at = cursor > 0 && !/\s/.test(text[cursor - 1]) ? " @" : "@";
        composer.set(text.slice(0, cursor) + at + text.slice(cursor), cursor + at.length);
        syncTokenPopup();
        return draw();
      }
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
          // The engine fixes a turn's permissions when it starts: say so if one is running.
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
      case "ps":
        // The engine's /ps: the background terminals of this conversation, with their last lines.
        return commitCell([[{ text: "/ps", style: DIM }], ...renderBackgroundTerminals([...st.terminals.values()], { width: width() })]);
      case "stop":
        // The engine's /stop (/clean): ends them all. Off when the pinned protocol lacks it (G5).
        try {
          await session.stopTerminals();
        } catch (err) {
          if (err?.code === "FEATURE_UNAVAILABLE") return warn(errorText(err));
          throw err;
        }
        return info0("Stopping all background terminals.");
      case "btw":
      case "side": {
        // The engine's /side (/btw): one at a time. What was typed comes back when it can't open.
        const typed = `/${name} ${arg}`.trim();
        if (side || sideOpening) {
          if (side) side.focus = "side";
          if (arg) composer.set(typed);
          return warn("A side conversation is already open. Press ctrl + c to return before starting another.");
        }
        if (reviewRunning()) return warn("'/side' is unavailable while code review is running.");
        const before = { thread: st.thread?.id, engine: session.engine };
        sideOpening = true;
        let s;
        try {
          s = await session.openSide();
        } catch (err) {
          if (arg && !composer.text) composer.set(typed);
          throw err;
        } finally {
          sideOpening = false;
        }
        // The main conversation or the engine changed meanwhile: this side belongs to neither.
        if (st.thread?.id !== before.thread || session.engine !== before.engine || st.engine.state !== "ready") {
          s.close();
          if (arg && !composer.text) composer.set(typed);
          return warn("The conversation changed while the side conversation opened: /side again.");
        }
        side = { session: s, focus: "side", mainStatus: null, noticesSeen: s.state.notices.length, off: s.on("change", () => drawSoon()) };
        if (arg) send(arg);
        return draw();
      }
      case "plan": {
        // The engine's /plan: switch, then send the text there; unavailable, the text goes back to the composer.
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
        const t = lastAgentText(side?.focus === "side" ? side.session.state : st);
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
        return session.engine.mcp.status().then((data) => commitCell(renderMcp(data, { width: width() })), fail);
      case "hooks":
        return Promise.resolve(session.engine.listHooks([cwd])).then((h) => commitCell(renderHooks(h, { width: width(), hooksFile: session.engine.home ? path.join(session.engine.home, "hooks.json") : null })), fail);
      case "skills":
        return session.engine.skills.list([cwd]).then((data) => commitCell(renderSkills(data, { width: width() })), fail);
      case "usage": {
        const rl = await session.engine.usage.limits().catch(() => st.rateLimits);
        const usage = await session.engine.usage.read().catch(() => null);
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
      case "ad": {
        const run = { login: actions.login, ad: actions.runAd }[name];
        if (!run) return warn(`/${name} isn't available here.`);
        if (turnActive()) return warn(`Wait for the turn to finish (or esc), then /${name}.`);
        return Promise.resolve(run(arg, { threadId: st.thread?.id ?? null }))
          .then((msg) => {
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
    collectSideDiagnostics();
    const kept = [...st.notices, ...commandErrors].filter((n) => n.level !== "info" || n.detail).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const unknown = Object.entries(session.engine?.unknownCounts?.() ?? {});
    const unused = [
      ...(keymap.warnings ?? []),
      ...(() => {
        const th = settings?.engine?.get?.("tui.theme");
        return th && !SYNTAX_THEMES.includes(th) ? [`tui.theme: ad doesn't ship "${th}"; it shows code in ansi`] : [];
      })(),
      ...unsupported(settings?.engine?.get("tui.status_line"), "status").map((id) => `tui.status_line: ad doesn't show "${id}"`),
      ...unsupported(settings?.engine?.get("tui.terminal_title"), "title").map((id) => `tui.terminal_title: ad doesn't show "${id}"`),
    ];
    if (!kept.length && !unknown.length && !unused.length) return renderNotice({ level: "info", message: "No warnings in this session." }, { width: width() });
    const out = [[{ text: "Warnings", style: T.bold }]];
    for (const n of kept.slice(-20)) {
      out.push(...renderNotice(n, { width: width() }));
      if (n.detail) for (const line of String(n.detail).split("\n").slice(0, 8)) out.push(truncate([{ text: `    details: ${clean(line)}`, style: DIM }], width()));
    }
    if (unknown.length) {
      out.push([{ text: "Events this ad doesn't know (a newer engine?):", style: DIM }]);
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
    if (info.compat) rows.push(["engine", info.compat]);
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
    modelsCache ??= await session.engine.models.list().catch(() => []);
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
      models = await session.engine.models.list();
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
      threads = (await session.engine.threads.list({ cwd, limit: 30, modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"], ...(archived ? { archived: true } : {}) })).filter((t) => t.id !== st.thread?.id);
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
        Promise.resolve(archived && session.engine.threads.unarchive(id))
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
    if (side?.focus === "side" && !shown) {
      const r = side.session.submit(privateMode ? `<private>${text}</private>` : text);
      r.accepted.catch((err) => warn(`Not sent: ${errorText(err)}`));
      return drawSoon();
    }
    if (changingDir) {
      if (!composer.text) composer.set(text);
      return warn("Changing directories: send it once that's done.");
    }
    recapping = null; // as the engine does, a prompt drops a recap on its way
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
          warn(`Not sent: ${errorText(err)}`);
          if (!composer.text && !shown) composer.set(raw);
          if (images.length && !attachments.length) attachments = images;
          drawSoon();
        },
      );
    } catch (err) {
      warn(`Not sent: ${errorText(err)}`);
    }
  }

  // After a crash the automatic restarts gave up on: Enter tries once more.
  function restartEngine() {
    note = { level: "info", text: "Restarting the engine\u{2026}" };
    Promise.resolve(session.restartEngine?.())
      .then((ok) => {
        note = ok ? null : { level: "warn", text: "The engine didn't come back. Enter tries again; /quit and `ad tui --last` start fresh." };
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
    if (sandboxSetup && !/^\/(?:quit|exit)\s*$/i.test(text.trim())) {
      if (!composer.text) composer.set(text);
      return warn("Input disabled until setup completes.");
    }
    if (st.engine.state === "crashed") restartEngine(); // the prompt waits in the queue meanwhile
    const t = text.trim();
    const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(t);
    if (m) {
      const name = m[1].toLowerCase();
      if (name === LEGACY.command) return warn(tombstoneEngineUiSlash({ settingsPath: session.engine?.home ? path.join(session.engine.home, "config.toml") : "(see ad doctor)" }));
      const upstream = UPSTREAM_COMMANDS.get(name);
      const cmd = SLASH_COMMANDS.find((c) => c.name === name) ?? (upstream && SLASH_COMMANDS.find((c) => c.source === "upstream" && c.name === upstream.name));
      // In a side conversation only the side commands work.
      if (side?.focus === "side" && (cmd || upstream)) {
        if (["side", "btw"].includes(cmd?.name ?? upstream?.name)) return warn("A side conversation is already open. Press ctrl + c to return before starting another.");
        if (!upstream?.sideAllowed || !cmd) {
          composer.set(text);
          return warn(`'/${name}' is unavailable in side conversations. Press Ctrl+C to return to the main thread first.`);
        }
      }
      if (cmd) {
        // The rule for upstream commands: some wait for the task to end. The draft stays.
        if (cmd.source === "upstream" && upstream && !upstream.duringTask && (side?.focus === "side" ? Boolean(side.session.state.activeTurnId || side.session.state.starting) : turnActive())) {
          composer.set(text);
          return warn(`'/${name}' is disabled while a task is in progress.`);
        }
        // Any failure inside a command (a rejected request, a renderer error) is shown, never left unhandled.
        return void Promise.resolve(slash(cmd.name, (m[2] ?? "").trim())).catch(fail);
      }
      // An upstream command ad doesn't run never goes to the model as a prompt, text or not.
      const said = notInAd(name);
      if (said) {
        composer.set(text);
        return info0(said);
      }
    }
    // A one-line "!cmd" runs in the shell; a multi-line paste that starts with "!" (an image link…) is a prompt.
    if (side?.focus === "side" && t.startsWith("!") && t.length > 1 && !t.includes("\n")) {
      composer.set(text);
      return warn("Shell commands are unavailable in side conversations.");
    }
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
    syncCursorShape();
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
    // In a side conversation, Ctrl+C on an empty prompt closes it (and doesn't arm the quit).
    if (side?.focus === "side" && !composer.text && !popup && !overlay) {
      closeSide();
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
    // /keymap debug: every key is shown, not acted on; Ctrl+C closes.
    if (inspector && !modal && !confirm) {
      if (ev.type === "key" && ev.ctrl && ev.name === "c") inspector = null;
      else if (ev.type === "key" || ev.type === "text") inspector.last = inspectKey(ev);
      return draw();
    }
    if (ev.type === "key" && ev.ctrl && ev.name === "c") {
      onCtrlC();
      return draw();
    }
    if (keymap.is("global", "clear_terminal", ev)) return void renderer.redraw();
    if (pager?.agent && !modal && isAgentKey(ev)) {
      cycleAgent(ev.name === "left" ? -1 : 1);
      return draw();
    }
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
    // Fixed agent keys: from an empty prompt, Alt+←/→ watch a subagent.
    if (isAgentKey(ev) && !modal && !confirm && !popup && !overlay && !composer.text && side?.focus !== "side" && st.agents.size) {
      cycleAgent(ev.name === "left" ? -1 : 1);
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
      // Esc and Shift+Tab only close it (Shift+Tab switches modes with nothing open, as upstream does).
      if (ev.type === "key" && (ev.name === "escape" || (ev.name === "tab" && ev.shift))) return draw();
    }
    if (popup && popupKey(ev)) return draw();
    // Vim's Esc comes first: Insert to Normal, or a pending command cancelled (never an
    // interrupt), in the main prompt and in a side conversation's alike.
    if (ev.type === "key" && ev.name === "escape" && composer.vim?.wantsEscape()) {
      composer.handle(ev);
      return draw();
    }
    // Ctrl+/ (0x1f, or CSI 47;5u): focus between the side panel and the main prompt.
    if (keymap.is("global", "toggle_side_conversation", ev) || (ev.type === "key" && ev.ctrl && ev.name === "_" && keymap.keys("global", "toggle_side_conversation").includes("ctrl-/"))) {
      if (side) side.focus = side.focus === "side" ? "main" : "side";
      return draw();
    }
    if (side?.focus === "side" && ev.type === "key") {
      // Esc interrupts only the side turn; Tab and Shift+Tab do nothing here.
      if ((ev.name === "escape" && !ev.ctrl && !ev.alt) || keymap.is("chat", "interrupt_turn", ev)) {
        const s = side.session.state;
        if (s.activeTurnId || s.starting) side.session.interrupt().catch(fail);
        return draw();
      }
      if (ev.name === "tab") return draw();
    }
    if (ev.type === "paste-empty") {
      note = { level: "warn", text: "The clipboard holds an image: save it as a file, then /image <path> (or paste the file's path)." };
      return draw();
    }
    // A pasted or dragged image file path attaches the image.
    if (ev.type === "paste") {
      const img = imagePath(ev.text, cwd, { pasted: true });
      if (img && side?.focus === "side") {
        note = { level: "warn", text: "Images can't go to a side conversation: Ctrl+/ to attach it in the main one." };
        return draw();
      }
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
    // Keys for /copy and /raw, and F2 for /warnings.
    // (straight to the command: a key never restarts a crashed engine, as sending a prompt does)
    const run = (name) => void Promise.resolve(slash(name, "")).catch(fail).finally(() => draw());
    if (keymap.is("global", "copy", ev)) return run("copy");
    if (keymap.is("global", "toggle_raw_output", ev)) return run("raw");
    if (ev.type === "key" && ev.name === "f2" && !ev.ctrl && !ev.alt && !ev.shift) return run("warnings");
    if (ev.type === "text" || ev.type === "paste") lastCtrlC = -Infinity; // new text: Ctrl+C clears it, not quit
    if ((ev.type === "text" || ev.type === "paste") && !turnActive()) actions.onTyping?.();
    // In Vim's Normal mode "?" searches backwards; the shortcuts open only from Insert (as upstream does).
    if (keymap.is("composer", "toggle_shortcuts", ev) && !composer.text && !(composer.vim && composer.vim.mode !== "insert")) {
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
    // Shift+Tab: the fixed key for the next collaboration mode (Plan ↔ Default), only with no task running.
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
    // A side conversation belongs to this main thread and this engine.
    if (side && (what === "thread" || (what === "engine" && st.engine.state !== "ready"))) closeSide();
    if (side && (what === "turn.started" || what === "starting") && turnActive()) side.mainStatus = null;
    if (side && what === "turn" && !st.activeTurnId) {
      const last = st.turns.at(-1)?.status;
      side.mainStatus = last === "failed" ? "main failed" : last === "interrupted" ? "main interrupted" : last === "completed" ? "main finished" : side.mainStatus;
    }
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
    /** Around a handoff (the editor): the title goes back to the terminal's, then ours again. */
    holdTitle(hold) {
      titleHeld = Boolean(hold);
      if (hold) {
        restoreTitle();
        syncCursorShape(); // the editor or the engine's own UI gets the terminal's own cursor
      } else draw();
    },
    dispose() {
      restoreTitle();
      clearT(drawTimer);
      clearT(hintTimer);
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
 * Collisions between ad's slash commands and upstream's (plan Part 7): an ad
 * command must not take an upstream name, and a mirrored one must still exist.
 */
export function slashCollisions(commands, upstreamNames) {
  const upstream = new Set(upstreamNames);
  const out = [];
  for (const c of commands) {
    if (c.source === "ad" && upstream.has(c.name)) out.push(`/${c.name} is ad's own but the engine's own UI now has it too`);
    if (c.source === "upstream" && !upstream.has(c.name)) out.push(`/${c.name} mirrors the engine's own UI, which no longer has it`);
  }
  return out;
}
