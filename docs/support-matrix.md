# Support matrix: where ad's memory is known to work

This page is the evidence behind every host named in a listing or in
marketing copy. `runtime/scripts/render-copy.mjs` names only the hosts with
at least one route **tested live**: a real copy of the host started ad's
memory server and its tools answered. A test against a fake host, or a
package that builds and validates, is **built**, not tested live.

One host per row; Status is `tested live` or `built` (anything else fails the
listing build). To move a row to tested live, record the acceptance check (host and version, OS,
route, install command, tools visible, project bound, capture path, a recall
check, the date) and link it in the Evidence column.

## Hosts

| Host | Route | Status | Evidence |
|---|---|---|---|
| Codex | installer | tested live | CI: `runtime/test/memory-host-codex.test.mjs` starts the real Codex binary on the installed entry and calls its tools, with a mock model (release gate b), three OSes, on every PR |
| Claude Code | installer | built | `runtime/test/memory-install.test.mjs` against a fake `claude`; owner acceptance pending |
| Claude Code | plugin | built | `runtime/test/host-packages.test.mjs`; owner acceptance pending |
| Cursor | installer | built | `runtime/test/memory-install.test.mjs`, install matrix; owner acceptance pending |
| Cursor | plugin | built | `runtime/test/host-packages.test.mjs`; owner acceptance pending |
| VS Code (Copilot) | installer | built | `runtime/test/memory-install.test.mjs`, install matrix; owner acceptance pending |
| VS Code (Copilot) | Agent Plugins | built | `runtime/test/host-packages.test.mjs` (unbound by design: see docs/memory/hosts.md) |
| Kiro | Agent Plugins | built | `runtime/test/host-packages.test.mjs` (unbound by design) |
| OpenHands | Agent Plugins | built | `runtime/test/host-packages.test.mjs` (unbound by design) |
| Gemini CLI | installer | built | `runtime/test/memory-install.test.mjs`, install matrix; owner acceptance pending |
| Gemini CLI | extension | built | `runtime/test/host-packages.test.mjs`; owner acceptance pending |

## Operating systems and Node

The memory server needs Node 22.16 or newer (built-in SQLite with full-text
search). CI runs the memory tests on Windows, macOS and Linux with Node 22.16
and 24.
