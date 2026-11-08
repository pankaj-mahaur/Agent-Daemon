# Architecture

How agent-daemon works under the hood. Read this if you're contributing, debugging weird behavior, or evaluating whether to adopt the daemon for your team.

---

## The three loops

agent-daemon is best understood as three nested loops:

```
┌─ Outer loop: cross-session learning ─────────────────────────────┐
│                                                                  │
│  ┌─ Middle loop: single session ────────────────────────────┐    │
│  │                                                          │    │
│  │  ┌─ Inner loop: single turn (Claude's tool use) ───┐    │    │
│  │  │                                                  │    │    │
│  │  │   PreToolUse → tool runs → PostToolUse           │    │    │
│  │  │   (block / allow / log / lint)                   │    │    │
│  │  │                                                  │    │    │
│  │  └──────────────────────────────────────────────────┘    │    │
│  │                                                          │    │
│  │   SessionStart  →  ... turns ...  →  SessionEnd          │    │
│  │   (inject memory)                    (run digest)        │    │
│  │                                                          │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│   memory/*.md  ←  digest  ←  many sessions                       │
│   (learnings persist across sessions)                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Inner loop** — hooks gate each tool call. Fast (< 200 ms), fail-safe.
**Middle loop** — one chat session. SessionStart loads context; SessionEnd digests.
**Outer loop** — accumulated learnings make every future session smarter.

---

## Components

### 1. CLI (`runtime/src/cli.mjs` + `runtime/src/cli-full.mjs`)

`runtime/src/cli.mjs` is the entry point the `ad` / `agent-daemon` bin shims and hook commands call. It is a small launcher: it routes the terminal UI (bare `ad`, `ad --last`, `ad tui`) itself, and hands every other command to `runtime/src/cli-full.mjs`, which holds the help text and the subcommand dispatcher. Roughly:

| Command | Module |
|---|---|
| bare `ad`, `ad --last`, `tui` | `runtime/src/tui/main.mjs` (`tui --preview`: `runtime/src/tui/preview.mjs`); whether bare `ad` can open it: `tui/flip.mjs`, `tui/preflight.mjs` |
| `session-start` | `runtime/src/session-start.mjs` |
| `digest`, `digest-latest`, `digest-sweep` | `runtime/src/digest/digest.mjs` |
| `watch`, `service` | `runtime/src/daemon/` |
| `hook <name>` | `runtime/src/hooks/*.mjs` (installed hooks run `runtime/bin/hook.mjs <event>` instead: the dispatcher, below) |
| `init`, `doctor`, `status`, `checkpoint` | `runtime/src/cli-full.mjs` directly |
| `review` | `runtime/src/review.mjs` (`review --import <id>`: `runtime/src/portability/state-cli.mjs`) |
| `memory`, `route`, `skill`, `viewer` | `runtime/src/memory/`, `route-map.mjs`, `skill-install.mjs`, `viewer.mjs` |
| `memory install`, `doctor`, `repair`, `status`, `uninstall` | `runtime/src/memory-install/` (also the `agent-daemon-memory` package's own CLI) |
| `skill propose`, `history`, `diff`, `undo`, `publish` | `runtime/src/skills/` (the skill library) |
| `state` | `runtime/src/portability/` |
| `sessions show` | `runtime/src/sessions/show.mjs` |
| `fallback` | `runtime/src/routing/` |
| `team *`, `spawn` | `runtime/src/orchestration/*.mjs` |
| `evolve` | `runtime/src/digest/gepa/*.mjs` |
| `auth`, `chat`, `run`, `loop`, `schedule`, `web`, `acp`, `tools`, `sandbox`, `agy`, `migrate` | `runtime/src/harness/*.mjs` (accounts: `runtime/src/auth/`; engine: `runtime/src/engine/codex/`) |

### 2. Hooks (`runtime/src/hooks/`)

Each hook is a small handler that reads JSON from stdin (the harness sends tool-call details) and writes a decision to stdout; the dispatcher (`runtime/bin/hook.mjs`, below) runs them by event. Hooks must:

- **Stay within the budgets** (spawned): `tool.before` 150/200/400 ms and `session.start`/`prompt.submit` 250/350/900 ms on Linux/macOS/Windows. `hook-latency.test.mjs` checks each hook's work over `node -e 0` (or, for a host that runs hooks through `pwsh`, over `pwsh` running it) against the budget minus node's reference start-up, scaled up on a slower runner
- **Fail safe** — any thrown error → `{}` and exit 0, never an allow (`{"decision":"approve"}` on PreToolUse would skip the user's own permission prompt); `tool.before` answers ask when it can't check a call a rule may cover
- **Log warnings to stderr only**, prefixed with `[agent-daemon]`
- **Wrap persistence in try/catch** — disk-full / permission errors must not block

See [`hooks/README.md`](../hooks/README.md) for the full list.

### 3. Digest pipeline (`runtime/src/digest/`)

Runs on `SessionEnd` or on demand via `ad digest` / `ad digest-latest`.

```
transcript.jsonl
    │
    ▼
┌─────────────────────────────────────────────┐
│ 1. summarize() (adapters/*.mjs)             │  Parse JSONL, count turns,
│    → TranscriptSummary                       │  collect events, detect adapter
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 2. triage(summary)                           │  Should we digest this at all?
│    → { shouldDigest, reason }                │  (duration ≥ 5min OR edits ≥ 1
│                                              │   OR tools ≥ 5)
└─────────────────────────────────────────────┘
    │
    ▼ (or --force)
┌─────────────────────────────────────────────┐
│ 3. extractLearnings(summary)                 │  Look for <agent-daemon-digest>
│    → { learnings, sessionSummary, source }   │  block in agent's text.
│                                              │  Fallback: LLM extraction.
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 4. classify(learnings, availableSkills)      │  Route each learning to a target:
│    → ClassifiedLearning[]                    │  activeContext.md | proposed/
│                                              │  | constitution/ | skills/
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 5. applyLearnings(classified)                │  Store for review:
│    → { sqliteInserted, quarantined, ... }    │  - Insert into SQLite as pending
│                                              │  - Queue skill/constitution edits and
│                                              │    held-back notes to .agent-daemon/proposed/
│                                              │  (accepting in review appends to .md)
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│ 6. appendSessionLog(entry)                   │  One JSONL line to
│                                              │  .agent-daemon/sessions.jsonl
└─────────────────────────────────────────────┘
```

### 4. Memory (`.agent-daemon/memory/` + SQLite)

**Per-project markdown** (`.agent-daemon/memory/`):
- `projectbrief.md` — high-level goals + scope
- `productContext.md` — user-facing features + decisions
- `activeContext.md` — current focus, recent decisions, in-flight branches
- `systemPatterns.md` — architecture, recurring patterns, ADRs
- `techContext.md` — stack, dev setup, env vars, gotchas
- `progress.md` — what's done, what's queued
- `user.md` — collaborator-specific notes

**Global SQLite** (`~/.agent-daemon/episodic.db`):
- `sessions` — one row per digested session
- `learnings` — one row per extracted learning, queryable by tag / scope / confidence
- `skill_failures` — feedback signal for the GEPA evolve loop
- `injections`, `correction_events`, `feedback` — what each session was shown, each correction and whether it repeated a lesson, and memory_feedback verdicts; read by `ad memory report` ([Memory metrics](memory/metrics.md))
- `history_clusters`, `instruction_imports`, `instruction_import_notes` — what a consented import found (`memory/history-import.mjs`, `memory/instruction-import.mjs`, made by the import itself, no schema bump): per project, each correction cluster of the Claude Code and Codex history (the redacted sentence only for 2+ repeats, keyed hashes otherwise) and each instruction file's version with the pending notes it became. Never exported; once proposed, a cluster's sentence lives only in its note, so rejecting or purging the note removes it. `proposal_rejections` keeps what you rejected in review out of later imports (keyed hashes, key in `memory/history.key`). `memory/review-queue.mjs` orders the review screen: up to 5 notes you saved in the last week, then every other pending note by repeat count, then one row per instruction file

The database opens through `better-sqlite3`, or Node's built-in `node:sqlite` (Node 22.16 or newer) when that isn't installed (`runtime/src/memory/driver.mjs`; `AD_SQLITE_DRIVER` picks one, `ad doctor` shows which).

**How memory stays safe** (details: [memory/security.md](memory/security.md)):
- **Project ids** (`memory/projects.mjs`). Each project has an id in `~/.agent-daemon/projects.json` (and `.agent-daemon/project.json` in a project you set up), and memory rows carry it, so a moved folder keeps its memory. Two folders whose old path slugs collide are withheld until each has its own id (`memory/safety.mjs`, `ad memory assign`).
- **One scope per reader** (`memory/scope.mjs`). The memory MCP server is bound to one project when it starts; no tool argument changes it.
- **The review service** (`memory/review-service.mjs`, `memory/trust.mjs`). Every writer stores a new note *pending*, and one the injection screen or the secret check flags *quarantined*. Only the review service accepts a note, and only with a token issued in your own terminal: a TTY, not the agent's tool shell (`AD_TOOL_SHELL`), and no agent process anywhere above it (`memory/ancestry.mjs` walks the whole process chain: Windows through one PowerShell CIM walk, Linux through `/proc/<pid>/exe`, macOS through `/bin/ps`). The host, the first process above the shells, decides the rest: a known terminal installed where the user's processes can't write passes (names alone prove nothing: on Windows the executable sits under Program Files, or is the Windows folder's `explorer.exe`, and is owned by SYSTEM, Administrators or TrustedInstaller with no write right for anyone else, which the walk reads through .NET; the Windows folder comes from the loaded system DLLs, never from `SystemRoot`; on macOS and Linux root owns the executable and every folder above it, none group- or world-writable). An editor's terminal, a PTY wrapper or multiplexer (tmux, `script`, ssh), an unknown app or a broken chain needs a one-time code shown in a native dialog and typed back (`memory/dialog-code.mjs`: the code reaches the dialog through stdin, never a command line; the dialog program by absolute path; on Linux the display from the editor's own process, never ad's environment). No environment variable stands in. An accepted note carries `accepted_by` (`review`, or `legacy` for notes accepted before schema v5), and readers serve accepted notes only (`acceptedSql`). Older ad, which reads `status = 'active'`, never sees a pending note as accepted. `ad review` and `ad memory held` (`memory/held.mjs`) are the ways in; `review-gate.test.mjs` holds the rest of the code to it. A gate against accidents and injection, not a sandbox. Forgetting follows the same line: an agent's forget, bound to its project, hides a note the agent itself wrote, never your own captured words, and only marks an accepted note `forget-requested` (still served until you decide). Only the review service erases or archives an accepted note (and drops its line from the project's memory file), or retires one in `ad memory consolidate --apply-*`; the maintenance pass erases hidden unaccepted notes after 7 days and returns 30-day-old provisional ones to pending (`memory/purge.mjs`). Every connection runs with `PRAGMA secure_delete`, the index with FTS5 secure-delete, and an erase ends with VACUUM and a WAL truncate (retried by maintenance when another process holds the store), so the text leaves the file, not just the row. An import never carries who accepted a note. The index's secure-delete raises its FTS5 format, so a `sqlite3` older than 3.44 (macOS's own, for one) can't read `learnings_fts`; ad's drivers are newer. Stated limits of the gate: an agent that drives a real terminal's own input (UI automation, a terminal's remote-control API such as `wezterm cli send-text` or Konsole's D-Bus) or reads the screen gets past it; the launch plan's self-protection hooks narrow that where hooks run.
- **Provisional notes and where notes came from** (`memory/provisional-write.mjs`, `memory/review-mode.mjs`, `memory/l5-tables.mjs`). A *provisional* note is a correction you typed that applies at once, tagged, in its project only, and goes back to pending after 30 days. Only `writeProvisional` makes one, and it re-checks everything itself: a first-party verdict the prompt hook issued for that prompt's own words (`hooks/prompt-source.mjs`: a positive host signal such as `source: "user"`, the hook's parent being the host's own executable, and the host's version), review mode not strict, a project, and a note that isn't flagged. No host qualifies yet (the allow-list in `hooks/host-capabilities.mjs` is empty), so every capture waits for review. Review mode (`strict` or `auto`) lives in the store and stays strict once set unless you turn it back with the review token. Each note records its provenance (`user-prompt`, `prompt`, `user-cli`, `agent`, `buffered`, `digest`, …), and an `events` table records what happened to it (kinds and hashes, never text). A provisional or hidden note never feeds a rule, sync, a global note or an export.
- **Capture from your prompts** (`memory/capture-prompt.mjs`, `memory/prompt-screen.mjs`). On each prompt the dispatcher runs one capture: the prompt screen (normalises zero-width, bidi, tag and look-alike characters, decodes base64/hex/ROT13, then looks for instructions aimed at the agent or its memory, review bypass, fake system or tool blocks, exfiltration, guard weakening and unsafe workflow rules — the last two polarity-aware for your own words, so "never use `--no-verify`" isn't flagged), L4a's correction extractor on your own words (pasted blocks, quotes and machine output stripped), and a dedupe against the project's notes. A clean correction is stored pending (provisional only on a host that can prove you typed it — none yet), a flagged one held back for a closer look, one with a secret not stored; a typed remember (`/<plugin>:remember`, `$<pkg>-remember`) goes the same way with its words as the note. It writes straight to a current store, else to the journal (which drains as `buffered`). Claude Code shows one receipt line per capture with the note's id.
- **Forget, restore and the memory verbs** (`memory/forget.mjs`, `memory/memory-cli.mjs`, `memory/reminder.mjs`, `hooks/memory-command.mjs`). One authority table decides a forget or restore by who asks: a first-party prompt or the CLI with the review token hides the user's notes (an accepted one is purged only from the terminal with its id typed back); a typed prompt no host can prove only marks the user's note; the CLI without the token (the agent's shell) hides only the agent's notes and turns an accepted note `forget-requested` (still recalled and enforced). A prompt's hide of the user's note keeps no clock until review shows it. Restores come back pending (provisional only through `writeProvisional` for a first-party restore, with its first 30-day clock). The agent's hides are told once on the next typed Claude Code prompt; the attended Claude Code session start shows a review reminder counted from the store (daily, then weekly).
- **Secrets** (`security/secret-patterns.mjs`). Key-shaped text is replaced with `[redacted:<kind>]` at every write and masked again when older notes are shown.

**The mistakes report** (`runtime/src/mistakes/`, [mistakes.md](mistakes.md)) reads the agents' own history and touches none of the above: no store, no file write, no network, no process (`mistakes-cli.test.mjs` runs it under a preload that trips on each). `cli.mjs` routes `ad mistakes` before loading the full command module. `history.mjs` lists Claude Code transcripts and Codex rollouts for the consent screen, then keeps only typed prompts (the S-HISTORY filters: meta, sidechain, compact summaries, wrappers, tool results, non-typed origins, injected context, subagent and headless runs; mid-turn prompts from `queued_command` attachments) and drops resumed and forked copies by uuid or item id. `classify.mjs` decides, with fixed rules, whether a prompt is a durable correction (gate: the held-out extractor corpus); `cluster.mjs` groups corrections by content words that carry a direction (`+pnpm -npm`), so opposite rules never merge; `redact.mjs` shortens each shown sentence; `coverage.mjs` counts `CLAUDE.md` rules Codex doesn't read and the other way round.

**The hook dispatcher** (`runtime/bin/hook.mjs <event> [--host claude|codex|ad] [--plugin]`). Every hook ad installs runs it: `ad init` writes Claude Code's entries in exec form (`{command: "node", args: [<abs>/runtime/bin/hook.mjs, <event>]}`, no shell in front; a command string for a Claude Code older than 2.1.314), ad's engine writes its `hooks.json` with it (`--host ad`), and the memory plugin's `server/hook.mjs` is the same dispatcher with `--plugin` (memory only; a step passes through when ad init's entry runs it). Each event loads only what it needs. **Routes** (`hooks/routes.mjs`): one row per host event and dispatcher event, each serving "steps" (the hook ids of `profiles.json`, plus `rules-check`, `scheduled-hashes` and `subagent-hashes`, which every install has). `ad init` replaces ad's older `ad hook …` entries and routes at another path, keeps every step they ran (a guard from an earlier profile stays) and the user's settings on them (`if`, a longer timeout, `onFailure`), and leaves other tools' hooks alone; no step runs from two entries. Events: `session.start`, `prompt.submit` (capture, recall and routing advice in one process, one `additionalContext`), `tool.before`, `tool.after` (scheduled-prompt hashes; build and edit notes), `subagent.stop`, `session.end` (spawns the digest), `skill.use`, `bash.guard`, `mcp.audit`. The dispatcher always exits 0 with JSON. **It never migrates the memory store**: it sets `AD_HOOK_NO_MIGRATE=1`, and `memory/sqlite.mjs open()` then reads the schema version read-only and opens only a store at this ad's `SCHEMA_VERSION`; otherwise the hook goes on without it (captures stay in the journal, the drain waits; telemetry, injection records and heartbeats of that moment are dropped, and recall shows nothing) and `memory/no-migrate.mjs` starts `memory/migrate-job.mjs` detached for an older or missing store (once per 5 minutes) and only logs for a newer one. At this ad's version, `open()` still runs its idempotent schema and migration statements: they set per-connection pragmas and mirror project keys, and change nothing else. While a memory plugin from before the dispatcher is on, `ad init` writes the prompt and session-start routes as command strings ending in a shell comment that carries the words that plugin's duplicate guard looks for (`OLD_PLUGIN_TAGS`). What a hook couldn't do goes to `adRoot()/hooks/hook.log`; `ad doctor` (`hooks/hook-doctor.mjs`) shows its tail, steps run twice, dead or temporary hook scripts, the rules file, an outdated memory plugin, the rules check's mode per host and the Claude Code version fail-closed needs, and which of the engine's hooks wait to be trusted. `tool.before` reads the rules snapshot `adRoot()/guards.json` (`hooks/guards.mjs`: the review service writes it with a generation number and keeps a last-good copy; a corrupt file falls back to that copy, a missing one means no rules) and runs the rules matcher, and nothing else: no memory store, no project registry, no full CLI (`startup.test.mjs` traces the import graph per event; `hook-latency.test.mjs` holds each event's work over `node -e 0` to its budget). The project is the snapshot root that contains the session's folder, found read-only. Decisions follow `hooks/host-capabilities.mjs`: Claude Code asks (denies in `bypassPermissions` and `dontAsk`, where an ask may be skipped), Codex denies with the reason (it fails open on ask); a matcher error or an unreadable command a rule may cover is an ask. `prompt.submit` classifies the prompt first (`hooks/prompt-source.mjs`: subagent markers, headless runs, ad's workers, wrappers, generated prompts, and hashes of recorded `CronCreate`/`ScheduleWakeup` inputs and subagent messages); prompts no one typed aren't captured, and the provisional allow-list is empty, so every capture waits for review. Session-end work runs detached and single-flight (`hooks/detached.mjs`).

**Rules** (`runtime/src/rules/`, the coming rule hook's matcher, used by the report's rule split today). Rules use one neutral schema: `{type:"command", program, subcommands, flags}` (the program after its path and `.exe`/`.cmd`/`.bat`/`.ps1`; the first non-option argument among `subcommands`; at least one of `flags`) or `{type:"write", globs}` (project-relative). `shell.mjs` turns a command line into every simple command it runs, in bash, PowerShell or cmd syntax: chains and control flow, nested shells (including a decoded `-EncodedCommand`), substitutions, here-documents fed to a shell, wrappers and package runners, quoting, Windows case and PowerShell's built-in aliases; text that is only data never becomes a command. `paths.mjs` resolves a target against cwd and the project root with the call's own OS rules and matches globs (a slash-free glob matches at any depth). `match.mjs` decides one call; a command rule never reads file content and a write rule never reads a shell command. `derive.mjs` turns a correction into a rule or a reminder, clause by clause (a negation forbids what its own clause names; "use pnpm" forbids npm installs; obligations and content are reminders). `replay.mjs` counts what a rule would have asked before over the history's tool calls (`history.mjs` `claudeToolCalls`, `codexToolCalls`). Pure: no fs, no spawn, bounded input.

### 5. Watch daemon (`runtime/src/daemon/watch.mjs`)

Foreground process. Uses `chokidar` (with Windows polling fallback) to watch transcript directories. For each file:

1. Detect change (`add` / `change`)
2. Debounce — wait 30 sec for the file to be stable
3. Stability check — poll size across two 5-sec intervals
4. Extract cwd from the transcript itself (Claude Code embeds it)
5. Fire `runDigest({ transcript, cwd, ... })`

Watched directories: `~/.claude/projects`, `~/.cursor/sessions`, `~/.codex/sessions`, and the harness's `~/.agent-daemon/engine/sessions` (opt out with `"harnessSessions": false`).

Also polls team inboxes every 10 sec for multi-agent orchestration, and runs scheduled harness jobs (`ad schedule`).

### 6. Constitution (`constitution/`)

Plain markdown files loaded into every session via `SessionStart`. Defines:

- `core.md` — identity, scope, what the agent is for
- `safety.md` — destructive-op guardrails, secret handling
- `verification.md` — how to confirm work is done
- `communication.md` — output style, when to ask vs proceed
- `ending-protocol.md` — the `<agent-daemon-digest>` block format

Constitution changes propagate to all future sessions on the next start. **No agent restart needed.**

### 7. Skills (`skills/`)

`SKILL.md` files with YAML frontmatter. Each is a self-contained "how to do X" instruction loaded on-demand. The classifier in the digest pipeline can route learnings to extend existing skills (via proposals).

### 8. Team orchestration (`runtime/src/orchestration/`)

Optional multi-agent layer. `ad team create` spins up a coordinator + workers, each in its own git worktree. `ad spawn` adds workers to an existing team. `ad team inbox` reads cross-agent messages.

Workers default to sandboxed engine threads: they can't reach the network or write `.git`, and the daemon commits their work on their branch. `--engine claude` (or `AD_AGENT_ENGINE=claude`) spawns headless `claude` as in v1.

Out of scope for daily solo workflow — see [`skills/orchestrate-team/SKILL.md`](../skills/daemon/orchestrate-team/SKILL.md) when you need it.

### 9. Agent harness (`runtime/src/harness/`, `runtime/src/engine/`)

ad's own agent runs on a pinned app-server, driven over JSON-RPC on stdio in ad's own engine home. `engine/index.mjs` is the engine API the rest of ad uses; `engine/codex/` is the only code that knows the engine's protocol and the only code that starts it. `harness/` holds the front ends (`chat`, `run`, `loop`, `schedule`, `web`, `acp`, `auth`, `sandbox`, `tools`, `agy`), the harness-home setup (`setup.mjs`: hooks, memory MCP server, skills, Windows sandbox), the session controller the terminal UI drives (`session.mjs`) and the `/undo` checkpoints (`checkpoints.mjs`). See [harness-design.md](harness-design.md).

### 10. Terminal UI (`runtime/src/tui/`)

Bare `ad` / `ad tui`: an inline terminal UI on the session controller. `terminal/` is the terminal layer (input decoding, sanitizing, widths, the inline renderer), `view/` the components (composer, markdown, cells, chrome, approval prompts), `app.mjs` the slash commands and keys, `main.mjs` the startup (sign-in, folder trust, header), `ad-layer.mjs` ad's own features (memory, loops, schedules, teams) and `undo.mjs` the `/undo` wiring. See [tui-architecture.md](tui-architecture.md) and [tui.md](tui.md).

---

### The provider gateway (P3.3)

API keys live in the secret store and in one place at run time: ad's gateway, a child process (`runtime/src/gateway/`) listening on `127.0.0.1`. The engine gets a per-run token and, per ready API account, a `-c model_providers.<entry>={ base_url = "http://127.0.0.1:<port>/p/<entry>/v1", env_key = "AD_GATEWAY_TOKEN" }`; the gateway swaps the token for the account's key, forwards `POST responses` and `GET models`, decodes a body the provider compressed anyway, and emits one observation per request (status, limits, usage, the error's class) for ad's own use. ad 3.0's provider name `openrouter` is pointed at the same route, so 3.0 conversations resume. Nothing about it is written to `config.toml`.

### Chat translation in the gateway (P6.1)

Some providers speak only Chat Completions; the engine speaks only the Responses API. A route whose preset says `mode: "chat"` is translated inside the gateway (`runtime/src/gateway/translate/`), so keys, the token check, the address allowlist and the redirect refusal stay the gateway's:

- **Request.** The engine's Responses request becomes a Chat body (`responses-in.mjs`). Namespaced and custom tools get flat names that map back exactly (`tools.mjs`). Anything with content ad can't carry is refused with HTTP 400 naming the field, never dropped. The engine's default cached web search is left out: it only works on OpenAI's own servers.
- **Answer.** The Chat stream becomes the engine's Responses events in its exact item shapes (`responses-out.mjs`). A tool call is handed over only whole, with its arguments parsed and its namespace or custom shape restored. A stream cut off mid-call, a length stop or an unmappable call runs nothing.
- **Failures.** Only codes the engine knows reach it (`errors.mjs`): a used-up daily or monthly limit is `insufficient_quota` (asked once, never retried), a per-minute limit `rate_limit_exceeded` with its wait, a too-long context the stream form of `context_length_exceeded`, a cut-off an unknown code (exactly one retry). The provider's real reason goes to the gateway's observation, and the TUI's failed-turn line and `ad run` show it instead of the engine's generic words.
- **Native modes** (P6.4): routes with `mode: "anthropic"` or `"gemini"` build the vendor's own request from the same translated turn (`upstream/anthropic.mjs`, `upstream/gemini.mjs`) and parse its own stream; everything engine-facing is the shared writer's. Claude's thinking blocks travel in a sealed envelope under their own scope, Gemini's signatures as per-call extras. The gateway refuses any upstream address carrying a key-like query parameter.
- **Hidden reasoning** a provider wants back (DeepSeek's) travels in the engine's `encrypted_content` as an AES-256-GCM envelope bound to provider and model, under a per-install key in the secret store (`gateway-seal`).
- **Contract.** `scripts/record-engine-requests.mjs` records what the pinned engine sends into `test/fixtures/gateway/engine-<version>/`; `translate-contract.test.mjs` translates every recorded request. An engine upgrade that changes the wire fails there first.
- `AD_TRANSLATE=0` turns translated routes off (they answer 502 with the reason).

### Accounts, engines and switching (P3.4)

- **Target** (`runtime/src/auth/accounts/target.mjs`). Which account and model a conversation starts on is resolved before any engine starts, in this order:
  1. a flag or command;
  2. this window's choice;
  3. `AD_ACCOUNT`/`AD_MODEL`;
  4. the project's `.agent-daemon/config.json` `target`, read only in a trusted folder;
  5. the registry's default;
  6. 3.0's settings.

  The level that names the account also bounds the model. A target is fixed when its thread starts.
- **Engines** (`runtime/src/engine/manager.mjs`).

  | Engine id | Home | Serves |
  |---|---|---|
  | `api` | `@default` (no ChatGPT sign-in there) or `api/` | every API-key account, through the gateway |
  | an account id | that account's own home | a ChatGPT account (or an OpenAI key the engine keeps) |

  The EngineManager runs one process per engine id per ad process:
  - Leases are in-process. An unleased engine stops after an idle period unless it was pinned.
  - An acquire during that stop waits for it, so there are never two processes on one id.
  - When the gateway entries change, `restartIfStale` restarts the engine, and only when no turn runs.
- **Launch** (`runtime/src/harness/engines.mjs`). Every entry point (the terminal UI, `ad run`/`chat`/`loop`, `ad web`, `ad acp`, workers) calls `launchHarness`:
  1. adopt 3.0's key as an account;
  2. resolve the target;
  3. acquire the engine of the home that serves it (`@default`, `api`, `a/<id>`) from the process's EngineManager;
  4. start threads with that account's provider entry.

  A home a command or test chose (`--home`-style options) runs as before, with no accounts. `--resume`/`--last` look in the other homes too.
- **Settings record** (`runtime/src/harness/settings-sync.mjs`). The default home is the record for `[tui]` and folder trust. It is read through the engine's `config/read` (no TOML parser) into `accounts/settings-record.json`, mirrored into `api/` and `a/<id>` at each engine start, and edits made elsewhere wait as `pending` for the default home's next start.
- **Switching** (`runtime/src/engine/switch.mjs`). A loaded, subscribed or running thread keeps its provider on `thread/resume` even though the answer says success. So:
  - `resumeThread` with a provider or model first refuses a running thread, or one whose background terminals the caller names (`RETARGET_BUSY`). Otherwise it unsubscribes, waits for the unload, and checks the answer (`RETARGET_IGNORED`). A fork that names a provider or model is checked the same way.
  - Switching to another account of the same provider forks:
    1. pause the goal;
    2. confirm the thread is idle;
    3. fork with `deferGoalContinuation` and check the fork took the target;
    4. move the goal to the fork: an active goal is paused there, any other status is kept.

    If any step fails, the goal ad paused is active again, and a fork that ignored the target is archived.
  - After the fork, the old thread is unsubscribed. If background terminals still run in it, it stays subscribed and watched until they end, because unloading would kill them. A turn the engine starts on it is stopped and reported.

### The session record and fallback (`runtime/src/sessions/`, `runtime/src/routing/`)

- **Logical sessions.** One session follows a conversation across threads and engine homes (a switch, a fork, a fallback). `sessions/coordinator.mjs` turns the session's events into an append-only record, `~/.agent-daemon/sessions/ses_<id>.jsonl` (`ledger.mjs`): which account and model ran each turn, who started it, and what each tool call did and how it ended, never its content. `sessions/index.json` maps threads to sessions. `ad sessions show` reads it; `AD_LEDGER=0` turns it off.
- **Switching.** `sessions/switch.mjs` decides how a conversation moves to another target at a safe point (the next turn, a fork for another key of the same provider, or a new thread seeded with a continuation capsule built from what you saw, `capsule.mjs`); `switch-runner.mjs` does it.
- **The fallback order.** `~/.agent-daemon/fallback.json` (`routing/store.mjs`, under a lock) holds the order and its rules; `routing/policy.mjs` validates it and keeps the consent hash, which clears itself when a confirmed destination changes. `routing/next-target.mjs` picks the next target from the accounts, their model catalogs and the last limits seen.
- **Automatic fallback.** `sessions/fallback.mjs` makes every decision as pure functions; `fallback-controller.mjs` acts at turn boundaries in `ad tui`, and in `ad run`, `ad loop`, schedules and team workers that opted in (`--fallback`, `ad team set <team> fallback on`).

### Portable state (P7.1b, `runtime/src/portability/`)

`ad state` moves ad's state to another machine ([harness.md](harness.md#moving-ad-to-another-computer) has the user's side). `export.mjs` writes a bundle for the selected projects from a consistent snapshot; `import.mjs` stages an untrusted bundle under `~/.agent-daemon/imports/<id>/`, checks its database for parts ad didn't make (`inspect-db.mjs`), maps projects, and applies a journaled, resumable, reversible plan. The format:

- **One file, `.adstate`:** tar (ustar, pax only for a long name or size) in gzip, written deterministically (sorted, mode 0600/0700, no times or owners). The reader accepts only files, folders and pax `path`/`size`; a link, a device, a global pax header or a name that could leave the bundle is an error, never a partial read (`archive.mjs`, `names.mjs`).
- **`manifest.json` first:** what is inside, from which machine, what was left out and why; a bundle never carries secrets (`manifest.mjs`).
- **Path tokens:** `{HOME}`, `{AD_ROOT}`, `{PROJECT:<id>}` replace one machine's absolute paths in structured fields (the longest root wins; case-insensitive only from Windows or macOS), so a project lands wherever it lives on the target (`paths.mjs`).
- **The inventory:** every file under ad's state root and a project's `.agent-daemon` belongs to one class: taken by default, only on request (`--include`), left behind (machine-local), or never (secrets, engine folders, sign-ins) (`inventory.mjs`). A test fails when the code adds a folder no class names.

## Data flow — a single session, start to finish

```
[ User opens Claude Code ]
        │
        ▼
SessionStart hook fires
   → node runtime/bin/hook.mjs session.start
   → reads constitution/*.md + memory/*.md + queries SQLite for relevant past learnings
   → emits JSON {"hookSpecificOutput": {"additionalContext": "..."}}
   → Claude Code injects as a system-prompt addendum
        │
        ▼
[ User asks Claude to do something ]
        │
        ▼
PreToolUse hooks fire on each tool call
   → hook.mjs tool.before (your rules; Bash, PowerShell, Write, Edit)
   → hook.mjs bash.guard  (security profile: e.g. block `--no-verify`)
        │
        ▼
[ Tool runs, e.g. Edit creates file.ts ]
        │
        ▼
PostToolUse hooks fire
   → hook.mjs tool.after (warn on console.log, tag PR URLs,
     remember prompts the model scheduled)
        │
        ▼
[ ... many turns ... ]
        │
        ▼
[ Agent emits <agent-daemon-digest> block in final message ]
        │
        ▼
[ User closes chat ]
        │
        ▼
SessionEnd hook fires (terminal CLI) OR
ad watch detects file settled OR
user runs `ad digest-latest`
   → ad digest --transcript X --cwd Y
   → triage → extract → classify → apply
   → memory/*.md grows, SQLite inserts, sessions.jsonl appends
        │
        ▼
[ Next session — SessionStart picks up the new memory ]
```

---

## File-system layout

```
Agent-Daemon/                       # The cloned repo
├── README.md
├── CHANGELOG.md
├── SECURITY.md
├── ATTRIBUTION.md
├── DEPENDENCIES.md
├── docs/
│   ├── workflow.md                 # ← this stream of docs
│   ├── troubleshooting.md
│   ├── architecture.md             # ← you are here
│   ├── harness.md, harness-design.md       # the agent harness: use, design
│   ├── tui.md, tui-architecture.md         # the terminal UI: use, design
│   ├── testing.md, manual-test.md          # test layers and CI, end-to-end checklist
│   ├── contributing.md
│   ├── installation-guide.md
│   ├── customization-guide.md
│   ├── skill-anatomy.md
│   ├── commands.md                 # engine slash commands in ad, keys, shared settings
│   ├── accounts.md, providers.md   # accounts and providers
│   ├── memory/                     # ad's memory in other agents: install, hosts, tools, security, metrics, FAQ
│   ├── support-matrix.md           # where memory is tested live
│   ├── privacy.md, terms.md
│   ├── upgrade-3.0.md
│   ├── ecosystem.md
│   └── future-harnesses.md
├── constitution/                   # Loaded into every session
├── memory-templates/               # Scaffolded into projects on `ad init`
├── skills/                         # Skills library
├── hooks/                          # Hook JSON snippets for settings.json
├── teams/                          # Multi-agent team templates
├── adapters/                     # per-agent reference configs (your own install, cursor)
├── runtime/                        # Node implementation
│   ├── src/
│   │   ├── cli.mjs                 # Launcher: terminal UI; the rest → cli-full.mjs
│   │   ├── cli-full.mjs            # Help text + dispatcher for every other command
│   │   ├── digest/                 # Pipeline modules
│   │   ├── hooks/                  # Hook handlers
│   │   ├── memory/
│   │   ├── mcp/                    # MCP memory server (reads + usefulness feedback)
│   │   ├── engine/                 # The engine adapter and façade
│   │   ├── harness/                # chat/run/loop/schedule/web/acp/auth/sandbox/agy, session controller, /undo checkpoints
│   │   ├── tui/                    # Terminal UI: terminal/ layer, view/ components, app, /undo wiring
│   │   ├── auth/                   # Accounts, provider keys + secret store
│   │   ├── gateway/                # The local provider gateway (keys stay here) and chat translation
│   │   ├── providers/              # Provider presets, model catalogs, limits, spend
│   │   ├── sessions/, routing/     # The session record, switching, fallback
│   │   ├── portability/            # ad state export / import
│   │   ├── memory-install/         # ad memory install (other agents)
│   │   ├── skills/                 # The skill library: versions, history, undo, publish
│   │   ├── security/               # The agent-shell guard, secret patterns
│   │   ├── orchestration/
│   │   ├── adapters/
│   │   ├── daemon/                 # Watcher
│   │   └── ...
│   ├── test/                       # Node --test suite
│   ├── profiles/profiles.json      # Install profile manifest
│   └── package.json
├── vendored/                       # Upstream snapshots (gitignored)
└── setup.sh / setup.ps1            # Convenience installers

~/.agent-daemon/                    # User-level state (per-machine)
├── episodic.db                     # SQLite — learnings, sessions
├── audit/mcp.jsonl                 # MCP call audit (security profile)
├── logs/                           # Digest failure reports, tui-probe logs
├── checkpoints/                    # Pre-compact memory markers (ad checkpoint; not /undo)
├── watch.json                      # Watcher config
├── engine/                         # Engine home (login, config, rollouts, skills mirror); codex-home/ on installs from before 3.0 (ad migrate renames it)
├── api/, a/<account id>/           # More engine homes: API-key accounts once engine/ holds a ChatGPT sign-in; an account's own home (see "Accounts, engines and switching")
├── launch/                         # The empty folder the engine process starts in
├── accounts/registry.json          # Accounts: id, label, owner, where the key lives (never the key)
├── secrets/                        # Provider keys (file backends)
├── quota/, catalog/                # Last limits and today's spend per account; each account's model list (re-read from the providers)
├── fallback.json                   # The fallback order and its rules (ad fallback)
├── sessions/                       # The session record: index.json + ses_<id>.jsonl (ad sessions show)
├── imports/<id>/                   # ad state import: staging, journal, unmapped files
├── memory/                         # ad memory install: install-ledger.json, backups/<host>/
├── schedules.json, schedule-logs/  # ad schedule jobs + output
├── tui/                            # Terminal UI: prompt history (0600), per-folder state
├── locks/                          # Conversation locks (one ad per conversation); a holder is judged by its process start time, so a reused pid is free at once and a suspended session keeps its lock
├── skill-manifest.json             # Provenance of skills installed with ad skill install
├── skills/<name>/                  # Accepted skill versions: current/, versions/<n>/, meta.json (ad review, ad skill undo)
├── projects.json                   # Project ids: paths, slugs, git remote (memory/projects.mjs); memory rows carry project_id
├── projects/<project id>/          # Capture files of a project without ad init (journals, proposals, memory)
├── teams/                          # Team state + inboxes
└── worktrees/                      # Worker git worktrees

<project>/.agent-daemon/            # Per-project state (per-codebase)
├── memory/                         # Project memory markdown files
├── proposed/                       # Queued proposals for review (ad status / ad review)
├── applied/, rejected/             # Proposals after review, kept as a record
├── sessions.jsonl                  # Per-session audit ledger
├── loops/                          # ad loop iteration logs
├── loop-tui.log                    # Output of a /loop started from ad tui
└── STOP                            # Create to stop a running ad loop

<repo>/.git/                        # Per repo where ad tui ran (/undo)
├── ad-checkpoint-index             # Private index for snapshots (never your index)
└── refs/ad/checkpoints/            # Snapshot trees, before and after each turn

~/.claude/settings.json             # Where hooks are registered
~/.claude/projects/<encoded>/*.jsonl  # Transcripts (input to digest)
~/.agent-daemon/engine/sessions/**/rollout-*.jsonl  # Harness transcripts
```

### Harness mode

The same hooks from `runtime/profiles/profiles.json` are rendered into the engine home's `hooks.json`, so `ad tui` (bare `ad`), `ad chat`, `ad run` and `ad loop` get memory injection, correction capture and guards. The engine caps SessionEnd at 3 s, so that hook spawns a detached `ad digest` instead of digesting inline. Memory is also exposed to the agent as the `agent-daemon-memory` MCP server, whose tools run without an approval prompt (`default_tools_approval_mode = "approve"`, unless the user set a mode). Design: [harness-design.md](harness-design.md).

**Isolation from the user's own install.** `runtime/src/engine/codex/` is the only code that starts the engine, and every spawn goes through `codexEnv()` in `home.mjs`:

- It runs only the pinned binary from `runtime/node_modules` (or `AD_ENGINE_BIN`), never a global or PATH install.
- Its home must be ad's own. `~/.codex`, a `CODEX_HOME` set by the user's shell, and any path that resolves to one of them are refused. Paths are compared by real path, which collapses junctions, symlinks, `\\?\`, 8.3 names and case. On Windows, trailing dots and spaces and UNC paths are refused too.
- Every `CODEX_HOME`, `CODEX_API_KEY` and similar variable is dropped, because those override config; `CODEX_CA_CERTIFICATE` is kept.
- `AD_INTERNAL_ENGINE_HOME` is stamped on the child, so hooks that the engine runs for ad recognise the home as ad's.
- `ad doctor` and the protocol-schema generator run the engine in throwaway temp homes.
- On Windows, `withoutStoreAliases()` in `app-server.mjs` drops every PATH entry with a `WindowsApps` segment at each spawn: the sandbox can't start PowerShell 7 from the Microsoft Store, so the engine uses an MSI PowerShell 7 or Windows PowerShell 5.1.

**Testing against the engine.** Three layers sit under the unit tests:
- the scripted fake app-server (`runtime/testkit/fake-codex-app-server.mjs`) for crashes and edge traffic;
- the real pinned binary against a mock Responses server (`runtime/test/engine-real.test.mjs` with `runtime/testkit/mock-responses.mjs`, opt-in `AD_REAL_ENGINE=1`), for behaviour a protocol snapshot can't catch;
- the real `ad tui` in a pseudo-terminal on the real binary and the mock model (`runtime/test/tui-live.test.mjs`, same opt-in).

CI's real-engine job runs the last two on Linux, macOS and Windows; it is non-blocking (`continue-on-error`), so read its result. Details: [testing.md](testing.md).

The terminal UI (`ad tui`, bare `ad`) builds on the same engine: [tui-architecture.md](tui-architecture.md).

---

## Why this design

A few load-bearing decisions:

### Fail safe, never allow
A daemon bug must never block the user's tool execution, and a hook never decides for the user either: no objection and its own errors are both `{}`, so the host's permission prompt still applies. Trade-off: an adversary who controls the hook's stdin could bypass it. But the stdin comes from the Claude Code host, which is the user's own machine — out of scope.

### Zero-LLM digest (with optional fallback)
Default extraction is parse-only — the agent emits a structured block during the session. Cheap, deterministic, no API key needed. LLM fallback exists for sessions where the agent didn't follow protocol; it runs on `claude` or ad's engine (`--llm claude|ad|auto`).

### Per-project memory, global SQLite
Per-project markdown means each codebase has its own brain. Global SQLite means queries can span all projects ("what have I learned about React in any project?").

### Profile-based install
`minimal`, `developer`, `security` — different audiences want different intrusiveness levels. The `developer` default is "useful but never blocks." The `security` profile adds shell-exec blocks for `--no-verify` etc.

### Idempotent everywhere
`ad init`, `ad digest-latest`, `npm link`, `ad watch` restart — all safe to run twice. This is core to the daemon being trustworthy.

---

## See also

- [Workflow](./workflow.md) — daily use
- [Troubleshooting](./troubleshooting.md) — common issues
- [Contributing](./contributing.md) — for new devs
- [SECURITY.md](../SECURITY.md) — threat model
- [Harness design](./harness-design.md) and [terminal UI architecture](./tui-architecture.md) — the agent harness and `ad tui` in depth
- [Testing](./testing.md) — test layers and CI
- [Manual test](./manual-test.md) — end-to-end checklist (Claude Code mode + harness + terminal UI)
