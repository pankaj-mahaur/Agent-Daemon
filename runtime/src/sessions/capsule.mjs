// The continuation capsule (P4.2): the history a conversation carries to a new thread on
// another provider or home, built from what the user saw (the session's items), never from
// the engine's raw history. Pure.
//
//   buildCapsule({ turns, goal, git, checkpoint, permissions, terminals, from, cwd, mode, budgetChars })
//     → { items, meta: { turns, leftOut, toolCalls, callIdMap? } }   items for thread/inject_items
//   buildNote(same)   the note alone (a fork keeps its history; it still learns what runs)
//   remapCallIds(items)   ad's own call ids (c + 8 base-36 digits), the same for both halves
//
// turns: [{ id, status, items: [ViewItem] }] (the session's normalized items: kind, text,
// command, exitCode, status, output, changes, source…). terminals: the live background
// terminals [{ command, startedAt, itemId }]. mode: "messages" (default) | "transcript" |
// "structured" (only when the target's catalog entry says structuredHistory).
//
// Never carried (D11): reasoning in any form, thinking signatures, ad's bridged envelopes,
// tool search, response and approval ids, hook prompts and items ad doesn't know.

import { redact } from "../auth/redact.mjs";

const OUTPUT_TAIL = 2048;
const OBJECTIVE_CAP = 500;
const DEFAULT_BUDGET = 4 * 0.5 * 64_000;
// ad's own bridged and sealed envelopes: opaque to any other provider.
const ENVELOPES = /\b(?:adbr1|adg1)\.[A-Za-z0-9_.~-]+/g;

const clean = (s) => redact(String(s ?? "")).replace(ENVELOPES, "");
const tail = (s) => {
  const t = String(s ?? "");
  return t.length > OUTPUT_TAIL ? `…${t.slice(-OUTPUT_TAIL)}` : t;
};
const cmdText = (c) => (Array.isArray(c) ? c.join(" ") : String(c ?? ""));

function diffCounts(diff) {
  let add = 0;
  let del = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}

function firstPrompt(turns) {
  for (const t of turns) for (const i of t.items ?? []) if (i?.kind === "userMessage" && String(i.text ?? "").trim()) return String(i.text);
  return null;
}

function noteText({ from, goal, turns = [], cwd, git, checkpoint, permissions, terminals = [] }) {
  const lines = [
    `This conversation continues work started with ${from?.label ?? "another model"}. What follows is the history so far, not new input.`,
    `Tool calls marked "done" already ran: don't run them again unless the user asks. Files on disk already have the earlier edits.`,
  ];
  if (terminals.length) {
    lines.push("Still running from before the switch (ad keeps them; you can't send them input; don't start them again):");
    for (const t of terminals) lines.push(`  $ ${clean(cmdText(t.command))}${t.startedAt ? `  (started ${t.startedAt})` : ""}`);
  }
  const objective = goal?.objective ?? firstPrompt(turns);
  if (objective) lines.push(`Objective: ${clean(objective).replace(/\s+/g, " ").trim().slice(0, OBJECTIVE_CAP)}`);
  const ws = [cwd ?? "."];
  if (git?.branch) ws.push(`git ${git.branch}`);
  if (git && Number.isInteger(git.files)) ws.push(`${git.files} file${git.files === 1 ? "" : "s"} changed (+${git.added ?? 0} −${git.deleted ?? 0})`);
  ws.push(`checkpoint ${checkpoint ?? "none"}`);
  lines.push(`Workspace: ${ws.join(" · ")}`);
  if (permissions) lines.push(`Permissions: ${permissions.sandbox ?? "?"} · ${permissions.approvalPolicy ?? "?"}`);
  return lines.join("\n");
}

