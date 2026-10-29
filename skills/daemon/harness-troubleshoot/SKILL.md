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

Version probes must capture child stderr explicitly: Node's `execFileSync` echoes it when stdio is omitted. Doctor retains probe stderr as labelled details, and live checks must preserve engine error codes/raw fields for the façade's mapping.

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
| `This provider can't take … through ad` / `ad can't pass … to this provider` (HTTP 400 from the gateway) | a Chat-only provider (translated route) got something it can't carry: live web search, a stored response, an image for a non-vision model | turn the feature off (`ad tools disable web-search`) or pick another model (troubleshooting #67) |
| `<provider>: the daily limit is used up` on a failed turn | the gateway classified the provider's 429 as a period quota and answered `insufficient_quota`, so the engine doesn't retry | wait for the reset or switch accounts (#68); if a per-minute body was misread, fix `translate/errors.mjs` with that body as a test |
| `… can't read this chat's earlier reasoning any more` | a reasoning envelope sealed for this provider and model no longer opens (the gateway-seal key in the secret store changed) | troubleshooting #71: a new chat; foreign or other-model reasoning is sent empty, never refused |
| `OpenCode Go's usage limit is reached` / `This OpenCode Go model isn't available to ad yet` | Go's plan window is used up (GoUsageLimitError → insufficient_quota), or the model is on Anthropic's/Gemini's API (P6.4) or another wire | troubleshooting #69/#70; a listed model never changes wire on its own: fix the dated table in the opencode-go preset |
| `Windows sandbox is …; unattended runs need it` | sandbox not set up | `ad sandbox setup` |
| hooks never fire / no memory injected | hooks untrusted, or `features.hooks` off for that thread | `ad doctor`; unattended threads only switch off non-memory MCP servers, not hooks |
| `ad digest-latest` finds no harness session | it only searches `~/.claude/projects` | `ad digest --transcript ~/.agent-daemon/engine/sessions/<…>/rollout-*.jsonl --cwd <project>` |
| `ad loop` stops right away | a STOP file exists, or a budget is too small | remove `.agent-daemon/STOP`; raise `--max-*` |
| ad won't run the engine in your own install's home (or `trailing dot or space`, `network (UNC) paths`) | `AD_ENGINE_DIR` (or `CODEX_HOME`) points at the user's own `~/.codex`, or a path leading there | unset it or point it at a new folder; never "fix" the guard |
| engine not installed — run: cd runtime && npm install | the pinned engine is missing; ad never falls back to the user's own install | re-run the installer or `cd runtime && npm install` |
| `401 Unauthorized` on `plugins/featured` in the log | the engine warming its plugin list | harmless, ignore |
| `Shell snapshot not supported yet for PowerShell` (WARN) | engine feature not available on Windows shells | harmless, ignore |
| memory tools answer "isn't bound to a project" | the server binds at start to one project (`--project`, `AD_MEMORY_PROJECT` from ad's façade, `CLAUDE_PROJECT_DIR` only with `--host claude-code`, else a git/`.agent-daemon` working folder); home, roots, system folders, ad's own folders and the install folder never count | open the project folder; Claude Code: `--host claude-code`; other hosts: `--project <folder>` (troubleshooting #44). Per host (S-MCP): ad's engine starts one server per conversation in its folder (and the façade passes `AD_MEMORY_PROJECT`); a GUI app's fixed launch folder never binds |
| a memory result shows `[withheld: this note reads like an instruction…]` | `memory/render-safe.mjs` withholds a stored note that reads like an injection or a command it tells the agent to run (3.0 stored some before its screen) | by design; `ad memory held` reviews held notes, and `ad memory scan` holds such old notes back once |
| a learning is missing from memory | agent-origin notes are `pending`, injection/secret hits `quarantined`, 3.0 global rows serve only in their session's project, user facts only where observed | by design (troubleshooting #45); the user can restate it or `/remember` it |
| `ad migrate`: "an ad session is running (pid N; engine pid M)" | every engine holds a lease in `~/.agent-daemon/locks` (`engine-*.lock`, kind engine) from start to exit; a holder that is gone with its engine still running keeps it held; dead leases are swept by the next migrate | close that session, or end the engine pid; never delete live lock files by hand |
| "Pick a project folder" / `HOME_FOLDER_REFUSED` / "Run this in a project folder" | the folder (home, or under a git home) would load the user's own `~/.codex` as a project layer: skills even untrusted, settings when trusted (`homeLayerRisk`, `engine/codex/home.mjs`); resume/fork are checked against the thread's stored folder | open a project folder; overrides `--allow-home-folder`, `AD_ALLOW_HOME_FOLDER=1`, pref `allowHomeFolder`; 3.0 jobs are grandfathered and listed by doctor (troubleshooting #48) |
| "ad auth: <account> needs its key again" | the picked account (--account, AD_ACCOUNT, project, default) has no working key | the command it names; or another --account (troubleshooting #60) |
| "The engine kept this conversation on …" / "still busy" | a move to another account while a turn or background terminal runs | wait, switch again, or a new conversation (troubleshooting #61) |
| "account changes can't run from the agent's own shell" | `ad auth login/use/rename/logout/remove/repair` from a tool shell (AD_TOOL_SHELL=1) | run it in your own terminal; `list`, `status`, `test` work anywhere |
| "\"x\" matches 2 accounts" / "no account matches" | an ambiguous or unknown account reference | name it as provider/label; `ad auth list` |
| "The key was refused (HTTP 401), so it wasn't saved" | the provider refused the key | copy it again; the command it names (troubleshooting #63) |
| "Couldn't reach <host> … The key is saved" | no network while adding a key | `ad auth test <provider>/<label>` later (troubleshooting #64) |
| "This endpoint speaks only Chat Completions" | the endpoint has no Responses API | Ollama 0.13.3+, LM Studio, vLLM or OpenRouter (troubleshooting #65) |
| "Ollama isn't answering on localhost:11434" | the local server isn't running | `ollama serve` / `lms server start` (troubleshooting #66) |
| "This conversation used an account you removed" | its API account is gone | a new conversation (troubleshooting #62) |
| "ad: couldn't reach <host>" | ad's gateway couldn't connect to the provider (network, proxy, company certificate) | `NODE_EXTRA_CA_CERTS` for a company CA; the gateway can't use an HTTP proxy yet (troubleshooting #58) |
| "ad: the provider redirected" | the endpoint redirects; ad never follows a redirect with a key | use the provider's final `/v1` address (troubleshooting #59) |
| doctor: older rows "can't be told apart" | two paths mapped to one `project_slug` (`/x/a/b`, `/x/a-b`); projects now have ids, and rows with no session or folder to tie them reach neither | `ad memory assign --list`, then `ad memory assign learnings:<id> --project <folder>` in the user's own terminal (troubleshooting #46) |
| a record tool says "This host's hooks already capture corrections" | `--capture auto` and a `capture_heartbeats` row for this `--host` and project in the last 30 min (the UserPromptSubmit hook writes it) | by design; `--capture tools` to record anyway (troubleshooting #49) |
| a record tool says "Not saved: that looks like it contains a secret" | `findSecrets` hit in the text, evidence or files; nothing stored | restate without the secret (troubleshooting #50) |
| "Saved for review" but the next session doesn't know it | record-tool notes are `pending` (origin agent, `applied_to proposed:mcp`): only this project's `memory_search`/`memory_get` show them, unreviewed | the user accepts in `ad review` (troubleshooting #51) |
| `ad review: accepting notes can't run from the agent's own shell` / `… needs an interactive terminal` | D49 guard on every accept/promote path (`AD_TOOL_SHELL=1`, or stdin/stdout not a TTY); no `--yes`, no env override | the user runs it in their own terminal; never work around it for them (troubleshooting #52) |
| the memory installer prints `✗ <host>: …; add this yourself:` | it changes only its own entry and refuses a config that doesn't parse, is read-only, already defines `agent-daemon-memory` outside its control (TOML table, dotted keys, inline table) or is ad's engine home | fix or remove the user's entry, then install again; or paste the snippet; `repair --adopt` claims a hand-made entry (troubleshooting #53) |
| memory tools missing in a host after install | hosts read MCP config at start | restart the host; `ad memory doctor` (`smoke.legacy`/`smoke.modern` start the entry like the host; `node.path` fails after a Node upgrade → `repair`) (#54) |
| doctor `capture.double` | Claude Code has ad's hooks and the entry uses `--capture tools` | `install --host claude-code --capture hooks` (#55) |
| capture files missing from `<repo>/.agent-daemon` | a folder without its own `.agent-daemon/` keeps journal, proposals, session log and telemetry in `~/.agent-daemon/projects/<slug>-<hash8>/` (`memory/project-dir.mjs`) | by design: capture never creates a folder in a repo; `ad init` gives the project its own folder |

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
| "two engine folders" (#37) | an older ad started after the `codex-home` link was removed, so both folders are real | `ad doctor` shows both with last use, count and sign-in; rename the one you don't want; delete nothing until checked. Only a folder with nothing but ad's first-run files is set aside by itself (`<name>.empty-<date>`, with a notice) |
| "Not moved: something is using …" or "an ad session is running (pid N)" from `ad migrate` (#38) | a file or working folder inside is held open (another ad window, an editor panel, a loop, a terminal, antivirus), or a live conversation lock | close it and run `ad migrate` (or `--undo`) again |
| "codex-home points to X, which doesn't exist" / "can't be read (CODE)" (#40) | the user's own `codex-home` or `engine` link to a drive that isn't connected or unlocked, or ad's own link from before `~/.agent-daemon` moved; ad never replaces a link it didn't make | reconnect the drive; if the folder is gone for good or the profile moved, remove only the link (`rmdir` on Windows); the next start remakes it |
| `/x isn't in ad yet.` | an engine slash command ad doesn't run yet (never sent to the model) | `docs/commands.md` lists every command |
| `'/x' is disabled while a task is in progress.` | the engine's rule for that command | wait for the turn or Esc; the draft stays |
| keys set outside ad don't work in ad (#30) | ad applies `tui.keymap` only to its own actions and skips chords, clashes and the prompt's editing keys | `/warnings` (F2) says which and why |
| `/clear` wiped the scrollback (#31) | the engine's `/clear` does | `/new` keeps it; `"clear.keepScrollback": true` in `~/.agent-daemon/tui/prefs.json` |
| window title still ad's after exit (#32) | no title stack in the terminal, or a crash | new tab, or `/title` with every item off |
| `/plan`: "Plan mode unavailable right now." (#33) | the engine didn't list its collaboration modes within 2 s of the engine starting (slow start, antivirus), or an engine build changed the experimental call | restart `ad`; check the engine version in `ad doctor` |
| `/recap`: "Could not generate a recap. Please try again." (#34) | the temporary read-only thread didn't start or answer in time (30 s + 30 s), sign-in, or the answer wasn't the engine's recap format; no recap at all = a prompt or another turn dropped it | retry while idle; `/status` for sign-in; the grey reason says which |
| `/approve`: "No recent auto-review denials…" or "invalid Guardian denial event" (#35) | denials are kept per conversation while ad runs (10), not after a resume, not a subagent's; the refusal = an engine version ad wasn't tested with | ask the model to retry; `ad doctor` for the version |
| "price unknown" (#75) / "upgrade to Plus" (#76) | the provider's list gives no price (or it's a day old); the ChatGPT plan doesn't include the use (not a quota) | `ad auth models <account> --refresh`; pick an account whose plan includes it |
| `/fallback` or `ad fallback` rows say "skipped now", or "None of these targets fits …" (#77) | fallback is off, or no target fits its rules now: a price not checked in a day under "free only", a metered model under "no extra spend", an unconfirmed trial endpoint, an account needing sign-in, a provider benched until its reset (every account of it, any window), the per-hour cap | `ad fallback preview --error quotaExhausted`; `ad auth models <account> --refresh`; add a free model or `ad fallback set cost noExtraSpend` |
| "Fallback is off: … changed since you confirmed the order" (#78) | the consent hash covers the order, each target, the account's identity, base URL and key revision, the cost and trial rules and the keep-running list; any change turns it off (lower limits don't) | the user checks `ad fallback`, then `ad fallback enable` |
| "⏸ Paused: … may still be running from the failed turn" (#79) / "still running in the background" (#80) / "switching too often", "budget is used up" (#81) | automatic fallback (P4.5) stops instead of moving: a command's end is unknown, a background command isn't on the keep-running list, or a limit (max-hops, max-switches, give-up) is reached; the session index shows `paused` with the reason | check the command, then `/retry`, `/model` or a new prompt; add servers to `ad fallback set keep-running`; raise a limit |
| a turn ended with a ↪ line and the engine's "Quota exceeded…" text is missing | fallback acted on it: ad's line replaces the engine's, which stays in `/warnings` | by design; `ad sessions show --last` has `routeFailure` and `switchCommitted` (reason `policy`) |
| "ad fallback can't be changed from the agent's own shell" | `AD_TOOL_SHELL=1`: mutations and `test --live` refuse (list, preview, dry test and disable work) | by design; the user runs it in their own terminal |
| "Couldn't switch to … Still on …" (#74) | a mid-task switch (P4.2) stopped before anything moved: sign-in, an unlisted model, the target's engine, the engine kept the old provider (fork answer), or a goal/subagent kept starting turns | nothing changed; fix the named reason and pick the account again; a kept provider: switch again (it takes the continuation path) and report it |
| "This session is open in another ad window" / "couldn't write this session's record" (#73) | one window writes a session's record (`~/.agent-daemon/sessions/`); a failed write (disk, permissions) | the conversation goes on either way; close the other window; check the folder is writable; `AD_LEDGER=0` turns the record off |
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
