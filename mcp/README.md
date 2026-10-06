# MCP servers

Curated Model Context Protocol (MCP) server configs and setup scripts.

MCP servers extend an AI agent with **new tools** — the agent can call them like built-in functions. Examples: query a database, search a knowledge base, fetch a webpage, run a sandboxed shell.

## What goes here

Each MCP server lives in its own folder:

```
mcp/<server-name>/
├── README.md           # what it does, install steps, env vars needed
├── claude-code.json    # Claude Code settings.json snippet
├── claude-desktop.json # Claude Desktop config snippet (optional)
├── cursor.json         # Cursor MCP snippet (optional)
└── setup.sh / setup.ps1  # any required setup (e.g. `npm install -g X`)
```

## Conventions

- **Folder name = server identifier.** kebab-case, no version suffix.
- **README states clearly:**
  - What tools the server exposes (one-line each)
  - Required env vars and where to get them
  - Whether it has filesystem / network / shell access (security blast radius)
  - Which agents/clients it has been verified with
- **Config snippets are real, copy-pasteable JSON** — not pseudocode.
- **No hardcoded secrets.** Use `${VAR_NAME}` placeholders and document the required env vars.

## Servers

| Server | What it does |
|---|---|
| [`agent-daemon-memory`](agent-daemon-memory/README.md) | Pull-based access to agent-daemon's own memory store (search, recent, timeline, detail, profile, feedback). In ad's own harness it is registered automatically; for Claude Code, add it with `claude mcp add` (see its README). |

Candidates for later: `repomix` (pack a codebase for review), `qmd` (search local markdown), `filesystem` (sandboxed file ops), `postgres` (read-only SQL), `github` (issues, PRs, releases).

## Install

Each server's README has the exact install line. `./setup.sh --mcp <name>` (`./setup.ps1 -Mcp "<name>"`) prints that server's install hint; it doesn't change any settings file.
