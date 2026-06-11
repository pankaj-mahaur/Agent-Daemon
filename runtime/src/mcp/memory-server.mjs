#!/usr/bin/env node
// agent-daemon memory MCP server — pull-based mid-session retrieval.
//
// Hook injection (SessionStart / query-retrieve) is push-only and budget-
// capped (~3 results / 2KB). This stdio MCP server turns the episodic store
// into something Claude can QUERY mid-task:
//
//   memory_search(query, scope?, limit?)  — BM25 + freshness-ranked learnings
//   memory_recent(project?, limit?)       — most recent learnings
//   memory_stats()                        — store counts + retrieval telemetry
//   user_facts_list()                     — cross-project user profile facts
//   memory_feedback(id, verdict)          — mark a learning useful|stale|wrong
//                                           (writes the usefulness signal the
//                                           consolidation ranking consumes)
//
// Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited) — no SDK dependency,
// matching the repo's no-new-deps posture. Read-only except memory_feedback.
// Blast radius: local read of ~/.agent-daemon/episodic.db; no network.
//
// Register (Claude Code):
//   claude mcp add agent-daemon-memory -- node <abs path to this file>

import readline from "node:readline";
import {
  searchLearnings,
  listRecentLearnings,
  stats,
  projectSlug,
  db
} from "../memory/episodic.mjs";
import { neutralizeText } from "../digest/sanitize.mjs";

const MAX_RESULTS = 5;
const MAX_RESPONSE_BYTES = 4096;

const TOOLS = [
  {
    name: "memory_search",
    description: "Search the agent-daemon episodic memory (BM25 + freshness ranking) for past learnings, corrections, gotchas, and decisions. Use when you need project history the current context doesn't show.",
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
    description: "List the most recent learnings for the current project (or globally).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: `max results (cap ${MAX_RESULTS})` }
      }
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
          serverInfo: { name: "agent-daemon-memory", version: "1.0.0" }
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