const developer = (text) => ({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
const userMsg = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantMsg = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

export function buildNote(o) {
  return developer(noteText(o));
}

// One tool item as the line the new model reads, or null (not a tool).
function toolLine(i, live) {
  const stillRunning = i.status === "inProgress" && (live.has(i.id) || i.source === "unifiedExecStartup");
  const tag = i.status === "declined" ? "declined" : i.status === "inProgress" ? (stillRunning ? "still running" : "may not have finished") : i.status === "failed" ? "failed" : "done";
  switch (i.kind) {
    case "commandExecution": {
      const head = `[${tag}] $ ${clean(cmdText(i.command))}`;
      if (tag !== "done" && tag !== "failed") return head;
      const out = String(i.output ?? "").trim();
      return `${head} → exit ${i.exitCode ?? "?"}${out ? `\n${clean(tail(out))}` : ""}`;
    }
    case "fileChange":
      return (i.changes ?? []).map((c) => {
        const { add, del } = diffCounts(c.diff);
        const verb = c.kind === "add" ? "add" : c.kind === "delete" ? "delete" : "edit";
        return `[${tag}] ${verb} ${clean(c.path)} (+${add} −${del})`;
      }).join("\n") || `[${tag}] edit (no files)`;
    case "mcpToolCall":
      return `[${tag}] ${clean(i.server ?? "mcp")}.${clean(i.tool ?? "tool")}`;
    case "dynamicToolCall":
      return `[${tag}] ${clean(i.tool ?? "tool")}`;
    case "collabAgentToolCall":
      return `[${tag}] subagent ${clean(i.tool ?? "")}${i.prompt ? `: ${clean(i.prompt).slice(0, 200)}` : ""}`;
    case "webSearch":
      return `[${tag}] web search: ${clean(i.query ?? "")}`;
    case "imageGeneration":
      return `[${tag}] image${i.savedPath ? ` ${clean(i.savedPath)}` : ""}`;
    default:
      return null;
  }
}

const TOOL_KINDS = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageGeneration"]);

// A turn as { user: [text], parts: [{ kind: "text"|"tool", text, item }] }.
function renderTurn(t, live, last = false) {
  const user = [];
  const parts = [];
  for (const i of t.items ?? []) {
    if (!i) continue;
    if (i.kind === "userMessage") user.push(clean(i.text));
    else if (i.kind === "agentMessage" && String(i.text ?? "").trim()) parts.push({ kind: "text", text: clean(i.text) });
    else if (i.kind === "plan" && String(i.text ?? "").trim()) parts.push({ kind: "text", text: `Plan:\n${clean(i.text)}` });
    else if (i.kind === "contextCompaction") parts.push({ kind: "text", text: "(earlier history was compacted)" });
    else if (TOOL_KINDS.has(i.kind)) {
      const line = toolLine(i, live);
      if (line) parts.push({ kind: "tool", text: line, item: i });
    }
    // reasoning, hookPrompt, functionCallOutput, unknown…: never carried
  }
  if (last && (t.status === "interrupted" || t.status === "inProgress")) parts.push({ kind: "text", text: "(this answer was cut off by the switch)" });
  return { user, parts, tools: parts.filter((p) => p.kind === "tool").length };
}

function messagesFor(r) {
  const out = r.user.filter(Boolean).map(userMsg);
  const body = r.parts.map((p) => p.text).join("\n");
  if (body) out.push(assistantMsg(body));
  return out;
}

function transcriptFor(r) {
  const lines = r.user.filter(Boolean).map((u) => `User: ${u}`);
  for (const p of r.parts) lines.push(p.kind === "text" ? `Assistant: ${p.text}` : p.text);
  return lines.join("\n");
}

function structuredFor(r) {
  const out = r.user.filter(Boolean).map(userMsg);
  const text = [];
  for (const p of r.parts) {
    if (p.kind === "tool" && p.item.kind === "commandExecution" && p.item.status !== "inProgress" && p.item.status !== "declined") {
      if (text.length) out.push(assistantMsg(text.splice(0).join("\n")));
      out.push({ type: "function_call", call_id: p.item.id ?? `x${out.length}`, name: "exec_command", arguments: JSON.stringify({ cmd: clean(cmdText(p.item.command)) }) });
      out.push({ type: "function_call_output", call_id: p.item.id ?? `x${out.length - 1}`, output: `exit ${p.item.exitCode ?? "?"}\n${clean(tail(p.item.output))}` });
    } else text.push(p.text);
  }
  if (text.length) out.push(assistantMsg(text.join("\n")));
  return out;
}

const size = (items) => JSON.stringify(items).length;

export function buildCapsule({ turns = [], mode = "messages", budgetChars = DEFAULT_BUDGET, terminals = [], ...rest } = {}) {
  const live = new Set(terminals.map((t) => t.itemId).filter(Boolean));
  const note = buildNote({ turns, terminals, ...rest });
  const rendered = turns.map((t, i) => renderTurn(t, live, i === turns.length - 1));
  const toolCalls = rendered.reduce((n, r) => n + r.tools, 0);
  const itemsOf = (r) => (mode === "structured" ? structuredFor(r) : mode === "transcript" ? [] : messagesFor(r));

  // The newest turns that fit, after the note and the first turn.
  const keep = new Set(rendered.length ? [0] : []);
  let used = size([note]) + (rendered.length ? size(itemsOf(rendered[0])) + (mode === "transcript" ? transcriptFor(rendered[0]).length : 0) : 0);
  for (let i = rendered.length - 1; i > 0; i--) {
    const cost = mode === "transcript" ? transcriptFor(rendered[i]).length + 8 : size(itemsOf(rendered[i]));
    if (used + cost > budgetChars) break;
    keep.add(i);
    used += cost;
  }
  const left = rendered.map((_, i) => i).filter((i) => !keep.has(i));
  const gap = left.length
    ? `(turns ${left[0] + 1}–${left.at(-1) + 1} left out: ${left.reduce((n, i) => n + rendered[i].user.length, 0)} prompts, ${left.reduce((n, i) => n + rendered[i].tools, 0)} tool calls; they're in the previous conversation)`
    : null;

  let items;
  if (mode === "transcript") {
    const blocks = [];
    for (let i = 0; i < rendered.length; i++) {
      if (keep.has(i)) blocks.push(transcriptFor(rendered[i]));
      else if (i === left[0]) blocks.push(gap);
    }
    items = [note, developer(blocks.filter(Boolean).join("\n\n"))];
  } else {
    items = [note];
    for (let i = 0; i < rendered.length; i++) {
      if (keep.has(i)) items.push(...itemsOf(rendered[i]));
      else if (i === left[0]) items.push(developer(gap));
    }
  }
  const meta = { turns: rendered.length, leftOut: left.length, toolCalls };
  if (mode === "structured") {
    const r = remapCallIds(items);
    items = r.items;
    meta.callIdMap = r.map;
  }
  return { items, meta };
}

export function remapCallIds(items) {
  const map = {};
  let n = 0;
  const idFor = (old) => (map[old] ??= `c${(n++).toString(36).padStart(8, "0")}`);
  return { items: items.map((i) => (i && typeof i.call_id === "string" ? { ...i, call_id: idFor(i.call_id) } : i)), map };
}
