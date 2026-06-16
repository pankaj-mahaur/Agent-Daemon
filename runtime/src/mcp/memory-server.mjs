#!/usr/bin/env node
// agent-daemon memory MCP server — pull-based mid-session retrieval.
//
// Hook injection (SessionStart / query-retrieve) is push-only and budget-
// capped (~3 results / 2KB). This stdio MCP server turns the episodic store
// into something Claude can QUERY mid-task:
//
// The 3-layer progressive-disclosure flow (cheap index → context → detail,
// modeled on claude-mem) keeps token cost low: search for compact IDs, expand
// only the few worth it.
//
//   memory_search(query, scope?, limit?)  — BM25 + freshness-ranked learnings (index)
//   memory_recent(project?, limit?)       — most recent learnings (index)
//   memory_files(path)                    — learnings touching a given file (index)
//   memory_timeline(id, limit?)           — the session + sibling learnings around a hit (context)
//   memory_get(ids)                       — full detail + provenance for kept IDs (detail)
//   memory_stats()                        — store counts + retrieval telemetry
//   user_facts_list()                     — cross-project user profile facts
//   memory_feedback(id, verdict)          — mark a learning useful|stale|wrong
//                                           (writes the usefulness signal the
//                                           consolidation ranking consumes)
//
// Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited) — no SDK dependency,
// matching the repo's no-new-deps posture. Read-only except memory_feedback
// (and memory_get's retrieval write-back). Blast radius: local read of
// ~/.agent-daemon/episodic.db; no network.
//
// Register (Claude Code):
//   claude mcp add agent-daemon-memory -- node <abs path to this file>

import readline from "node:readline";
import {
  searchLearnings,
  listRecentLearnings,
  searchLearningsByFile,
  getLearningsByIds,
  learningTimeline,
  markRetrieved,
  stats,
  projectSlug,
  db
} from "../memory/episodic.mjs";
import { neutralizeText } from "../digest/sanitize.mjs";

const MAX_RESULTS = 5;
const MAX_RESPONSE_BYTES = 4096;
// memory_get is the "detail" layer — allow a larger budget than the compact
// index tools, but still cap so a pathological row can't flood the context.
const MAX_DETAIL_BYTES = 8192;
const MAX_DETAIL_TEXT_CHARS = 1200;

const TOOLS = [
  {
    name: "memory_search",
    description: "Search the agent-daemon episodic memory (BM25 + freshness ranking) for past learnings, corrections, gotchas, and decisions. Returns compact [id …] lines — the INDEX layer. Drill in with memory_timeline(id) for context, then memory_get(ids) for full detail. Use when you need project history the current context doesn't show.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text search query" },
        scope: { type: "string", enum: ["project", "global", "any"], description: "default any" },
        limit: { type: "number", description: `max results (cap ${MAX_RESULTS})` }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_recent",
    description: "List the most recent learnings for the current project (or globally). Compact INDEX layer — pair with memory_get(ids) for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `max results (cap ${MAX_RESULTS})` }
      }
    }
  },
  {
    name: "memory_files",
    description: "Find learnings that reference a given file (by path or basename) — what was previously learned while working on it. INDEX layer; drill in with memory_get(ids).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "file path or basename, e.g. 'src/auth.ts' or 'auth.ts'" },
        scope: { type: "string", enum: ["project", "global", "any"], description: "default any" },
        limit: { type: "number", description: `max results (cap ${MAX_RESULTS})` }
      },
      required: ["path"]
    }
  },
  {
    name: "memory_timeline",
    description: "CONTEXT layer: given a learning id (from a search/recent/files result), show its originating session and the sibling learnings extracted from that same session, chronologically. Use to understand what was going on when something was learned before fetching full detail.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "learning id (shown as [id N] in index results)" },
        limit: { type: "number", description: "max sibling learnings (cap 50)" }
      },
      required: ["id"]
    }
  },
  {
    name: "memory_get",
    description: "DETAIL layer: fetch full learnings by id (un-clipped text, evidence quote, tags, confidence, and provenance — which session/date it came from). Batch all the ids you want in one call. This is the only tool that returns full bodies; the index tools stay compact on purpose.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "learning ids to expand (batch them)" }
      },
      required: ["ids"]
    }
  },
  {
    name: "memory_stats",
    description: "Row counts and retrieval telemetry for the episodic memory store.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "user_facts_list",
    description: "List active cross-project user profile facts (preferences, conventions that travel between projects).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "memory_feedback",
    description: "Record whether a retrieved learning was useful. verdict: useful | stale | wrong. Feeds ranking and consolidation.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "learning id (shown in search results)" },
        verdict: { type: "string", enum: ["useful", "stale", "wrong"] }
      },
      required: ["id", "verdict"]
    }
  }
];

