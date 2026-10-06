// Transcript cells (plan Part 5c): ViewItems (engine/codex/events.mjs) to span
// lines, the way Codex's TUI shows them. Pure; untrusted text (commands,
// output, paths, tool results) is sanitized here.
//
//   renderCell(item, {width, live})   → lines for one item
//   renderExploring(items, {width})   → one "Explored" cell for a run of read/list/search commands
//   isExploring(item)                 → true for a command made only of read/list/search actions
//   renderPlan(steps, {width, explanation})
//   renderDiff(changes, {width, maxLines})
//   renderNotice(notice, {width}) · renderAdRow(kind, text, {width})
//
// Command output shows its last 5 lines (50 for a user's `!` command, which is
// labelled "unsandboxed"); everything else is capped too, so one item never
// floods the scrollback.

import { sanitize } from "../terminal/sanitize.mjs";
import { normalize, truncate, wrap } from "../terminal/text.mjs";
import { stringWidth } from "../terminal/width.mjs";
import { codeLines, renderMarkdown, wrapPrefixed } from "./markdown.mjs";

const S = {
  bullet: { dim: true },
  head: { bold: true },
  dim: { dim: true },
  ok: { fg: "green", bold: true },
  bad: { fg: "red", bold: true },
  warn: { fg: "yellow" },
  err: { fg: "red" },
  cmd: { fg: "cyan" },
  user: { fg: "cyan", bold: true },
  add: { fg: "green" },
  del: { fg: "red" },
  hunk: { fg: "cyan", dim: true },
  italic: { dim: true, italic: true },
};

const OUTPUT_TAIL = 5;
const SHELL_TAIL = 50;
const COMMAND_LINES = 3;
const DIFF_LINES = 40;
const TEXT_LINES = 20;

const clean = (t) => sanitize(String(t ?? ""), "transcript").replace(/\t/g, "    ");
const BRANCH = "  \u{2514} ";
const INDENT = "    ";

// "• Head rest…" wrapped with a hanging indent under the head.
function header(bullet, parts, width) {
  return wrapPrefixed(parts, width, [{ text: `${bullet} `, style: bullet === "\u{2022}" ? S.bullet : undefined }], [{ text: "  " }]);
}

// Detail lines under a header: "  └ first" then "    rest".
function details(lines, width) {
  return lines.flatMap((l, i) => wrapPrefixed(l, width, [{ text: i === 0 ? BRANCH : INDENT, style: S.dim }], [{ text: INDENT }]));
}

