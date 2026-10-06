---
name: harness-troubleshoot
description: "Use when agent-daemon's harness misbehaves — `ad tui` / `ad chat` / `ad run` / `ad loop` / `ad web` / `ad acp` fails, hangs, says \"Not logged in\", \"Access is denied\", \"spawn EPERM\", \"sandbox is not ready\", \"Codex stopped\", hooks don't fire, memory isn't injected, or \"ad run kaam nahi kar raha\" / \"harness toot gaya\" / \"codex error aa raha\". Checks login → sandbox → hooks → Codex's own log in that order, with the known Windows gotchas and the ad tui symptoms."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.1"
allowed-tools: Bash, Read, Grep
---

# Troubleshoot the ad harness

The harness drives `codex app-server` in its own home (`~/.agent-daemon/codex-home`). Most failures are one of four things: login, sandbox, hooks, or an engine error that only shows up in Codex's own log. Check them in that order. Don't guess from the agent's chat output.

## When to use

Any harness command errors out, hangs, or finishes without doing the work ("my shell was denied", "couldn't run the tests").

## Procedure

1. **Login.** `ad auth status`. `Not logged in` → `ad auth login chatgpt` (or `openai` / `openrouter --model <slug>`). The harness login is separate from the user's own `codex` login.
2. **Engine + hooks.** `ad doctor`. Look at the Codex lines:
   - the engine version should equal the pin in `runtime/package.json`; if it doesn't, `cd runtime && npm install`.
   - `Harness hooks: k/N trusted` with k < N → the next `ad run` re-trusts them; if it stays low, the hook commands changed (re-run `ad run` once, then check again).
3. **Sandbox (Windows).** `ad sandbox status`. Not ready → `ad sandbox setup`. Unattended runs (`ad loop`, workers, schedules) refuse to start without it.
4. **Reproduce small**, in a scratch dir and never the user's repo, so test prompts don't land in its memory:
   ```bash
   mkdir <scratch>/probe && cd <scratch>/probe && git init -q
   ad run "Run: node --version. Report the output." --json
   ```
5. **Read Codex's log** when the output doesn't explain it. It's `logs_2.sqlite` in the harness home, table `logs` (columns `id`, `level`, `target`, `feedback_log_body`). `sqlite3` may not be installed; use Node:
   ```bash
   cd ~/.agent-daemon/codex-home
   node --experimental-sqlite --no-warnings -e '
   const { DatabaseSync } = require("node:sqlite");
   const db = new DatabaseSync("logs_2.sqlite", { readOnly: true });
   for (const r of db.prepare("select id, level, target, feedback_log_body b from logs where level in (?, ?) order by id desc limit 10").all("ERROR", "WARN"))
     console.log(r.id, r.level, r.target, "::", r.b.slice(r.b.lastIndexOf("}:") + 2, r.b.lastIndexOf("}:") + 500));'
   ```
   Never print `auth.json` or tokens.
6. **Match it to a known cause** (below), fix, and re-run step 4.

## Known causes

| Symptom / log line | Cause | Fix |
|---|---|---|
| `CreateProcessAsUserW failed: 5 (Access is denied.)` for `...\WindowsApps\pwsh.exe` | Store PowerShell is an app alias the sandbox can't launch | upgrade to agent-daemon ≥ 2.0.1 |
| `spawn EPERM` from `node --test`, npm scripts or anything that starts child processes | the unelevated Windows sandbox blocks Node child processes | run test files directly (`node x.test.js`), or try `ad sandbox setup --elevated` (untested) |
| `Windows sandbox is …; unattended runs need it` | sandbox not set up | `ad sandbox setup` |
| hooks never fire / no memory injected | hooks untrusted, or `features.hooks` off for that thread | `ad doctor`; unattended threads only switch off non-memory MCP servers, not hooks |
| `ad digest-latest` finds no harness session | it only searches `~/.claude/projects` | `ad digest --transcript ~/.agent-daemon/codex-home/sessions/<…>/rollout-*.jsonl --cwd <project>` |
| `ad loop` stops right away | a STOP file exists, or a budget is too small | remove `.agent-daemon/STOP`; raise `--max-*` |
| `refusing to run Codex in …: that is your own Codex home` (or `trailing dot or space`, `network (UNC) paths`) | `AD_CODEX_HOME` points at the user's own `~/.codex` / `CODEX_HOME`, or a path leading there | unset `AD_CODEX_HOME` or point it at a new folder; never "fix" the guard |
| `Codex engine not installed — run: cd runtime && npm install` | the pinned engine is missing; ad never falls back to the user's global `codex` | re-run the installer or `cd runtime && npm install` |
| `401 Unauthorized` on `plugins/featured` in the log | Codex warming its plugin list | harmless, ignore |
| `Shell snapshot not supported yet for PowerShell` (WARN) | Codex feature not available on Windows shells | harmless, ignore |

