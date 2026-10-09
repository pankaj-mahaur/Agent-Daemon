---
name: codex-upgrade
description: "Use when landing a Codex engine upgrade in agent-daemon v2 — the weekly `codex-upgrade` bot PR (\"chore(engine): bump Codex to X\", labels codex-upgrade / breaking-protocol / tests-failing), or the user says \"bump codex\", \"upgrade the engine\", \"codex update aaya\", \"naya codex version\". Reviews the protocol diff, runs the suite, does a live Windows smoke in a temp dir, then hands off to release-flow. Never merges, tags or pushes without the user's OK."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.1"
  kind: flow
allowed-tools: Bash, Read, Grep, Edit
---

# Codex Upgrade

The harness pins `@openai/codex` exactly (`runtime/package.json`). Each upgrade is a protocol change we must review before it reaches users. CI runs the unit suite on Linux, macOS and Windows, but against a fake engine, so a green bot PR doesn't prove the real Windows sandbox. This flow is the missing half. Every command here runs our pinned binary in the harness home or a temp home; the user's own `codex` and `~/.codex` are never touched.

## When to use

- A PR titled `chore(engine): bump Codex to <version>` opened by `.github/workflows/codex-upgrade.yml`.
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
   - The last line runs the **real** new Codex against a mock model (`testkit/mock-responses.mjs`; no login, throwaway homes): `engine-real` covers a streamed turn, an escalation approval, a patch and the error classes the code relies on; `tui-live` runs the real `ad tui` in a pseudo-terminal through the manual test's terminal UI script and ad's own TUI features. A behaviour change shows up here even when the schema didn't change.
   - The workflow's own run is on Linux; the PR's CI (`test.yml`, all three OSes, `engine-real` job) only runs when the `CODEX_UPGRADE_TOKEN` secret is set. That job is non-blocking: read its result, not the run's colour. The bot's PR body lists real-engine failures by name (label `real-engine-failing`).
   - **`compat.json`** (`runtime/src/engine/codex/compat.json`): write the one-line, user-facing "what changed" note for the new version. `/status` and `ad doctor` show it.
   - **A slash collision** (test names it) means Codex now has a command ad uses for something else: rename ad's, or mark it `source: "codex"` if it now means the same.
   - **`/init`**: re-copy Codex's prompt into `runtime/src/tui/init-prompt.mjs` from `codex-rs/tui/assets/prompt_for_init_command.md` at the new tag.
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
   Trust the folder, ask it to fix the test again, approve the command (check the prompt shows the full command), steer once while it runs (Enter), queue one (Tab), `/status` (the Codex line says "tested"), `/codex` and quit back, then Ctrl+C twice. `node "<repo>/runtime/src/cli.mjs" tui --last` must show the conversation again.
4. **If the smoke fails, read Codex's own log** before guessing (the [`harness-troubleshoot`](../harness-troubleshoot/SKILL.md) skill has the query and a table of known causes): `logs_2.sqlite` in the harness home (`~/.agent-daemon/codex-home`, table `logs`, column `feedback_log_body`). There's no `sqlite3` on this machine, so query it with `node --experimental-sqlite` (`DatabaseSync`, read-only), filtering `level IN ('ERROR','WARN')` and the newest ids. Never print `auth.json`.
5. **Ship.** Bump the patch/minor version in `runtime/package.json` + `package-lock.json`, add a CHANGELOG entry naming the new Codex version, then hand off to `release-flow`. Tag only after the user merges.

## Known gotchas (check these first)

