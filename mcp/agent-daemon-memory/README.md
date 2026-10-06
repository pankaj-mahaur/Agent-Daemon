# agent-daemon-memory (MCP server)

Pull-based mid-session access to the agent-daemon episodic memory store.

Hook injection (SessionStart / UserPromptSubmit) is push-only and budget-capped
(~3 results / 2KB). This server lets the agent (Claude Code, or ad's own
harness on Codex) *query* memory when it decides it needs history — converting
the episodic store from a 2KB drip into an on-demand database.

## Tools

Three-layer **progressive disclosure** (index → context → detail) keeps token cost
low: search for compact ids, then expand only the few worth reading in full.

| Tool | Effect | Writes? |
|---|---|---|
| `memory_search(query, scope?, limit?)` | **index** — BM25 + freshness-ranked learnings (≤5 results, ≤4KB) | no |
| `memory_recent(limit?)` | **index** — most recent learnings for the current project | no |
| `memory_files(path, scope?, limit?)` | **index** — learnings tagged with a given file (path or basename) | no |
| `memory_timeline(id, limit?)` | **context** — the originating session + sibling learnings around a hit | no |
| `memory_get(ids)` | **detail** — full text + evidence + provenance + derivation tier for the given ids (≤8KB) | **yes** — retrieval write-back (`retrieval_count`, `last_retrieved_at`) |
| `memory_profile()` | deterministic "how this user works" rollup (identity / prefers / tools / conventions / watch-out) from user facts + stated learnings — the no-LLM analog of a user model | no |
| `memory_stats()` | row counts + retrieval telemetry | no |
| `user_facts_list()` | active cross-project user profile facts | no |
| `memory_feedback(id, verdict)` | mark a learning `useful` / `stale` / `wrong` | **yes** — `usefulness` column only |

## Security blast radius

- Reads `~/.agent-daemon/episodic.db` (local SQLite). No network access.
- Two narrow write surfaces, neither of which can insert, delete, or alter
  memory text: `memory_feedback` updates one numeric column (`usefulness`) +
  `last_verified_at`; `memory_get` bumps retrieval counters
  (`retrieval_count`, `last_retrieved_at`) on the rows it returns.
- All returned learning text passes the daemon's `neutralizeText` injection
  guard before reaching the model.
- In ad's own harness the tools run **without an approval prompt** (see below),
  because the blast radius is this narrow.

## In ad's own harness (`ad`, `ad tui`, `ad chat`, `ad run`, `ad loop`)

Nothing to install. Before each run ad registers this server in its Codex home
(`~/.agent-daemon/codex-home/config.toml`, `mcp_servers.agent-daemon-memory`)
and sets `default_tools_approval_mode = "approve"`, so the agent's memory
lookups and feedback don't ask each time. If you set another approval mode for
this server yourself (anything but `auto`), ad keeps it. Unattended runs
(`ad loop`, team workers, scheduled loops) turn every other MCP server off but
keep this one.

## Install (Claude Code)

```sh
claude mcp add agent-daemon-memory -- node <repo>/runtime/src/mcp/memory-server.mjs
```

Or merge into `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "agent-daemon-memory": {
      "command": "node",
      "args": ["<repo>/runtime/src/mcp/memory-server.mjs"]
    }
  }
}
```

`claude-code.json` in this directory carries the same snippet with a relative
path placeholder — replace `<repo>` with your clone path.

## Implementation notes

- Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited) — no SDK dependency.
- Concurrent with the hook writers: better-sqlite3 + WAL handles one writer /
  many readers; the feedback write is a single-row UPDATE.
