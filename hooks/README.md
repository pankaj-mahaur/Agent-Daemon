# hooks/

Pre-baked Claude Code hook configurations that wire `agent-daemon` into the session lifecycle. Copy-paste into your `~/.claude/settings.json`.

## Files

| File | Purpose | Hook event |
|---|---|---|
| [session-start-load.json](session-start-load.json) | Inject constitution + project memory at session start | `SessionStart` |
| [session-end-digest.json](session-end-digest.json) | Run digest pipeline at session end | `SessionEnd` |
| [pre-compact-checkpoint.json](pre-compact-checkpoint.json) | Save a memory checkpoint before `/compact` so context isn't lost | `PreCompact` |
| [pre-tool-use-shell-guard.json](pre-tool-use-shell-guard.json) | Block `git --no-verify`, dev-server-not-in-tmux; warn on `git push` | `PreToolUse` (Bash) |
| [post-tool-use-shell-log.json](post-tool-use-shell-log.json) | Tag `gh pr create` URLs and `npm run build` completions | `PostToolUse` (Bash) |
| [post-tool-use-file-edit-lint.json](post-tool-use-file-edit-lint.json) | Warn about `console.log` left in JS/TS files | `PostToolUse` (Edit/Write/MultiEdit) |
| [pre-tool-use-mcp-audit.json](pre-tool-use-mcp-audit.json) | Append every MCP call to `~/.agent-daemon/audit/mcp.jsonl`, warn on untrusted servers | `PreToolUse` (`mcp__.*`) |
| [pre-tool-use-qmd-redirect.json](pre-tool-use-qmd-redirect.json) | Redirect raw memory reads to QMD search | `PreToolUse` (Read/Grep) |
| [user-prompt-submit-retrieve.json](user-prompt-submit-retrieve.json) | Inject relevant past learnings into UserPromptSubmit | `UserPromptSubmit` |

The shell-guard, shell-log, edit-lint, and mcp-audit hooks were ported from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) (MIT) into our `ad hook <name>` Node helpers — see [ATTRIBUTION.md](../ATTRIBUTION.md).

## Hook authoring conventions

If you write a new hook handler under [`runtime/src/hooks/`](../runtime/src/hooks/):

- `exit 0` (or `passthrough()` from [`io.mjs`](../runtime/src/hooks/io.mjs)) on any non-critical error. Hooks must never block tool execution because of their own bugs.
- `PreToolUse` and `Stop` handlers should finish in under 200ms — no network calls, no slow filesystem walks.
- Log to stderr with the `[agent-daemon]` prefix (use `warn()` from `io.mjs`). Never write to stdout outside the JSON decision.

## What each hook does

### `SessionStart` — load
Reads `constitution/core.md` + `safety.md` + `verification.md` + `communication.md` + the project's `memory/*.md` files, plus the top-N relevant episodic memories (when SQLite backend ships in v0.2). Outputs them as `additionalContext` JSON, which Claude Code injects as a system prompt addendum.

### `SessionEnd` — digest
When the session ends (any reason: `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`), runs the `agent-daemon digest` CLI against the transcript at `transcript_path`. The digest pipeline:
1. Triages the session (skip if below threshold).
2. Extracts learnings via headless `claude` CLI.
3. Classifies each learning by target store.
4. Dedupes against existing memory.
5. Auto-applies low-risk additions; queues high-risk diffs to `proposed/`.
6. Prints a one-line summary to stderr.

Runs `async: true` so it doesn't block the user closing their session — fires off and runs in the background.

### `PreCompact` — checkpoint
Before Claude Code compacts context (manual `/compact` or auto-compact at context limit), checkpoints the current `activeContext.md` so post-compact retrieval can recover what was in flight. Lightweight; only writes if there's been meaningful change since the last checkpoint.

## Installation

### Option A — installer (recommended)

```bash
./setup.sh --hooks                # adds all three to ~/.claude/settings.json
./setup.ps1 -Hooks                # Windows
```

The installer is non-destructive: existing hook entries are preserved; the agent-daemon entries are appended.

### Option B — manual

1. Open `~/.claude/settings.json` (create it if missing).
2. Copy the relevant snippet from this directory.
3. Merge into the `hooks` section. Schema reference: [Claude Code hook docs](https://code.claude.com/docs/en/hooks).

Example merged settings.json:

```json
{
  "model": "opus[1m]",
  "hooks": {
    "SessionStart": [ ... agent-daemon entry ... ],
    "SessionEnd":   [ ... agent-daemon entry ... ],
    "PreCompact":   [ ... agent-daemon entry ... ]
  }
}
```

## Verifying hooks are wired

After install, run:

```bash
agent-daemon doctor
```

This checks:
- `~/.claude/settings.json` exists and parses
- Each agent-daemon hook entry is present
- The `agent-daemon` CLI is on `PATH`
- The constitution + memory-templates + skills directories exist
- The `claude` CLI (used as digest engine) is on `PATH`

A failed check prints the exact fix command.

## Uninstall

Either:

```bash
./setup.sh --hooks --uninstall    # removes only agent-daemon hook entries
```

Or manually delete the relevant blocks from `~/.claude/settings.json`.

## Performance

Each hook is gated behind a fast-path check. Approximate overheads:

| Hook | Overhead | Notes |
|---|---|---|
| `SessionStart` | 50–200ms | Mostly file reads. SQLite retrieval (v0.2) adds ~30ms. |
| `SessionEnd` | < 10ms direct (async) | The digest pipeline runs in the background after the hook returns. Pipeline itself takes 5–30s. |
| `PreCompact` | < 50ms | Skips entirely if no meaningful change. |

If you notice session-start latency, run `agent-daemon doctor --bench` to profile.
