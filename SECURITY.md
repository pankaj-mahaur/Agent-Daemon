# Security model

agent-daemon does two jobs, and both are covered here:

- **Tooling around your coding agent** (Claude Code, Cursor, Codex). Its hooks process the JSON the host hands them about tool calls the agent is about to make.
- **Its own agent harness** (since v2). `ad` / `ad tui`, `ad chat`, `ad run`, `ad loop`, `ad schedule`, `ad web` and `ad acp` run the agent themselves on ad's own pinned engine. There ad also shows untrusted model and command output, asks for your approvals, serves a local web UI and stores provider keys. See [The agent harness and terminal UI](#the-agent-harness-and-terminal-ui).

This document explains the threat model, the design choices behind it, and how to report a vulnerability.

## Threat model

| Asset | Threats considered | Treatment |
|---|---|---|
| The agent's tool execution flow | Hook crashes blocking the user's work | **Fail-safe to approve** — see below |
| `~/.claude/settings.json`, `~/.claude.json` | Concurrent writes corrupting JSON; a file ad can't parse being replaced | `ad init` reads → mutates in memory → writes a temp file in the same folder, flushes it, renames it over (retrying while Claude Code holds the file on Windows); a file it can't parse is left unchanged |
| `~/.agent-daemon/audit/mcp.jsonl` | Unbounded growth, log injection | Size-based rotation (10 MB × 3 generations); fields are JSON-escaped |
| `~/.agent-daemon/episodic.db` (SQLite) | Rows hold captured prompt and transcript text. One project's notes reaching another project's agent; an agent (or injected text) planting instructions in memory; secrets typed into a prompt being stored | Local-only, not network-exposed. Secrets (provider keys, tokens, passwords, `user:pass@` URLs) are redacted before any write and masked again when shown. Each memory reader is bound to one project (the MCP server at start, hooks to their folder); ids from another project return nothing; home, system folders and ad's own folders never count as a project. Notes the agent wrote in its own turn (a "remember: …" in its reply), and digest items it marks as its own, are stored **pending** and never served until you accept them (typing the same note yourself accepts it); notes the injection screen flags are **quarantined** (hidden from older ad versions too). The words you type yourself apply at once within their project, by design: text you paste counts as your own. Nothing becomes global by itself. `ad memory scan` checks notes stored before these rules |
| Memory accept, release and drop (`ad memory held`) | An agent running them on your behalf | They refuse inside ad's engine tool shells (`AD_TOOL_SHELL=1`, set by harness setup) and without a terminal, then ask you to type the note's id. An agent with a terminal-backed shell in another host is outside this check |
| Vendored upstream content | Code-injection if upstream is compromised | Vendored snapshot is **gitignored** (only `MANIFEST.md` + `fetch.mjs` tracked); commit SHA is pinned |
| MCP audit trail | Tampering / repudiation | Append-only writes; rotation rather than truncation; no remote log shipping (yet) |
| Your own install (`~/.codex`, its login, sessions, daemon) | The harness reading or changing it | The harness runs only its pinned engine, in its own home (`~/.agent-daemon/engine`). It refuses `~/.codex`, a `CODEX_HOME` your shell sets, network paths and any spelling that resolves to them, and drops your `CODEX_HOME`, `CODEX_API_KEY` and similar variables (`CODEX_CA_CERTIFICATE` excepted) |
| Provider keys and logins | Leaking into config, argv, logs or the agent's shell | OpenRouter keys: DPAPI on Windows, libsecret on Linux (else a 0600 file), a 0600 file on macOS; never in config or argv; excluded from the agent's shell environment. The ChatGPT login and an OpenAI API key are kept by the engine in the harness home (`auth.json`, file store), never in your OS keyring or `~/.codex` |
| Approval prompts | A command or diff that hides part of itself; type-ahead approving by accident | Hidden characters (control, bidi, zero-width, look-alike spaces) show as `<U+XXXX>`; an answer that grants something counts only 400 ms after the prompt opens and after your last key; only a "don't ask again" rule the request offered can be sent, and one whose prefix hides characters is never offered |
| Your terminal | Escape sequences in model or command output (clearing the screen, faking a prompt, setting the title or clipboard) | Untrusted text is sanitized before it is drawn: control sequences are removed or shown as visible `<U+…>` forms |
| Memory shown to an agent (MCP tools, session start, prompt recall) | A stored note crafted to steer the agent | One render path (`runtime/src/memory/render-safe.mjs`): a note that reads like an instruction (an injection, or a command it tells the agent to run) is withheld whole; others are neutralized and their secrets masked; every MCP result is headed as data, not instructions |
| `ad web` | Other local users or web pages driving the agent | Binds 127.0.0.1 only; every API call needs the random token in the printed link; the Host header must be loopback (DNS rebinding); strict content security policy; all data rendered as text, never HTML |
| Your working tree under `/undo` | Undo reverting your own edits | Only files the agent's applied edits reported are restored, each compared with what the agent wrote; any other change is a conflict and plain `/undo` refuses. Snapshots are private git refs with a private index; your index, HEAD, branches and stash are never touched |
| Unattended runs (`ad loop`, team workers, scheduled loops) | An agent acting with nobody watching | Workspace-only sandbox, no network, never asks; MCP servers other than ad's memory are off, live web search is off; on Windows they refuse to start without a ready sandbox; team workers can't write `.git` |

