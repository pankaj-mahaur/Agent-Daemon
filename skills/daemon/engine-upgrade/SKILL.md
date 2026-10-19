---
name: engine-upgrade
description: "Use when landing an engine upgrade in agent-daemon v2 — the weekly `engine-upgrade` bot PR (\"chore(engine): bump the engine to X\", labels engine-upgrade / breaking-protocol / tests-failing), or the user says \"bump the engine\", \"upgrade the engine\", \"engine update aaya\", \"naya engine version\". Reviews the protocol diff, runs the suite, does a live Windows smoke in a temp dir, then hands off to release-flow. Never merges, tags or pushes without the user's OK."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.2"
  kind: flow
allowed-tools: Bash, Read, Grep, Edit
---

# Engine Upgrade

The harness pins `@openai/codex` exactly (`runtime/package.json`). Each upgrade is a protocol change we must review before it reaches users. CI runs the unit suite on Linux, macOS and Windows, but against a fake engine, so a green bot PR doesn't prove the real Windows sandbox. This flow is the missing half. Every command here runs our pinned binary in the harness home or a temp home; the user's own install and `~/.codex` are never touched.

## When to use

- A PR titled `chore(engine): bump the engine to <version>` opened by `.github/workflows/engine-upgrade.yml`.
- The bot opens no PR at all: GitHub refuses PRs from `GITHUB_TOKEN` unless the repo setting "Allow GitHub Actions to create and approve pull requests" is on, or the `ENGINE_UPGRADE_TOKEN` secret (a repo-scoped fine-grained PAT) is set; the setting and the PAT are the owner's. The bot skips a version only while an open or merged PR exists for its branch, so a closed attempt is retried by the next run (or `gh workflow run engine-upgrade.yml -f version=<v>`).
- The user asks to move the pin by hand (`npm install --save-exact @openai/codex@<v>` in `runtime/`).

## Procedure

1. **Read the PR body.** It is the protocol diff (committed snapshot → new pin). Check the labels:
   - `breaking-protocol` — methods or tracked definition fields were **removed**. Grep `runtime/src/engine/` and `runtime/src/harness/` for every removed name before anything else; each hit is a required code change.
   - `tests-failing` — the suite failed on the bot's run. Reproduce locally first.
   - Additions alone are safe, but note any new approval method (`*/requestApproval`): `runtime/src/engine/codex/approvals.mjs` must answer it, or the turn hangs until it's declined by default.
2. **Check out the PR branch** and run, from `runtime/`:
   ```bash
   npm install
   npm test
   node scripts/codex-schema-snapshot.mjs --check
   node scripts/codex-notifications.mjs          # stable/experimental notification list for the new pin
   node --test test/codex-events.test.mjs        # every new notification needs a handler or an ignore reason
   node scripts/codex-slash.mjs                  # Codex's slash names at the new tag (needs gh)
   node --test test/tui-resilience.test.mjs      # slash collisions, compat.json, fake-vs-protocol, future fixture
   AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs test/tui-live.test.mjs
   ```
   - `--check` exits 1 if the committed snapshot doesn't match the pinned binary.
    - The last line runs the **real** new engine against a mock model (`testkit/mock-responses.mjs`; no login, throwaway homes): `engine-real` covers a streamed turn, an escalation approval, a patch and the error classes the code relies on; `tui-live` runs the real `ad tui` in a pseudo-terminal through the manual test's terminal UI script and ad's own TUI features. A behaviour change shows up here even when the schema didn't change.
    - The workflow's own run is on Linux; the PR's CI (`test.yml`, all three OSes, `engine-real` job) only runs when the `ENGINE_UPGRADE_TOKEN` secret is set (the old `CODEX_UPGRADE_TOKEN` keeps working). That job is non-blocking: read its result, not the run's colour. The bot's PR body lists real-engine failures by name (label `real-engine-failing`).
   - **`compat.json`** (`runtime/src/engine/codex/compat.json`): write the one-line, user-facing "what changed" note for the new version. `/status` and `ad doctor` show it.
    - **A slash collision** (test names it) means the engine now has a command ad uses for something else: rename ad's, or mark it `source: "upstream"` if it now means the same.
    - **`/init` and `/recap`**: re-copy the engine's prompts into `runtime/src/tui/init-prompt.mjs` (from `codex-rs/tui/assets/prompt_for_init_command.md` at the new tag) and `runtime/src/tui/recap.mjs` (prompt, schema and the temporary-thread key list from the new tag) — see the gotchas below. Put the new version in each file's header line too: `test/attribution.test.mjs` fails until both attributed files name the pinned version, which is how a bot PR shows the prompts still need re-copying.
