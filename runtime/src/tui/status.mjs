// The status line and the terminal window title (codex-parity-2 Part 3), by
// Codex's item ids (tui.status_line, tui.terminal_title), so the stock UI and
// ad read the same settings. Pure: every value comes in `ctx`.
//
//   statusSegments(ids, ctx) → [{id, text, warn}]     ids unset → DEFAULT_STATUS; [] → none
//   titleText(ids, ctx) → string                      ids unset → DEFAULT_TITLE
//   titleSafe(text) → one line, no control characters, at most 80 graphemes
//   canonical(id) / unsupported(ids, kind)
//
// ctx: {app, model, effort, cwd, home, project, hostname, branch, changes,
//       running, waiting, sandbox, approvalPolicy, tokens, rateLimits,
//       codexVersion, threadId, threadName, plan, frame}

import { sanitize } from "./terminal/sanitize.mjs";
import { graphemes } from "./terminal/width.mjs";
import { shortenPath } from "./view/chrome.mjs";

// Codex's aliases (codex-rs/tui/src/bottom_pane/status_line_setup.rs, title_setup.rs).
const ALIASES = { "model-name": "model", project: "project-name", "project-root": "project-name", status: "run-state", approval: "approval-mode", "context-usage": "context-used", "session-id": "thread-id", spinner: "activity" };
export const canonical = (id) => ALIASES[id] ?? id;

// ad's own defaults when the setting is unset (Codex's differ: "unset" means each app's own).
export const DEFAULT_STATUS = ["model-with-reasoning", "current-dir", "context-remaining", "five-hour-limit"];
export const DEFAULT_TITLE = ["activity", "thread-name", "project-name"];

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const pct = (n) => `${Math.round(n)}%`;
function contextUsed(t) {
  if (!t?.contextWindow || !t.last) return null;
  return Math.min(100, (t.last.total / t.contextWindow) * 100);
}
function limit(w, fallback) {
  if (w?.usedPercent == null) return null;
  const label = w.windowDurationMins ? (w.windowDurationMins >= 7 * 24 * 60 ? "wk" : `${Math.round(w.windowDurationMins / 60)}h`) : fallback;
  return { text: `${label} ${pct(w.usedPercent)}`, warn: w.usedPercent >= 80 };
}
const homeShort = (p, home) => (home && (p === home || p.startsWith(home + "\\") || p.startsWith(home + "/")) ? `~${p.slice(home.length)}` : p);

// id → (ctx) → string | {text, warn} | null. Ids missing here are Codex's but not shown by ad.
const ITEMS = {
  "app-name": (c) => c.app ?? "ad",
  model: (c) => c.model,
  "model-with-reasoning": (c) => (c.model ? `${c.model}${c.effort ? ` ${c.effort}` : ""}` : null),
  reasoning: (c) => c.effort,
  "current-dir": (c) => (c.cwd ? shortenPath(homeShort(c.cwd, c.home), 40) : null),
  "project-name": (c) => c.project,
  hostname: (c) => c.hostname,
  "git-branch": (c) => c.branch,
  "branch-changes": (c) => (c.changes && (c.changes.added || c.changes.removed) ? `+${c.changes.added} -${c.changes.removed}` : null),
  "run-state": (c) => (c.waiting ? "waiting for you" : c.running ? "working" : "ready"),
  permissions: (c) => c.sandbox,
  "approval-mode": (c) => c.approvalPolicy,
  "context-remaining": (c) => {
    const u = contextUsed(c.tokens);
    return u == null ? null : { text: `ctx ${pct(100 - u)}`, warn: u >= 80 };
  },
  "context-used": (c) => {
    const u = contextUsed(c.tokens);
    return u == null ? null : { text: `ctx ${pct(u)} used`, warn: u >= 80 };
  },
  "context-window-size": (c) => (c.tokens?.contextWindow ? `${k(c.tokens.contextWindow)} window` : null),
  "five-hour-limit": (c) => limit(c.rateLimits?.primary, "usage"),
  "weekly-limit": (c) => limit(c.rateLimits?.secondary, "wk"),
  "codex-version": (c) => (c.codexVersion ? `codex ${c.codexVersion}` : null),
  "used-tokens": (c) => (c.tokens?.last?.total != null ? `${k(c.tokens.last.total)} tokens` : null),
  "total-input-tokens": (c) => (c.tokens?.total?.inputTokens != null ? `${k(c.tokens.total.inputTokens)} in` : null),
  "total-output-tokens": (c) => (c.tokens?.total?.outputTokens != null ? `${k(c.tokens.total.outputTokens)} out` : null),
  "thread-id": (c) => c.threadId,
  "thread-name": (c) => c.threadName,
  "task-progress": (c) => {
    const steps = c.plan?.steps;
    return steps?.length ? `${steps.filter((s) => s.status === "completed").length}/${steps.length} steps` : null;
  },
  activity: (c) => (c.waiting ? "action required" : c.running ? SPINNER[(c.frame ?? 0) % SPINNER.length] : null),
};
const SPINNER = ["\u{280b}", "\u{2819}", "\u{2839}", "\u{2838}", "\u{283c}", "\u{2834}", "\u{2826}", "\u{2827}", "\u{2807}", "\u{280f}"];

