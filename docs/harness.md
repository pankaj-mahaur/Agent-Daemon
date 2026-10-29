# Agent harness guide

Since v2, agent-daemon runs agents itself. The engine is a pinned copy of the open-source engine in `@openai/codex` (Apache-2.0; see `THIRD_PARTY_NOTICES.md`): the daemon drives its app-server over JSON-RPC, in its own home, with the daemon's memory, hooks and skills wired in. This guide covers everyday use. The design and its decisions are in [harness-design.md](harness-design.md).

- [Setup](#setup)
- [Commands](#commands)
- [Safety model](#safety-model)
- [Memory, hooks and skills inside the harness](#memory-hooks-and-skills-inside-the-harness)
- [Windows](#windows)
- [Files and environment variables](#files-and-environment-variables)
- [When something goes wrong](#when-something-goes-wrong)

---

## Setup

1. **Install** with the one-liner (see the [README](../README.md#quick-start)). `npm install` pulls the pinned `@openai/codex`; you don't need your own install of the engine separately.
2. **Log in** once. Pick one (an OpenAI API key or an OpenRouter key first, a ChatGPT plan last):

    ```bash
    ad auth login openai                       # OpenAI API key (hidden prompt, or pipe it on stdin)
    ad auth login openrouter --model <slug>    # OpenRouter key: Claude, Gemini, … through one key
    ad auth login chatgpt                      # ChatGPT plan, in the browser (--device for a code instead)
    ad auth status                             # who is logged in, which provider is active (no secrets)
    ```

    Switch between saved providers with `ad auth use openai` or `ad auth use openrouter --model <slug>`. `ad auth logout` signs out; `ad auth logout openrouter` deletes the stored key.

3. **Windows only:** the first run sets up the engine's command sandbox (unelevated). For stronger isolation run `ad sandbox setup --elevated` once (one UAC prompt). See [Windows](#windows).

The harness keeps its own engine home at `~/.agent-daemon/engine`, and its own pinned engine binary under `runtime/node_modules`. Your own install is never changed:
- The harness refuses to run the engine in `~/.codex`, in a `CODEX_HOME` your shell sets, or in any path that leads there (junctions, `\\?\`, a trailing dot or space).
- It never runs your own global install.
- It never passes your `CODEX_HOME`, `CODEX_API_KEY` and similar variables to its engine (`CODEX_CA_CERTIFICATE` excepted).

The one thing that reads your own install's data is the optional `ad watch` daemon: it reads `~/.codex/sessions` transcripts to learn from your own sessions. It never writes there.

**Subscriptions.** ChatGPT sign-in uses the engine's own login. Claude Pro/Max and Google AI Pro/Ultra logins are never reused: their terms forbid it. For Claude or Gemini models use an API key or OpenRouter. `ad agy` can hand a prompt to *your own* Antigravity CLI (see below).

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

### `ad` / `ad tui`: the terminal UI

```bash
ad                               # in the current folder (same as ad tui)
ad tui "<prompt>"                # and send a first prompt
ad tui --last                    # continue the newest conversation here (ad --last too)
ad tui --resume <thread-id>      # continue a given one
```

A terminal UI on ad's own engine home. History goes into your terminal's scrollback; only the bottom of the screen is redrawn. If something gets in the way, `ad chat` is the plain line mode.
- **First run:** a sign-in panel if ad isn't signed in (it runs `ad auth login …` for you), then a one-time trust question per folder.
- **Keys:** Enter sends, and steers a running turn. Tab queues a prompt for after the turn. Esc interrupts. The newline key depends on the terminal (Shift+Enter in Zed, Ctrl+Enter in Windows Terminal, Ctrl+J or `\` + Enter anywhere). `?` shows every shortcut.
- **Approvals** list what the engine offers. An answer that grants something is taken only 400 ms after the box opens, so type-ahead never approves, and hidden characters show as `<U+…>`.
- **Commands:** the engine's (`/new`, `/clear`, `/resume`, `/archive`, `/delete`, `/model`, `/review`, `/diff`, `/compact`, `/statusline`, `/title`, …) keep the engine's meaning and rules; one ad doesn't have yet answers why instead of reaching the model ([commands.md](commands.md) lists every one). ad adds `/undo` (put back the files the last turn changed), `/memory`, `/remember`, `/private`, `/proposals`, `/loop`, `/team`, `/schedule`, `/tools`, `/image`, `/login` and `/ad <command>`.
- **Bare `ad`** opens the TUI where the terminal can show it. `AD_TUI=0` turns that off: bare `ad` prints the help, and `ad --last` points you at `ad tui --last`.
- **Requirements:** an interactive terminal, and on Windows Node 22.17+ or 24.2+. Otherwise use `ad chat` (with `/resume` to continue a conversation).

Keys, commands, `/undo`, terminals and the files it writes: **[tui.md](tui.md)**.

### `ad codex` is gone

`ad codex` (the engine's own UI) was removed in 3.0. It now prints what to use instead: `ad --last` resumes a conversation, and the engine's settings file holds the settings. Maintainers can still reach the engine's UI with `ad engine ui --debug`.

### `ad tui --preview`: the minimal preview

A minimal, earlier preview of the terminal UI, on the same engine: plain streamed text instead of the full UI. History stays in your terminal's own scrollback, so scrolling, selecting and copying work as usual. Only the bottom few lines (the composer and the footer) are redrawn.
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
ad run "…" --json                # one JSON line: threadId, turnId, status, output, error, target
ad run "…" --account openrouter/work --model qwen3-coder --effort high
```

`--account` takes `provider/label`, a label, or an id (`ad auth list`); an unknown or ambiguous one exits 2 and says what to type. The account and model that run the turn are printed on stderr (`target: OpenRouter · work · qwen3-coder`). `ad loop` and `ad tui` take the same three flags.

Nobody can answer approvals in `ad run`, so anything that needs one is declined and the agent works around it. Exit code: `0` when the turn completed, `1` otherwise, `2` for a usage error or a refusal, `4` when fallback paused (below).

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

Every iteration is logged to `.agent-daemon/loops/`. Exit code: `0` when the objective is done, `3` when a brake stopped it, `4` when fallback paused, `1` on a setup error.

### `ad schedule`: recurring jobs

```bash
ad schedule add "0 9 * * 1-5" run "summarize yesterday's commits" --cwd ~/code/app
ad schedule add "*/30 * * * *" loop "keep the docs build green"
ad schedule list
ad schedule run <id>             # run once now
ad schedule disable <id> | enable <id> | remove <id>
```

Jobs use standard 5-field cron syntax. They're run by `ad watch` (or the registered service, `ad service install`), so one of those must be running. A job never overlaps itself. Output goes to `~/.agent-daemon/schedule-logs/<id>.log`, and each run leaves `<id>.status.json` (`{at, exitCode, status, reason, switchedTo}`, status `completed`, `failed`, `refused`, `stopped` or `paused`); `ad schedule list` shows the last one (`paused: …`, `ok, last run switched to …`).

### Fallback in unattended runs

When a limit runs out with nobody watching, a run can continue on the next model in your fallback order (`ad fallback`), as `ad tui` does. It needs your yes twice: the order turned on (`ad fallback enable`), and this run's own opt-in:

```bash
ad run "…" --fallback
ad loop "…" --fallback
ad schedule add "0 2 * * *" loop "…" --fallback      # or: ad schedule edit <id> --fallback | --no-fallback
ad team set <team> fallback on                        # the team's workers
```

- **Refused (exit 2)** when the order is off, when an account in it changed since you confirmed it, or from the agent's own shell: granting or changing fallback is a terminal-only decision. A scheduled job or a team worker uses the grant you made.
- **What it does.** The same rules as in `ad tui`: only at the end of a turn, only for a used-up limit, a rate limit, a network or a provider error; never another account of a provider that just ran out; a tool that ran is never run again. The new model gets a fresh thread with this run's own settings (sandbox, approvals, the loop's instructions) and ad's request to carry on. stderr says so: `[ad] ↪ Switched to Gemini API · gemini-2.5-flash: OpenRouter's free daily limit is used up (resets 05:30). Fallback 1 of 3.`
- **Nobody to ask: it pauses instead,** and never waits for a reset. Exit code `4`, stderr `[ad] ⏸ Paused: <why>. Work so far is saved (session ses_…).` `ad run --json` adds `"status": "paused"`, `"reason"`, `"sessionId"`; a completed run adds `"target"` (the model that finished) and `"fallback"` (each switch). A paused team worker shows as blocked on the board, with the reason.
- **`ad loop`.** A turn fallback moved is logged `switched` (and as a `fallback` line in the same log), never counts toward the failed-turn or same-error brakes, and the next prompt says where the loop is now. The token budget counts every model.
- **Without the opt-in nothing changes,** except one line when a run hits a limit while your order is on: `Fallback is on in your settings but not for this run: add --fallback.` (`"hint"` in `--json`; for a job, the `ad schedule edit` command; for a worker, `ad team set`). `AD_FALLBACK=0` turns fallback off even for a run that opted in.

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

`ad sp` (spawn) now starts **engine workers** by default; see [Multi-agent orchestration](../README.md#multi-agent-orchestration). `--engine claude` (or `AD_AGENT_ENGINE=claude`) spawns headless `claude` as in v1.

- **Names.** Team ids, roles and agent names become part of a git branch and a folder name, so they can use only letters, digits, `.`, `_` and `-` (at most 64 characters, starting with a letter or digit). `--model` takes a model id (letters, digits and `._:/@+-`).
- **How a worker starts.** No shell is involved: the task reaches Claude Code on stdin and in a temporary system-prompt file (`--append-system-prompt-file`, removed when the worker ends), never on a command line. On Windows ad starts `claude` and `git` by their full path from PATH, so a `claude.exe` or `git.exe` inside a repo never runs. An npm-installed `claude.cmd` works: ad runs the script it starts with its own Node. Set `AD_CLAUDE_BIN` to use a specific Claude Code (`claude.exe` or its `cli.js`).
- **Claude workers' permissions.** A Claude worker runs with `--dangerously-skip-permissions`: it can run any command as you and reach the network, and its worktree is not a sandbox. Use it only for tasks you'd run yourself. The default `ad` worker is sandboxed (below).

---

### Models, prices, limits and spend

```bash
ad auth models openrouter/work            # its models: tools, context, price, route
ad auth models openrouter/work --refresh  # ask the provider again (at most every 10 minutes)
```

ad keeps what it has seen about each account, so that a later switch or fallback knows what a target can do and whether it can take work. It never polls: everything comes from what passes anyway.

- **Models and prices** (`~/.agent-daemon/catalog/`): from the provider's own model list, on demand. A model is **free** only when every price it lists is exactly zero and that was seen under 24 hours ago, or the server is local. A `:free` name alone doesn't count, a subscription is never "free", and a price nobody reported is shown as **price unknown**, never as zero.
- **Limits** (`~/.agent-daemon/quota/observations.json`): from the provider's rate-limit headers and errors as ad's gateway sees them, ChatGPT's own limit reports, and OpenRouter's key data, read once after a 429 (at most every 30 s). A limit past its reset time, or older than 6 hours, is **unknown** again, never "ok".
- **Benched providers**: when an account hits its quota or a rate limit, that provider (every account of it) is benched until the reset (24 hours when none is known for a quota, 10 minutes for a rate limit), across windows and restarts, so an automatic move never just rotates to another key of the same provider.
- **Spend** (`~/.agent-daemon/quota/spend.json`, per account per day): usage × price for each answer the provider bills. An answer that doesn't report its usage is charged pessimistically (the request's size as input, the model's maximum output). Rejections (429, 5xx) cost nothing. ChatGPT accounts are subscriptions and aren't counted.
- **Why a turn failed** is recorded in the session record (`ad sessions show`): from the provider's real answer when ad's gateway saw it, else from the engine's own code. Only a rate limit, a used-up quota, a network failure or a provider's server error can ever move work elsewhere; anything ad can't place for sure is `unknown` and moves nothing. "Upgrade to Plus" from ChatGPT means the plan doesn't include it: no switch can wait that out.

Deleting `catalog/` and `quota/` loses only these caches: every target reads "unknown" until it is seen again.

### The fallback order: `ad fallback`

You choose, ahead of time, where ad may continue a task when a model's limit runs out or its provider fails, and on what rules. With it on, `ad tui` moves the conversation there by itself at the end of the failed turn (see [tui.md](tui.md#automatic-fallback) for what you see, and when it pauses instead). It is off until you turn it on; `AD_FALLBACK=0` turns it off for a run whatever the file says.

How the move stays safe:
- **Turn boundaries only.** A failed turn's tools have all settled by then: the pinned engine runs a tool the model asked for once, and carries its result into its single retry, even when the stream dies right after the call. A tool whose end is unknown pauses instead.
- **Bounded retries.** API accounts already go through ad's gateway with one retry each; while fallback is on, a ChatGPT sign-in's engine also stops reconnecting forever (`features.unbounded_connection_retries=false`, from its next start). On top of that, a turn that keeps retrying is stopped when the order's "give up after" time runs out, its goal paused first; the interrupt is recorded with its cause, so it never counts as yours.
- **Recorded.** Each step is in the session record (`ad sessions show`): `routeFailure`, `fallbackInterrupt`, `switchCommitted` with reason `policy`, `paused` with why. A window that restarts mid-way rebuilds where it was, and the session list shows a paused session as `paused`.

```bash
ad fallback add openrouter/work:qwen/qwen3-coder:free   # account[:model]; --effort, --at <N>
ad fallback add gemini --model gemini-2.5-flash          # a trial or free-tier endpoint asks first
ad fallback add chatgpt --model gpt-5.5 --effort medium
ad fallback                                              # the order, what can continue now, and why not
ad fallback preview --error quotaExhausted               # what would happen now, step by step
ad fallback enable                                       # shows every destination, then asks
```

- **The file** is `~/.agent-daemon/fallback.json`. Every change is checked first and refused if it adds a problem ("… bills per use. 'No extra spend' allows free models and plans you already pay for."). A problem that was already there (an account removed since) never blocks removing it or `ad fallback disable`.
- **Cost rule.** `noExtraSpend` (the default): free models and plans you already pay for. `freeOnly`: free models and local servers only. A model is free only from a fresh price check (see above); a model whose billing ad doesn't know is never used.
- **Trial and free-tier endpoints** (NVIDIA's trial catalog, Gemini's free tier, which may use what you send) each need your own yes when you add them. `ad fallback set trial never` refuses them; `allow` stops asking.
- **What it switches on:** only a used-up limit, a rate limit, a network failure or a provider's server error. Never on sign-in, plan or policy problems: those need you.
- **Limits:** `set max-hops` (targets one task may move through, 1–5), `set max-switches` (per hour, 1–20), `set give-up` (seconds of trying, 10–600).
- **Another account of the same provider** is used only while that provider hasn't hit a limit. A provider that ran out is skipped, on every account, until it resets, also when another window saw it.
- **Long-running commands.** `set keep-running "npm run dev"` lists commands a switch may leave running; a bare `npm`, `node`, `bash` and the like are refused (they would allow almost anything).
- **Consent.** `ad fallback enable` lists every target and what its provider does with your data, then asks. It runs only in your own terminal: `--yes` skips the question there (the text goes to stderr), never the terminal, since an agent in another tool has no `AD_TOOL_SHELL` but no terminal either. Confirming a trial endpoint and `test --live` work the same way. What you confirmed is fingerprinted: the order, each account's identity, workspace, base URL, key revision and sign-in folder, the cost and trial rules, the keep-running list. Changing any of them, re-signing an account into another identity included, turns fallback off until you confirm again ("Fallback is off until you confirm the new order: ad fallback enable"). Lowering the limits doesn't. A ChatGPT sign-in whose account ad hasn't recorded yet is tied to its sign-in folder only; the consent says so.
- **The agent can't change it.** In the shells ad's agent runs commands in (`AD_TOOL_SHELL=1`), `ad fallback add`, `remove`, `order`, `move`, `set`, `enable` and `test --live` refuse: "ad fallback can't be changed from the agent's own shell. Run it in your terminal." Listing, preview, the dry test and `disable` still work there.
- **`ad fallback test`** checks each target without sending anything: account ready, model listed, limits as last seen. `--live` sends one tiny request to each API account (it asks first; it counts against free limits). A ChatGPT sign-in is never tested by starting a second engine.
- **Undo:** `ad fallback disable`, or delete `fallback.json`.

### The session record: `ad sessions show`

```bash
ad sessions show --last          # the newest session: bindings, turns, tool calls
ad sessions show ses_01J… --json # one session as JSON
```

ad keeps its own record of each conversation you start in `ad tui`, `ad run` or `ad loop`, from the first prompt on. It says which engine home, conversation and target (account, provider, model, effort) ran each turn, who started the turn (`user`, `ad`, `goal`, `subagent` or `engine`), and what each tool call did: its effect (`read`, `exec`, `write`, `external`, `agent`) and how it ended (`succeeded`, `failed`, `declined`, or `unknown` when the turn or the engine ended first). Switching accounts later (M4) builds on it.

- **What it never holds:** never reasoning, a question's or form's answer, file contents, command output, headers or keys. Prompts, summaries and error messages are cut to size and have keys redacted; a `/private` prompt is stored without its text. Paths in the project are relative; others under your home folder start with `~`.
- **A command is a read only when ad can prove it.** ad checks the command line itself (no redirect, no `tee`, no `find -delete`, only known read commands); the engine's own summary of a command never makes it a read.
- **One window per session.** A second window on the same conversation says "This session is open in another ad window" and records nothing.
- **Off switch:** `AD_LEDGER=0`. Deleting `~/.agent-daemon/sessions/` loses only this record; conversations stay in the engine's folder.

## Safety model

| Mode | Used by | Sandbox | Approvals |
|---|---|---|---|
| Interactive | `ad tui`, `ad chat`, `ad web`, `ad acp` | `workspace-write`: writes only inside the project | asks you |
| One-shot | `ad run` | `workspace-write` (or `--sandbox`) | declined |
| Unattended | `ad loop`, team workers, `loop` schedule jobs | workspace only, **no network** | never asked |

Unattended runs also switch off every MCP server except the daemon's memory, and downgrade live web search to cached. On Windows they refuse to start without a ready sandbox. Team workers can't write `.git`: the daemon commits their work on their own branch, with repo hooks disabled for that commit.

`--sandbox danger-full-access` turns the sandbox off for `ad run` / `ad chat`. Use it only in a throwaway environment.

**Keys.** OpenRouter keys are stored with DPAPI on Windows, libsecret on Linux (falling back to a 0600 file), and on macOS in the keychain when the optional `@napi-rs/keyring` module is installed (else a 0600 file; `ad doctor` says which). They never go into config or argv, and `OPENROUTER_API_KEY` is removed from the agent's shell. ChatGPT / OpenAI logins are kept by the engine in the harness home (`auth.json`).

**The gateway.** API keys never reach the engine, its hooks or the tools it runs:
- **How it works.** ad starts a small local gateway (a child process on `127.0.0.1`) and gives the engine only a per-run token (`AD_GATEWAY_TOKEN`) and an address per account. The gateway checks the token, adds the account's key on the way out, and streams the answer back unchanged.
- **What it watches.** Each answer's status, rate limits and usage; that is how ad can later say "OpenRouter's free limit resets at 05:30".
- **What the token can do.** Spend through the gateway while this ad runs. It can never reveal a key, and tool shells don't get it.
- **What can see the token.** Hook processes inherit it with the engine's environment, and an MCP server sees it only if a config names it in `env_vars`.
- **Its limits.** It never follows a redirect with a key, and sends keys over https only (a local endpoint may use http).
- **Long waits.** A provider asking to wait longer than a minute ends the turn at once with the provider's own message, instead of sleeping for an hour.

**Accounts.** ad keeps a list of accounts (`~/.agent-daemon/accounts/registry.json`): each has an id, a label, an owner tag and where its credential lives, and never the credential itself (an API key shows only its last 4 characters). ad 3.0's sign-in and OpenRouter key become accounts by themselves, without moving or rewriting anything 3.0 uses, so going back to 3.0 still works. An interrupted sign-in or key change leaves something `ad auth repair` finishes (it asks before deleting a key).

**Adding accounts.** `ad auth login <provider>` adds an API key (OpenAI, OpenRouter, Kimi, Moonshot, xAI, Fireworks), your own endpoint or a local server; see [accounts.md](accounts.md) for providers, free models and what ad doesn't offer.

**Which account a conversation uses.** ad decides before any engine starts, and the first message already goes to that account. The first of these that names an account wins:
1. `--account <provider>/<label>` (or `/model`, `/account` in the terminal UI);
2. what this window picked;
3. `AD_ACCOUNT` (with `AD_MODEL`), a default for whatever you launch;
4. the project's `.agent-daemon/config.json` `"target": {"provider", "label", "model", "effort"}`, read only in a folder you trusted, and shown as "This project picks …";
5. the default account;
6. what ad 3.0 used.

An account that needs its key or sign-in again stops the start with the command that fixes it. A conversation keeps the account it started on. Switching to another account of the same provider (same model) continues it as a copy on the new account; anything else starts a new conversation. Background terminals keep running in the old one, and `/undo` checkpoints stay with it.

**What a tool can still reach.** The file backend's keys and the `.dpapi` files can be read (and DPAPI files decrypted) by programs the agent runs as you, until ad can deny those reads to its tools (planned with the gateway). `ad doctor` notes this on the Secret store line.

### Working in your home folder

Open ad in a project folder. If you start it in your home folder and your own `~/.codex/` (from your own install of the engine ad runs on) has skills, `ad` first shows **Pick a project folder**: your last project is selected, so Enter opens it. The engine would otherwise load those skills into every conversation there, because it reads a folder's `.codex/` as project settings, and it adds that folder's skills even while the folder isn't trusted.

- The same applies to any folder under a home folder that is a git repository, since the repository's root is then your home.
- A `~/.codex/` with no skills (or no `~/.codex/` at all) is never a reason: ad opens directly. One exception: if your home folder is a git repository and `~/.codex/config.toml` has settings, ad doesn't offer to trust a folder inside it that has no git repository of its own, because trusting that folder would also apply those settings there. A folder trusted that way earlier gets the launcher.
- `/cd` into such a folder is refused with the same reason. `ad run`, `ad chat` and `ad loop` still run there in 3.0.x and say so once per folder. From 3.1 they need `--allow-home-folder`. `ad schedule add` there needs the flag now. Scheduled jobs and team workers that already worked there keep running, with a note, and `ad doctor` lists them under "Home-folder jobs".
- To work there anyway, use one of the overrides. Each makes ad print one note saying your skills load in that session:
  - `--allow-home-folder` on `ad`, `ad tui`, `ad chat`, `ad run`, `ad loop` or `ad schedule add`;
  - `AD_ALLOW_HOME_FOLDER=1`;
  - the launcher's **Always open home without asking**. It saves `"allowHomeFolder": true` in `~/.agent-daemon/tui/prefs.json`; delete the key to undo.

ad never uses folder trust for this. It doesn't mark your home folder `untrusted`, which would change the approvals and sandbox there. If ad's engine settings trust your home folder (from an older version or the engine's own UI), ad removes that entry when it starts and says so once. Folders you trusted yourself are unchanged.

`~/.agents/skills` and a project's own `.codex/` and `AGENTS.md` still load: `~/.agents/skills` is the folder agents share on purpose. On Windows the engine finds `~/.agents/skills` in your real profile folder even when `HOME` or `USERPROFILE` point elsewhere.

The engine process itself runs in an empty folder, `~/.agent-daemon/launch`, never in your project. So `/mcp` lists the MCP servers from ad's own settings. Servers from a project's `.codex/config.toml` start with that project's conversations, once the project is trusted. To add a server for every project, add it to ad's engine settings (`ad about` shows the path).

---

## Memory, hooks and skills inside the harness

Every harness run gets the same daemon features as a Claude Code session:

- **Memory in:** the SessionStart hook injects project memory and recent learnings, and each prompt recalls relevant learnings.
- **Memory out:** corrections you type are captured, and SessionEnd starts a digest in the background.
- **Memory on demand:** the agent can query memory mid-turn through the `agent-daemon-memory` MCP server, which ad registers in its engine home. Its tools read ad's memory and record usefulness feedback into it, and they run without an approval prompt (`default_tools_approval_mode = "approve"`). A mode you set for that server yourself is kept.
- **Guards:** the PreToolUse hooks from your install profile (for example blocking `--no-verify`) run on the agent's commands.
- **Skills:** `~/.claude/skills/` and the project's `.claude/skills/` are mirrored into the engine home and registered as skills.
- **Instructions:** the constitution is added to the harness's `AGENTS.md` (a managed block; your own text there is kept).

Loop and worker prompts are marked as non-user (`AD_WORKER=1`), so they never end up in memory as your corrections.

---

## Windows

- **Sandbox.** `ad sandbox status` shows readiness. The default is unelevated, and its sandbox identity is kept per engine home, so it is separate from your own install. `ad sandbox setup --elevated` is stronger (one UAC prompt), but it is **machine-wide**: it creates Windows sandbox accounts and rules that your own install uses too. It asks for consent first (`--yes` skips the question off a terminal).
- **PowerShell from the Microsoft Store** can't be started by the sandbox. On Windows, every engine ad starts gets a PATH without any `WindowsApps` folder: neither the per-user app-alias folder nor the Store package folder that PowerShell 7 puts first when you start ad from it. The engine then runs commands, sandboxed, in a PowerShell 7 installed from the MSI or in Windows PowerShell 5.1. Store app aliases (`winget`, the `python` stub) aren't on the agent's PATH either. Fixed in 2.0.1 for the alias folder, completed in 2.1.1 for the package folder; see [troubleshooting #16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-access-is-denied-or-createprocessasuserw-failed).
- **`node --test` fails with `spawn EPERM`** in the unelevated sandbox, because Node can't start child processes there. The agent can run test files directly (`node file.test.js`). `--elevated` may lift this, but that's untested.

---

## Files and environment variables

| Path | What |
|---|---|
| `~/.agent-daemon/engine/` (new installs; older installs: `codex-home/`) | engine home: `config.toml`, `hooks.json`, `AGENTS.md`, login `auth.json`, `sessions/` rollouts, `logs_2.sqlite` (see "The engine's folder" below) |
| `~/.agent-daemon/secrets/` | provider keys (file backends) |
| `~/.agent-daemon/accounts/` | the account list (`registry.json`, its `.bak`) and `settings-record.json` (your `[tui]` settings and folder trust, copied from the engine's folder); never a key |
| `~/.agent-daemon/api/` | the engine folder for API-key accounts once the main one holds a ChatGPT sign-in (see "The engine's folder") |
| `<project>/.agent-daemon/config.json` | `target`: the account this project picks (trusted folders only) |
| `~/.agent-daemon/schedules.json`, `schedule-logs/` | scheduled jobs and their output |
| `<project>/.agent-daemon/loops/` | `ad loop` iteration logs |
| `<project>/.agent-daemon/STOP` | stop file for loops in this project |
| `~/.agent-daemon/catalog/`, `~/.agent-daemon/quota/` | what ad has seen of each account's models and prices, limits, benched providers and today's spend (caches; see "Models, prices, limits and spend") |
| `~/.agent-daemon/fallback.json` | the fallback order, its rules and what you confirmed (see "The fallback order") |
| `~/.agent-daemon/sessions/` | the session record: `ses_<id>.jsonl` per session and `index.json` (owner-only); never reasoning, a question's or form's answer, file contents, command output, headers or keys (see "The session record") |
| `~/.agent-daemon/tui/`, `~/.agent-daemon/locks/` | `ad tui` prompt history and per-folder state; conversation locks (see [tui.md](tui.md#files-ad-writes)) |

| Variable | Effect |
|---|---|
| `AD_LEDGER` | `0`: ad keeps no session record (`~/.agent-daemon/sessions/`) |
| `AD_FALLBACK` | `0`: automatic fallback does nothing in this run, whatever `~/.agent-daemon/fallback.json` says |
| `AD_TUI` | `0`: bare `ad` prints the help instead of opening the terminal UI (`ad tui` still opens it). `1`: the default behaviour |
| `AD_ALLOW_HOME_FOLDER` | `1`: work in a folder that would load your own `~/.codex` skills, like `--allow-home-folder` (see "Working in your home folder") |
| `AD_ENGINE_DIR` (old name `AD_CODEX_HOME`, still read) | use another engine home (never your own `~/.codex` or `CODEX_HOME`: refused) |
| `AD_ENGINE_BIN` (old name `AD_CODEX_BIN`, still read) | run a specific engine binary instead of the pinned one (testing) |
| `CODEX_HOME` and similar (yours) | not passed to the harness's engine, so they can't point it at your own state; `CODEX_CA_CERTIFICATE` is kept |
| `AD_INTERNAL_ENGINE_HOME` (old name `AD_ENGINE_HOME`) | set by ad on the engine processes it starts (hooks use it); don't set it yourself |
| `AD_AGENT_ENGINE` | `ad` (default) or `claude` for team workers |
| `AD_CLAUDE_BIN` | the Claude Code to start for Claude workers and digest calls: an absolute path to `claude.exe` (`claude` on macOS and Linux) or to the `cli.js` it runs. Default: `claude` from PATH |
| `AD_LLM_BACKEND` | `claude`, `ad` or `auto` for digest / GEPA LLM calls (same as `--llm`) |
| `AD_HOOK_HOST` | `ad` for hook input/output adaptation |
| `AD_ENGINE_MODEL` (old name `AD_CODEX_LLM_MODEL`, still read) | model for those calls when they run on the engine |
| `AD_SECRETS_BACKEND=file` | store keys in plain 0600 files instead of the OS store |
| `AD_ACCOUNT`, `AD_MODEL` | the account (`<provider>/<label>`, a label, or an id) and model for what you launch, below a window's own choice and `--account` |

## Chat-only providers

Providers that speak only Chat Completions go through a translation in ad's gateway: the engine still sees the Responses API, the provider sees Chat Completions. What a provider can't do is refused before anything is sent, with ad's reason (for example live web search). When such a provider's daily limit is used up, the turn stops at once and ad says so; it isn't retried. `AD_TRANSLATE=0` turns these providers off. Details: [architecture.md](architecture.md#chat-translation-in-the-gateway-p61).

The gateway's token is the engine's only: commands the agent runs see `AD_GATEWAY_TOKEN` empty. This keeps it out of their environment, not out of reach: a process running as you could still read the engine's own environment. The token opens only ad's loopback gateway, for this run.

## The engine's folder

New installs keep the engine's folder at `~/.agent-daemon/engine/`, plus a link named `codex-home` pointing at it (a rolled-back ad 2.x finds the same folder). Installs from before 3.0 keep their `codex-home/` folder untouched; `ad doctor` calls it the older folder name and says `ad migrate` is optional.

`ad migrate` (interactive terminal only) renames `codex-home/` to `engine/` and leaves the link; `ad migrate --undo` reverses it. Nothing is ever moved without you running it: no other command renames the folder, and a folder you chose with `AD_ENGINE_DIR` is never touched. In Git Bash run `winpty ad migrate` (or use PowerShell or Windows Terminal). Both refuse while an ad session is running; close it first.

Which folder runs what:

| Engine folder | Runs |
|---|---|
| `engine/` (the main one) | ad 3.0's sign-in; a ChatGPT sign-in made there; every API-key account while it holds no ChatGPT sign-in |
| `api/` | every API-key account once the main folder holds a ChatGPT sign-in. New API conversations never start next to a ChatGPT sign-in. API conversations 3.0 already wrote there still continue there |

Your `[tui]` settings and folder trust live in the main folder's settings file. Other folders get a copy each time their engine starts, so a hand edit there is overwritten. Edit the main folder's settings: other folders pick your edit up the next time ad starts an engine on the main folder.

What a start does with these names:

- A `codex-home` link you made yourself (to another drive, say) is used as it is. If its target is missing or can't be read, ad refuses to start and names the target ([troubleshooting #40](troubleshooting.md#40-a-start-says-codex-home-points-to-a-folder-that-doesnt-exist)); it never removes or replaces your link.
- If `engine` is a link to `codex-home` (or the other way round), both names are one folder.
- If both are real folders and one holds nothing but ad's first-run files (its marker, the one-line settings file, empty `log/` and `tmp/`), the terminal UI renames that one to `<name>.empty-<date>` and says so. Any other file or setting makes it yours, and ad asks you to choose ([troubleshooting #37](troubleshooting.md#37-two-engine-folders)).
- If `engine/` has no `codex-home` link next to it, the start makes it again; where links can't be made, ad works without it and says so once.

---

## When something goes wrong

Engine failures use ad's words. Read `/warnings` in the terminal UI or the labelled `details:` lines in CLI output for the engine's original diagnostic text. The web UI points to the server log for that detail. See [what ad cannot rename](troubleshooting.md#39-what-ad-cant-rename).

1. `ad doctor`: engine version, login, hooks trusted, Windows sandbox. `ad about` says what ad runs on: ad's version and license, the engine's name, version, license, URL, process name, home and settings path, and the tested engine versions.
2. `ad auth status` and `ad sandbox status`.
3. [troubleshooting.md](troubleshooting.md): entries 14–21 (harness, including the Windows sandbox and Store PowerShell in #16), 22–28 (`ad tui`) and 29 (a slow first command on Windows).
4. The engine's own log: `logs_2.sqlite` in the harness home (table `logs`). The [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill shows how to read it.
