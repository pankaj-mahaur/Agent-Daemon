---
name: harness-troubleshoot
description: "Use when agent-daemon's harness misbehaves — `ad tui` / `ad chat` / `ad run` / `ad loop` / `ad web` / `ad acp` fails, hangs, says \"Not logged in\", \"Access is denied\", \"spawn EPERM\", \"sandbox is not ready\", \"engine stopped\", hooks don't fire, memory isn't injected, or \"ad run kaam nahi kar raha\" / \"harness toot gaya\" / \"engine error aa raha\". Checks login → sandbox → hooks → the engine's own log in that order, with the known Windows gotchas and the ad tui symptoms."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.2"
allowed-tools: Bash, Read, Grep
---

# Troubleshoot the ad harness

The harness drives the engine's app-server in its own home (`~/.agent-daemon/engine`). Most failures are one of four things: login, sandbox, hooks, or an engine error that only shows up in the engine's own log. Check them in that order. Don't guess from the agent's chat output.

If an error says "The engine reported a problem", open `/warnings` in the TUI or read the `details:` lines in CLI output for the engine's original text. `ad doctor` shows its tested version.

## When to use

Any harness command errors out, hangs, or finishes without doing the work ("my shell was denied", "couldn't run the tests").

## Procedure

1. **Login.** `ad auth status`. `Not logged in` → `ad auth login openai` (or `openrouter --model <slug>` / `chatgpt`). The harness login is separate from your own install's login.
2. **Engine + hooks.** `ad doctor`. Look at the engine lines:
   - the engine version should equal the pin in `runtime/package.json`; if it doesn't, `cd runtime && npm install`.
   - `Engine hooks: k/N trusted` with k < N → the next `ad run` re-trusts them; if it stays low, the hook commands changed (re-run `ad run` once, then check again). After an upgrade the hooks file is regenerated at the next start; hooks written for older ad keep working.
3. **Sandbox (Windows).** `ad sandbox status`. Not ready → `ad sandbox setup`. Unattended runs (`ad loop`, workers, schedules) refuse to start without it.
4. **Reproduce small**, in a scratch dir and never the user's repo, so test prompts don't land in its memory:
   ```bash
   mkdir <scratch>/probe && cd <scratch>/probe && git init -q
   ad run "Run: node --version. Report the output." --json
   ```
