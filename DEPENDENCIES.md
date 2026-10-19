# Dependencies

Most skills have zero external dependencies. Two skills require specific tools:

| Skill | Required | Install Command |
|-------|----------|-----------------|
| diagnose-fetch-failure | None | — |
| graphify | Python 3.9+ | `pip install graphifyy` |
| qmd | Node.js 18+ | `npm install -g @tobilu/qmd` |
| seed-data | None | — |
| review-slice | None | — |
| merge-feature-branch | None | — |
| security-audit | None | — |
| production-readiness | None | — |
| optimization-audit | None | — |
| dead-code-review | None | — |
| docs-sync-audit | None | — |

## The memory installer

The `agent-daemon-memory` package (and `ad memory install`) depends on two parsers, pinned exactly, with no dependencies of their own and no install scripts:

| Package | Version | Why |
|---|---|---|
| `jsonc-parser` | 3.3.1 | edits Cursor's `mcp.json` in place, keeping comments and formatting |
| `smol-toml` | 1.9.0 | parses Codex's `config.toml` to refuse an existing entry in any shape and to check every edit |

Memory itself runs on Node's built-in `node:sqlite` (Node 22.13+) in the package, and on `better-sqlite3` in the full runtime; `AD_SQLITE_DRIVER=node:sqlite|better-sqlite3` picks one.

## Notes

- **graphify** uses the Python package `graphifyy` (note the double y). It requires Python 3.9 or later and installs NetworkX, graspologic, and other graph analysis libraries.
- **qmd** is a Node.js CLI and MCP server for searching markdown files. After installing, index your markdown with `qmd collection add ~/path/to/docs --name myname && qmd embed`.
- All other skills are pure markdown instructions with no runtime dependencies.
