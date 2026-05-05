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

## Status

Scaffolded — content coming in subsequent passes. Initial candidates:

- `repomix` — pack a codebase into AI-readable XML for review
- `qmd` — search local markdown knowledge bases (BM25 + vector)
- `filesystem` — sandboxed file ops with allowlist
- `postgres` — run read-only SQL against a Postgres instance
- `github` — issue / PR / release access via GitHub API

## Install (when content lands)

```bash
# Bash
./setup.sh --mcp repomix,qmd

# PowerShell
./setup.ps1 -Mcp "repomix,qmd"
```

The installer will append the server entry to your global Claude Code `settings.json` (or print the snippet for manual paste if you prefer that flow).