- **Store pwsh.** Codex runs commands in the first `pwsh.exe` on PATH. The Store's PowerShell is an app alias (`...\Microsoft\WindowsApps\pwsh.exe`) and an MSIX package (`C:\Program Files\WindowsApps\Microsoft.PowerShell_…`, which PowerShell 7 puts first on its children's PATH); the sandbox's restricted token can launch neither (`CreateProcessAsUserW failed: 5` / `-1073283067`). `withoutStoreAliases()` in `app-server.mjs` drops every PATH entry with a `WindowsApps` segment (2.0.1 dropped only the alias folder, so starting ad *from* Store PowerShell still broke until 2.1.1). If commands are denied again, check whether Codex changed how it picks a shell.
- **Codex behaviours ad depends on** (re-check on a bump; the live tests exercise each):
  - item ids can repeat across turns with some providers (`msg-1`, `call_0`): the session keys them per turn;
  - the `turn/start` response can arrive before the `turn/started` notification;
  - `item/started` for a patch is not ordered before its disk write;
  - a real exec approval offers `accept`, an `acceptWithExecpolicyAmendment` ("don't ask again for …", key `p`) and `cancel` (Esc, ends the turn); `decline` (`n`) appears for patch approvals;
  - MCP tool approval per server: `default_tools_approval_mode` = `auto` | `prompt` | `writes` | `approve` (ad sets `approve` on its memory server);
  - Codex's diff of an applied patch matches git's line counts (the `/undo` chain check relies on it: a mismatch shows as a false "changed during the turn" in the live test's EDITMATH step);
  - the first sandboxed action in a fresh Codex home sets up the Windows sandbox (~35 s, once);
  - with the mock provider, "Model metadata for `mock-model` not found" warnings are expected.
- **`spawn EPERM` in the unelevated sandbox.** Node can't start child processes there, so `node --test` fails inside the agent's shell. That's expected with `windows.sandbox = "unelevated"`, not a regression.
- **Thread config overrides need dotted keys** (`"features.hooks": false`, `"mcp_servers.<id>.enabled": false`). Nested objects and the app-server `--disable` / `-c` flags were silently ignored in 0.159 (unchanged through 0.160). Re-verify if a smoke shows hooks or MCP servers running when they should be off.
- **A new or changed slash command** fails `tui-resilience.test.mjs` ("every Codex command has a decision in ad") and the parity-doc test. `runtime/src/tui/codex-slash.json` is regenerated by `node scripts/codex-slash.mjs` (it fetches `slash_command.rs` and `bottom_pane/command_popup.rs` at the tag with `gh api`; `--file` / `--popup` read local copies). Decide per command: run it in ad (a `source: "codex"` row) or answer in `NOT_IN_AD` (`app.mjs`), then update `docs/codex-parity.md`. A changed "during a task" rule or popup hiding follows automatically.
- **The experimental allowlist** (`EXPERIMENTAL_ALLOWLIST`, `ad tui` only): the snapshot's `experimental` section is generated with `generate-json-schema --experimental` and records the allowlisted methods, notifications (`thread/settings/updated` is experimental) and fields; the upgrade diff marks a removed one as breaking. The real-engine test "plan mode on the allowlist" checks the behaviour: presets Plan (effort medium) + Default, `thread/settings/update` → `{}` + `thread/settings/updated` (Codex fills in its plan.md), a `<proposed_plan>` → `item/plan/delta` + a `plan` item (`<turnId>-plan`) cut from the message, the resume response's mode, and that opted-out notifications stay quiet. The only experimental server request, `currentTime/read`, gets ad's -32601 refusal. `/cd` (S6, 0.160): `thread/fork` with `cwd` gives a new thread whose sandbox writable root and edits follow the new folder, and a cold `thread/resume` without `cwd` keeps it. Background terminals (S2, 0.160 on Windows): an exec_command still running after its `yield_time_ms` stays an in-progress `unifiedExecStartup` item (with `processId`, Codex's own number, not the OS pid) whose output keeps streaming after `turn/completed`; `thread/backgroundTerminals/clean` → `{}`, the OS process ends, then `item/completed` with status failed, exit -1.
- **Requests ad sends** are checked against the snapshot (`checkRequest` in the fake). A field Codex removed or made required, or one that became experimental, fails the app tests with `Invalid request`. `SENT_METHODS` lists every method ad sends.
- **`thread_unload_delay_secs`** (ad's TUI engine runs with `-c thread_unload_delay_secs=0`): `thread/unsubscribe` of the last subscriber unloads an idle thread at once and `thread/closed` reaches every connection; an immediate `thread/resume` would cancel the unload. `/codex` relies on it (real-engine test "S8").
- **Codex's `tui.*` settings** (`status_line`, `terminal_title`, `theme`, `vim_mode_default`, `keymap`) round-trip through `config/batchWrite` and `config/read`; a value of the wrong type is refused, an unknown status id is kept (real-engine test "S1"). `tui.keymap` contexts reject unknown fields and the stock UI exits on a key conflict: ad never writes it.
- **A new server notification** fails `codex-events.test.mjs` by name until it has a handler in `engine/codex/events.mjs` or a reason in `surface.mjs`. The real-engine test "the events adapter understands everything the real Codex sends" catches one that the regenerated list misses.
- **`availableDecisions` on exec approvals is experimental** and only reaches us because upstream doesn't strip it yet. `engine-real.test.mjs` fails by name when it disappears; the TUI then falls back to Codex's default decision list.
- **Isolation.** Every Codex process ad starts goes through `codexEnv()` (`src/engine/codex/home.mjs`). If an upgrade adds a new `CODEX_*` variable that matters for TLS or proxies (like `CODEX_CA_CERTIFICATE`), add it to that file's allowlist rather than passing the user's environment through.
- **Hook trust is by hash.** A Codex upgrade that changes hook hashing shows up as `Harness hooks: 0/N trusted` in doctor. `ensureHarnessSetup` re-trusts only our own hooks on the next run.
- **Rollout format.** If `ad digest` stops finding prompts in Codex sessions, compare a fresh `sessions/**/rollout-*.jsonl` against `runtime/test/fixtures/codex-rollout.jsonl` (0.159–0.160 record the prompt only in `item_completed` UserMessage events).

## Examples

### Example 1: additive bump, CI green

Bot PR `chore(engine): bump Codex to 0.160.0`, label `codex-upgrade` only, diff lists two new notifications. Steps 2–3 pass. Bump to 2.0.2 with CHANGELOG line "Codex engine 0.160.0", hand to `release-flow`, and tell the user it's ready to merge.

### Example 2: breaking-protocol

Diff says `thread/compact/start` was removed. `grep -rn "thread/compact" runtime/src` → `engine/index.mjs` (`compactThread`). Find the replacement method in the new schema (`codex app-server generate-json-schema`), update the engine and the fake app-server (`runtime/testkit/fake-codex-app-server.mjs`), add a test, re-run steps 2–3.

## Anti-patterns

- **Merging on a green bot PR alone.** CI has no real login and GitHub's Windows runners can't run Codex's sandbox; skipping step 3 is how the Store-pwsh break shipped in 2.0.0, and why the package-folder case was only found by a real session in 2.1.0.
- **Smoke-testing with cwd = the repo.** It pollutes `.agent-daemon/learning-journal.jsonl` with the test prompt.
- **Trusting the agent's "tests pass".** Run the test yourself after the turn.
- **Upgrading the user's own `~/.codex`.** The harness has its own `CODEX_HOME`; never touch `~/.codex`.