function tail(text, n, width) {
  const all = clean(text).replace(/\n+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return [];
  const kept = all.slice(-n);
  const lines = [];
  if (all.length > n) lines.push([{ text: `\u{2026} +${all.length - n} lines`, style: S.dim }]);
  for (const l of kept) lines.push(...codeLines(l, Math.max(1, width - INDENT.length), S.dim));
  return lines;
}

function capLines(lines, n, what = "lines") {
  if (lines.length <= n) return lines;
  return [...lines.slice(0, n), [{ text: `\u{2026} +${lines.length - n} ${what}`, style: S.dim }]];
}

const seconds = (ms) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

const EXPLORE = new Set(["read", "listFiles", "search"]);

export function isExploring(item) {
  return item?.kind === "commandExecution" && item.source !== "userShell" && Array.isArray(item.actions) && item.actions.length > 0 && item.actions.every((a) => EXPLORE.has(a?.type));
}

function actionLine(a) {
  if (a.type === "read") return { verb: "Read", what: clean(a.name || a.path) };
  if (a.type === "listFiles") return { verb: "List", what: clean(a.path || ".") };
  const q = a.query ? clean(a.query) : "";
  return { verb: "Search", what: q && a.path ? `${q} in ${clean(a.path)}` : q || clean(a.path || a.command) };
}

/** One cell for a run of exploring commands; consecutive reads are merged. */
export function renderExploring(items, { width = 80 } = {}) {
  const running = items.some((i) => i.status === "inProgress" || i.streaming);
  const rows = [];
  for (const a of items.flatMap((i) => i.actions)) {
    const { verb, what } = actionLine(a);
    const last = rows.at(-1);
    if (last && last.verb === verb && verb === "Read") last.what.push(what);
    else rows.push({ verb, what: [what] });
  }
  const out = header("\u{2022}", [{ text: running ? "Exploring" : "Explored", style: S.head }], width);
  const lines = rows.map((r) => [{ text: `${r.verb} `, style: S.cmd }, { text: [...new Set(r.what)].join(", ") }]);
  out.push(...details(capLines(lines, 8, "more"), width));
  return out;
}

function renderCommand(item, width) {
  const shell = item.source === "userShell";
  const status = item.streaming && item.status !== "failed" && item.status !== "declined" ? "inProgress" : item.status;
  const failed = status === "failed" || (Number.isInteger(item.exitCode) && item.exitCode !== 0 && status !== "inProgress");
  const verb =
    item.incomplete ? "Stopped" : status === "inProgress" ? "Running" : status === "declined" ? "Declined" : failed ? "Failed" : "Ran";
  const verbStyle = failed || status === "declined" ? S.bad : S.head;
  const cmd = clean(item.command).replace(/\s*\n\s*/g, " \u{21b5} ");
  const parts = [{ text: verb, style: verbStyle }, { text: " " }];
  if (shell) parts.push({ text: "(unsandboxed) ", style: S.warn });
  parts.push({ text: cmd, style: S.cmd });
  if (failed && Number.isInteger(item.exitCode)) parts.push({ text: ` (exit ${item.exitCode})`, style: S.err });
  if (status !== "inProgress" && item.durationMs != null) parts.push({ text: ` \u{00b7} ${seconds(item.durationMs)}`, style: S.dim });
  const out = capLines(header("\u{2022}", parts, width), COMMAND_LINES, "lines of command");
  const output = tail(item.output ?? "", shell ? SHELL_TAIL : OUTPUT_TAIL, width);
  if (output.length) out.push(...output.map((l, i) => normalize([{ text: i === 0 ? BRANCH : INDENT, style: S.dim }, ...l])));
  else if (status !== "inProgress" && !failed && status !== "declined") out.push([{ text: `${BRANCH}(no output)`, style: S.dim }]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

/**
 * A file change as rows {n, sign, text}. A new or deleted file's `diff` is its
 * content, shown line for line whatever it contains. An update is a unified
 * diff: anything before the first hunk header is skipped, and each hunk takes
 * exactly the lines its header counts, so content that looks like a header
 * ("+++x", "--- y", "@@") is still shown. `mode` is the sanitize mode
 * ("approval" when the user is asked to approve the change).
 */
export function diffRows(change, mode = "transcript") {
  const raw = sanitize(String(change?.diff ?? ""), mode).replace(/\n$/, "");
  const src = raw === "" ? [] : raw.split("\n");
  const rows = [];
  if (change?.kind === "add" || change?.kind === "delete") {
    const sign = change.kind === "delete" ? "-" : "+";
    src.forEach((t, i) => rows.push({ n: i + 1, sign, text: t }));
    return rows;
  }
  let i = 0;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  while (i < src.length && !header.test(src[i])) i++;
  if (i === src.length) {
    // No hunk at all: show the text as it is.
    src.forEach((t, k) => rows.push({ n: k + 1, sign: " ", text: t }));
    return rows;
  }
  while (i < src.length) {
    const h = header.exec(src[i]);
    if (!h) {
      // Outside every hunk's counts (a malformed diff): shown, marked "?", never hidden.
      if (src[i] !== "") rows.push({ n: null, sign: "?", text: src[i] });
      i++;
      continue;
    }
    if (rows.length) rows.push({ n: null, sign: "\u{22ee}", text: "" });
    let oldN = Number(h[1]);
    let newN = Number(h[3]);
    let oldLeft = h[2] === undefined ? 1 : Number(h[2]);
    let newLeft = h[4] === undefined ? 1 : Number(h[4]);
    i++;
    while (i < src.length && (oldLeft > 0 || newLeft > 0)) {
      // A header inside a hunk means the counts were wrong: start the next hunk there.
      if (header.test(src[i])) break;
      const l = src[i++];
      if (l.startsWith("\\")) continue; // "\ No newline at end of file"
      if (l.startsWith("+") && newLeft > 0) {
        rows.push({ n: newN++, sign: "+", text: l.slice(1) });
        newLeft--;
      } else if (l.startsWith("-") && oldLeft > 0) {
        rows.push({ n: oldN++, sign: "-", text: l.slice(1) });
        oldLeft--;
      } else {
        // A context line starts with a space; anything else is malformed and shown whole.
        rows.push({ n: newN++, sign: " ", text: l.startsWith(" ") ? l.slice(1) : l });
        oldN++;
        oldLeft--;
        newLeft--;
      }
    }
  }
  return rows;
}

/** Counts of added and removed lines. */
export function diffStats(change) {
  const rows = diffRows(change);
  return { added: rows.filter((r) => r.sign === "+").length, removed: rows.filter((r) => r.sign === "-").length };
}

// One file's diff as gutter lines: "  12 + text".
function diffBody(change, width, maxLines, mode) {
  const rows = diffRows(change, mode);
  const nw = Math.max(1, ...rows.map((r) => String(r.n ?? "").length));
  const out = [];
  for (const r of rows) {
    const style = r.sign === "+" ? S.add : r.sign === "-" ? S.del : r.sign === " " ? undefined : r.sign === "?" ? S.warn : S.dim;
    const gutter = `${INDENT}${String(r.n ?? "").padStart(nw)} ${r.sign} `;
    const room = Math.max(1, width - stringWidth(gutter));
    codeLines(r.text, room, style).forEach((l, i) => out.push(normalize([{ text: i === 0 ? gutter : " ".repeat(stringWidth(gutter)), style: S.dim }, ...l])));
  }
  return capLines(out, maxLines);
}

/** "Edited N files (+A -R)" and each file's diff with a line-number gutter. */
export function renderDiff(changes, { width = 80, maxLines = DIFF_LINES, verb = "Edited", mode = "transcript" } = {}) {
  // Paths are shown the same way as the content: "approval" makes hidden characters visible.
  const clean = (t) => sanitize(String(t ?? ""), mode).replace(/\s*\n\s*/g, " ");
  const stats = changes.map(diffStats);
  const added = stats.reduce((n, s) => n + s.added, 0);
  const removed = stats.reduce((n, s) => n + s.removed, 0);
  const count = (a, r) => [{ text: " (" }, { text: `+${a}`, style: S.add }, { text: " " }, { text: `-${r}`, style: S.del }, { text: ")" }];
  const what = changes.length === 1 ? clean(changes[0].path) : `${changes.length} files`;
  const out = header("\u{2022}", [{ text: verb, style: S.head }, { text: ` ${what}` }, ...count(added, removed)], width);
  changes.forEach((c, i) => {
    if (changes.length > 1) {
      const label = c.movePath ? `${clean(c.path)} \u{2192} ${clean(c.movePath)}` : clean(c.path);
      out.push(...details([[{ text: label }, ...count(stats[i].added, stats[i].removed)]], width));
    } else if (c.movePath) out.push(...details([[{ text: `${clean(c.path)} \u{2192} ${clean(c.movePath)}` }]], width));
    out.push(...diffBody(c, width, maxLines, mode));
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Plans, notices, ad rows                                             */
/* ------------------------------------------------------------------ */

export function renderPlan(steps, { width = 80, explanation = null } = {}) {
  const out = header("\u{2022}", [{ text: "Updated plan", style: S.head }], width);
  const lines = [];
  if (explanation) lines.push([{ text: clean(explanation), style: S.italic }]);
  for (const s of steps ?? []) {
    const done = s.status === "completed";
    const mark = done ? "\u{2714} " : s.status === "inProgress" ? "\u{25a1} " : "\u{25a1} ";
    const style = done ? { dim: true, strike: true } : s.status === "inProgress" ? { fg: "cyan", bold: true } : undefined;
    lines.push([{ text: mark, style: done ? { fg: "green" } : style }, { text: clean(s.step), style }]);
  }
  out.push(...details(lines, width));
  return out;
}

const NOTICE = {
  info: { mark: "\u{2022}", style: S.dim },
  warn: { mark: "\u{26a0}", style: S.warn },
  error: { mark: "\u{25a0}", style: S.err },
};

export function renderNotice(notice, { width = 80 } = {}) {
  const n = NOTICE[notice?.level] ?? NOTICE.info;
  return wrapPrefixed([{ text: clean(notice?.message), style: n.style }], width, [{ text: `${n.mark} `, style: n.style }], [{ text: "  " }]);
}

const AD_ROWS = {
  recalled: "Recalled",
  skill: "Skill suggested:",
  guard: "Guard blocked:",
  learned: "Learned:",
  loop: "Loop:",
  team: "Team:",
};

/** One dim line for something ad did (recalled memory, a skill, a guard…). */
export function renderAdRow(kind, text, { width = 80 } = {}) {
  const label = AD_ROWS[kind] ?? `${clean(kind)}:`;
  const line = truncate([{ text: "\u{2022} ", style: S.dim }, { text: `${label} `, style: { dim: true, bold: true } }, { text: clean(text).replace(/\s*\n\s*/g, " "), style: S.dim }], width);
  return [line];
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const toolArgs = (args) => {
  if (args == null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return clean(s).replace(/\s+/g, " ");
};

function toolResult(result, error) {
  if (error) return typeof error === "string" ? error : (error.message ?? JSON.stringify(error));
  if (result == null) return "";
  if (Array.isArray(result?.content)) return result.content.map((c) => (c?.type === "text" ? c.text : `[${c?.type ?? "content"}]`)).join("\n");
  return typeof result === "string" ? result : JSON.stringify(result);
}

function mdCell(text, width, { bullet = "\u{2022}", style } = {}) {
  const body = renderMarkdown(text, { width: Math.max(1, width - 2) });
  return body.map((l, i) => normalize([{ text: i === 0 ? `${bullet} ` : "  ", style: S.bullet }, ...(style ? l.map((s) => ({ ...s, style: { ...s.style, ...style } })) : l)]));
}

/** Lines for one ViewItem; a streaming item (`streaming`) says "Running", "Editing"… */
export function renderCell(item, { width = 80 } = {}) {
  const w = Math.max(4, width);
  // Count markers and the like are cut, never wrapped past the edge.
  return cellLines(item ?? {}, w).map((l) => truncate(l, w));
}

function cellLines(item, width) {
  const done = !item.streaming;
  switch (item.kind) {
    case "userMessage": {
      // A /private prompt shows as typed, marked private (the model sees the wrapper).
      const priv = /^<private>([\s\S]*)<\/private>$/.exec(String(item.text ?? ""));
      const body = [{ text: clean(priv ? priv[1] : item.text) }, ...(priv ? [{ text: "  (private)", style: S.dim }] : [])];
      return wrapPrefixed(body, width, [{ text: "\u{203a} ", style: S.user }], [{ text: "  " }]);
    }
    case "agentMessage":
      return mdCell(item.text ?? "", width);
    case "reasoning": {
      const text = item.summaryText ?? (item.summary ?? []).join("\n\n");
      return text.trim() ? capLines(mdCell(text, width, { style: S.italic }), TEXT_LINES) : [];
    }
    case "plan":
      return mdCell(item.text ?? "", width);
    case "commandExecution":
      return isExploring(item) ? renderExploring([item], { width }) : renderCommand(item, width);
    case "fileChange": {
      const changes = item.changes ?? [];
      const verb = item.incomplete ? "Not applied" : item.status === "failed" ? "Edit failed" : item.status === "declined" ? "Edit declined" : !done || item.status === "inProgress" ? "Editing" : "Edited";
      return changes.length ? renderDiff(changes, { width, verb }) : header("\u{2022}", [{ text: verb, style: S.head }], width);
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const name = item.kind === "mcpToolCall" ? `${clean(item.server)}.${clean(item.tool)}` : [item.namespace, item.tool].filter(Boolean).map(clean).join(".");
      const failed = item.status === "failed" || item.success === false;
      const verb = item.incomplete ? "Tool stopped" : item.status === "inProgress" || !done ? "Calling" : failed ? "Tool failed" : "Called";
      const out = capLines(header("\u{2022}", [{ text: verb, style: failed ? S.bad : S.head }, { text: " " }, { text: name, style: S.cmd }, { text: `(${toolArgs(item.arguments)})`, style: S.dim }], width), COMMAND_LINES);
      const res = item.kind === "mcpToolCall" ? toolResult(item.result, item.error) : "";
      if (res) out.push(...tail(res, OUTPUT_TAIL, width).map((l, i) => normalize([{ text: i === 0 ? BRANCH : INDENT, style: S.dim }, ...l])));
      if (item.progress && !done) out.push([{ text: `${BRANCH}${clean(item.progress)}`, style: S.dim }]);
      return out;
    }
    case "webSearch":
      return header("\u{2022}", [{ text: done ? "Searched" : "Searching", style: S.head }, { text: ` ${clean(item.query ?? item.action?.query ?? "the web")}` }], width);
    case "imageView":
      return header("\u{2022}", [{ text: "Viewed image", style: S.head }, { text: ` ${clean(item.path)}` }], width);
    case "imageGeneration": {
      if (item.failure) return header("\u{2022}", [{ text: "Image failed", style: S.bad }, { text: ` ${clean(typeof item.failure === "string" ? item.failure : JSON.stringify(item.failure))}` }], width);
      return header("\u{2022}", [{ text: done ? "Generated image" : "Generating image", style: S.head }, { text: item.savedPath ? ` ${clean(item.savedPath)}` : "" }], width);
    }
    case "enteredReviewMode":
      return header(">>", [{ text: "Code review started", style: S.head }, { text: item.review ? `: ${clean(item.review)}` : "" }], width);
    case "exitedReviewMode": {
      const out = header("<<", [{ text: "Code review finished", style: S.head }], width);
      if (item.review) out.push(...mdCell(String(item.review), width));
      return out;
    }
    case "contextCompaction":
      return [[{ text: "\u{2022} Context compacted", style: S.dim }]];
    case "collabAgentToolCall": {
      const n = item.receiverThreadIds?.length ?? 0;
      const label = { spawnAgent: "Spawned", sendInput: "Messaged", wait: "Waiting for", closeAgent: "Closed", resumeAgent: "Resumed" }[item.tool] ?? clean(item.tool ?? "Agent");
      const out = header("\u{2022}", [{ text: `${label} ${n === 1 ? "agent" : `${n} agents`}`, style: S.head }], width);
      if (item.prompt) out.push(...details(capLines(wrap([{ text: clean(item.prompt), style: S.dim }], Math.max(1, width - INDENT.length)), 3), width));
      return out;
    }
    case "subAgentActivity":
      return header("\u{2022}", [{ text: clean(item.agentPath ?? "agent"), style: S.cmd }, { text: ` ${clean(item.activity ?? "")}`, style: S.dim }], width);
    case "hookPrompt":
      return capLines(header("\u{2022}", [{ text: "Hook: ", style: S.dim }, { text: clean(item.text), style: S.dim }], width), 3);
    case "sleep":
      return header("\u{2022}", [{ text: done ? "Waited" : "Waiting", style: S.head }, { text: ` ${seconds(item.durationMs)}`, style: S.dim }], width);
    case "functionCallOutput":
      return capLines(header("\u{2022}", [{ text: "Tool output", style: S.head }, { text: ` ${clean(item.name ?? "")}`, style: S.cmd }], width), 1);
    default:
      return [[{ text: `\u{2022} (not shown: ${clean(item.type ?? item.kind ?? "unknown")} item)`, style: S.dim }]];
  }
}