// What each surface offers (Codex's lists; ad shows the ones it can compute).
export const STATUS_IDS = ["model-with-reasoning", "model", "reasoning", "current-dir", "project-name", "hostname", "git-branch", "branch-changes", "run-state", "permissions", "approval-mode", "context-remaining", "context-used", "context-window-size", "five-hour-limit", "weekly-limit", "codex-version", "used-tokens", "total-input-tokens", "total-output-tokens", "thread-id", "thread-name", "task-progress"];
export const TITLE_IDS = ["activity", "app-name", "project-name", "current-dir", "run-state", "thread-name", "git-branch", "context-remaining", "context-used", "five-hour-limit", "weekly-limit", "codex-version", "used-tokens", "total-input-tokens", "total-output-tokens", "thread-id", "model", "model-with-reasoning", "reasoning", "task-progress"];

/** The ids in a setting ad can't show (Codex's others, or typos): kept in the config, listed in /warnings. */
export function unsupported(ids, kind = "status") {
  const known = new Set(kind === "title" ? TITLE_IDS : STATUS_IDS);
  return (Array.isArray(ids) ? ids : []).filter((id) => typeof id !== "string" || !known.has(canonical(id)));
}

/** One line of text, safe to put in a window title or a status row. */
export function titleSafe(text, max = 80) {
  // Invisible format characters go too (zero-width spaces, bidi marks), except
  // the joiner that holds emoji sequences together.
  const one = sanitize(String(text ?? ""), "transcript").replace(/\s+/g, " ").replace(/(?!\u{200d})\p{Cf}/gu, "").trim();
  const g = graphemes(one);
  return g.length > max ? `${g.slice(0, max - 1).join("")}\u{2026}` : one;
}

function value(id, ctx, kind) {
  const known = kind === "title" ? TITLE_IDS : STATUS_IDS;
  const c = canonical(id);
  if (!known.includes(c)) return null;
  const v = ITEMS[c](ctx);
  if (v == null || v === "") return null;
  return typeof v === "object" ? { text: titleSafe(v.text), warn: Boolean(v.warn) } : { text: titleSafe(v), warn: false };
}

/** The status line's items with a value, in the setting's order. */
export function statusSegments(ids, ctx) {
  const list = Array.isArray(ids) ? ids : DEFAULT_STATUS;
  const out = [];
  for (const id of list) {
    const v = typeof id === "string" ? value(id, ctx, "status") : null;
    if (v) out.push({ id: canonical(id), ...v });
  }
  return out;
}

/** The window title: items joined with " | ", the activity spinner set off by spaces only (Codex's way). */
export function titleText(ids, ctx) {
  const list = Array.isArray(ids) ? ids : DEFAULT_TITLE;
  let out = "";
  let prevActivity = false;
  for (const id of list) {
    const v = typeof id === "string" ? value(id, ctx, "title") : null;
    if (!v) continue;
    const isActivity = canonical(id) === "activity";
    out += out ? (isActivity || prevActivity ? " " : " | ") + v.text : v.text;
    prevActivity = isActivity;
  }
  return titleSafe(out);
}