3. **Live smoke on Windows**, in a scratch directory, **never the repo**. Prompts run in the repo write learnings into its memory journal.
   ```bash
   mkdir <scratch>/smoke && cd <scratch>/smoke && git init -q
   printf 'export function add(a, b) {\n  return a - b;\n}\n' > math.js
   printf 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n' > math.test.js
   echo '{"type":"module"}' > package.json
   node "<repo>/runtime/src/cli.mjs" auth status
   node "<repo>/runtime/src/cli.mjs" run "The test in math.test.js fails. Fix the bug in math.js."
   node --test        # run it yourself — the agent's own claim is not the check
   node "<repo>/runtime/src/cli.mjs" doctor
   ```
   Pass = `math.js` fixed, your `node --test` green, doctor shows the hooks trusted and the sandbox ready.

    Then the terminal UI, in the same scratch folder, in Windows Terminal (and Zed if you have it):
    ```bash
    node "<repo>/runtime/src/cli.mjs" tui
    ```
    Trust the folder, ask it to fix the test again, approve the command (check the prompt shows the full command), steer once while it runs (Enter), queue one (Tab), `/status` (the engine line says "tested"), then Ctrl+C twice. `node "<repo>/runtime/src/cli.mjs" tui --last` must show the conversation again.
4. **If the smoke fails, read the engine's own log** before guessing (the [`harness-troubleshoot`](../harness-troubleshoot/SKILL.md) skill has the query and a table of known causes): `logs_2.sqlite` in the harness home (`~/.agent-daemon/engine`, table `logs`, column `feedback_log_body`). There's no `sqlite3` on this machine, so query it with `node --experimental-sqlite` (`DatabaseSync`, read-only), filtering `level IN ('ERROR','WARN')` and the newest ids. Never print `auth.json`.
5. **Ship.** Bump the patch/minor version in `runtime/package.json` + `package-lock.json`, add a CHANGELOG entry naming the new engine version, then hand off to `release-flow`. Tag only after the user merges.

## Known gotchas (check these first)

- **Unknown method** (0.160): the engine answers `-32600 "Invalid request: unknown variant …"`, not `-32601`; the façade classifies by that shape.
- **Hooks see the engine's whole environment** (0.163): hook processes inherit the engine's full env whatever `shell_environment_policy` filters say, so a key in the engine's env reaches every hook. Keys stay out of the engine env (the provider gateway, plan P3.3).
- **A per-thread config override for an MCP server that isn't configured** makes the engine reject the thread's whole config (`thread/start` fails). ad's façade sends the memory-scope override only when the home configures `agent-daemon-memory` (real-engine test "memory scope: a bare home…").

