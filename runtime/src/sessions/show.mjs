// `ad sessions show [<id> | --last] [--json]` (P4.1): one logical session from its ledger,
// read-only. Bindings (which home, thread and target ran), turns (who started them, how
// they ended) and each turn's tool calls with their effect and status.

import { adRoot } from "../ad-root.mjs";
import { readLedger } from "./ledger.mjs";
import { readIndex } from "./index.mjs";

export const SESSIONS_USAGE = "Usage: ad sessions show [<session-id> | --last] [--json]";

/** The session's record as one object (what --json prints). */
export function summarizeSession(sessionId, { root = adRoot() } = {}) {
  const meta = readIndex({ root }).sessions[sessionId] ?? null;
  const events = readLedger(sessionId, { root });
  if (!events.length && !meta) return null;
  const created = events.find((e) => e.type === "created");
  const bindings = [];
  const turns = new Map();
  const tools = new Map();
  const violations = [];
  let gen = 0;
  for (const e of events) {
    // Compaction keeps every binding event, so a snapshot's own list isn't needed here.
    if (e.type === "bindingStarted") {
      gen = e.binding?.gen ?? e.gen ?? gen + 1;
      bindings.push({ gen, home: e.binding?.home ?? null, threadId: e.binding?.threadId ?? null, how: e.binding?.how ?? null, target: e.binding?.target ?? null, startedAt: e.at, endedAt: null, endReason: null });
    } else if (e.type === "bindingEnded") {
      const b = bindings.findLast((x) => x.gen === e.gen);
      if (b) Object.assign(b, { endedAt: e.at, endReason: e.reason ?? null });
    } else if (e.type === "turnStarted") turns.set(e.turnId, { turnId: e.turnId, gen, trigger: e.trigger ?? null, ...(e.thread ? { thread: e.thread, parentTurnId: e.parentTurnId ?? null } : {}), startedAt: e.at, status: "running", tools: [] });
    else if (e.type === "turnCompleted") {
      const t = turns.get(e.turnId);
      if (t) Object.assign(t, { status: e.status ?? "completed", endedAt: e.at, ...(e.error ? { error: e.error.message ?? null } : {}) });
    } else if (e.type === "toolIntent") {
      const tool = { key: e.key, kind: e.kind ?? null, effect: e.effect ?? null, summary: e.summary ?? "", ...(e.paths ? { paths: e.paths } : {}), ...(e.background ? { background: true } : {}), status: "running" };
      tools.set(e.key, tool);
      turns.get(e.turnId)?.tools.push(tool);
    } else if (e.type === "toolResult") {
      const tool = tools.get(e.key);
      if (tool) Object.assign(tool, { status: e.status, ...(Number.isInteger(e.exitCode) ? { exitCode: e.exitCode } : {}) });
    } else if (e.type === "violation") violations.push({ gen: e.gen, threadId: e.threadId, turnId: e.turnId });
  }
  return {
    sessionId,
    title: meta?.title ?? null,
    cwd: created?.cwd ?? meta?.cwd ?? null,
    origin: created?.origin ?? meta?.origin ?? null,
    ...(created?.adoptedFrom ? { adoptedFrom: created.adoptedFrom } : {}),
    state: meta?.state ?? null,
    createdAt: created?.at ?? meta?.createdAt ?? null,
    bindings,
    turns: [...turns.values()],
    ...(violations.length ? { violations } : {}),
  };
}

const targetText = (t) => (t ? [t.provider, t.model, t.effort].filter(Boolean).join(" ") || t.key : "(unknown target)");

// Recorded text (a command line, a title) never reaches the terminal as control characters.
const plain = (v) => String(v ?? "").replace(/\p{Cc}/gu, " ");

export function renderSession(s) {
  return renderLines(s).map(plain).join("\n");
}

function renderLines(s) {
  const lines = [`${s.sessionId}${s.title ? `  ${s.title}` : ""}`, `  ${s.origin ?? "?"} · ${s.state ?? "?"} · ${s.cwd ?? ""}`];
  for (const b of s.bindings) lines.push(`  binding ${b.gen}  ${targetText(b.target)} · ${b.home ?? "?"} · thread ${b.threadId ?? "?"}${b.how ? ` (${b.how})` : ""}${b.endReason ? ` · ended: ${b.endReason}` : ""}`);
  for (const t of s.turns) {
    lines.push(`  turn ${t.turnId}  ${t.trigger ?? "?"} · ${t.status}${t.thread ? ` · subagent ${t.thread}` : ""}${t.error ? ` · ${t.error}` : ""}`);
    for (const tool of t.tools) lines.push(`    ${tool.effect ?? "?"}  ${tool.status}  ${tool.summary}`);
  }
  for (const v of s.violations ?? []) lines.push(`  ! turn ${v.turnId} ran on thread ${v.threadId}, which binding ${v.gen} no longer owns`);
  return lines;
}

/** The newest session (by its last update), or null. */
export function lastSessionId({ root = adRoot() } = {}) {
  const all = Object.entries(readIndex({ root }).sessions);
  all.sort((a, b) => String(b[1].updatedAt ?? "").localeCompare(String(a[1].updatedAt ?? "")));
  return all[0]?.[0] ?? null;
}

export async function cmdSessions(sub, { id, last = false, json = false, root = adRoot(), stdout = process.stdout, stderr = process.stderr } = {}) {
  if (sub !== "show") {
    stderr.write(`${SESSIONS_USAGE}\n`);
    return 2;
  }
  if (id && !/^ses_[0-9A-Za-z]{10,40}$/.test(id)) {
    stderr.write(`ad sessions: "${id}" isn't a session id (ses_…).\n`);
    return 2;
  }
  const sessionId = id ?? (last || !id ? lastSessionId({ root }) : null);
  if (!sessionId) {
    stderr.write("ad sessions: no sessions recorded yet.\n");
    return 1;
  }
  const s = summarizeSession(sessionId, { root });
  if (!s) {
    stderr.write(`ad sessions: no session ${sessionId}.\n`);
    return 1;
  }
  stdout.write(json ? `${JSON.stringify(s, null, 2)}\n` : `${renderSession(s)}\n`);
  return 0;
}
