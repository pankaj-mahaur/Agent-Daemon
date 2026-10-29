# Changelog

All notable changes to agent-daemon. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

## [Unreleased]

### Security

- Commands the agent runs no longer see the gateway's token (`AD_GATEWAY_TOKEN` is empty in their environment). Before, a tool could read it and spend your API accounts' quota through ad's gateway.
- One safe way to show memory to an agent: a note that reads like an instruction (an injection, or a command it tells the agent to run, such as notes ad 3.0 stored before its screen) is withheld in the memory tools, at session start and in prompt recall, and every memory result is headed as data, not instructions. `memory_files` treats `%` and `_` in a path literally.
- Claude Code team workers (`ad sp --engine claude`) no longer start through `cmd.exe` on Windows, so a task containing `&`, `|` or `%VAR%` can't run commands on your machine before Claude starts. The task goes to Claude on stdin and in a temporary system-prompt file (`--append-system-prompt-file`), never on the command line. Digest calls through Claude Code do the same.
- On Windows, the worker path starts `claude` and `git`, and the key store starts Windows PowerShell, by full path, so a `claude.exe`, `git.exe` or `powershell.exe` in the repo or the current folder never runs instead.
- `ad sp` checks team ids, roles, agent names and `--model` before anything starts: names can use only letters, digits, `.`, `_` and `-` (max 64).
- No other child process uses a shell or a bare program name either: `ad skill install` (a repo URL with `&` stays one argument), `ad init`'s QMD setup (a folder name with `"` or `&`), `ad viewer --open` (an `--out` name with `&` or `$(…)`), `ad review`'s editor, the terminal UI's editor and `/diff`, SessionStart's git, checkpoints, `taskkill`, `attrib` and the browser opener all start by full path with plain arguments. An editor that is a `.cmd` file still runs through `cmd.exe`, by full path, and ad refuses a file name with `%`, `"` or a line break there.
- **Memory stays in its project.** The memory MCP server is bound to one project when it starts (`--project`, ad's per-conversation folder, Claude Code's project with `--host claude-code`, or a working folder inside a git repo) and no tool argument changes it. `scope: "global"` returns only notes you accepted as global, and an id from another project returns nothing; `memory_feedback` on one changes nothing. A server that can't tell the project (home, a system folder, a plain folder) serves nothing. SessionStart and prompt recall read only the folder's own notes, and serve nothing for home, system folders or ad's own folders.
- **Flagged notes are held back.** A note the injection screen flags is stored as quarantined and served nowhere (older ad versions don't show it either); 3.0's quarantined rows are hidden too.
- **Secrets are filtered out.** Common secret shapes (provider API keys and tokens, private keys, JWTs, `user:pass@` URLs, Bearer and Basic headers, Azure keys, and passwords or keys assigned to a secret-looking name) are replaced with `[redacted:<kind>]` before the learning journal, memory, memory files or skill telemetry see them, and masked when older notes are shown. `/remember` says when it removed one. `ad memory scan` checks older notes once and holds back those holding a provider key or an instruction-override injection.
- **Agent notes wait for you.** A note the agent wrote about itself (from its own turn, or a digest item it marks as its own) is stored as pending until you type it yourself: it isn't added to `activeContext.md`, isn't served, and never becomes a user fact. What you type yourself still applies at once in its project.
- **Nothing goes global by itself.** Notes that sound global stay in their project and are marked for promotion, which you decide in `ad review`; nothing is appended to `~/.agent-daemon/user.md` automatically. User facts are served only in the projects that observed them. Notes ad 3.0 stored as global are served only in the project whose session wrote them. Older ad versions still show those older notes and all user facts everywhere.
- Two folders whose paths map to the same memory key (`/x/a/b` and `/x/a-b`) are withheld from the MCP server, SessionStart and prompt recall until each project gets its own ID.
- ad's engine tool shells carry `AD_TOOL_SHELL=1`, so the memory review commands refuse to run from an agent's shell.
- **Accepting notes is yours alone.** `ad review` (interactive, `--accept <file>`, `--accept-all`, `--global`) and `ad memory promote` refuse inside an agent's tool shell and without a terminal, and ask you to type `accept` (or the count, for a batch). There is no `--yes`. You confirm the note as the memory store holds it, and a proposal file can only accept a pending note of its project or promote one that asked for it, so a forged file can't make a private note global.
- **Capture never adds a folder to a repo you didn't set up.** The learning journal, proposals, session log and telemetry of a folder without its own `.agent-daemon/` live under `~/.agent-daemon/projects/<name>-<hash>/`, and move into the project once it gets its own folder (`ad init`). Proposals from `ad memory consolidate` and skill evolution follow the same rule. In a project's own `.agent-daemon/`, ad writes a `.gitignore` for the journal and proposals on the first write when it is missing; `ad doctor` warns while it is. Journals and archives written before the secret filter are scrubbed once by `ad memory migrate`, `ad doctor`, the TUI and the memory server (never by a hook).
- **Your own Codex install stays out of ad.** Started in your home folder (or under a home folder that is a git repository), the engine loaded your own `~/.codex` as project settings: its skills always, and its model, MCP servers and other settings when ad's engine trusted that folder. Now the engine runs in an empty launch folder, ad doesn't work in such a folder while your `~/.codex` has skills (see Changed), and a `trusted` entry for your home folder in ad's engine settings is removed at start, with a one-time note. ad never marks it `untrusted`, and folders you trusted are unchanged.

### Added

- **Choose where a task continues when a limit runs out.** `ad fallback` (and `/fallback` in the terminal UI) keeps an order of accounts and models with its rules: free only, or free plus plans you already pay for; which failures switch (a used-up limit, a rate limit, the network, a provider's servers, never sign-in or plan problems); moves per task and per hour; trial endpoints. Every change is checked first ("… bills per use", "… can't call tools", a trial endpoint you haven't confirmed), `ad fallback preview` shows what would happen now, and `ad fallback test` checks each target (`--live` sends one tiny request each, after asking). Turning it on lists every destination and what its provider does with your data; changing the order or the account behind a target turns it off until you confirm again. The agent's own shell can't change it. It is off by default, and this release only keeps the order: moving work by itself comes next.
- **What each account can do and has left.** `ad auth models <account>` lists its models with tools, context, price and route; `/model` shows the price beside each row. ad also keeps each account's limits as last seen, benches a provider that hit its quota or rate limit until the reset, counts today's spend per account, and records why a turn failed (a rate limit, a used-up quota, the network, the provider's servers, or unknown). Free means seen free under a day ago; anything ad hasn't seen is "unknown", never "ok" or "free". Groundwork for automatic fallback.
- **Switch a conversation to another account or provider mid-task.** In `/model` or `/account`, another account now moves the open conversation there at a safe point, with its history: a copy for another key of the same provider, else a new conversation seeded with the history (the old one stays in `/resume`). During a turn: switch after it, or stop it and switch now. Goals pause and resume after the first answer; background terminals keep running with the old conversation and the new model is told not to restart them; prompts sent meanwhile run once, there. `"switching.crossAccount": false` turns it off. `ad run`, `ad loop` and `ad tui` take `--effort`, `ad tui` takes `--account`, and `ad run` names its target.
- **A record of each session** (`~/.agent-daemon/sessions/`): for every conversation in `ad tui`, `ad run` and `ad loop`, which account and model ran each turn, who started it, and what each tool call did and how it ended. `ad sessions show --last` prints it (`--json` too) and `/status` names the session. It never holds reasoning, answers, file contents, command output or keys; `AD_LEDGER=0` turns it off.
- **Claude and Gemini API keys on their own APIs.** The Anthropic API (Messages) and the Gemini API (streamGenerateContent) are spoken natively inside ad's gateway: Claude's extended thinking and Gemini's thought signatures survive tool loops, and the Gemini key never goes in a URL. Candidates until checked on real keys.
- **Fourteen more providers through ad's chat translation** (candidates until checked on real keys): Gemini API, Groq, Cerebras, Mistral, NVIDIA, Anthropic API, DeepSeek, Together AI, Z.ai, Hugging Face, Nebius, MiniMax and SambaNova, with free tiers marked and a one-time notice where a provider's terms call for one (NVIDIA's trial, Gemini's free keys). Daily limits and empty balances stop the turn with the provider's reason; each listed model's context window reaches the engine so it compacts in time. Your own endpoint may now speak only Chat Completions. See docs/providers.md.
- **OpenCode Go with your own key** (`ad auth login opencode-go`), including its open models (GLM, Kimi, DeepSeek and others) through ad's chat translation. ad names itself to OpenCode and sends each conversation's id, as OpenCode asks; its usage limit stops the turn with the reset time. Zen's free models stay out (OpenCode allows them only in its own app). A candidate until checked on a real key.
- **Accounts in the terminal UI.** `/model` picks the account too: grouped by provider, each row saying whether the conversation continues or a new one starts. `/account` opens the list and `/model default` sets the default. `/login` adds an account from inside ad with a masked key field. `/logout` signs out one account. Free models are marked, each window keeps its own choice, and the footer names the account.
- **`ad auth list | use | rename | logout | remove | status | test`.** Several accounts with your own labels and owner tags. `use` sets the default (`--project`, `--session` and `--digest` for narrower scopes). `logout` signs one account out and keeps it, and `remove` forgets it. `--json` is the scripting contract. Account changes refuse to run from the agent's own shell. `logout <label>` now keeps the account (it used to delete it); use `remove` for that.
- **New providers.** OpenAI keys (several side by side), OpenRouter (free models marked from a fresh price check), Kimi Code, Moonshot, xAI, Fireworks, your own endpoint (`ad auth login custom --base-url …`), Ollama and LM Studio. `ad auth login openrouter --oauth` signs in on OpenRouter's site instead of pasting a key. `ad auth status` lists every account, `ad auth use` picks the default, `ad auth test` checks a key again. A key is never taken on the command line, a refused key is never saved, and a failing provider ends the turn after one retry instead of retrying for minutes. See [docs/accounts.md](docs/accounts.md).
- **Each conversation runs on the account you picked, from the first message.** `--account <provider>/<label>` on `ad`, `ad tui`, `ad run`, `ad chat`, `ad loop` and `ad sp`; `AD_ACCOUNT`/`AD_MODEL` as a launch default; a project can pick its account in `.agent-daemon/config.json` (only in a folder you trusted). An account that needs its key again stops the start with the command that fixes it. Switching accounts never changes a running conversation: another account of the same provider continues it as a copy; anything else starts a new one. API-key accounts run in their own engine folder once the main one holds a ChatGPT sign-in. Your terminal settings and folder trust follow you into every engine folder. `--resume` finds a conversation in whichever folder holds it, and the exit hint names its account.
- **API keys never reach the engine, its hooks or the tools it runs.** ad's local gateway adds the key on the way out; the engine holds only a per-run token. The gateway also sees each provider's limits and usage, ends a turn at once when a provider asks to wait more than a minute, never follows a redirect with a key, and turns an unreachable provider into a clear error instead of endless retries. ad 3.0 conversations on OpenRouter resume through it. Error lines, engine details and notes now hide anything that looks like a key or token.
- **Accounts.** ad keeps a list of accounts (`~/.agent-daemon/accounts/registry.json`), each with an id, a label, an owner tag and where its key or sign-in lives, never the key itself (only its last 4 characters). Several keys for one provider no longer overwrite each other. ad 3.0's ChatGPT sign-in and OpenRouter key become accounts by themselves, and 3.0 keeps working on the same files. `ad auth repair` finishes an interrupted sign-in or key change and asks before deleting a key no account uses; `ad doctor` shows the account counts and which secret store is in use. Keys are saved atomically now (a crash keeps the old one), and on macOS they go to the keychain when the optional keychain module is installed.
- **Every project has its own id.** Memory used to be keyed by a slug built from the folder's path, so moving a folder lost its memory, and two folders like `/x/a/b` and `/x/a-b` shared one key (ad kept both out). Projects now have ids (`~/.agent-daemon/projects.json`, plus `.agent-daemon/project.json` in projects you set up, kept out of git): a moved folder keeps its memory, and two folders that shared a key are each served their own notes. Older rows get their id once, from the session or folder they were recorded in (`ad memory migrate` also does it on demand); a note nothing ties to either folder reaches neither, and `ad memory assign` places it by hand. Capture files outside a project now live in `~/.agent-daemon/projects/<id>/`. The change is additive: an older ad keeps working on the same files.
- **Accepting a skill change applies it, everywhere.** `ad review` shows a skill proposal as a diff against the SKILL.md your sessions load; typing `accept` applies it as a new version, writes it to Claude Code (and ad), and to Codex and Gemini CLI where ad's memory is installed. `ad skill history`, `diff` and `undo` work on every version; `ad init` keeps a version you accepted across upgrades. `ad evolve`, `/evolve` (through the new `ad skill propose`) and the digest all queue proposals ad can check, and rejected proposals are kept in `rejected/`. `ad review --list` and `--reject <file>` work without a terminal; accepting and undo still need you at one.
- **Memory in VS Code and Gemini CLI.** `npx agent-daemon-memory install` (and `ad memory install`) now also sets up VS Code with Copilot (`~/.copilot/mcp-config.json`) and Gemini CLI (`~/.gemini/settings.json`), with the same backup, ledger and exact uninstall as the other hosts.
- **Memory as host plugins.** `runtime/scripts/build-host-packages.mjs` builds a Claude Code marketplace plugin (memory server, prompt and session-start hooks, a skill) and an Agent Plugins 1.0 package from the runtime's own code. The Claude Code plugin does nothing where `ad init`'s hooks already run, and never creates a folder in your repository. See docs/memory/hosts.md.
- **Cursor and Gemini CLI packages.** The same build also makes a Cursor plugin (with `${CURSOR_PLUGIN_ROOT}`, which Cursor expands) and a Gemini CLI extension (`gemini-extension.json` at the repository root, `GEMINI.md`). Both capture through the record tools.
- **Memory docs in one place** (`docs/memory/`): overview, install, hosts and plugins, a tools reference generated from the server's own tool list, security and FAQ. `docs/support-matrix.md` records which hosts are tested live.
- **Listings from evidence.** The build also writes the MCP Registry entry (`server.json`, pinned to the package version, with an optional `--project` so a client can bind the open folder; the package gains `mcpName`). The memory server also accepts `--project=<folder>`. Quick-try links for Cursor and VS Code start an exact version. Listing copy names only hosts the support matrix shows as tested live, and a claims check keeps hosts, percentages and rankings out of hand-written copy.
- **A release workflow for memory** (`release-memory.yml`): dispatched by the owner only, a dry run by default (every artifact and `SHA256SUMS`, nothing published), and publishing (npm with provenance, the marketplace and Gemini repositories, a GitHub release) only behind an approved environment.
- **The `agent-daemon-memory` skill** tells a host's agent when to search memory, to record only the user's own corrections, and that results are notes, not instructions.
- The memory server stops with a clear line when a host passes a variable it didn't expand (`${PLUGIN_ROOT}` in Cursor), instead of reading a wrong path.

- **`ad memory report`** (and `npx agent-daemon-memory report`): is memory working in this project? Corrections captured, how many repeated a lesson memory already had and whether that lesson was shown first, how much memory showed per session, what feedback said, and what waits for review. `--share` prints the numbers with no project, path, lesson or session. When a lesson was shown and the same correction still came back twice, `ad review` offers to reword it (`memory-reword`, behind the same typed confirmation). See docs/memory/metrics.md.
- **A correction benchmark** (`bench/correction-bench/`): does an agent repeat a mistake it was already corrected for, with ad's memory, with the host's own memory, with the correction written into the rules file, or with nothing? Twelve development families with deterministic checks, drivers for ad's engine and Claude Code (headless), a pre-registered analysis (an exact sign-flip test over families, with McNemar and GEE as checks) and a power check. The test families stay private until the pre-registration is tagged; only their hashes will be in the repository. No results yet: the pilot comes first. See bench/correction-bench/PROTOCOL.md.
- **Feedback changes ranking.** `memory_feedback` now moves a lesson up or down in search (×0.7 to ×1.3); the first verdict counts in full. For a cross-project lesson only the searching project's verdicts count. A correction that repeats a lesson memory didn't show raises that lesson a little.
- **One command puts ad's memory in Claude Code, Codex and Cursor:** `npx agent-daemon-memory install` (or `ad memory install`). It shows what it will change and asks first, keeps a backup, changes only its own entry (Claude Code through `claude mcp add`, Codex's `config.toml` in a marked block, Cursor's `mcp.json` with your comments kept), refuses a config it can't edit safely and prints the snippet instead, and `uninstall` puts an untouched config back byte for byte. `doctor` checks each host by starting its entry and talking to it; `repair` and `status` too. The package needs Node 22.16+ and no native build (memory runs on Node's built-in SQLite there); hosts start a launcher by absolute Node path, never `npx`. `npx agent-daemon-memory review` accepts recorded notes without ad.
- **Memory on hosts without hooks.** The memory MCP server has two record tools, `memory_record_correction` and `memory_record_learning`, for the agent to save what you just taught it. What they save is pending: this project's `memory_search` and `memory_get` show it marked `(unreviewed)`, nothing else does, and it reaches your sessions once you accept it in `ad review`. Repeating a note answers `Already known`; a secret saves nothing; an instruction-looking note is held back; at most 20 saves per 10 minutes. `--capture auto` (the default) saves nothing extra while this host's own ad hooks are capturing; `tools` always records; `hooks` and `off` don't list the tools. `--host` takes `ad`, `claude-code`, `codex`, `cursor`, `vscode`, `gemini`, `opencode`, `windsurf` or `agent-plugins`.
- `ad review` accepts or rejects the notes an agent recorded (`memory-add`) and its requests to make one cross-project (`memory-promote`); `ad review --global` decides on the notes ad 3.0 stored as global, grouped by the project they came from (accept: every project; reject: only that project). `ad memory promote fact:<id>` makes a user fact apply everywhere; `ad review` suggests facts seen in two or more projects. `ad memory migrate` runs the one-time memory upkeep now.
- The memory MCP server speaks MCP 2026-07-28 (no `initialize`; `_meta` on every request; `server/discover`) as well as 2024-11-05 to 2025-11-25. Its tools carry titles, closed input schemas and annotations; a failing tool answers with `isError`, and calls in flight are answered when the client hangs up. `--allow-cross-project` and `--db` are new launch flags.
- `ad tui` follows key chords and the leader key from `tui.keymap`, as the engine's own UI does: `"ctrl-x ctrl-s"`, or `"leader c"` with `global.leader` (default `ctrl-x`). While a chord waits, the footer shows what can follow; Esc cancels. `/keymap` names the leader.
- `/subagents` shows each subagent's model and reasoning effort when the engine reports them.
- `ad memory held` lists the memory notes waiting for you (agent-written) or held back (flagged), for this project or `--all-projects`. `ad memory held accept|release|drop <id>` run only in your own terminal and ask you to type the id; a note holding a secret can be dropped, never released. `ad status` and `ad doctor` say how many are waiting; doctor also flags folders that share one memory key. `ad` and `ad doctor` run the one-time check of older notes, and SessionStart reminds you when it hasn't run yet.

### Internal

- Chat translation in the provider gateway: providers that speak only Chat Completions can be routed through ad (presets come in the next wave). Tool calls are handed to the engine only whole, quota and rate limits reach it as codes it handles without re-asking an exhausted provider, and the TUI and `ad run` show the provider's real reason. `AD_TRANSLATE=0` turns it off. Recorded engine fixtures and a contract test catch wire changes at an engine upgrade.
- A mock provider and auth kit for account and provider tests (mock OpenAI/OpenRouter APIs with faults and quotas, a token-refresh server, a loopback gateway prototype, key-isolation probes), and real-engine tests showing two providers in one engine and no provider key in any tool shell, hook or MCP server.

### Fixed

- One state root for everything ad keeps: MCP audit logs now go to `~/.agent-daemon/audit/` (or `AD_ROOT`) instead of following `AGENT_DAEMON_HOME`, which names the runtime folder (`ad doctor` points at old logs), and the digest's global memory, its queue and the skill manifest no longer land in a second folder when `HOME` and `USERPROFILE` differ (Git Bash on Windows).
- macOS: memory works in a project under a temp folder (`/tmp`, `/var/folders/…`). Every folder under `/private` was taken for a system folder, so memory served and stored nothing there; plain `/etc` and `/var` are now system folders as they should be.
- The memory package needs Node 22.16 or newer (was 22.13): Node's built-in SQLite has full-text search from 22.16, and on 22.13–22.15 every memory write failed with "no such module: fts5". An older Node now reports that no SQLite driver is available, with the version it needs.
- An npm-installed Claude Code (`claude.cmd`) works for digest calls, which used to fail with `ENOENT`, and starts Claude workers without `cmd.exe`. `AD_CLAUDE_BIN` picks a specific Claude Code.
- A conversation lock left by a crashed ad no longer blocks for up to two minutes when the OS has given its process number to another program: ad checks when the process holding that number started, and takes the lock at once if it isn't the one that wrote it.
- A session suspended with Ctrl+Z (or paused in a debugger) keeps its conversation lock: another ad no longer takes over a live session whose heartbeat stopped.
- `ad migrate` no longer refuses because of a stale lock from a process whose number was reused.
- `ad migrate` now sees every running engine, not only sessions with an open conversation: a session before its first prompt, one suspended with Ctrl+Z, `ad run`/`ad loop`, team workers, digests and `ad engine ui` each hold a record while their engine runs, and so does an engine whose ad crashed. Records of processes that are gone are cleared by the next `ad migrate`.
- A scheduled job no longer stays blocked forever by a reused process number, and a job still running after the daemon died or restarted isn't started twice.
- `ad tui`: key settings the engine leaves unset no longer show up as "Settings ad couldn't use" (the engine writes an unset action as `null`). Key settings ad really can't use (a chord, a leader key, a non-key value) are summed up in one line in `/warnings`; `/keymap` lists each.
- `ad init` writes Claude Code's `~/.claude/settings.json` and `~/.claude.json` atomically (a temp file, then a rename), so a crash or Claude Code reading at the same moment never sees half a file. A `settings.json` or `~/.claude.json` ad can't parse is left untouched (it used to be replaced, keeping only ad's hooks).
- The manual's memory paragraph said `ad init` registers the memory MCP server for Claude Code; it doesn't. It now gives the `claude mcp add … agent-daemon-memory-mcp --host claude-code` command.
- SessionStart: a project's `activeContext.md` is no longer cut off by a large global `~/.agent-daemon/user.md` (without QMD, the project's memory now comes first). A file over its budget keeps its `## Now`, `## Open issues` and `## Rules` sections and its newest lines, instead of only its oldest ones. `ad doctor` points to the compaction recipe in `docs/workflow.md`.
- `ad tui`: in a terminal without synchronized output, a turn's answer could vanish for a moment when the turn ended right after another row (an engine warning) was added: blank rows showed where it had been until the next batch of history. A frame now writes any waiting history in the same write.
- `ad tui`: the same engine warning repeated (a config warning per conversation, a deprecation per turn) shows once, with a count in `/warnings`, instead of a new row each time.

### Changed

- Memory can run on Node's built-in SQLite (`node:sqlite`) when `better-sqlite3` isn't installed; `AD_SQLITE_DRIVER` picks one, and `ad doctor` shows which is in use ("SQLite driver"). The managed instructions now point at `ad memory install` for other agents, and `ad init` offers to add the memory server to Claude Code (in a terminal; scripts get the command as a hint).
- One note per project: a learning that differs from one already in the project only in case, spacing or end punctuation counts as the same note (it reinforces it), and the same text in two projects is two notes (it used to be stored once, in whichever project said it first).
- **The engine moves to 0.163.0** (from 0.160.0). The protocol only gains fields and methods. `/config` and `/daybreak` answer with a note; `/archive`, which the engine now allows during a task, still waits for the turn in `ad`; and key chords and the leader key from its keymap work in `ad tui` (see Added). Going back to an ad release on engine 0.160 after this one has run is not supported: the engine may have updated its own data in ad's engine folder.
- **Home folder.** `ad` started where your own `~/.codex` skills would load shows **Pick a project folder** (your last project first; Enter opens it). `/cd` there is refused, and so is `ad schedule add`. `ad run`, `ad chat` and `ad loop` still run there in 3.0.x, with a one-time note per folder; **from 3.1 they need `--allow-home-folder`**. The overrides are `--allow-home-folder`, `AD_ALLOW_HOME_FOLDER=1`, and the pref `allowHomeFolder` (the launcher's "Always open home without asking"). Each prints one note saying your skills load. A `~/.codex` without skills changes nothing. Scheduled jobs from 3.0 in such a folder keep running, with a note, and `ad doctor` lists them ("Home-folder jobs"); team workers without a worktree there do the same. `~/.agents/skills` still loads everywhere. In a home folder that is a git repository with your own engine settings in `~/.codex/config.toml`, ad no longer offers to trust a folder without its own repository, since trusting it would apply those settings there.
- The engine process starts in `~/.agent-daemon/launch` instead of your project, so `/mcp` lists the MCP servers in ad's own settings; a trusted project's own servers start with its conversations.
- Agent Daemon is a personal open-source project: the MIT licence now names its author, Pankaj Kumar (Pankaj Mahaur). Security reports go to pankajmahaur2003@gmail.com or a private GitHub security advisory.

## [3.0.0] — 2026-10-17

Agent Daemon 3.0: ad is its own product. Same agent and sign-in; conversations, skills and settings carry over.

1. Your data folder keeps its name; `ad migrate` (optional) renames it to `~/.agent-daemon/engine` and `ad migrate --undo` reverses it.
2. ad's screens call the runtime "the engine"; `ad about` says what it is (OpenAI's open-source Codex, Apache-2.0).
3. Removed `ad codex` and `/codex` (the engine's own UI); `docs/upgrade-3.0.md` lists what to use instead. Renamed: `AD_CODEX_HOME` → `AD_ENGINE_DIR`, `AD_CODEX_BIN` → `AD_ENGINE_BIN`, `AD_CODEX_LLM_MODEL` → `AD_ENGINE_MODEL` (the old names keep working; `AD_ENGINE_HOME` is not a setting and is refused); `--engine codex` → `--engine ad` (the old value works until 3.1).
4. Something wrong? `ad doctor`. Rolling back to 2.2.0: see the upgrade guide.
5. Upgrade guide: [docs/upgrade-3.0.md](docs/upgrade-3.0.md).

### Added

- A brand lint (`npm run lint:brand`; CI runs it in strict mode): the engine's name stays in its allowed zone (the engine adapter, the dependency pin, the two prompt files reproduced from upstream, the upgrade runbook, descriptive statements about other agents), with an allowlist that carries a reason for every exception. The texts that may name the engine on screen now live in one attribution module. Groundwork for 3.0, where ad's screens, docs and settings say "the engine" throughout.
- `ad migrate` renames the engine's folder to `~/.agent-daemon/engine` (optional; `--undo` reverses it). New installs use that name and keep a link with the old one. ad never removes or replaces a `codex-home` link you made: if it points to a drive that isn't connected, ad refuses to start until you reconnect it. A start sets aside only a second folder holding nothing but ad's own first-run files, and says so. A missing link is made again on the next start (or by `ad migrate`). `ad migrate` and `--undo` wait until no ad session is running.
- `ad about`: what ad runs on (versions, the engine, licenses, settings path).
- The agent is told what it is: Agent Daemon's agent, on ad's engine, with the sign-in route (in the engine folder's AGENTS.md).

### Changed

- Errors and notices from the engine show in ad's words; the engine's own text is in `/warnings` (and on a `details:` line in CLI commands).
- `ad doctor`: the engine's rows are now Engine, Engine version, Engine home, Engine compatibility, Engine sign-in, Engine hooks and Windows sandbox, in plain words.
- New names for the env vars: `AD_ENGINE_DIR`, `AD_ENGINE_BIN`, `AD_ENGINE_MODEL`; the old names still work.
- Flags and env vars that choose ad's engine take `ad` (`--engine ad`, `--llm ad`, `AD_HOOK_HOST=ad`); `codex` still works until 3.1.
- `ad sandbox setup --elevated` asks before it changes the machine (`--yes` to skip the question).
- The terminal UI says "the engine" where it used to name it; the sign-in picker lists an OpenAI API key and OpenRouter first.
- `ad tui`: the prompt sits at the bottom of the screen from the start, and the conversation fills the space above it; history still goes into your terminal's own scrollback. `"prompt.atBottom": false` in `~/.agent-daemon/tui/prefs.json` brings back the old behaviour.
- The engine-upgrade workflow and skill replace codex-upgrade; upgrade PRs regenerate and commit the protocol notifications list, and the old token secret still works.

### Removed

- `ad codex` (the engine's own UI). It now says what to use instead.
- `/codex` in the terminal UI (the engine's own UI). It now says what to use instead.

### Fixed

- `ad doctor` keeps engine version warnings on labelled `details:` lines and shows engine startup failures in ad's words.
- The daemon now watches the engine's conversations in a folder set with `AD_ENGINE_DIR` / `AD_CODEX_HOME`.
- `/cd`: refused while a subagent is still working ("Cannot change: another agent is running."), and every thread is checked again after the trust question ("Cannot change: a task is running."), as Codex does. A subagent's turn now ends with the engine that ran it, so a crash and restart doesn't leave `/cd` refused; a late "started" hint for a subagent whose turn already ended is ignored, as in Codex.

## [2.2.0] — 2026-10-11

### Fixed

- `ad tui`: a Codex command ad doesn't have yet (`/plan fix the bug`, `/side …`, `/clear`) was sent to the model as a prompt. Now it answers why it isn't in ad (and that `/codex` has it, where the stock UI can help), and what you typed stays in the prompt.
- `/codex`: ad's engine kept the conversation loaded while the stock UI ran it too, so both wrote to it and, back in ad, the turns taken in the stock UI were missing. ad's engine now unloads the conversation before the stock UI opens it, and resumes it from disk afterwards.
- `ad tui`: a late reply from the terminal (a colour, a version) could arrive as Alt+], some text and Ctrl+G (which opened the editor). Terminal replies are now recognised and dropped; Alt+] still types.
- `ad tui`: Ctrl+C now closes the Ctrl+T pager (it cleared the prompt underneath), and Shift+Tab no longer acts as Tab in the command popup.

### Added

- `ad tui` runs the rest of the Codex commands on its stable surface: `/recap` (Codex's catch-up, from a temporary read-only thread with no tools), `/subagents` (watch each subagent's transcript live; Alt+← / Alt+→), `/approve` (one retry of an action Codex's auto-review denied), `/setup-default-sandbox` (Windows, after a confirm), `/mention`, `/debug-config` (secrets masked), `/rollout`, and Codex's answer for `/agents`. See [Slash commands](docs/tui.md#slash-commands).
- `ad tui` colours code by language, as Codex does: fenced code blocks in answers and the unchanged lines of edits' diffs (JavaScript/TypeScript, Python, Rust, Go, C/C++/C#/Java, JSON, YAML, TOML, shell, PowerShell, HTML/XML, CSS, SQL, diff), with no new dependency. `/theme` chooses the colours with a live preview: `ansi` (the terminal's own, the default) or Codex's `catppuccin-mocha` / `catppuccin-latte`, saved as Codex's `tui.theme`. See [Syntax highlighting](docs/tui.md#syntax-highlighting).
- `ad tui` has Codex's Vim mode for the prompt: `/vim` turns it on (and `tui.vim_mode_default` from the start), with Codex's Normal, Insert and Replace modes, motions, `d y c` operators and text objects, search, undo/redo and `.`. The footer shows the mode; the cursor is a bar in Insert. See [Vim mode](docs/tui.md#vim-mode).
- `ad tui`: `/keymap` shows the keys in effect (yours from the stock UI's `/keymap` marked), and `/keymap debug` is Codex's Keypress Inspector: what your terminal sends for a key and which actions it presses.
- `ad tui` has Codex's side conversations: `/side [question]` (or `/btw`) opens an ephemeral fork in a panel under the main conversation, also while a turn runs; Ctrl+/ moves between the two prompts, Ctrl+C closes it and its transcript stays in the scrollback; nothing merges back. ad's side runs read-only with no approvals and no hooks. See [Side conversations](docs/tui.md#side-conversations).
- `ad tui` has Codex's `/cd [folder]`: the conversation is forked into the folder and continues there (edits, commands, `@` files, the status line's git facts, ad's memory and `/undo` follow it). A folder you haven't trusted yet is asked about first.
- `ad tui` has Codex's background terminals: a long-running command the model starts (a dev server, a watcher) no longer holds back the transcript; the footer counts them, `/ps` lists them with their last output lines, and `/stop` (`/clean`) stops them all. See [Background terminals](docs/tui.md#background-terminals).
- `ad tui` has Codex's plan mode: `/plan` (or Shift+Tab) switches to it and `/plan <prompt>` sends a prompt there; the model explores without editing and ends with a **Proposed Plan**, and ad asks "Implement this plan?" with Codex's choices (implement here, implement in a fresh conversation, or keep planning). The footer shows **Plan mode** and the prompt turns magenta. It shares the mode with `/codex` and uses Codex's `plan_mode_reasoning_effort`. See [Plan mode](docs/tui.md#plan-mode).
- `ad tui` has Codex's keys for copy (Ctrl+O), raw output (Alt+R) and reasoning effort (Shift+↑ / Shift+↓, besides Alt+. / Alt+,), F2 for the warnings, and Codex's pager keys in the Ctrl+T transcript (`j` `k`, Ctrl+B / Ctrl+F, Ctrl+U / Ctrl+D, Shift+Space).
- Keys set with the stock UI's `/keymap` (Codex's `tui.keymap`, in ad's Codex home) apply in `ad tui` too, for the actions ad has.
- `ad tui`: Codex's status line under the prompt (`/statusline` chooses its items, saved as Codex's `tui.status_line`), and the terminal window's title (`/title`, Codex's `tui.terminal_title`): a spinner while a turn runs, "action required" while an approval waits. The context and usage meters moved from the footer into the status line.
- `ad tui`: Codex's `/clear [name]` (clears the terminal, scrollback included, and starts a new conversation; `clear.keepScrollback` in `~/.agent-daemon/tui/prefs.json` keeps the scrollback), `/archive` and `/delete` (each asks first; `/delete` also drops the conversation's `/undo` snapshots), `/resume archived` (resuming unarchives), and `/pwd` (`/cwd`).

### Changed

- `ad tui`: the model's checklists (Codex's `update_plan`) now go into the scrollback as **Updated Plan** each time they change, as in Codex, instead of showing only while the turn runs.
- `ad tui` now opts into a small part of Codex's experimental app-server API, for plan mode (and `/stop` later): the methods are on an allowlist, every other experimental notification is turned off, and tests and the Codex upgrade check refuse anything else. `ad chat`, `ad web`, `ad acp`, `ad run` and `ad loop` stay on the stable API.
- ad's prompt hooks skip the message Codex's "clear context and implement" writes (a fixed text plus the model's plan), so it isn't recorded as something you said.
- `ad tui` follows Codex's rules for its commands: those Codex disables while a task runs (`/new`, `/fork`, `/compact`, `/init`, `/export`, `/review`, `/logout`) wait for the turn to end, and keep your draft. Codex's aliases (`/cwd`, `/clean`, `/pet`) are recognised.
- Tests check every request ad sends against the pinned Codex's stable protocol, not only what Codex sends.
- For contributors: the doc link check also fails on a section heading that appears twice, and the `ad-ci-readiness` project skill runs the CI pipeline locally (here and in a Linux container) with a release-readiness checklist.
- New docs: [Commands in ad](docs/commands.md) lists every engine slash command (works in ad, or why not yet), the keys and the settings shared with the engine's own UI; troubleshooting entries for `/keymap` keys, `/clear` and the window title; contributing has the steps for adding a terminal UI command.

## [2.1.1] — 2026-10-06

### Fixed

From the first live use on a real ChatGPT login:

- Windows, when ad is started from PowerShell 7 installed from the Microsoft Store: every sandboxed command failed (`CreateProcessAsUserW failed`) and needed approval to run outside the sandbox. PowerShell puts its Store package folder first on PATH, and the 2.0.1 fix only removed the app-alias folder. The engine's PATH now leaves out every `WindowsApps` folder, so commands run sandboxed in Windows PowerShell 5.1 (or an MSI PowerShell 7).
- ad's own memory tools (`memory_search` …) no longer ask for approval each time (`default_tools_approval_mode = "approve"` on the memory server, unless you set a mode yourself).
- `ad tui`: a reply that wraps shows its bullet on the first line only (every line had one).
- `ad tui`: links to local files (`[app.js](</D:/My Projects/app.js:12>)`, as Codex writes them) render as links instead of raw text.
- `ad tui`: the header names the model Codex will use instead of "default"; choosing `/permissions` during a turn says the running turn keeps its settings.
- `ad --last` when the terminal UI is turned off (`AD_TUI=0`) or can't run here says what to do instead of "unknown command".
- `ad tui` on old Node on Windows: the message says exactly which versions to move to (22.17+, 24.2+).

### Changed

- New design and contributor docs: [harness design](docs/harness-design.md), [terminal UI architecture](docs/tui-architecture.md) (with the `/undo` safety model) and [testing](docs/testing.md). The public docs were checked against the code and brought up to date (security model for the harness and the terminal UI, uninstall steps, layout trees, Node requirements).
- The maintainer's working plans and research notes are no longer published (they stay local); example names in tests and docs are generic.
- `runtime/scripts/check-doc-links.mjs` checks that every relative link in the docs points at a file in the repo.

## [2.1.0] — 2026-10-06

`ad` is now a Codex-style terminal UI with agent-daemon's extras: bare `ad` opens it (`AD_TUI=0` turns that off). Guide: [docs/tui.md](docs/tui.md).

### Fixed

- `ad tui`: a reply or command whose item id a provider reuses from an earlier turn shows again (it was merged into the old item and never printed).
- `ad tui`: "Learned:" rows show during the session, and `/memory` lists what was captured but not yet saved.
- `ad tui`: `/undo` compares with what the agent's edit wrote, so a file you saved right after the turn is "changed since the agent's edit", which `/undo force` can override.
- `ad tui`: `/private` prompts show as typed, marked "(private)".
- `ad tui`: `/undo` recognizes the agent's edits when Codex names the folder differently from git (an 8.3 short name like `RUNNER~1`, a junction, a `subst` drive).
- `ad tui`: `/undo` keeps a checkpoint on a busy machine (the snapshot taken at send may take up to 10 s), and never undoes a save of yours made during the turn to a file the agent also edited ("changed during the turn").
- `ad acp`: with two sessions open, one prompt ending no longer drops the other's edit diff from its permission request.

- The Windows one-liner installer works in Windows PowerShell 5.1 again. 5.1 stripped the quotes inside `node -p '…split(".")…'`, so the Node check always read version 0 and stopped with "Node.js >=22 required". A failing step now stops the script with `throw` instead of `exit`, which used to close the window under `irm | iex`.
- ad never runs Codex in your own Codex home:
  - It refuses `~/.codex` and a `CODEX_HOME` your shell sets, however the path is spelled (junctions, `\\?\`, case, relative paths, a trailing dot or space).
  - It refuses network (UNC) homes.
  - It drops `CODEX_*` variables such as `CODEX_SQLITE_HOME`; `CODEX_CA_CERTIFICATE` is kept.
  - It only runs its pinned Codex, never a global or PATH install.
  - `ad doctor` and schema generation use throwaway homes.
  - Hooks that Codex runs for ad still recognise ad's home, through `AD_ENGINE_HOME`.

- `ad chat` approvals for network access now name the host (they read "$ null"), and a request to send input to a running command shows that input, escaped.
- An approval answer can only send a "don't ask again" rule that the request actually offered. A rule whose command prefix hides control or invisible characters is never offered.

### Changed

- Codex engine 0.160.0 (protocol unchanged from 0.159.2).
- **Engine:**
  - Every Codex notification is now mapped to ad's own event vocabulary, or deliberately ignored with a reason. A Codex release that adds one fails a test by name until it is handled.
  - Subagent threads are routed to their parent.
  - The protocol diff on Codex upgrades now catches type changes.
- Installers skip devDependencies (`npm install --omit=dev`, `npm link --omit=dev`). On Windows, they warn when Node is older than 22.17 / 24.2, which the coming terminal UI needs.
- CI uses `actions/checkout@v7` and `actions/setup-node@v7`, and gains an opt-in job that runs the real pinned Codex against a mock model on Linux, macOS and Windows. On Linux it allows unprivileged user namespaces, which Codex's sandbox needs on Ubuntu 24.04 runners.

### Added

- `runtime/scripts/tui-probe.mjs keys|screen`: shows what your terminal sends for each key and how it wraps and reflows. It's a troubleshooting tool for the terminal UI.
- Plan and research for the `ad` terminal UI: `docs/plans/ad-tui.md`, `docs/research/` (with an index).
- Terminal UI groundwork (not wired to a command yet), in `runtime/src/tui/terminal/`:
  - **Cell widths:** a vendored Unicode 16 wide-character table. There are two emoji profiles, because VS Code and Windows Terminal draw emoji sequences differently.
  - **Styled text:** colour-depth detection, word wrap, truncation.
  - **`sanitize()`:** strips terminal control sequences from untrusted output, and shows every hidden character in approval prompts.
  - **Keyboard and paste input:** decodes what Windows Terminal, Zed and kitty-protocol terminals send. Enter sends; Shift+Enter (Zed), Ctrl+Enter (Windows Terminal) or Ctrl+J adds a new line. A paste is one event even when it stalls, and an image paste is recognised.
  - **Terminal session:** raw mode and capability negotiation, a restore on every exit path (signals, crashes), handing the terminal to a child program, and Ctrl+Z on Linux/macOS.
  - **Inline renderer:** history goes into your terminal's own scrollback (scroll, select and copy as usual), and only the bottom few lines are redrawn. Resizing re-anchors without erasing history. Terminal detection covers Windows Terminal, Zed, VS Code and others.
  - `node runtime/scripts/tui-demo.mjs`: try the terminal layer on its own, with no engine.
- `ad tui --preview`: an early preview of the terminal UI on the real engine. Answers stream into your scrollback; approve with y / a / n; Esc interrupts; Ctrl+C quits.
  - **Tests:** golden-file tests (`AD_UPDATE_GOLDEN=1` rewrites them).
- A session controller (`runtime/src/harness/session.mjs`) that the terminal UI will drive:
  - It holds one conversation: prompts, steering a running turn, a prompt queue and approvals.
  - Two ad windows can't open the same thread.
  - When Codex crashes, the running turn fails cleanly, Codex restarts (capped) and the conversation resumes.
- Bare `ad` (and `ad --last`) opens the terminal UI where the terminal can show it. `AD_TUI=0` turns that off; `ad chat` stays the plain line mode and says so once.
  - The TUI needs an interactive terminal and, on Windows, Node 22.17+ or 24.2+.
  - When it can't run, `ad` says why and prints the help.
  - `ad tui "<prompt>"` starts with that prompt.
  - Under the hood, `runtime/src/cli.mjs` is now a small launcher (bin shims unchanged).
- `ad tui`: the terminal UI, early. It runs on ad's own Codex home, with:
  - sign-in and folder-trust prompts;
  - streaming answers in your scrollback;
  - approvals, steering and a prompt queue;
  - `@` file mentions, `!` shell commands and slash commands (`/model`, `/permissions`, `/resume`, `/diff`, `/review`, `/remember`, `/codex`…).

  `ad tui --last` / `--resume <id>` continue a conversation. See `docs/harness.md`.
- `ad codex [args…]`: the pinned stock Codex UI on ad's home (never `~/.codex`), with your `~/.claude/skills` mirrored in.
- More Codex parity in `ad tui`:
  - Esc Esc rewinds to an earlier prompt, and Ctrl+T shows the transcript.
  - `/copy`, `/raw`, `/export`, `/fork`, `/rename`, `/mcp`, `/hooks`, `/skills`, `/usage`.
  - Images: paste a file path, or use `/image`.
  - Ctrl+G edits the prompt in your editor.
  - Alt+, and Alt+. change the reasoning effort.
  - Auto-review verdicts show as notices.
  - `/terminal-setup` explains how to set up Shift+Enter.
- `/undo` in `ad tui` (git repos): puts back the files the last turn's applied edits changed, byte for byte, and rewinds the conversation. The "before" snapshot is taken when you press Enter. It refuses when you edited those files during or since the turn, and never touches files the agent didn't edit or the snapshots leave out (big files, heavy folders). It never takes your git index lock. Checkpoints are private git trees; your index, branches and stash are untouched.
- ad's own features in `ad tui`:
  - `/memory` search, recent, forget and profile; `/private`; "Learned:" rows after a turn; `/proposals`.
  - `/loop` in the background, with a row per iteration; `/team`, `/schedule`, `/tools`.
  - A warning when scheduled jobs are overdue.
- Codex upgrades are safer:
  - `ad doctor` and `/status` show the tested Codex versions and what changed.
  - `/warnings` lists events from a newer Codex that ad doesn't know yet.
  - The weekly upgrade PR also checks slash-command names and runs the real engine.
- Terminal UI view components (`runtime/src/tui/view/`):
  - **Composer:** a multi-line prompt editor with word moves, kill/yank, history (`~/.agent-daemon/tui/history.jsonl`, private, Ctrl+R search) and big pastes shown as `[Pasted N lines]`.
  - **Streaming markdown:** a streamed answer looks exactly like the finished one.
  - **Transcript cells:** commands (Explored / Ran / Failed), diffs with line numbers, plans, tools and notices.
  - **Chrome:** the header card, status line and adaptive footer.
  - **Prompts:** approval, question and form prompts. Approvals show hidden characters and ignore keys pressed too soon.
- Skills:
  - `big-feature-flow` (installed by default): research how others built it → plan in parts → adversarial review rounds until final → spikes → a per-part implement/test/review loop.
  - `ad-tui-dev` (maintainers): working on the terminal UI with its isolation and renderer rules.

### Docs

- **Harness guide:** what ad does and doesn't touch of your own Codex, including that `ad watch` reads `~/.codex/sessions`. The elevated Windows sandbox is machine-wide. New env-var rows.
- **Troubleshooting:** entries 19–22 (own-Codex-home refusal, missing engine, PowerShell 5.1 installer, keys and paste with `tui-probe`). Fixed the broken Store-pwsh path in entry 16.
- **Other guides:** the installation guide, architecture (isolation and the engine test layers), contributing (real-engine tests, isolation rule, editing files that contain backslashes) and the README (CI coverage for Codex upgrades) are updated.
- **`runtime/README.md`:** rewritten for v2.
- **Skills:** `codex-upgrade` gains the real-engine step; `harness-troubleshoot` gains the new errors.

## [2.0.2] — 2026-10-04

### Added

- `docs/harness.md`: full agent-harness guide (setup, every command, safety model, memory/hooks/skills inside the harness, Windows, files and env vars).
- `docs/manual-test.md`: current end-to-end checklist for Claude Code mode and the harness.
- Skills `ad-harness` (hand work to `ad run` / `ad loop` / `ad schedule` / `ad sp`, with brakes and self-verification) and `harness-troubleshoot` (login → hooks → sandbox → Codex log, known Windows causes). Both are installed by default.

## [2.0.1] — 2026-10-01

### Fixed

- Windows: agent shell commands no longer fail with "Access is denied" when PowerShell 7 comes from the Microsoft Store. The Store's `pwsh.exe` is an app alias the Codex sandbox can't launch, so `WindowsApps` is kept off the engine's PATH and Codex falls back to an installed pwsh 7 or `powershell.exe`.

### Added

- `codex-upgrade` daemon skill (maintainers): protocol diff review, suite, live Windows sandbox smoke, then release-flow.
- `docs/plans/backlog.md` for ideas not yet planned.

### Docs

- Docs refreshed for v2: harness commands and state paths in architecture, workflow, installation and contributing guides; new troubleshooting entries (login, Windows sandbox, Store pwsh, `spawn EPERM`, stopping `ad loop`); `.agents/skills` → `.claude/skills`; broken skill-catalog links fixed; stale counts and version promises removed.

## [2.0.0] — 2026-10-01

Agent Daemon becomes its own agent harness on the OpenAI Codex engine. Claude Code mode (hooks, memory, skills, GEPA) is unchanged. Design: [docs/harness-design.md](docs/harness-design.md).

### Added

- Codex engine: pinned `@openai/codex` driven over `codex app-server` JSON-RPC in an isolated `CODEX_HOME` (`~/.agent-daemon/codex-home`); memory, guard hooks, skills, AGENTS.md and the memory MCP server wired in automatically.
- `ad auth` — ChatGPT login (browser / device code), OpenAI API key, OpenRouter key for Claude/Gemini models. Keys in an OS secret store (DPAPI / libsecret / 0600 file), never in config or the agent's shell.
- `ad chat`, `ad run`, `ad loop` (autonomous loop with dual exit, circuit breaker, budgets, STOP file), `ad schedule` (cron jobs), `ad web` (loopback UI), `ad acp` (Agent Client Protocol for Zed / JetBrains), `ad tools` (Playwright browser, web search), `ad sandbox` (Windows sandbox setup), `ad agy` (opt-in hand-off to your own Antigravity CLI).
- Codex workers for teams: sandboxed, no `.git` writes, committed for them on their own branch.
- `--llm claude|codex|auto` for digest, extract and GEPA calls.
- Upstream tracking: committed Codex protocol snapshot + weekly `codex-upgrade` workflow that opens labelled upgrade PRs.
- Installers accept `AD_VERSION` to pin a release (e.g. `v1.0.0`).

### Changed

- **Breaking:** `ad sp` spawns Codex workers by default. Use `--engine claude` (or `AD_AGENT_ENGINE=claude`) for v1 behaviour.
- Codex session adapter rewritten for current rollout files; `.out-of-scope/no-codex-runtime.md` superseded.

## [1.0.0] — 2026-10-01

First stable release of the Claude Code memory runtime, and the last before the Codex-based agent harness (v2). Fixes land on the `release/v1` branch; install it with `AD_VERSION=v1.0.0`.

### Added since 0.2.0 (highlights)

- Honcho-inspired typed observations (`derivation` explicit/inferred) and a no-LLM user representation (`memory_profile` MCP tool, SessionStart profile block).
- claude-mem-inspired recall: progressive-disclosure MCP tools (`memory_get`, `memory_timeline`, `memory_files`), `<private>` stripping, file-aware learnings, `ad viewer` HTML snapshot.
- Slim per-project CLAUDE.md block + `AD-INSTRUCTIONS.md`; one-liner installers (`install.sh`, `install.ps1`).
- User-facts profile, workflow flows, routing-map evolution; deterministic skill-routing advice at prompt time.
- Reliability hardening: digest parsing salvage, content-hash dedup, Claude-local evolution feedback.

### Added — Phase 5: Deeper Claude integration + self-improving polish (WS-1..WS-8)

Eight-workstream pass to make agent-daemon feel native to Claude Code, broader-triggered, fully self-improving without API keys, and tighter on multi-agent internals. Merged as PR #2 (`2a73cb5`). 10 commits, 97 → 141 tests pass, 0 lint errors.

**Stack-detection-driven smart skill install (WS-1 + WS-3):**

- New `ad init --skills-mode <smart|all|minimal|manual>` flag (default `smart`).
- `runtime/src/stack-detect.mjs` reads `package.json` deps, framework configs, `requirements.txt`, `Cargo.toml`, `go.mod`, `pubspec.yaml`, `Gemfile`, `Dockerfile`, etc. and emits a Set of detected stack labels: `react, next, vite, astro, eleventy, svelte, vue, react-native, expo, flutter, fastapi, flask, django, nest, rails, rust, go, python, dotnet, node-cli, tauri, prisma, drizzle, supabase, postgres, playwright, cypress, docker, monorepo`.
- `runtime/profiles/stack-skill-map.json` declaratively maps stacks → `{ global, project, exclude }` skill lists + a `combos` field for cross-stack pairings (e.g. `react+fastapi` → `diagnose-fetch-failure`).
- `cmdInit` now installs skills to BOTH `~/.claude/skills/` (global) AND `<cwd>/.claude/skills/` (project-local subset, smart mode only).
- Install loop upgraded: mtime-based idempotency — source newer → `↻ updated`, equal → silent skip. Project-local lane auto-scaffolds a `README.md` documenting daemon-managed entries.
- Deeper `~/.claude/` integration: idempotently copies repo `commands/*.md` to `~/.claude/commands/`, appends a managed `<!-- agent-daemon:start --> ... <!-- agent-daemon:end -->` block to `~/.claude/CLAUDE.md` (never touches user content outside markers), adds `.claude/skills/` to project-audit display.

**Three new daemon skills:**

- **`skills/daemon/skill-author/`** — dedup-first skill authoring. 5-phase procedure: classify scope (global vs project-local), Glob existing SKILL.md and compute trigger + body keyword overlap (≥70% → append-mode), check cross-session log at `.agent-daemon/skill-author-log.jsonl` for prior near-misses, write or append (append-mode preserves Procedure section, only extends triggers / examples / anti-patterns), log JSONL line to both per-project and global logs. Auto-triggers on English + Hinglish phrases ("create a skill", "is se skill banao", "har baar yaad rakhna", "skill bana lo", "promote this to a skill"). Solves the cross-session "Claude keeps creating near-duplicate skills" failure mode.
- **`skills/daemon/session-close/`** — no-API session-end macro. Auto-triggers on multi-language phrases ("bye", "session khatam", "aaj ka kaam ho gaya", "done for today", "wrapping up", "session band karo", "kal milte hain", etc.). 7-phase protocol: read CLAUDE.md managed block → idempotency check via `.agent-daemon/last-session-close.flag` (5-min throttle, re-trigger re-emits digest only) → update session-logs/<N>.md with End-of-session block → emit `<agent-daemon-digest>` JSON block (schema from `constitution/ending-protocol.md`, cap 8 learnings) → invoke handoff skill (dual-write per-project + global) → query episodic.db for ≥3-failure skills, write stubs to `.agent-daemon/gepa-queue/<skill>.md` → touch idempotency flag. Communication style explicit: no confirmation prompts, no ceremony.
- **`skills/daemon/gepa-evolve-inline/`** — the zero-API-key GEPA evolution path. Auto-triggers on "evolve skill", "skill ko better banao", "regenerate skill X". 5-step procedure: run `ad evolve --list-candidates --json` → run `ad evolve --export-traces <skill>` → read traces inline (no headless `claude` spawn, no `ANTHROPIC_API_KEY` needed) → reflect in current Claude context → write proposal markdown to `.agent-daemon/proposed/<skill>-<timestamp>.md` matching existing proposal schema → log to `.agent-daemon/gepa-inline-log.jsonl`. Anti-patterns enumerated (hallucinating from <5 traces, confidence theater, full rewrites when reflection only justifies one change).

**GEPA without API key (WS-5):**

- New `ad evolve --list-candidates [--json]` — emits `findSkillsNeedingEvolution()` results (skills with ≥3 failures in last 30 days). Zero LLM calls, zero auth needed.
- New `ad evolve --export-traces <skill>` — wraps `sampleSkillExecutions()` to write JSONL traces to `<cwd>/.agent-daemon/skill-traces/<skill>.jsonl`. Sanitised (booleans for `succeeded`, no SQLite internals).
- New module `runtime/src/digest/gepa/export-traces.mjs`.
- Auth-fallback messaging in `runtime/src/digest/gepa/evolve.mjs`: when the default GEPA pipeline fails with auth-related errors (spawn EOF, ENOENT, "not logged in"), surface all three recovery paths including the no-API inline alternative.

**Broader triggers (WS-6):**

- 7 new Hinglish/Hindi-Roman extractor rules in `runtime/src/hooks/extractors.mjs` at confidence 0.45 (lower than English's 0.55–0.75 to reduce false-positive risk; drain step boosts on duplicates). All clause-anchored with the same `(?:^|[.!?,;:—–-]\s+|\n\s*)` prefix used by v0.4.1 English rules: `correction-galti-hindi`, `pattern-yaad-rakhna`, `convention-yun-karna`, `decision-decide-kiya`, `gotcha-mistake-thi`, `tool-command-chalana`, `pattern-nahi-karna` (the last one uses a `composer` to prepend `"don't"` to the captured action).
- 4 skill `description:` lines extended with Hinglish trigger phrases: `debug-triage` (+kuch toot gaya, kaam nahi kar raha, broken hai, error aa raha hai, crash ho raha), `implement-feature` (+ye banao, feature add karo, iska page banao, wire up karo, naya banao), `review-slice` (+ye review karo, iska review karna hai, check karo properly), `security-audit` (+security check karo, vulnerability hai kya, audit karo).

**Multi-agent orchestration internals (WS-7):**

- **Inbox acked-message purging (`runtime/src/orchestration/inbox.mjs`):** new `purgeAckedOlderThan(teamId, agentName, opts)` deletes acked messages older than 7 days. Called non-blocking via `setImmediate` at end of every `readInbox()`. Throttled to 6-hour cadence via `<acked>/.last-purge` marker — hot polling loops only pay scan cost 4× per day per inbox.
- **Task retry/rollback (`runtime/src/orchestration/team.mjs`):** tasks gain `attempts`, `max_retries` (default 2), `last_error`, `next_retry_at` fields. New `"retrying"` and `"error"` statuses. New `markTaskFailed()` increments attempts with exponential backoff (`2^attempts × 30s`); new `retryTask()` resets to pending or blocked depending on dependency state. New CLI: `ad team retry --team <id> --task <task-id>` (alias `ad tr`).
- **File-conflict pre-detection (new `runtime/src/orchestration/conflict-detect.mjs`):** `detectConflicts(tasks)` scans task descriptions for file path mentions and flags overlaps between unordered (non-blocked_by-chained) task pairs. Path-extraction whitelisted to top-level dirs (`src, app, lib, runtime, skills, teams, components, hooks, services, tests, api, routes, pages, public, templates, static`) and common file extensions. Hook in `cmdSpawn`: TTY → "Proceed anyway? (y/N)" prompt; non-TTY (CI / scripted) → warn-and-proceed. Wrapped in try/catch so detection failure never blocks spawn.
- **Template schema versioning (`runtime/src/orchestration/templates.mjs`):** `CURRENT_SCHEMA_VERSION = 2`. `loadTemplate()` detects missing/v1 version, runs `migrateV1ToV2()` in memory (no disk write — user templates preserved), prints one-time stderr warning per template name. Migration: sets `schema_version: 2`, defaults `role.max_retries` to 2, mirrors `tasks[].blocked_by` into `blocked_by_titles` for future task-ID resolution. All 4 shipped templates updated.

**activeContext.md weekly rotation (WS-8):**

- New `rotateActiveContextIfNeeded(cwd)` in `runtime/src/session-start.mjs`, called at the very start of every `runSessionStart` (before drain + memory load). Best-effort — failure never blocks session start.
- Compound trigger — BOTH must hit: size > 32 KB AND mtime > 7 days. Size-only preserves "high-touch project last week"; age-only preserves "low-traffic project with one important note".
- Splits activeContext.md at midpoint by line count, moves oldest 50% to `.agent-daemon/archive/activeContext-<YYYY-MM-DD>.md` (appends with `---` separator if rotated twice on same day), keeps newest in place with HTML-comment breadcrumb pointing to the archive file.

**Testing:**

- Test count: 97 → 141 pass (44 new tests across 5 new test files).
- New test files: `runtime/test/inbox-purge.test.mjs`, `team-retry.test.mjs`, `conflict-detect.test.mjs`, `templates-migration.test.mjs`, `active-context-rotation.test.mjs`.
- Extended `runtime/test/extractors.test.mjs` with 8 Hinglish rule tests.
- Lint: 0 errors, 18 vendored-only warnings (unchanged).

### Added — Phase 4 Group A++: 4 generic global skills + dual-write handoff + auto-handoff via CLAUDE.md

Extracted this development session's most reusable lessons as **project-agnostic global skills** — every project that installs agent-daemon gets these, no daemon-specific dependencies. Plus wired the session-close protocol to automatically create handoff docs at both per-project AND global paths.

**4 new generic skills** (any-language, any-project):

- **`skills/llm-output-lenient-parsing/`** — Pattern for parsing LLM-emitted structured blocks when Claude drifts the format (colon for hyphen, YAML for JSON, fenced for bare). Fallback chain: strip fences → strict JSON → tolerant YAML → coerce-then-retry. Hand-rolled YAML parser pattern for fixed schemas. Test fixtures from real transcripts. Distilled from the agent-daemon v0.3 lenient parser fix.
- **`skills/regex-clause-anchored-extractors/`** — Anchor natural-language regex to clause boundaries (`(?:^|[.!?]\s+|\n)`) to stop mid-sentence fragment matches. Concrete before/after for the `we always|never` rule that produced 75% noise. Confidence calibration tiers (auto-apply / queue-for-review / episodic-only / delete) based on real precision data.
- **`skills/audit-every-attempt/`** — Engineering principle: write a one-line audit on every code path — success, failure, skip, no-op. Distinguishes "didn't run" from "ran, did nothing." Schema recommendation, where-to-write tiers by volume, anti-patterns. Cites the agent-daemon v0.2 → v0.3 audit-ledger gap.
- **`skills/repomix-deep-research/`** — Workflow for evaluating remote GitHub repos via repomix pack → grep → read. Beats WebFetch by 60x for multi-file analysis. Pattern guide with real call examples. Adoption-decision template.

**Handoff skill upgraded — now dual-writes:**

`skills/handoff/SKILL.md` now writes to **both** locations on a single invocation:
- **Per-project:** `<cwd>/.agent-daemon/handoffs/handoff-<ISO-ts>.md` (committable, lives with the code)
- **Global:** `~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-ts>.md` (cross-project personal trail; project-slug is lowercased path)

Identical content, two destinations. Lets you `grep` "what was I doing last week" across every project at once.

**`ad init` scaffolding extended:**

`runtime/src/cli.mjs` now creates **both** handoff directories:
- `<cwd>/.agent-daemon/handoffs/` (per-project, was already there from Phase 4 Group A)
- `~/.agent-daemon/handoffs/<project-slug>/` (NEW — global trail per project)
- `~/.agent-daemon/handoffs/README.md` — top-level README with cross-project grep example

Non-fatal if the global dir can't be created (e.g. permission issue) — per-project still works.

**CLAUDE.md managed section: session-close protocol upgraded from 2 actions to 3:**

Previously the daemon's managed CLAUDE.md section instructed Claude on a 2-action protocol when the user said "end session" / "session khatam" / etc — update session log + emit digest block. Now it's **3 actions** — adds automatic handoff doc creation at both per-project and global paths.

Trigger phrases widened: also fires on `"wrapping up"`, `"I'm done"`. All three actions happen in the same response, no confirmation asked.

Existing projects with the v0.3 managed section will get the upgraded 3-action protocol on next `ad init` (idempotent — replaces the section).

### Added — Phase 4 Group A: Karpathy guidelines + 5 productivity skills

After deep-researching `forrestchang/andrej-karpathy-skills` (~110K stars) and `mattpocock/skills` (MIT, 21 active skills), imported Group A — the high-leverage subset that improves baseline session quality without disrupting existing flow. All additive, zero regression risk.

**`constitution/karpathy-guidelines.md`** — distilled from Andrej Karpathy's 2026-01-26 observations on LLM coding pitfalls. Four behavioral guardrails injected into every SessionStart alongside `core.md`:
1. **Think Before Coding** — state assumptions, present alternatives, push back, stop when confused
2. **Simplicity First** — minimum code, no speculative features, "would a senior engineer call this overcomplicated?"
3. **Surgical Changes** — touch only what you must, match existing style, mention dead code don't delete
4. **Goal-Driven Execution** — verifiable success criteria, "Add validation → write tests for invalid inputs, then make them pass"

Wired in `runtime/src/session-start.mjs` — always-loaded with `core.md`, ~3KB total system-prompt cost.

**5 new skills (vendored from `mattpocock/skills` MIT, all with `source:` frontmatter):**

- **`skills/caveman/`** — Ultra-compressed output mode. ~75% token reduction by dropping filler / articles / pleasantries while keeping technical accuracy. Persistent once triggered. Triggers: *"caveman mode"*, *"be brief"*, *"less tokens"*.
- **`skills/handoff/`** — Compact current conversation into a durable handoff doc at `<cwd>/.agent-daemon/handoffs/handoff-<ts>.md` for the next agent. Adapted from upstream (`mktemp -t handoff-XXX.md`) to land inside the daemon's audit trail. Solves /compact persistence problem.
- **`skills/grill-me/`** — Pre-implementation interview that walks every branch of the design tree. One question at a time. Stops the "Claude built the wrong thing" failure mode.
- **`skills/grill-with-docs/`** — Same as grill-me, but cross-references `constitution/` + `.agent-daemon/memory/activeContext.md` and **updates them inline** as decisions crystallise. Adapted from upstream `CONTEXT.md` + `docs/adr/` pattern to use our memory layout.
- **`skills/zoom-out/`** — One-line skill to ask for the higher-level architectural picture (callers, dependencies, seam location) instead of line-by-line code.

**`ad init` scaffolds `.agent-daemon/handoffs/`** with a README explaining the directory's purpose. Idempotent — skips if already present.

`skills/README.md` updated with new "Productivity (Phase 4)" section.

Tests: still 74/74 pass — no new code paths required testing.

### Added — Continuous learning capture (Phase 3 — kills the digest-block dependency)

Production use surfaced a hard architectural problem: the v0.2.x daemon relied on Claude emitting a `<agent-daemon-digest>` JSON block at session end + the harness firing `SessionEnd` to trigger the digest pipeline. Both legs broke — the VS Code Claude Code extension misses ~30% of `SessionEnd` events, and Claude drifts the block format (colon for hyphen, YAML for JSON) so even when the hook fires, the parser rejects the payload. Two real multi-hour sessions in `redseer-frontend` produced zero captured learnings.

Phase 3 rebuilds capture on **`UserPromptSubmit`** (95% harness-enforced, works in VS Code extension) + **`SessionStart`** (100% enforced) so Claude doesn't have to remember or format anything correctly.

**`UserPromptSubmit` hook — `ad hook user-prompt-extract`.** Fires before every user turn. Reads the user's prompt + the previous assistant turn (tailing the transcript JSONL), runs ~12 rules-based regex extractors, and appends matches to `<cwd>/.agent-daemon/learning-journal.jsonl`. Zero LLM calls. Zero Claude cooperation. <50 ms typical latency.

Patterns detected:
- Corrections — `"actually we use X"`, `"no it's X"`, `"not X but Y"`
- Notes — `"remember: X"`, `"important: X"`, `"we always X"`, `"never X"`
- Conventions — `"the convention is X"`, `"we standardize on X"`
- Decisions — `"decided X"`, `"we'll go with X"`, `"let's use X"`
- Gotchas — `"the bug was X"`, `"root cause was X"`, `"TIL: X"`, `"X fails because Y"`
- Tools — `"the right command is X"`

Each match carries `evidence_quote` (≤200 chars), `evidence_speaker` (user/agent), `confidence` (0.5–0.75), and auto-tags. Modules: `runtime/src/hooks/user-prompt-extract.mjs`, pure rule registry in `runtime/src/hooks/extractors.mjs`, journal writer in `runtime/src/hooks/journal.mjs`. Smoke replay against an 8.8-hour real session: **14 learnings captured** (12 patterns, 1 gotcha, 1 decision).

**`SessionStart` drain.** Extended `runtime/src/session-start.mjs` to drain the journal at every session open, dedupe + classify + apply via the existing digest pipeline, then archive to `learning-journal.archive.jsonl`. Project-scoped `pattern`/`decision`/`tool` with confidence ≥ 0.5 append to `activeContext.md`. `correction`/`gotcha` go to `.agent-daemon/proposals/` for `ad status` review. Surfaces a one-line note in the session injection telling Claude what was carried over. Module: `runtime/src/hooks/journal-drain.mjs`.

**Profile wiring.** `user-prompt-extract` added to all three profiles (`minimal`/`developer`/`security`) in `runtime/profiles/profiles.json`. Standalone snippet at `hooks/user-prompt-submit-extract.json` for manual installs.

### Changed — Lenient digest-block parser

`runtime/src/digest/extract.mjs` now accepts both tag forms (`<agent-daemon[-:]digest>`) and both payload formats (JSON + a small hand-written YAML parser tuned to the digest schema — no new npm dep). Strips `` ```json `` and `` ```yaml `` Markdown fences. The tag regex is now global so the *last* block in a multi-block assistant turn wins (the intent was always "most-recent block wins" — the previous code took the first match in the turn). `VALID_TYPES` widened to accept the new `gotcha` and `decision` types.

### Changed — Audit ledger writes on every digest attempt

`runtime/src/digest/digest.mjs` now appends to `sessions.jsonl` on **all** exit paths: triage-skip, no-block-found, extract-error, success. Previously only success + triage-skip wrote a line, leaving "the daemon never ran" indistinguishable from "the daemon ran and found nothing." New `extract_source` values: `"no-block-found"`, `"extract-error"`, `"user-prompt-hook"`.

### Tests

Total runs from 33 → 74 (`pass 74 / fail 0`). New files:
- `runtime/test/extractors.test.mjs` — 15 cases over the regex rule registry
- `runtime/test/journal.test.mjs` — 7 cases (append/read/archive/rotation/fail-safe)
- `runtime/test/journal-drain.test.mjs` — 6 cases (routing, dedup, dry-run, audit-ledger write)
- `runtime/test/digest-lenient.test.mjs` — 10 cases (hyphen+JSON, colon+JSON, hyphen+YAML, colon+YAML, fences, no-block, multi-block, new types)
- `runtime/test/user-prompt-extract.test.mjs` — 3 subprocess cases (stdin → journal lands, empty prompt, malformed stdin)

### Earlier in this release

**`ad init` now scaffolds `session-logs/`.** A local-only (gitignored) per-project journal directory with a README documenting the format and the close-session workflow. The managed CLAUDE.md section now instructs Claude to update the log on three triggers — `"log tokens"`, `"close session" / "end session" / "session khatam"`, and `"new session"` — and mandates that closing a session emits BOTH the End-of-session block and the agent-daemon digest block in the same response.

**Bootstrap workflow in init output.** The post-init message and the managed CLAUDE.md section now surface the canonical bootstrap prompt (`"bootstrap the daemon memory using the bootstrap-daemon skill"`) so users know how to populate empty memory templates in their first session.

**Per-project session audit ledger.** Every digest run appends one JSONL line to `<project>/.agent-daemon/sessions.jsonl` capturing duration, turns, tool calls, edits, triage decision, learnings extracted/applied/queued, and extract source. Rotated at 5 MB. Module: `runtime/src/digest/session-log.mjs`. 5 new tests.

**`ad digest-latest` command.** One-shot manual digest for the VS Code Claude Code extension (where `SessionEnd` hooks don't fire reliably). Encodes the current `--cwd` to find the matching transcript folder under `~/.claude/projects/`, picks the newest `.jsonl`, and force-digests. Idempotent — SQLite dedupes already-processed sessions.

**`--force` flag for `ad digest`.** Bypass the triage threshold for short verification sessions or known-valuable transcripts.

**`--fallback-to-llm` flag for `ad digest` and `ad watch`.** Wire the LLM extraction path (was previously env-var-only). Now propagated through the SessionEnd hook command in profiles.

**`--once-on-existing` flag for `ad watch`.** Also digest transcripts that exist when the watcher starts.

### Changed

**Watcher reliability on Windows.** `ad watch` now:
- Forces `chokidar` polling mode on Windows by default (native `fs.watch` misses events deep in directory trees). Tunable via `AGENT_DAEMON_WATCH_POLL=1` elsewhere.
- Reads each transcript's actual `cwd` from inside the JSONL (Claude Code embeds it) instead of using `dirname(transcript)` — memory now lands in the correct project root.
- Logs every `+ add` / `~ change` event when `--verbose` is on.
- Propagates `--force` and `--fallback-to-llm` to each digest run.

**SessionEnd hook** (`hooks/session-end-digest.json` + `runtime/profiles/profiles.json`) now passes `--fallback-to-llm` so sessions without an agent-emitted digest block still get learnings extracted via LLM.

### Documentation

- New `docs/workflow.md` — daily workflow (`watch` vs `digest-latest`), the ending protocol, decision matrix, verification commands.
- New `docs/troubleshooting.md` — 13 documented failure modes with diagnosis + fix steps (Windows watch quirks, LLM fallback EOF, hook misses on VS Code extension, `{{PLACEHOLDER}}` confusion, encoded-path mismatches, etc.).
- New `docs/architecture.md` — three-loops model, components, full data-flow diagram, complete file-system layout, design-decision rationale.
- New `docs/contributing.md` — onboarding for new devs: layout, conventions, how to add commands/hooks/skills/tests, commit + branching rules.
- README reshuffled to surface daily workflow + reorganized Docs section.

## [0.2.0] — 2026-05-11

### Added

**Cross-harness adapters.** First-class support for Cursor and Codex alongside Claude Code (our primary target).

- `adapters/cursor/hooks.json` — Cursor v1 hook bindings that route to our `ad hook <name>` Node helpers (the same handlers Claude Code uses).
- `adapters/cursor/adapt.mjs` — convert `skills/<name>/SKILL.md` → Cursor `.mdc` rule. Modes: single skill (stdout), `--all`, `--core` (skips vendored).
- `adapters/codex/config.example.toml` — drop-in Codex configuration mirroring our profile matrix.
- `adapters/codex/agents/explorer.toml` + `agents/reviewer.toml` — Codex sub-agent role definitions referenced from the example config.

**Install profiles.** `ad init` now drives skill set + hook injection + feature gating from `runtime/profiles/profiles.json`.

- `minimal` — memory + lifecycle hooks only.
- `developer` (default) — adds `console.log` warn + build/PR-URL log + 7 core skills.
- `security` — extends developer with `git --no-verify` block, dev-server-not-tmux block, MCP audit log, untrusted-server warning + 3 security skills.
- `setup.sh --profile <name>` and `setup.ps1 -Profile <name>` delegate to `ad init --profile`.

**Ported hooks.** Reimplemented four production hooks from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) (MIT) as Node helpers under `runtime/src/hooks/`, exposed via `ad hook <name>`:

- `bash-pre` — block `git --no-verify` and dev-server-without-tmux; warn on `git push`.
- `bash-post` — surface `gh pr create` URLs, build completions.
- `edit-post` — warn on `console.log` in JS/TS files just edited.
- `mcp-audit` — append every MCP call to `~/.agent-daemon/audit/mcp.jsonl`; warn on untrusted servers.

**Skill catalog.** 181 net-new skills imported from upstream (each tagged with `source:` provenance frontmatter); `methodology-api-design` and `methodology-tdd` hand-merged with upstream sections.

**Tests.** 27 tests across hooks, profile resolver, skills-diff, and Cursor MDC conversion. `npm test` is wired in CI.

**CI.** GitHub Actions `test.yml` matrix (Ubuntu/macOS/Windows × Node 22) running `npm test`, `lint:skills`, `ad doctor` smoke, profile-plan smoke, and skills-diff shape check. `skills-lint.yml` for fast PR feedback on skill-only changes.

**Docs.** `ATTRIBUTION.md` at repo root credits upstream. `vendored/MANIFEST.md` pins the upstream commit (`841beea4`). `vendored/fetch.mjs` re-hydrates the snapshot. `docs/future-harnesses.md` records deferred work (Kiro/Trae/CodeBuddy/OpenCode/Gemini).

### Changed

- `runtime/scripts/lint-skills.mjs` exempts vendored skills (those carrying `source:` frontmatter) so upstream conventions don't break our linter.
- `runtime/package.json` test script: `node --test test/` → `node --test` (auto-discovery; old form failed with `MODULE_NOT_FOUND` when no fixtures matched).
- `hooks/README.md` documents the four new hook configs plus authoring conventions (`exit 0` on non-critical error, `<200ms` for blocking hooks, `[agent-daemon]` stderr prefix).
- `skills/README.md` explains the vendored-skill catalog and how to re-sync.
- `README.md` adds the install-profile matrix and links to `ATTRIBUTION.md`.

### Removed (from vendored snapshot)

These were stripped during import as out-of-scope for our daemon:

- `ecc2/` — upstream Rust control plane (architecture inspiration only).
- `ecc_dashboard.py` — upstream Tkinter dashboard.
- Multilingual READMEs, marketing files (`SOUL.md`, `EVALUATION.md`, `SPONSORS.md`, etc.).

Kept in the snapshot but not ported this release: `.codebuddy/`, `.kiro/`, `.trae/`, `.gemini/`, `.opencode/` — see `docs/future-harnesses.md`.

## [0.1.0] — 2026-05-10 (baseline)

Initial public state. Self-improving memory + skills runtime for Claude Code with multi-agent orchestration. 36 skills, 6 lifecycle hooks (SessionStart, SessionEnd, PreCompact, UserPromptSubmit, plus QMD-redirect), constitution layer, digest pipeline, GEPA skill evolution, multi-agent team templates, `ad init` / `ad doctor` / `ad team` / `ad spawn` CLI.

[3.0.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v3.0.0
[2.2.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.2.0
[2.1.1]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.1.1
[2.1.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.1.0
[2.0.2]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.0.2
[2.0.1]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.0.1
[2.0.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v2.0.0
[1.0.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v1.0.0
[0.2.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v0.2.0
[0.1.0]: https://github.com/pankaj-mahaur/Agent-Daemon/releases/tag/v0.1.0
