# Security model

agent-daemon runs as **opt-in tooling around your AI coding agent**. It doesn't process untrusted user input directly — it processes JSON that Claude Code / Codex / Cursor hands to it about tool calls the agent is about to make. This document explains the threat model, the design choices behind it, and how to report a vulnerability.

## Threat model

| Asset | Threats considered | Treatment |
|---|---|---|
| The agent's tool execution flow | Hook crashes blocking the user's work | **Fail-safe to approve** — see below |
| `~/.claude/settings.json` | Concurrent writes corrupting JSON | `ad init` reads → mutates in memory → atomic write |
| `~/.agent-daemon/audit/mcp.jsonl` | Unbounded growth, log injection | Size-based rotation (10 MB × 3 generations); fields are JSON-escaped |
| `~/.agent-daemon/episodic.db` (SQLite) | Local-only, user-owned. Not network-exposed. | Standard `better-sqlite3` defaults; rows are agent-emitted, not user-controlled |
| Vendored upstream content | Code-injection if upstream is compromised | Vendored snapshot is **gitignored** (only `MANIFEST.md` + `fetch.mjs` tracked); commit SHA is pinned |
| MCP audit trail | Tampering / repudiation | Append-only writes; rotation rather than truncation; no remote log shipping (yet) |

What's **not** in scope:

- Sandboxing the AI agent itself — that's Claude Code / Codex / Cursor's job.
- Hardening user-supplied skill content — skills are markdown text loaded into the agent's prompt, treated like documentation.
- Protecting against a compromised `node`/`git`/`gh` binary on PATH.
- Multi-tenant isolation — agent-daemon is a single-user tool.

## The fail-safe-to-approve decision

Every hook handler under [runtime/src/hooks/](runtime/src/hooks/) **never blocks the agent's tool call because of its own bug**. When stdin is malformed, the file doesn't exist, or the handler throws unexpectedly, the result is `{"decision":"approve"}` (PreToolUse) or `{}` passthrough (PostToolUse). The agent's tool runs as normal.

**Why:** a daemon bug that blocked legitimate tool calls would be a worse failure mode than the bug it was trying to catch. Users would disable the hook entirely on the first false positive, losing the real protection it provides on well-formed input.

**Trade-off:** an adversary who could feed crafted JSON to our hook stdin could bypass the block. But the JSON comes from the host harness (Claude Code / Cursor / Codex), not from user input — so this requires either compromising the host or running on the user's local machine. Both scenarios are out of scope; if either holds, the attacker already has more direct paths to harm.

**What we still catch on adversarial input** (the cases the hook is designed for, not the cases the hook isn't designed to defend against):

- `git commit --no-verify` / `git push --no-verify` — blocked. The pattern matches the literal substring even inside semicolon-joined / backgrounded variants.
- `npm run dev` / `pnpm dev` / `yarn dev` outside tmux on Linux/macOS — blocked.
- MCP calls to non-trusted servers — warned (not blocked) and audit-logged. The trusted list is configurable via `AGENT_DAEMON_TRUSTED_MCP=server1,server2`.
- `console.log` left in JS/TS files just edited — warned on stderr.

## Audit log

When the `security` install profile is active, every MCP call writes one JSONL line to `~/.agent-daemon/audit/mcp.jsonl`:

```json
{"ts":"2026-05-11T17:58:16.269Z","server":"qmd","tool":"search","session":null,"project":"..."}
```

- **Rotation**: when the file exceeds 10 MB, it rotates to `mcp.jsonl.1`. Older rotations push down (`.1` → `.2`, `.2` → `.3`). Generation 4 is discarded. Worst-case disk usage: ~40 MB.
- **Trusted list**: `AGENT_DAEMON_TRUSTED_MCP=server1,server2` extends the default (qmd, graphify, context-mode, repomix, ccd_session, ccd_session_mgmt, ccd_directory, scheduled-tasks, mcp-registry).
- **Not shipped remotely.** The audit log stays on the user's machine. No telemetry, no phone-home.

## Vendored upstream

The vendored ECC snapshot at `vendored/everything-claude-code/` is **read-only and gitignored**. Only [`vendored/MANIFEST.md`](vendored/MANIFEST.md) (pinned commit SHA) and [`vendored/fetch.mjs`](vendored/fetch.mjs) (re-hydration script) are tracked.

If upstream is compromised, re-hydration via `node vendored/fetch.mjs --force` would pull the bad commit. Mitigation: the pin is reviewed when bumped, and we keep our hand-merged content (`methodology-api-design`, `methodology-tdd`) cleanly attributed so a bad pull is visible in `git diff`.

## Reporting a vulnerability

- Email: pankaj@mobiux.in
- Or open a private security advisory on [GitHub](https://github.com/Pankaj-mobiux/Agent-Daemon/security/advisories).

We aim to acknowledge within 72 hours and ship a fix on the `main` branch within 7 days for issues of high severity or above.
