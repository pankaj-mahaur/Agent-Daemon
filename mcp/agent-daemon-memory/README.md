# agent-daemon-memory (MCP server)

Pull-based mid-session access to the agent-daemon episodic memory store.

Hook injection (SessionStart / UserPromptSubmit) is push-only and budget-capped
(~3 results / 2KB). This server lets the agent (Claude Code, or ad's own
harness) *query* memory when it decides it needs history — converting
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
| `memory_stats()` | the scope it is bound to, and this project's learning and fact counts | no |
| `user_facts_list()` | user profile facts observed in this project (or accepted as global) | no |
| `memory_feedback(id, verdict)` | mark a learning `useful` / `stale` / `wrong` | **yes** — `usefulness` column only |

## Which project it serves

One server process is bound to **one project**, chosen when it starts. No tool
argument changes it, so an agent (or text injected into one) can't read another
project's notes.

1. `--project <folder>` in the server's command line, else
2. `AD_MEMORY_PROJECT` (ad's own engine sets it per conversation), else
3. `CLAUDE_PROJECT_DIR`, only with `--host claude-code` (another host started from
   a Claude Code shell inherits that variable, so it doesn't count there), else
4. the server's working folder, **if it looks like a project**: inside a git repo,
   or holding a `.agent-daemon` folder.

Otherwise the server is **unbound** and every tool answers that it isn't bound to
a project: it serves nothing, not even global notes. Home, a drive root, system
folders (`C:\Windows`, `Program Files`, `/usr`, …), ad's own folders and its install
folder never count as a project.

What a bound server serves:
- the project's own notes; ids from another project return nothing, and
  `memory_feedback` on one changes nothing;
- notes accepted as global (none are, until a later release adds `ad memory promote`);
- older notes from ad 3.0 that were stored as "global" are served only in the
  project whose session wrote them;
- user facts observed in this project.

Notes an agent wrote about itself wait as **pending**, and notes the injection
screen or the secret check flagged are **held back**: neither is ever served. Two
folders whose paths map to the same memory key (`/x/a/b` and `/x/a-b`) are both
withheld until each project gets its own ID.

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

Nothing to install. Before each run ad registers this server in its engine home
(`~/.agent-daemon/engine/config.toml`, `mcp_servers.agent-daemon-memory`)
and sets `default_tools_approval_mode = "approve"`, so the agent's memory
lookups and feedback don't ask each time. If you set another approval mode for
this server yourself (anything but `auto`), ad keeps it. Unattended runs
(`ad loop`, team workers, scheduled loops) turn every other MCP server off but
keep this one. Each conversation's server is bound to that conversation's folder
(`AD_MEMORY_PROJECT`); a team worker's to the repo it was spawned from, not its
worktree.

## Install (Claude Code)

```sh
claude mcp add agent-daemon-memory -- node <repo>/runtime/src/mcp/memory-server.mjs --host claude-code
```

Or merge into `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "agent-daemon-memory": {
      "command": "node",
      "args": ["<repo>/runtime/src/mcp/memory-server.mjs", "--host", "claude-code"]
    }
  }
}
```

`--host claude-code` lets the server use `CLAUDE_PROJECT_DIR` to find the open
project. Without it (a registration made before this change), the server uses its
working folder, if that looks like a project; otherwise it is unbound. Re-run the
`claude mcp add` line above to add the flag.

`claude-code.json` in this directory carries the same snippet with a relative
path placeholder — replace `<repo>` with your clone path.

## Implementation notes

- Hand-rolled JSON-RPC 2.0 over stdio (newline-delimited) — no SDK dependency.
- Concurrent with the hook writers: better-sqlite3 + WAL handles one writer /
  many readers; the feedback write is a single-row UPDATE.