What's **not** in scope:

- Enforcing the sandbox. That is the host's job (Claude Code, Cursor) or the engine's. In ad's own harness, ad chooses the engine sandbox mode and approval policy for each kind of run (see [docs/harness.md](docs/harness.md#safety-model)); `--sandbox danger-full-access` and the "Full access" permission turn the sandbox off on purpose.
- Commands you run yourself with `!` in `ad tui`: like the engine's own `!`, they run unsandboxed, as you.
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

## The agent harness and terminal UI

The harness drives a pinned app-server. The engine owns the agent loop, the model calls and the sandbox; ad decides the sandbox mode and approval policy for each kind of run, and wires in its memory, hooks and skills. The table above lists the main assets. In more detail:

- **Hooks inside the harness** are the same handlers as in Claude Code, with the same fail-safe-to-approve rule. Only hooks from ad's own `hooks.json` are trusted automatically; a repo's or plugin's hooks are not.
- **Folder trust.** The first time `ad tui` runs in a folder it asks whether you trust it; only a trusted folder may run its own hooks, skills and settings.
- **ad's memory MCP server** (`agent-daemon-memory`) is registered in the harness home and its tools run without an approval prompt, unless you set an approval mode for that server yourself. Its blast radius: it reads the local memory store and can write only retrieval counters and a usefulness score; it can't insert, delete or change memory text ([details](mcp/agent-daemon-memory/README.md#security-blast-radius)).
- **Local files the TUI writes.** The prompt history (`~/.agent-daemon/tui/history.jsonl`) is owner-only (0600) and never stores masked answers. `/export` writes a new file inside the current folder only (no overwrite, no device names, no path through a link that leads out). Prompts typed under `/private` are wrapped in `<private>`, which ad's extractors drop, so they never become learnings.
- **Windows.** The engine's PATH leaves out every `WindowsApps` folder, so commands never run in a Store (MSIX) PowerShell that the sandbox can't start; they run sandboxed in an MSI PowerShell 7 or Windows PowerShell 5.1. `ad sandbox setup --elevated` creates machine-wide sandbox accounts that your own install uses too.
- **`ad acp`** speaks the Agent Client Protocol on stdio to the editor that started it; approvals become the editor's permission prompts.
- **Team workers and Claude Code calls start without a shell.** Task text reaches a Claude worker only on stdin and in a temporary system-prompt file, so `&`, `|` or `%VAR%` in a task can't run as commands on your machine. On Windows, `claude`, `git` and Windows PowerShell (which receives secrets on stdin for DPAPI) are started by full path (PATH, or `%SystemRoot%\System32`), never looked up in the current folder, so a `git.exe` planted in a repo doesn't run. Team, role and agent names are limited to letters, digits, `.`, `_` and `-`. The same rule covers every program ad starts: git, `qmd`, editors, the browser opener, `taskkill` and `attrib`. The one deliberate shell is `cmd.exe` for an editor that is a `.cmd` file (VS Code's `code.cmd`), started by full path, and ad refuses arguments it can't pass to it safely. A test fails if new code starts a shell or a bare program name.
- **Claude workers run with `--dangerously-skip-permissions`** (opt-in: `--engine claude` or `AD_AGENT_ENGINE=claude`). Such a worker can run any command as you, reach the network and read your files; its git worktree is not a sandbox. The default worker is ad's engine: sandboxed to its worktree, no network, no approvals.

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

- Email: pankajmahaur2003@gmail.com
- Or open a private security advisory on [GitHub](https://github.com/pankaj-mahaur/Agent-Daemon/security/advisories).

We aim to acknowledge within 72 hours and ship a fix on the `main` branch within 7 days for issues of high severity or above.