5. **Read the engine's log** when the output doesn't explain it. It's `logs_2.sqlite` in the harness home, table `logs` (columns `id`, `level`, `target`, `feedback_log_body`). `sqlite3` may not be installed; use Node:
    ```bash
    cd ~/.agent-daemon/engine
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
| `CreateProcessAsUserW failed: 5 (Access is denied.)` or `-1073283067` for a `pwsh.exe` under `...\WindowsApps\...` (every command then asks to run outside the sandbox) | PowerShell 7 from the Microsoft Store: the sandbox can't start a Store (MSIX) app. 2.0.1 dropped only the alias folder from the engine's PATH; started *from* Store PowerShell 7, its package folder `C:\Program Files\WindowsApps\Microsoft.PowerShell_…` still came first | upgrade to agent-daemon ≥ 2.1.1 (`withoutStoreAliases` drops every WindowsApps entry); to reproduce, run the harness from that PowerShell with a temp `AD_ENGINE_DIR` and a `SHELL` prompt against the mock model |
| `agent-daemon-memory: Allow the agent-daemon-memory MCP server to run tool "memory_search"?` on every recall | before 2.1.1 the memory server kept the engine's default approval mode, or the user set `prompt` | upgrade (setup sets `default_tools_approval_mode = "approve"` unless the user chose a mode); valid modes: `auto`, `prompt`, `writes`, `approve` |
| the first command or edit after installing sits on "Thinking" for ~35 s (Windows) | the engine sets up its sandbox for the harness home on the first sandboxed action, once | nothing to do (#29) |
| `spawn EPERM` from `node --test`, npm scripts or anything that starts child processes | the unelevated Windows sandbox blocks Node child processes | run test files directly (`node x.test.js`), or try `ad sandbox setup --elevated` (untested) |
| `Windows sandbox is …; unattended runs need it` | sandbox not set up | `ad sandbox setup` |
| hooks never fire / no memory injected | hooks untrusted, or `features.hooks` off for that thread | `ad doctor`; unattended threads only switch off non-memory MCP servers, not hooks |
| `ad digest-latest` finds no harness session | it only searches `~/.claude/projects` | `ad digest --transcript ~/.agent-daemon/engine/sessions/<…>/rollout-*.jsonl --cwd <project>` |
| `ad loop` stops right away | a STOP file exists, or a budget is too small | remove `.agent-daemon/STOP`; raise `--max-*` |
| ad won't run the engine in your own install's home (or `trailing dot or space`, `network (UNC) paths`) | `AD_ENGINE_DIR` (or `CODEX_HOME`) points at the user's own `~/.codex`, or a path leading there | unset it or point it at a new folder; never "fix" the guard |
| engine not installed — run: cd runtime && npm install | the pinned engine is missing; ad never falls back to the user's own install | re-run the installer or `cd runtime && npm install` |
| `401 Unauthorized` on `plugins/featured` in the log | the engine warming its plugin list | harmless, ignore |
| `Shell snapshot not supported yet for PowerShell` (WARN) | engine feature not available on Windows shells | harmless, ignore |

### `ad tui`

The terminal UI runs the same engine in the same home, so steps 1–5 apply. These are its own symptoms; details in `docs/troubleshooting.md` #22–29 and `docs/tui.md`.

| Symptom | Cause | Fix |
|---|---|---|
| `ad tui needs an interactive terminal`, `needs Node 22.17+ or 24.2+ on Windows`, mintty, `TERM=dumb` (#23) | a pipe or script, old Node on Windows (no VT input), or Git Bash's window | a real terminal; upgrade Node within 22.x; `winpty ad tui`; or `ad chat` |
| Shift+Enter sends (#24) | Windows Terminal 1.24 and VS Code send it as Enter | Ctrl+Enter (Windows Terminal), Ctrl+J or `\` + Enter anywhere; `/terminal-setup` prints the binding |
| ghost copies of the bottom lines after narrowing the window (#25) | known: some terminals move the cursor further than the re-wrap; ad errs towards never erasing history | Ctrl+L redraws. Ask for `node runtime/scripts/tui-probe.mjs screen --bottom` (narrow, then widen), its log and a screenshot |
| `/undo` says `Not undone: <file> (<why>)` (#26) | the file changed after the turn; or during it by something other than the agent's edits (a command, the user's editor), also on top of an agent edit ("changed during the turn"); or a folder/file now stands in the way; or the snapshots never held it | look at the diff first; `/undo force` overrides only the "changed since…" kinds (a save after the agent's edit), never "changed during the turn", files the agent didn't edit, folders, or what the snapshots never held |
| `/undo`: `The last turn has no checkpoint (…)` (#26) | the "before" snapshot (taken at Enter) wasn't done within 10 s, git fails in this repo, the turn was started by the engine itself (review, goal), or it predates `ad tui` | nothing to undo for that turn; fix the git error if one is shown |
| `ad's engine stopped (exit N). Your text is kept. Enter restarts and resumes.` (#27) | the engine exited and the 3 automatic restarts failed | Enter retries; else `/quit`, `ad doctor`, `ad tui --last`. The reason is in `logs_2.sqlite` (step 5) |
| Ctrl+G: `The editor returned at once without waiting` (#28) | the editor opened the file in a running window and exited | `EDITOR="code --wait"` or another editor that waits |
| `thread … is open in another ad (pid N)` | one `ad` per conversation (locks in `~/.agent-daemon/locks`) | close the other `ad tui`; a crashed one's lock is taken over once its process is gone |
| "two engine folders" (#37) | an older ad started after the `codex-home` link was removed, so both folders are real | `ad doctor` shows both with last use, count and sign-in; rename the one you don't want; delete nothing until checked |
| "Not moved: something is using …" from `ad migrate` (#38) | a file or working folder inside is held open (another ad window, an editor panel, a loop, a terminal, antivirus) | close it and run `ad migrate` again |
| `/x isn't in ad yet.` | an engine slash command ad doesn't run yet (never sent to the model) | `docs/commands.md` lists every command |
| `'/x' is disabled while a task is in progress.` | the engine's rule for that command | wait for the turn or Esc; the draft stays |
| keys set outside ad don't work in ad (#30) | ad applies `tui.keymap` only to its own actions and skips chords, clashes and the prompt's editing keys | `/warnings` (F2) says which and why |
| `/clear` wiped the scrollback (#31) | the engine's `/clear` does | `/new` keeps it; `"clear.keepScrollback": true` in `~/.agent-daemon/tui/prefs.json` |
| window title still ad's after exit (#32) | no title stack in the terminal, or a crash | new tab, or `/title` with every item off |
| `/plan`: "Plan mode unavailable right now." (#33) | the engine didn't list its collaboration modes within 2 s of the engine starting (slow start, antivirus), or an engine build changed the experimental call | restart `ad`; check the engine version in `ad doctor` |
| `/recap`: "Could not generate a recap. Please try again." (#34) | the temporary read-only thread didn't start or answer in time (30 s + 30 s), sign-in, or the answer wasn't the engine's recap format; no recap at all = a prompt or another turn dropped it | retry while idle; `/status` for sign-in; the grey reason says which |
| `/approve`: "No recent auto-review denials…" or "invalid Guardian denial event" (#35) | denials are kept per conversation while ad runs (10), not after a resume, not a subagent's; the refusal = an engine version ad wasn't tested with | ask the model to retry; `ad doctor` for the version |
| `/setup-default-sandbox` refuses or fails (#36) | elevated sandbox = machine-wide + UAC; ad changes only a home it created; input waits while it runs | approve UAC; `ad sandbox setup` (non-admin); `ad sandbox setup --elevated --force` for a home ad didn't make |

Reproduce TUI problems with `ad tui` in a scratch folder. Never run the user's own install or use `~/.codex`.

## Examples

### Example 1: "ad run did nothing"

The agent says its shell was denied, and every command asks to run outside the sandbox. Step 5 shows `CreateProcessAsUserW failed` on a `pwsh.exe` under `WindowsApps`. `ad --version` says older than 2.1.1 → upgrade (re-run the one-liner), then re-run the step 4 probe from the same PowerShell.

### Example 2: "tests won't run inside the agent"

`node --test` → `spawn EPERM` while `node --version` works. That's the unelevated sandbox. Tell the agent to run the test file directly, or verify the tests yourself after the turn.

## Anti-patterns

- **Debugging in the user's repo.** Probe prompts get captured as memory there.
- **Editing `~/.codex`, or running the probe with the user's own install.** It's the user's own install; the harness never runs the engine there, and `codexEnv()` refuses it. Debug with the harness home or a temp engine home only.
- **Turning the sandbox off** (`--sandbox danger-full-access`) to make an error go away. Find the cause.
- **Pasting log rows wholesale.** They can be long; print the tail of the message, and never auth data.