### `ad tui` and `ad codex`

The terminal UI runs the same engine in the same home, so steps 1–5 apply. These are its own symptoms; details in `docs/troubleshooting.md` #23–28 and `docs/tui.md`.

| Symptom | Cause | Fix |
|---|---|---|
| `ad tui needs an interactive terminal`, `needs Node 22.17+ or 24.2+ on Windows`, mintty, `TERM=dumb` (#23) | a pipe or script, old Node on Windows (no VT input), or Git Bash's window | a real terminal; upgrade Node within 22.x; `winpty ad tui`; or `ad chat` |
| Shift+Enter sends (#24) | Windows Terminal 1.24 and VS Code send it as Enter | Ctrl+Enter (Windows Terminal), Ctrl+J or `\` + Enter anywhere; `/terminal-setup` prints the binding |
| ghost copies of the bottom lines after narrowing the window (#25) | known: some terminals move the cursor further than the re-wrap; ad errs towards never erasing history | Ctrl+L redraws. Ask for `node runtime/scripts/tui-probe.mjs screen --bottom` (narrow, then widen), its log and a screenshot |
| `/undo` says `Not undone: <file> (<why>)` (#26) | the file changed after the turn; or during it by something other than the agent's edits (a command, the user's editor), also on top of an agent edit ("changed during the turn"); or a folder/file now stands in the way; or the snapshots never held it | look at the diff first; `/undo force` overrides "changed since the turn" only (never files the agent didn't edit, never folders) |
| `/undo`: `The last turn has no checkpoint (…)` (#26) | the agent's first edit started before the "before" snapshot (started at Enter) was done, git fails in this repo, or the turn predates `ad tui` | nothing to undo for that turn; fix the git error if one is shown |
| `Codex stopped (exit N). Your text is kept. Enter restarts and resumes.` (#27) | the engine exited and the 3 automatic restarts failed | Enter retries; else `/quit`, `ad doctor`, `ad tui --last`. The reason is in `logs_2.sqlite` (step 5) |
| Ctrl+G: `The editor returned at once without waiting` (#28) | the editor opened the file in a running window and exited | `EDITOR="code --wait"` or another editor that waits |
| `thread … is open in another ad (pid N)` | one `ad` per conversation (locks in `~/.agent-daemon/locks`) | close the other `ad tui`; a crashed one's lock is taken over once its process is gone |
| "This needs the stock UI: /codex" | a Codex request ad doesn't handle yet | `/codex` opens the stock UI on the same conversation; `ad codex` runs it standalone on ad's home with `--no-daemon` |

Reproduce TUI problems with `ad tui` in a scratch folder. Never use the user's own `codex` or `~/.codex`.

## Examples

### Example 1: "ad run did nothing"

The agent says its shell was denied. Step 5 shows `CreateProcessAsUserW failed: 5` on `WindowsApps\pwsh.exe`. `ad --version` says 2.0.0 → upgrade (re-run the one-liner), then re-run the step 4 probe.

### Example 2: "tests won't run inside the agent"

`node --test` → `spawn EPERM` while `node --version` works. That's the unelevated sandbox. Tell the agent to run the test file directly, or verify the tests yourself after the turn.

## Anti-patterns

- **Debugging in the user's repo.** Probe prompts get captured as memory there.
- **Editing `~/.codex`, or running the probe with the user's own Codex.** It's the user's own install; the harness never runs Codex there, and `codexEnv()` refuses it. Debug with the harness home or a temp `CODEX_HOME` only.
- **Turning the sandbox off** (`--sandbox danger-full-access`) to make an error go away. Find the cause.
- **Pasting log rows wholesale.** They can be long; print the tail of the message, and never auth data.