function renderLearnings(rows) {
  const lines = rows.map(r =>
    `[id ${r.id}] ${r.category} (conf ${Number(r.confidence).toFixed(2)}): ${neutralizeText(r.text)}`
  );
  let out = lines.join("\n") || "(no results)";
  if (Buffer.byteLength(out, "utf8") > MAX_RESPONSE_BYTES) {
    out = out.slice(0, MAX_RESPONSE_BYTES) + "…";
  }
  return out;
}

/** Parse the JSON tags column into a clean string[] (best-effort). */
function parseTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr.filter(t => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** DETAIL render — full body + provenance for memory_get. */
function renderDetailed(rows) {
  if (!rows.length) return "(no learnings found for those ids)";
  const blocks = rows.map(r => {
    const lines = [
      `[id ${r.id}] ${r.category} (conf ${Number(r.confidence).toFixed(2)}, seen ${r.observed_count ?? 1}×, retrieved ${r.retrieval_count ?? 0}×)`,
      neutralizeText(r.text, { maxChars: MAX_DETAIL_TEXT_CHARS })
    ];
    if (r.evidence) lines.push(`evidence: ${neutralizeText(r.evidence, { maxChars: 400 })}`);
    const tags = parseTags(r.tags);
    if (tags.length) lines.push(`tags: ${tags.map(t => neutralizeText(t, { maxChars: 80 })).join(", ")}`);
    const prov = r.session_id
      ? `from session ${r.session_id} on ${r.created_at}${r.project_slug ? ` (project ${r.project_slug})` : ""}`
      : `recorded ${r.created_at}${r.project_slug ? ` (project ${r.project_slug})` : ""}`;
    lines.push(prov);
    return lines.join("\n");
  });
  let out = blocks.join("\n\n");
  if (Buffer.byteLength(out, "utf8") > MAX_DETAIL_BYTES) {
    out = out.slice(0, MAX_DETAIL_BYTES) + "…";
  }
  return out;
}

/** CONTEXT render — session header + neighbor index lines for memory_timeline. */
function renderTimeline(tl) {
  if (!tl) return "(no learning with that id)";
  const head = `[id ${tl.learning.id}] ${tl.learning.category} (conf ${Number(tl.learning.confidence).toFixed(2)}): ${neutralizeText(tl.learning.text)}`;
  const sessLine = tl.session
    ? `session ${tl.session.id} — ${tl.session.started_at || "?"} → ${tl.session.ended_at || "?"} [${tl.session.digest_status}]${tl.session.project_slug ? ` (${tl.session.project_slug})` : ""}`
    : (tl.learning.session_id ? `session ${tl.learning.session_id} (no session row)` : "(no originating session recorded)");
  const neighbors = (tl.neighbors || []).length
    ? tl.neighbors.map(n => `  [id ${n.id}] ${n.category} (conf ${Number(n.confidence).toFixed(2)}): ${neutralizeText(n.text)}`).join("\n")
    : "  (no sibling learnings from this session)";
  let out = `${head}\n${sessLine}\nsame-session learnings:\n${neighbors}`;
  if (Buffer.byteLength(out, "utf8") > MAX_DETAIL_BYTES) {
    out = out.slice(0, MAX_DETAIL_BYTES) + "…";
  }
  return out;
}

async function callTool(name, args) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  switch (name) {
    case "memory_search": {
      const rows = await searchLearnings(String(args.query || ""), {
        projectSlug: projectSlug(cwd),
        scope: args.scope || "any",
        limit: Math.min(MAX_RESULTS, args.limit || MAX_RESULTS)
      });
      return renderLearnings(rows);
    }
    case "memory_recent": {
      const rows = await listRecentLearnings({
        projectSlug: projectSlug(cwd),
        limit: Math.min(MAX_RESULTS, args.limit || MAX_RESULTS)
      });
      return renderLearnings(rows);
    }
    case "memory_files": {
      const rows = await searchLearningsByFile(String(args.path || ""), {
        projectSlug: projectSlug(cwd),
        scope: args.scope || "any",
        limit: Math.min(MAX_RESULTS, args.limit || MAX_RESULTS)
      });
      return renderLearnings(rows);
    }
    case "memory_timeline": {
      const tl = await learningTimeline(args.id, { limit: args.limit });
      return renderTimeline(tl);
    }
    case "memory_get": {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      const rows = await getLearningsByIds(ids);
      // Retrieval write-back: expanding a learning is a real "this was useful
      // enough to read in full" signal — feeds freshness-aware ranking.
      if (rows.length) {
        try { await markRetrieved(rows.map(r => r.id)); } catch { /* best-effort */ }
      }
      return renderDetailed(rows);
    }
    case "memory_stats": {
      const s = await stats();
      if (!s.driver) return "episodic store unavailable (better-sqlite3 not installed)";
      const counts = Object.entries(s.counts).map(([t, n]) => `${t}: ${n}`).join(", ");
      const ret = s.retrieval
        ? ` | retrieval 7d: ${s.retrieval.events} events, ${(s.retrieval.truncationRate * 100).toFixed(0)}% truncated`
        : "";
      return `${counts}${ret}`;
    }
    case "user_facts_list": {
      const handle = await db();
      if (!handle) return "episodic store unavailable";
      const rows = handle.all(
        `SELECT id, category, text, confidence, observed_count
           FROM user_facts WHERE status = 'active'
          ORDER BY confidence DESC, observed_count DESC LIMIT 20`
      );
      return rows.length
        ? rows.map(r => `[fact ${r.id}] ${r.category} (conf ${Number(r.confidence).toFixed(2)}, seen ${r.observed_count}×): ${neutralizeText(r.text)}`).join("\n")
        : "(no user facts recorded yet)";
    }
    case "memory_feedback": {
      const handle = await db();
      if (!handle) return "episodic store unavailable";
      const id = Number(args.id);
      const verdict = String(args.verdict);
      if (!Number.isInteger(id) || !["useful", "stale", "wrong"].includes(verdict)) {
        throw new Error("memory_feedback requires an integer id and verdict useful|stale|wrong");
      }
      // usefulness is a running average in [-1, 1]: useful=+1, stale=-0.5, wrong=-1
      const delta = verdict === "useful" ? 1 : verdict === "stale" ? -0.5 : -1;
      const r = handle.run(
        `UPDATE learnings
            SET usefulness = COALESCE((COALESCE(usefulness, 0) + ?) / 2.0, ?),
                last_verified_at = CASE WHEN ? > 0 THEN ? ELSE last_verified_at END
          WHERE id = ?`,
        [delta, delta, delta, new Date().toISOString(), id]
      );
      return r.changes > 0 ? `recorded: learning ${id} → ${verdict}` : `no learning with id ${id}`;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0 over stdio                                             */
/* ------------------------------------------------------------------ */

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-daemon-memory", version: "1.1.0" }
        });
        break;
      case "notifications/initialized":
        break;  // notification — no response
      case "tools/list":
        reply(id, { tools: TOOLS });
        break;
      case "tools/call": {
        const text = await callTool(params.name, params.arguments || {});
        reply(id, { content: [{ type: "text", text }] });
        break;
      }
      case "ping":
        reply(id, {});
        break;
      default:
        if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (id !== undefined) replyError(id, -32000, err.message);
  }
});

rl.on("close", () => process.exit(0));