- **Project layers from the user's home** (0.160, spike S-HOME; re-run it on every bump, cases a–k): every `<dir>/.codex` from the project root (nearest ancestor with a marker, `.git` needing `HEAD`; the path as given, links not resolved) down to the thread's folder is a project layer. A disabled (untrusted) layer still adds its `skills/` (the start-up `configWarning` says "but skills still load"); hooks, rules and MCP servers stay off; an untrusted layer is parsed leniently, a trusted one strictly (an unknown key fails `thread/start`). The launch folder's layers load at start-up, so ad launches in `~/.agent-daemon/launch` (or with `-c project_root_markers=[]` plus markers on each new thread; resume and fork found the repo layer without them in 0.160). Trust deletes need JSON-quoted key paths (`projects."C:\x"`; a single-quoted one is a silent no-op); `config/batchWrite` takes the user layer's `version` as `expectedVersion`. On Windows the user-scope `~/.agents/skills` comes from the real profile whatever HOME/USERPROFILE say.
- **0.160 → 0.163 (P1.1)**: protocol additions only (3 method names: `thread/attachmentOwner/list` plus 2 experimental notifications; `turn/start.parentTurnId`/`rootTurnId`, `subAgentActivity.model`/`reasoningEffort`; `namespaceTools` gone from `modelProvider/capabilities/read` per the upstream source, a type the snapshot doesn't track; ad never calls it). New commands `/config`, `/daybreak` (a per-thread cyber-access switch saved with `thread/metadata/update`) need `NOT_IN_AD` entries; `/archive` became allowed during a task (ad keeps waiting: `WAITS_FOR_TASK` in tui/app.mjs, since its session leaves a conversation only when idle). The keymap gains `global.leader` and `"leader <key>"` bindings, which ad warns about once and ignores. The temporary structured thread no longer sends `approval_policy: never` upstream (ad keeps it). A thread's MCP servers start in the thread's folder; a per-thread `mcp_servers.<id>.enabled=false` survives `config/mcpServer/reload`. Base instructions now travel as the first developer message (the mock reads developer texts). With `approval_policy=never` and no Windows sandbox set up, `exec_command` is rejected (`CreateProcess Rejected`) instead of asking: real-engine tests keep on-request and accept.
- **Store pwsh.** The engine runs commands in the first `pwsh.exe` on PATH. The Store's PowerShell is an app alias (`...\Microsoft\WindowsApps\pwsh.exe`) and an MSIX package (`C:\Program Files\WindowsApps\Microsoft.PowerShell_…`, which PowerShell 7 puts first on its children's PATH); the sandbox's restricted token can launch neither (`CreateProcessAsUserW failed: 5` / `-1073283067`). `withoutStoreAliases()` in `app-server.mjs` drops every PATH entry with a `WindowsApps` segment (2.0.1 dropped only the alias folder, so starting ad *from* Store PowerShell still broke until 2.1.1). If commands are denied again, check whether the engine changed how it picks a shell.
- **Engine behaviours ad depends on** (re-check on a bump; the live tests exercise each):
  - item ids can repeat across turns with some providers (`msg-1`, `call_0`): the session keys them per turn;
  - the `turn/start` response can arrive before the `turn/started` notification;
  - `item/started` for a patch is not ordered before its disk write;
  - a real exec approval offers `accept`, an `acceptWithExecpolicyAmendment` ("don't ask again for …", key `p`) and `cancel` (Esc, ends the turn); `decline` (`n`) appears for patch approvals;
  - MCP tool approval per server: `default_tools_approval_mode` = `auto` | `prompt` | `writes` | `approve` (ad sets `approve` on its memory server);
  - the engine's diff of an applied patch matches git's line counts (the `/undo` chain check relies on it: a mismatch shows as a false "changed during the turn" in the live test's EDITMATH step);
  - the first sandboxed action in a fresh engine home sets up the Windows sandbox (~35 s, once);
  - with the mock provider, "Model metadata for `mock-model` not found" warnings are expected.
- **`spawn EPERM` in the unelevated sandbox.** Node can't start child processes there, so `node --test` fails inside the agent's shell. That's expected with `windows.sandbox = "unelevated"`, not a regression.
- **Thread config overrides need dotted keys** (`"features.hooks": false`, `"mcp_servers.<id>.enabled": false`). Nested objects and the app-server `--disable` / `-c` flags were silently ignored in 0.159 (unchanged through 0.160). Re-verify if a smoke shows hooks or MCP servers running when they should be off.
- **A new or changed slash command** fails `tui-resilience.test.mjs` ("every engine command has a decision in ad") and the parity-doc test. `runtime/src/engine/codex/upstream-commands.json` is regenerated by `node scripts/codex-slash.mjs` (it fetches `slash_command.rs` and `bottom_pane/command_popup.rs` at the tag with `gh api`; `--file` / `--popup` read local copies). Decide per command: run it in ad (a `source: "upstream"` row) or answer in `NOT_IN_AD` (`app.mjs`), then update `docs/commands.md`. A changed "during a task" rule or popup hiding follows automatically.
- **The experimental allowlist** (`EXPERIMENTAL_ALLOWLIST`, `ad tui` only): the snapshot's `experimental` section is generated with `generate-json-schema --experimental` and records the allowlisted methods, notifications (`thread/settings/updated` is experimental) and fields; the upgrade diff marks a removed one as breaking. The real-engine test "plan mode on the allowlist" checks the behaviour: presets Plan (effort medium) + Default, `thread/settings/update` → `{}` + `thread/settings/updated` (Codex fills in its plan.md), a `<proposed_plan>` → `item/plan/delta` + a `plan` item (`<turnId>-plan`) cut from the message, the resume response's mode, and that opted-out notifications stay quiet. The only experimental server request, `currentTime/read`, gets ad's -32601 refusal. Side conversations (S5, 0.160): `thread/fork {ephemeral, excludeTurns, sandbox, approvalPolicy}` works (no rollout path, not in `thread/list`, `thread/unsubscribe` → `thread/closed`), but the fork's `developerInstructions` and `config.developer_instructions` never reach the model: ad injects its side texts with `thread/inject_items`. `/cd` (S6, 0.160): `thread/fork` with `cwd` gives a new thread whose sandbox writable root and edits follow the new folder, and a cold `thread/resume` without `cwd` keeps it. Background terminals (S2, 0.160 on Windows): an exec_command still running after its `yield_time_ms` stays an in-progress `unifiedExecStartup` item (with `processId`, Codex's own number, not the OS pid) whose output keeps streaming after `turn/completed`; `thread/backgroundTerminals/clean` → `{}`, the OS process ends, then `item/completed` with status failed, exit -1.
- **`/cd` has two layers in Codex** (0.160): the chat widget's gate (`chatwidget/working_directory.rs`: same thread, no side conversation, not ephemeral, no unified-exec processes, no running or pending turn, nothing queued or steered → "Changing directories requires an idle primary session without queued input.") and the app's checks before the fork (`app/working_directory.rs`): "Cannot change: another agent is running." when any other tracked agent thread is running and not closed, "Conversation history is not saved.", "MCP inventory is still loading.", then after the trust/config step a `thread/read` status pass over every tracked thread → "Cannot change: a task is running." ad mirrors the gate and the two agent checks (from `state.agents`); the history and MCP checks it doesn't have. Re-read that file on a bump: the texts are asserted in `tui-app.test.mjs`.
- **Requests ad sends** are checked against the snapshot (`checkRequest` in the fake). A field the engine removed or made required, or one that became experimental, fails the app tests with `Invalid request`. `SENT_METHODS` lists every method ad sends. The `SENT_METHODS` test scans only `runtime/src/engine/` (the façade). An experimental method a feature depends on is listed in `FEATURE_NEEDS` in `engine/index.mjs`; a release that drops it turns the feature off with a notice.
- **`thread_unload_delay_secs`** (ad's TUI engine runs with `-c thread_unload_delay_secs=0`): `thread/unsubscribe` of the last subscriber unloads an idle thread at once and `thread/closed` reaches every connection; an immediate `thread/resume` would cancel the unload (real-engine test "S8").
- **`/approve`'s event is the engine's core `GuardianAssessmentEvent`, not the v2 notification** (`guardianDenialEvent` in `engine/codex/events.mjs`): snake_case keys and enum values, the action tagged by a snake_case `type`, nested keys snake_case too (`file_system`), absent fields left out, and `write_stdin.cwd` as a `file:` URL (a plain `C:\…` is refused: "unsupported path URI scheme"). The real-engine test "S7" sends one of every action kind; a refusal reads `invalid Guardian denial event: …`.
- **`/recap`'s temporary thread** takes `threadSource: "system"` and the tool-off dotted keys in `TEMPORARY_THREAD_CONFIG` (`tui/recap.mjs`, copied from the engine's `temporary_structured_request.rs`); the real-engine test checks the engine still starts it read-only and ephemeral. When the pin moves, re-copy the recap prompt and that key list from the new tag (`HISTORY_MAX_BYTES` must stay 32768 minus the prompt's bytes).
- **The engine's `tui.*` settings** (`status_line`, `terminal_title`, `theme`, `vim_mode_default`, `keymap`) round-trip through `config/batchWrite` and `config/read`; a value of the wrong type is refused, an unknown status id is kept (real-engine test "S1"). `tui.keymap` contexts reject unknown fields: ad never writes it.
- **A new server notification** fails `codex-events.test.mjs` by name until it has a handler in `engine/codex/events.mjs` or a reason in `surface.mjs`. The real-engine test "the events adapter understands everything the real engine sends" catches one that the regenerated list misses.
- **`availableDecisions` on exec approvals is experimental** and only reaches us because upstream doesn't strip it yet. `engine-real.test.mjs` fails by name when it disappears; the TUI then falls back to the engine's default decision list.
- **Isolation.** Every engine process ad starts goes through `codexEnv()` (`src/engine/codex/home.mjs`). If an upgrade adds a new `CODEX_*` variable that matters for TLS or proxies (like `CODEX_CA_CERTIFICATE`), add it to that file's allowlist rather than passing the user's environment through.
- **Hook trust is by hash.** An engine upgrade that changes hook hashing shows up as `Engine hooks: 0/N trusted` in doctor. `ensureHarnessSetup` re-trusts only our own hooks on the next run.
- **Rollout format.** If `ad digest` stops finding prompts in engine sessions, compare a fresh `sessions/**/rollout-*.jsonl` against `runtime/test/fixtures/codex-rollout.jsonl` (0.159–0.160 record the prompt only in `item_completed` UserMessage events).

## Examples

### Example 1: additive bump, CI green

Bot PR `chore(engine): bump the engine to 0.160.0`, label `engine-upgrade` only, diff lists two new notifications. Steps 2–3 pass. Bump to 2.0.2 with CHANGELOG line "engine 0.160.0", hand to `release-flow`, and tell the user it's ready to merge.

### Example 2: breaking-protocol

Diff says `thread/compact/start` was removed. `grep -rn "thread/compact" runtime/src` → `engine/index.mjs` (`compactThread`). Find the replacement method in the new schema (`codex app-server generate-json-schema`), update the engine and the fake app-server (`runtime/testkit/fake-codex-app-server.mjs`), add a test, re-run steps 2–3.

## Anti-patterns

- **Merging on a green bot PR alone.** CI has no real login and GitHub's Windows runners can't run the engine's sandbox; skipping step 3 is how the Store-pwsh break shipped in 2.0.0, and why the package-folder case was only found by a real session in 2.1.0.
- **Smoke-testing with cwd = the repo.** It pollutes `.agent-daemon/learning-journal.jsonl` with the test prompt.
- **Trusting the agent's "tests pass".** Run the test yourself after the turn.
- **Upgrading the user's own `~/.codex`.** The harness has its own engine home; never touch `~/.codex`.
