---
name: codex-upgrade
description: "Use when landing a Codex engine upgrade in agent-daemon v2 — the weekly `codex-upgrade` bot PR (\"chore(engine): bump Codex to X\", labels codex-upgrade / breaking-protocol / tests-failing), or the user says \"bump codex\", \"upgrade the engine\", \"codex update aaya\", \"naya codex version\". Reviews the protocol diff, runs the suite, does a live Windows smoke in a temp dir, then hands off to release-flow. Never merges, tags or pushes without the user's OK."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
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
   AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs
   ```
   - `--check` exits 1 if the committed snapshot doesn't match the pinned binary.
   - The last line runs the **real** new Codex against a mock model (`testkit/mock-responses.mjs`; no login, throwaway homes). It covers a streamed turn, an escalation approval, a patch, and the error classes the code relies on. A behaviour change shows up here even when the schema didn't change.
   - The PR's CI runs the same suite in its `engine-real` job on Linux, macOS and Windows; read those results too.
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
4. **If the smoke fails, read Codex's own log** before guessing (the [`harness-troubleshoot`](../harness-troubleshoot/SKILL.md) skill has the query and a table of known causes): `logs_2.sqlite` in the harness home (`~/.agent-daemon/codex-home`, table `logs`, column `feedback_log_body`). There's no `sqlite3` on this machine, so query it with `node --experimental-sqlite` (`DatabaseSync`, read-only), filtering `level IN ('ERROR','WARN')` and the newest ids. Never print `auth.json`.
5. **Ship.** Bump the patch/minor version in `runtime/package.json` + `package-lock.json`, add a CHANGELOG entry naming the new Codex version, then hand off to `release-flow`. Tag only after the user merges.

## Known gotchas (check these first)

- **Store pwsh.** `...\Microsoft\WindowsApps\pwsh.exe` is an app alias; the sandbox's restricted token can't launch it (`CreateProcessAsUserW failed: 5`). `withoutStoreAliases()` in `app-server.mjs` strips `WindowsApps` from the engine PATH. If commands are denied again, check whether Codex changed how it picks a shell.
- **`spawn EPERM` in the unelevated sandbox.** Node can't start child processes there, so `node --test` fails inside the agent's shell. That's expected with `windows.sandbox = "unelevated"`, not a regression.
- **Thread config overrides need dotted keys** (`"features.hooks": false`, `"mcp_servers.<id>.enabled": false`). Nested objects and the app-server `--disable` / `-c` flags were silently ignored in 0.159 (unchanged through 0.160). Re-verify if a smoke shows hooks or MCP servers running when they should be off.
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

- **Merging on a green bot PR alone.** CI never runs the Windows sandbox; skipping step 3 is how the Store-pwsh break shipped in 2.0.0.
- **Smoke-testing with cwd = the repo.** It pollutes `.agent-daemon/learning-journal.jsonl` with the test prompt.
- **Trusting the agent's "tests pass".** Run the test yourself after the turn.
- **Upgrading the user's own `~/.codex`.** The harness has its own `CODEX_HOME`; never touch `~/.codex`.
