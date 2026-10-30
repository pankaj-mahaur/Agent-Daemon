# Testing agent-daemon

How the test suite is laid out, how to run each layer, how the live terminal UI tests work, and the practices that keep the tests honest. The quick version is in [contributing.md](contributing.md#adding-a-new-test).

## Run it

```sh
cd runtime
npm test                                            # everything that needs no real engine
node --test test/checkpoints.test.mjs               # one file
AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/engine-real.test.mjs test/tui-live.test.mjs
node scripts/check-doc-links.mjs                    # every relative link in the docs points at a tracked file
```

Install with `npm ci` (or `npm install`) in `runtime/`, devDependencies included: the screen and live tests use `@xterm/headless` and `@lydell/node-pty`, which the one-liner's `--omit=dev` install leaves out. The real-engine tests need nothing else: no login, no network.

## The layers

| Layer | Where | What it proves |
|---|---|---|
| Pure units | `test/tui-width`, `tui-text`, `tui-sanitize`, `tui-markdown`, `tui-input`, … | width tables, wrapping, escape-sequence sanitizing, streamed markdown equals full markdown, key decoding |
| Golden screens | `test/golden/tui/*.txt` via `testkit/golden.mjs` | header, cells, modals, markdown and parity layouts at 40, 80 and 120 columns |
| Screen tests | `testkit/screen.mjs` (`@xterm/headless`, and a VT model that never reflows) | the renderer under resizes, slow cursor replies, narrow terminals |
| App + session on a fake engine | `test/tui-app`, `tui-ad`, `tui-parity`, `tui-resilience`, `session`, … with `testkit/fake-codex-app-server.mjs` | keys, slash commands, approvals, steer/queue, crashes and restarts, odd traffic |
| `/undo` on real git repos | `test/checkpoints.test.mjs` | snapshots, restores byte for byte, every conflict kind, adversarial cases |
| Real engine, protocol level | `test/engine-real.test.mjs` + `testkit/mock-responses.mjs` | what an engine release actually sends for a turn, an approval, a patch |
| Automatic fallback, real engine | `test/fallback-real.test.mjs` + `testkit/fault-responses.mjs` (`AD_REAL_ENGINE=1`) | F1–F13: providers failing at each point of a turn (before the first byte, mid-text, after a tool call is emitted, on a tool's result, a long Retry-After, a refused connection), through ad's gateway; switch or pause, and a tool never runs twice |
| Real engine, real terminal | `test/tui-live.test.mjs` | the terminal UI script of the manual test (section 6) and ad's own features, on the real `ad tui` |
| Vim, highlighting, recap | `test/tui-vim`, `tui-highlight`, `tui-recap` | the engine's Vim binding table; each language's lexer, hostile input at the caps, a style golden per theme; the recap history budget and strict parse |
| Keys, styles, settings | `test/tui-keymap`, `tui-styles`, `tui-dialogs`, `tui-prefs`, `tui-status` | the engine's key spelling and `tui.keymap` overrides; a golden that keeps every span's style (and no colour outside `view/theme.mjs`); the confirm and checklist; settings files; status-line and title items, `titleSafe` |
| The key routing table | `test/tui-app.test.mjs` ("key routing table") | for each layer (approval, ad's confirm, pager, shortcuts, popup, checklist, composer idle or running), what Esc, Ctrl+C, Tab, Shift+Tab, Enter and PgUp do |
| The correction benchmark | `bench/correction-bench/test/` (run by `test/correction-bench.test.mjs`); `smoke-real.test.mjs` in the real-engine job | each dev family's oracle on its violating and compliant example; the statistics on synthetic data with known answers (a 40% → 20% effect, an effect held by one family); the episode flow; the driver smoke: the real engine with a scripted model, the correction turn, ad's hooks, capture and the lesson in session 2. See [`bench/correction-bench/PROTOCOL.md`](../bench/correction-bench/PROTOCOL.md) |
| Engine pin bookkeeping | `test/tui-resilience.test.mjs` | ad's slash commands don't collide with the engine's (`src/engine/codex/upstream-commands.json` must match the pinned tag); `src/engine/codex/compat.json` lists the pin as tested, with a "what changed" note (`AD_COMPAT_NOTE_PENDING=1` lets the upgrade bot's run pass until a person writes it) |

### The fake engine speaks the pinned protocol

`testkit/fake-codex-app-server.mjs` is a scripted app-server: a prompt's text picks a scenario (`edit-file`, `two-approvals`, `hang`, `subagent`, `subagents-2`, `plan-reply`, `bg-terminal`, `auto-review-deny`, `same-id …`, `reject-start`, …; environment knobs such as `FAKE_RECAP`, `FAKE_REQUIREMENTS`, `FAKE_SANDBOX_FAIL`, `FAKE_SANDBOX_DELAY_MS`). Its messages are checked against the committed protocol snapshot by `testkit/protocol-check.mjs`, so it can't teach the client a message the real engine can't send. A new scenario must keep passing that check (the `future` scenario, a synthetic newer engine, is the one deliberate exception).

It also checks ad's own requests (`checkRequest`): a method the pinned stable protocol doesn't have, a top-level field its params type lacks, or a wrong type is rejected with -32600, as the engine would. A new `request("method")` in `src/` needs the method in `SENT_METHODS` (`engine/codex/protocol-snapshot.mjs`) and a regenerated snapshot (`node scripts/codex-schema-snapshot.mjs`, pinned binary, temp home); a test compares the list with the source.

The fake answers an unknown method with -32600, like the real engine. Tests reach the fake's `debug/` and `test/` methods through `engine.testRequest()`, feed notifications with `engine.testNotify()`, observe raw traffic with `engine.onRawNotification()` / `engine.onRawServerRequest()`, and crash the engine with `engine.kill()`; `engine.server` no longer exists.

### The mock model

`testkit/mock-responses.mjs` stands in for the OpenAI Responses API. A keyword in the prompt picks the reply: `PING` (a streamed "pong"), and in `tui-live`'s own script `SPAWNONE` (the engine's `spawn_agent`; 0.160–0.163 namespace the agent tools as `multi_agent_v1`, so the call carries `namespace`) and the engine's recap prompt (an answer in its schema), `SHELL` / `ESCALATE` (a command, the second asking to leave the sandbox), `PATCH` (an `apply_patch` adding `hello.txt`), `FAIL`, `HOLD` (streams, then waits for `mock.release()`). A test can pass its own script; the live test adds `STEERED`, `QUEUED` and `EDITMATH` (an Update File patch).

### Mock providers and auth

For accounts and providers (M3), the testkit has:
- `mock-providers.mjs` `startMockProvider({ personality, keys, models, script })`: an OpenAI-, OpenRouter- or generic-shaped API on the same scripted stream.
  - It records each request's headers, model and tools, and what a tool printed (`functionOutputs`). The key itself is never recorded: the bearer becomes `{ scheme, matchesKey, sha256 }`.
  - It answers a wrong key with that provider's 401 and serves `/models` (OpenRouter: with pricing and `GET /api/v1/key`).
  - `setQuota` gives each provider's 429 body; `setFault` gives a 5xx with Retry-After, a stream cut after the first delta, a slow stream or a reset socket.
- `fault-responses.mjs` `startFaultProvider({ personality, keys })` (P4.5): a provider that fails at a chosen point, per prompt marker (`schedule(marker, steps)`: `fault.quota()`, `rate(s)`, `freePerDay()`, `unauthorized()`, `afterCreated()`, `midText(n)`, `afterToolCallEmitted(probe)`, `sseFailed(code)`, `slow(ms)`, `ok()`; `onToolResult(callId, step)`; `refusedUrl()`). Its probes (`EXEC` appends to `marker.txt`, `WRITE` adds `made.txt`, `BGHOLD` starts a background command) run only when the request shows no sign they ran (their result, or ad's `[done]` / still-running line), so a lost carry-over shows as a doubled marker.
- `mock-auth.mjs` `startMockAuth()`: ChatGPT-style token refresh with rotation; a refresh token used twice answers `refresh_token_reused`.
- `gateway-proto.mjs`: the loopback gateway prototype (P3.1; P3.3 builds the real one). The engine holds only a gateway token; the gateway swaps it for the account key and decodes compressed upstream bodies.
- `mock-chat.mjs` `startMockChat({ script })`: a Chat Completions provider (P6.1). A script answers with stream chunks (split every n bytes, or the socket dropped at the end), an error or redirect status, or a held stream; it counts requests per prompt word and hang-ups.
- `probes.mjs`: an environment dump that runs as a hook or a stdio MCP server, tool-shell probe commands, and `scanForSecrets`, which reports which fake secret appeared and never prints one.

Rules: fake keys only (`sk-test-…`, built by joining parts so no scanner mistakes them for real ones), a fake home for every engine run, and nothing about a request is written to disk. `test/engine-real-accounts.test.mjs` (`AD_REAL_ENGINE=1`) runs the pinned engine through the gateway:
- two providers in one engine;
- a resume that changes the provider;
- the key-isolation probes, with a control that puts the key in the engine's environment to prove the hook probe can see one.

### Chat translation fixtures

`scripts/record-engine-requests.mjs` drives the pinned engine against the mock and writes what it sends into `test/fixtures/gateway/engine-<version>/` (instructions elided by hash; install id, cache key, timezone, date and temp paths blanked). `test/translate-contract.test.mjs` translates every recorded request and compares the shape with `test/golden/translate/`. Re-record after an engine upgrade and read the diff. `test/engine-real-translate.test.mjs` (`AD_REAL_ENGINE=1`) runs the pinned engine through the gateway to `mock-chat` and counts what ran and how many upstream calls were made: a split tool call runs once, a used-up daily quota is asked once, a cut-off is retried exactly once, and a tool printing its environment sees neither the key nor the gateway token.

## The live terminal UI tests

`test/tui-live.test.mjs` runs `node src/cli.mjs tui` in a pseudo-terminal (`@lydell/node-pty`; ConPTY on Windows, the same path Windows Terminal uses) and feeds its output to `@xterm/headless`, which also answers the UI's terminal queries. The engine is the real pinned engine; the model is the mock.

**Isolation.** Each test builds a throwaway world: a temp `HOME`/`USERPROFILE` (so ad's memory, state and locks are temp ones), a temp engine home with only the mock provider and the ad-managed marker (so ad installs its real hooks and memory server there), and a scratch git repo as the project. The user's `~/.codex` and `~/.agent-daemon` are never read or written.

**What it covers.**
- FC3: header, a streamed answer, exec approval (the 400 ms guard, Esc = "No, and stop", approval), a patch in Auto and `/undo`, an Update File patch and `/undo`, the permissions picker and a read-only patch approval, steer, queue, interrupt, Esc Esc, `/undo` refusing a user's edit and `/undo force`, Ctrl+T, a narrowing resize, quit, `ad tui --last`.
- FC4: `/memory`, `/private` (the model receives the wrapper; the transcript shows the prompt as typed), a correction becoming a "Learned:" row, `/schedule`, `/team`, `/proposals`, `/loop` start and stop.
- Engine parity: plan mode end to end, a background terminal with `/ps` and `/stop`, `/cd` then an edit, `/side` during a turn, `/vim`, `/theme`, `/recap`, and a real subagent (spawned through the engine) in `/subagents`.
- G2: the live brand test — nothing on ad's screen names the engine; signed-out startup and a rejected model request are covered too. The latter verifies that `/warnings` retains the original error. `test/engine-text.test.mjs` and the TUI app tests also cover crash stderr, engine notices, RPC failures and raw diagnostic retention.

**Writing steps that don't flake.**
- Wait for state, never for time: `t.until(predicate)`. Sleep only where a person would pause (after Esc, so the next key isn't read as Alt+key).
- Text that appeared earlier is still in the scrollback: count occurrences (`t.count(/…/g)`) and wait for the count to grow, instead of matching once.
- Wait for the footer to be idle (`t.idle()`: shows "? shortcuts", no "esc to interrupt") before typing the next prompt; otherwise Enter steers it into the running turn.
- Match long paths with `\s+` between words: a long temp path wraps differently on each OS.
- Close every pseudo-terminal in `finally` (`launched`); an open ConPTY keeps node alive.
- An `/archive` or `/delete` step waits past the confirm's arm delay (400 ms) before answering.
- Some runners can't run the engine's sandbox (GitHub's Windows runners): the engine then asks "retry without sandbox?", which `patchTurn` approves.
- The first sandboxed action in a fresh engine home sets up the Windows sandbox (about 35 s, longer on a busy machine): give it minutes, not seconds.
- On GitHub's Windows runner, the engine's non-admin sandbox (seen with 0.160.0) refuses a background command (`exec_command` with `yield_time_ms`) outright: "cannot enforce split writable root sets directly; refusing to run unsandboxed", with no "retry without sandbox?". The Part 5 live test skips there on exactly that message; any other failure still fails.
- On Linux, the engine's sandbox gives a command its own PID namespace: a pid the command writes isn't the host's. Check a background process by what it does (a file it keeps writing), never with `process.kill(pid, 0)`.
- A test that waits on a file's modification time must set it (`utimesSync`): a fast runner writes two versions in the same millisecond.
- **A step that stalls** (a patch or a background command that never finishes): its timeout message ends with the process tree under the pseudo-terminal (name, pid, CPU seconds), which shows what is still alive: a sandbox helper, a hook (`node … hook`), PowerShell or git. `AD_LIVE_KEEP=1` keeps each test's temp world and prints its path. `AD_PROFILE=minimal` in the world removes ad's tool hooks, to rule them in or out. One such stall on a Windows developer machine (October 2026) went away on its own while the code stayed the same; CI's per-test results are the proof either way.

## Keeping tests honest

- **Mutation checks.** For a guard that matters (a safety check, a fix), break it on purpose (delete the condition, flip it) and run its test: the test must fail. If it passes, the test doesn't cover the guard; add the case that would. Keep the mutation script out of the repo (a scratch file that patches, runs `node --test <file>`, and restores in `finally`).
- **Assert the observable the bug moves.** A count that stays the same with the bug present proves nothing; assert the text, the file contents, the exit code.
- **Reproduce before fixing.** A failing live test or a user's transcript is first reproduced in a temp home (same shell, same PATH), then fixed, then checked with the same reproduction.
- **Never touch real user state.** Tests use temp homes for `~/.agent-daemon`, the engine home, the clipboard and the editor. Never start the real engine outside `codexEnv()`. A test that writes memory sets a temp `HOME`/`USERPROFILE` before the first write (the episodic DB path is read from HOME when it opens). Locks are covered automatically: under `node --test`, when the home isn't faked, `defaultLockDir()` (`runtime/src/lock.mjs`) returns a per-process temp folder. New tests that create engines or locks call `assertFakeHome()` (`testkit/real-home-guard.mjs`).

## The claims lint

`node runtime/scripts/check-claims.mjs [files]` checks public copy (README, `docs/compare.md`, `docs/memory/`, `docs/site/`, host package descriptions) sentence by sentence: no "#1", "best" or "SOTA"; a percentage or "N×" only with a link and a named baseline ("no memory", "own memory", "rules file"); a host name only when `docs/support-matrix.md` lists it as tested live (`{{hosts}}` renders that list); no "reviewed lessons" without saying whose review; "never … another project" only as the one approved sentence. Tests: `runtime/test/check-claims.test.mjs`. It isn't in CI yet: the README and docs are rewritten to pass it first. The approved sentence has its own proof, `runtime/test/claim-cross-project.test.mjs`: project A's learning, a user fact seen only in A, a 3.0 global row from A's session and an agent's request to go global reach neither project B, a folder sharing A's slug nor an unbound server (memory tools, SessionStart, prompt retrieval); after a typed accept of the fact and the global row, B sees exactly those two. If it fails, the sentence leaves the copy.

## The brand lint

ad runs on a pinned third-party engine; the product says "the engine", and the engine's own name appears only in its allowed zone. `node runtime/scripts/check-brand.mjs` checks four rules over every tracked text file:

| Rule | What it finds |
|---|---|
| A | the engine's name, in content or in a file name, outside the allowed zone |
| B | a protocol method name in a request or wait call outside the adapter (`runtime/src/engine/codex/`) and the façade (`runtime/src/engine/index.mjs`) |
| C | prose that names the engine in a string, template or JSON value under `runtime/src` (bare tokens such as env vars, paths and package names pass); such prose comes from `runtime/src/engine/attribution.mjs` only |
| D | the adapter imported from outside `runtime/src/engine/` |

The allowed zone and the other legitimate places are `runtime/scripts/brand-allowlist.json`: one entry per place, each with a reason, and every docs/tests entry narrowed to the exact phrases it covers (`match`). An entry that matches nothing is reported as stale. `npm run lint:brand` runs in strict mode. Report mode (the default when calling the script directly) prints counts and exits 0; `--strict` fails on any hit or stale entry, and CI runs `node runtime/scripts/check-brand.mjs --strict --tracked`. `--verbose` lists every hit, `--json` prints the result. The tests in `test/check-brand.test.mjs` plant one hit per rule and prove that strict mode fails on each; `test/attribution.test.mjs` proves the attribution module's texts and that the two files that reproduce upstream's prompts keep their license headers.

## CI

`.github/workflows/test.yml` runs on every push to `main`, every PR that targets `main`, and on demand:

| Job | Runs |
|---|---|
| `ubuntu / macos / windows · node 22` | `npm test`, the skill linter, the brand lint (strict), the doc-link check, and smoke runs of `ad doctor`, `ad init --plan` and the skills-diff script |
| `real engine · ubuntu / macos / windows` | `engine-real`, `tui-live` and the correction benchmark's driver smoke with `AD_REAL_ENGINE=1` (on Linux after allowing unprivileged user namespaces for the engine's bubblewrap sandbox) |
| `memory install · ubuntu / macos / windows · node 22.16 / 24` | the memory tests on `node:sqlite` (`AD_SQLITE_DRIVER=node:sqlite`); the installer's config matrix, `runtime/scripts/memory-install-matrix.mjs` (release gate a: ≥ 95% and no uninstall-integrity failure); the package build and `npm pack --dry-run`; `test/memory-host-codex.test.mjs`, the real Codex binary loading the installed entry (gate b) |
| `state export / state import · ubuntu / macos / windows` | `runtime/scripts/portability-fixture.mjs`: each OS exports a throwaway project (paths with spaces and non-ASCII, a git remote, a second project that must not travel) with `ad state export`; each OS imports the other two bundles into a fresh home with the clone at another path, then checks `ad state verify --import`, `ad review --import --accept-all`, that `ad query-retrieve` brings the lesson back, that nothing of the second project arrived, and that a second import adds nothing. Run it locally with `export <file>` then `import <file>` |

Installer tests run in fake homes only (HOME, USERPROFILE, APPDATA, XDG_CONFIG_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, AD_ROOT) with a fake `claude` (`testkit/fake-claude.mjs`); they never read a real host config.

The real-engine job is non-blocking (`continue-on-error`): **read its result**, don't rely on the run's overall status.

Run the same pipeline before pushing, on this machine and in a Linux container, with the project skill [`ad-ci-readiness`](../.claude/skills/ad-ci-readiness/SKILL.md): it also reads a PR's CI test by test and holds the release-readiness checklist.

`.github/workflows/engine-upgrade.yml` runs `npm test` and the same real-engine tests in its own Linux job before it opens the PR that bumps the engine pin, and puts the results in the PR body. The PR's own `test.yml` run (all three OSes) happens only when the repo has an `ENGINE_UPGRADE_TOKEN` secret (the old `CODEX_UPGRADE_TOKEN` also works): PRs opened with the default token don't trigger other workflows.

## Pitfalls met in practice

| Symptom | Cause | Fix |
|---|---|---|
| A lock or lease test passes alone, fails in the full suite on Windows | the process-identity lookup (PowerShell, 3 s budget) times out under load, returns "unknown", and a fresh lease counts as live, which is the designed fallback | inject `identityOf` where the test is about counting or classifying; give a real-lookup test its own budget (`identityOf(pid, { timeoutMs })`) |
| A path check passes on Windows locally, fails on macOS or the Windows runner | the same folder has two spellings: macOS's `/var` is `/private/var`, the runner's temp folder is the 8.3 short name `RUNNER~1` | compare folders by `statSync(p, { bigint: true })` `dev:ino`, or build fixtures from `realpathSync.native`; code that stops at a folder checks every spelling of it |
| A lock test with a made-up pid fails on Linux only | pid 111 can be a real process there; its start time makes the record read as a reused pid | pass `identityOf: () => ({ unknown: "test pid" })` |
| `ENOTEMPTY` removing a temp repo on Linux | a big commit started git's background auto-gc, still writing | `git config gc.auto 0` in test repos; retry `rmSync` |
| A test file never exits | an open pseudo-terminal or a long timer | close ptys in `finally`; keep fake timers short |
| Strings with `\` or `$` mangled in an edit | bash heredocs and `node -e` eat backslashes | edit with an editor tool or a script file; build escape bytes with `"\x1b"` |
| Windows: every command fails with `CreateProcessAsUserW failed` | PowerShell 7 from the Store; the sandbox can't start MSIX apps | handled by the engine's PATH: `withoutStoreAliases()` drops every `WindowsApps` entry ([troubleshooting #16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-access-is-denied-or-createprocessasuserw-failed)) |
| A live step times out after a patch | the first sandboxed action set up the Windows sandbox | allow minutes for the first one |
| A screen regex fails only in the full suite | a long temp path or hint wraps at the test's width | match with `\s+` between words, or give the test more columns |
| A test passes alone, fails under load | a short real-time wait (a 50 ms terminal-query timeout, an arm delay of 60 ms that has passed before the "too soon" key) | give waits that only end early on success a generous cap; use a long arm delay where "too soon" is asserted |
| `until(async () => …)` returns at once | an async predicate is a truthy Promise | the helper awaits the predicate's result |
| A guard's mutation isn't caught | the test's setup makes the old and new behaviour look alike (a cursor that is on the same row either way) | change the setup until the mutation fails the test |
| A mutation run with `--test-name-pattern` "fails" for the wrong reason, or passes vacuously | a pattern that matches no subtest passes; a matched test that needs an earlier test's fixture fails with the guard intact | run each pattern unmutated first; make tests set up their own fixtures; prefer the whole file |
| A mutation run reports no failure, but nothing was mutated | a `perl -0pi` or `sed` pattern spanning a newline misses a CRLF working-tree file | patch with a script that matches the file's own line ending and fails when the pattern isn't found; never revert with `git checkout -- <file>` (it drops every other uncommitted change in that file) |
| A test file is red with every subtest green: `RemoveEnvironmentCleanupHook` (SIGABRT) at exit | a better-sqlite3 build for another Node major tearing down | run with the Node major CI uses; after switching OS on a shared checkout, `npm rebuild better-sqlite3` and `npm install` in `runtime/`; compare with a pristine worktree of the base before blaming the change |
| A live colour assertion fails only under an agent | the agent runner exports `NO_COLOR=1` / `TERM=dumb` | give the test an explicitly colour-capable temp terminal; never weaken the assertion |
| Timing tests (the highlight speed budget, a lock race) fail once | the full suite ran while another suite or a reviewer's probes loaded the machine | rerun the file alone; run the full suite after other test runs finish |
| A probe's output carries a child's stderr you didn't ask for | `execFileSync` echoes the child's stderr unless `stdio` is explicit | pass `stdio: ["ignore", "pipe", "pipe"]` and keep the stderr as labelled detail |
