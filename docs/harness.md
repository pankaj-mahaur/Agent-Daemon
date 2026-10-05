# Agent harness guide

Since v2, agent-daemon runs agents itself. The engine is [OpenAI Codex](https://github.com/openai/codex): the daemon drives a pinned `codex app-server` over JSON-RPC, in its own Codex home, with the daemon's memory, hooks and skills wired in. This guide covers everyday use. The design and its decisions are in [plans/codex-harness.md](plans/codex-harness.md).

- [Setup](#setup)
- [Commands](#commands)
- [Safety model](#safety-model)
- [Memory, hooks and skills inside the harness](#memory-hooks-and-skills-inside-the-harness)
- [Windows](#windows)
- [Files and environment variables](#files-and-environment-variables)
- [When something goes wrong](#when-something-goes-wrong)

---

## Setup

1. **Install** with the one-liner (see the [README](../README.md#quick-start)). `npm install` pulls the pinned `@openai/codex`; you don't need Codex installed separately.
2. **Log in** once. Pick one:

   ```bash
   ad auth login chatgpt                      # ChatGPT plan, in the browser (--device for a code instead)
   ad auth login openai                       # OpenAI API key (hidden prompt, or pipe it on stdin)
   ad auth login openrouter --model <slug>    # OpenRouter key: Claude, Gemini, … through one key
   ad auth status                             # who is logged in, which provider is active (no secrets)
   ```

   Switch between saved providers with `ad auth use openai` or `ad auth use openrouter --model <slug>`. `ad auth logout` signs out; `ad auth logout openrouter` deletes the stored key.

3. **Windows only:** the first run sets up Codex's command sandbox (unelevated). For stronger isolation run `ad sandbox setup --elevated` once (one UAC prompt). See [Windows](#windows).

The harness keeps its own Codex home at `~/.agent-daemon/codex-home`, and its own pinned Codex binary under `runtime/node_modules`. Your own Codex is never changed:
- The harness refuses to run Codex in `~/.codex`, in a `CODEX_HOME` your shell sets, or in any path that leads there (junctions, `\\?\`, a trailing dot or space).
- It never runs your global `codex` binary.
- It never passes your `CODEX_*` variables to its engine (`CODEX_CA_CERTIFICATE` excepted).

The one thing that reads your Codex data is the optional `ad watch` daemon: it reads `~/.codex/sessions` transcripts to learn from your own Codex sessions. It never writes there.

**Subscriptions.** ChatGPT uses Codex's own login. Claude Pro/Max and Google AI Pro/Ultra logins are never reused: their terms forbid it. For Claude or Gemini models use an API key or OpenRouter. `ad agy` can hand a prompt to *your own* Antigravity CLI (see below).

---

## Commands

### `ad chat`: interactive session

```bash
ad chat                          # in the current folder
ad chat --cwd ../other-repo --model <name>
ad chat --resume <thread-id>     # pick up an earlier thread
```

When the agent wants to run something outside its sandbox or edit outside the workspace, it asks. Answer `y` (once), `a` (always, for this session) or anything else to decline. `Ctrl+C` interrupts a running turn.

| In-chat command | What it does |
|---|---|
| `/help` | list commands |
| `/new` | start a fresh thread |
| `/threads` | recent threads for this folder |
| `/resume <id>` | continue an earlier thread |
| `/model <name>` | use another model from the next turn (`/model` alone: back to the default) |
| `/goal <objective>` | set a durable goal for the thread (`/goal clear` removes it) |
| `/compact` | summarize the thread to free context |
| `/status` | login, model, folder, thread |
| `/exit` | quit |

### `ad tui`: the terminal UI (early)

```bash
ad tui                           # in the current folder
ad tui --last                    # continue the newest conversation here
ad tui --resume <thread-id>      # continue a given one
```

A Codex-style terminal UI on ad's own Codex home. It is new: expect rough edges, and use `ad chat` if something gets in the way.
- **First run in a folder:** ad asks once whether you trust it. Trusted folders may load their own `.codex` config, hooks and skills.
- **Not signed in:** a sign-in panel offers ChatGPT, an OpenAI key or OpenRouter. It runs `ad auth login …` for you.
- **Keys:**
  - Enter sends. While a turn runs, Enter steers it and Tab queues the prompt for afterwards; Tab on an empty composer pulls the last queued prompt back.
  - The newline key depends on the terminal: Shift+Enter in Zed, Ctrl+Enter in Windows Terminal, Ctrl+J anywhere, or `\` + Enter.
  - Esc interrupts. Ctrl+C closes a popup, then clears the composer, then interrupts; pressing it twice quickly quits.
  - ↑/↓ walk your prompt history (`~/.agent-daemon/tui/history.jsonl`), Ctrl+R searches it, `?` shows every shortcut.
  - `@` completes file names, `/` completes commands, `!cmd` runs a shell command (unsandboxed, like Codex's).
  - Esc twice on an empty prompt rewinds the conversation to an earlier prompt and puts that prompt back to edit. Files on disk stay as they are.
  - Ctrl+T pages through the whole transcript, and Ctrl+G edits the prompt in your editor (`$VISUAL` / `$EDITOR`, else Notepad or vi).
  - Alt+, and Alt+. lower or raise the reasoning effort.
  - **Images:** paste or drag an image file's path, or use `/image <path>`, to attach it to the next prompt.
- **Approvals:** a prompt lists what Codex offers (yes, yes for this session, "don't ask again for this prefix", no). Keys pressed in the first 400 ms are ignored, so type-ahead never approves. Hidden characters in commands are shown as `<U+…>`.
- **Commands:**
  - **Conversations:** `/new`, `/resume`, `/fork`, `/rename`, `/compact`, `/export` (markdown, in this folder).
  - **Settings:** `/model`, `/permissions`, `/login`, `/logout`.
  - **Work:** `/goal`, `/review`, `/diff`, `/init`, `/image`.
  - **Output:** `/copy` (the last answer, to the clipboard), `/raw` (the last answer as plain text).
  - **Inspection:** `/status`, `/usage`, `/mcp`, `/hooks`, `/skills`, `/warnings`.
  - **ad:**
    - `/remember`.
    - `/memory` (`search <words>`, `recent`, `forget <id>`, `profile`).
    - `/private` wraps your prompts in `<private>`, so ad never learns from them.
    - `/proposals`.
    - `/loop "<objective>"` runs `ad loop` in the background with its brakes; one row per iteration. `/loop stop` ends it.
    - `/team`, `/schedule` (`run <id>`), `/tools`, `/codex`, `/ad <command>`.
  - **Rows and warnings:** after a turn, a "Learned:" row shows what ad's hooks recorded. If a scheduled job is overdue, the header says the scheduler isn't running.
  - **Help:** `/terminal-setup` (how to make Shift+Enter add a newline in your terminal), `/help`, `/quit`.
- **`/codex`** opens the stock Codex UI on the same conversation (ad lets go of it meanwhile) and comes back when you quit it.
- **On exit** ad prints how to continue: `ad tui --resume <id>`.
- **Requirements:** an interactive terminal, and on Windows Node 22.17+ or 24.2+. Otherwise use `ad chat`.

`ad tui --preview` still runs the earlier walking skeleton.

### `ad codex`: the stock Codex UI on ad's home

```bash
ad codex                         # the pinned Codex's own UI
ad codex resume --last           # any codex arguments
```

The pinned Codex, with `CODEX_HOME` set to ad's home (never `~/.codex`) and `--no-daemon`, so it never talks to your own Codex. Your `~/.claude/skills` are mirrored into the home's `skills/` folder first; folders you put there yourself are never touched. Project `.claude/skills` aren't visible in `ad codex`.

### `ad tui --preview`: the walking skeleton

This is the earlier preview of the Codex-style terminal UI. History stays in your terminal's own scrollback, so scrolling, selecting and copying work as usual. Only the bottom few lines (the composer and the footer) are redrawn.
- **Keys:**
  - Enter sends.
  - The newline key depends on the terminal: Shift+Enter in Zed, Ctrl+Enter in Windows Terminal, Ctrl+J anywhere.
  - Esc interrupts a running turn. Ctrl+C clears the composer, and quits when the composer is empty.
- **Approvals:** answer them with `y`, `a` (always, this session) or `n` / Esc. Pastes and other keys never answer an approval.
- **Commands:** the in-chat commands above work too.
- **Requirements:** an interactive terminal, and on Windows Node 22.17+ or 24.2+. Otherwise use `ad chat`.

To try the terminal layer on its own, with no engine and no login, run `node runtime/scripts/tui-demo.mjs`.

### `ad run`: one turn, no questions

```bash
ad run "fix the failing test in math.test.js"
ad run "summarize the open TODOs" --sandbox read-only
ad run "…" --json                # one JSON line: threadId, turnId, status, output, error
```

Nobody can answer approvals in `ad run`, so anything that needs one is declined and the agent works around it. Exit code: `0` when the turn completed, `1` otherwise.

### `ad loop`: work until done

```bash
ad loop "make the build green"
ad loop "migrate the tests to node:test" --max-iterations 10 --max-minutes 30 --max-tokens 2000000
ad loop --resume <thread-id>     # continue a thread's goal
```

The model doesn't decide when to stop; the daemon does. Each turn must end with a `LOOP_STATUS` line, and the loop stops when:

- the agent reports both `done` **and** `exit_signal` (dual exit), or
- the circuit breaker trips: 3 turns with no file changes, no commands and no new progress text; the same error 5 times; or 3 failed turns in a row, or
- a budget runs out: iterations (default 20), minutes (default 60) or tokens, or
- a STOP file appears: `.agent-daemon/STOP` (this project) or `~/.agent-daemon/STOP` (every loop). It's checked between and during turns. An existing STOP file also refuses to start a loop.

Every iteration is logged to `.agent-daemon/loops/`. Exit code: `0` when the objective is done, `3` when a brake stopped it, `1` on a setup error.

### `ad schedule`: recurring jobs

```bash
ad schedule add "0 9 * * 1-5" run "summarize yesterday's commits" --cwd ~/code/app
ad schedule add "*/30 * * * *" loop "keep the docs build green"
ad schedule list
ad schedule run <id>             # run once now
ad schedule disable <id> | enable <id> | remove <id>
```

Jobs use standard 5-field cron syntax. They're run by `ad watch` (or the registered service, `ad service install`), so one of those must be running. A job never overlaps itself. Output goes to `~/.agent-daemon/schedule-logs/<id>.log`.

### `ad web`: local web UI

```bash
ad web                           # prints http://127.0.0.1:<port>/#t=<token>
ad web --port 8787
```

Chat with approvals, threads, loops and schedules in the browser. It binds to `127.0.0.1` only, and the printed link carries a random access token. Don't share it.

### `ad acp`: use the daemon as an editor agent

`ad acp` serves the [Agent Client Protocol](https://agentclientprotocol.com) (v1) on stdio, so ACP editors (Zed, JetBrains, …) can drive the harness. Approvals appear as the editor's permission prompts. Register `ad` with the argument `acp` as a custom agent in your editor. See its ACP documentation for where that setting lives.

### `ad tools`: optional agent tools

```bash
ad tools list
ad tools enable browser          # Playwright MCP (browser automation)
ad tools enable web-search       # live web search (default is cached)
ad tools disable browser
```

### `ad agy`: hand a prompt to your own Antigravity CLI

```bash
ad agy "explain this stack trace" --accept-risk   # --accept-risk is needed once
ad agy "refactor utils.js" --edits                # let agy edit files
```

Opt-in, and it uses *your* installed Antigravity CLI and its login. The daemon never touches Google credentials.

### Team workers

`ad sp` (spawn) now starts **Codex workers** by default; see [Multi-agent orchestration](../README.md#multi-agent-orchestration). `--engine claude` (or `AD_AGENT_ENGINE=claude`) spawns headless `claude` as in v1.

---

## Safety model

| Mode | Used by | Sandbox | Approvals |
|---|---|---|---|
| Interactive | `ad chat`, `ad web`, `ad acp` | `workspace-write`: writes only inside the project | asks you |
| One-shot | `ad run` | `workspace-write` (or `--sandbox`) | declined |
| Unattended | `ad loop`, team workers, `loop` schedule jobs | workspace only, **no network** | never asked |

Unattended runs also switch off every MCP server except the daemon's memory, and downgrade live web search to cached. On Windows they refuse to start without a ready sandbox. Team workers can't write `.git`: the daemon commits their work on their own branch, with repo hooks disabled for that commit.

`--sandbox danger-full-access` turns the sandbox off for `ad run` / `ad chat`. Use it only in a throwaway environment.

**Keys.** OpenRouter keys are stored with DPAPI on Windows, libsecret on Linux (falling back to a 0600 file) and a 0600 file on macOS. They never go into config or argv, and `OPENROUTER_API_KEY` is removed from the agent's shell. ChatGPT / OpenAI logins are kept by Codex in the harness home (`auth.json`).

---

## Memory, hooks and skills inside the harness

Every harness run gets the same daemon features as a Claude Code session:

- **Memory in:** the SessionStart hook injects project memory and recent learnings, and each prompt recalls relevant learnings.
- **Memory out:** corrections you type are captured, and SessionEnd starts a digest in the background. The agent can also query memory mid-turn through the `agent-daemon-memory` MCP server.
- **Guards:** the PreToolUse hooks from your install profile (for example blocking `--no-verify`) run on the agent's commands.
- **Skills:** `~/.claude/skills/` and the project's `.claude/skills/` are registered as Codex skills.
- **Instructions:** the constitution is added to the harness's `AGENTS.md` (a managed block; your own text there is kept).

Loop and worker prompts are marked as non-user (`AD_WORKER=1`), so they never end up in memory as your corrections.

---

## Windows

- **Sandbox.** `ad sandbox status` shows readiness. The default is unelevated, and its sandbox identity is kept per Codex home, so it is separate from your own Codex. `ad sandbox setup --elevated` is stronger (one UAC prompt), but it is **machine-wide**: it creates Windows sandbox accounts and rules that your own Codex uses too.
- **PowerShell from the Microsoft Store** can't be launched by the sandbox. Since 2.0.1 the harness keeps `WindowsApps` off the engine's PATH, so Codex uses an installed pwsh 7 or `powershell.exe`.
- **`node --test` fails with `spawn EPERM`** in the unelevated sandbox, because Node can't start child processes there. The agent can run test files directly (`node file.test.js`). `--elevated` may lift this, but that's untested.

---

## Files and environment variables

| Path | What |
|---|---|
| `~/.agent-daemon/codex-home/` | harness Codex home: `config.toml`, `hooks.json`, `AGENTS.md`, login `auth.json`, `sessions/` rollouts, `logs_2.sqlite` |
| `~/.agent-daemon/secrets/` | provider keys (file backends) |
| `~/.agent-daemon/schedules.json`, `schedule-logs/` | scheduled jobs and their output |
| `<project>/.agent-daemon/loops/` | `ad loop` iteration logs |
| `<project>/.agent-daemon/STOP` | stop file for loops in this project |

| Variable | Effect |
|---|---|
| `AD_CODEX_HOME` | use another harness Codex home (never your own `~/.codex` or `CODEX_HOME`: refused) |
| `AD_CODEX_BIN` | run a specific `codex` binary instead of the pinned one (testing) |
| `CODEX_*` (yours) | not passed to the harness's Codex, so they can't point it at your own state; `CODEX_CA_CERTIFICATE` is kept |
| `AD_ENGINE_HOME` | set by ad on the Codex processes it starts (hooks use it); don't set it yourself |
| `AD_AGENT_ENGINE` | `codex` (default) or `claude` for team workers |
| `AD_LLM_BACKEND` | `claude`, `codex` or `auto` for digest / GEPA LLM calls (same as `--llm`) |
| `AD_CODEX_LLM_MODEL` | model for those calls when they run on Codex |
| `AD_SECRETS_BACKEND=file` | store keys in plain 0600 files instead of the OS store |

---

## When something goes wrong

1. `ad doctor`: engine version, login, hooks trusted, Windows sandbox.
2. `ad auth status` and `ad sandbox status`.
3. [troubleshooting.md](troubleshooting.md), entries 14–22.
4. Codex's own log: `logs_2.sqlite` in the harness home (table `logs`). The [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill shows how to read it.
