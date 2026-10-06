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
| Real Codex, protocol level | `test/engine-real.test.mjs` + `testkit/mock-responses.mjs` | what a Codex release actually sends for a turn, an approval, a patch |
| Real Codex, real terminal | `test/tui-live.test.mjs` | the terminal UI script of the manual test (section 6) and ad's own features, on the real `ad tui` |
| Codex pin bookkeeping | `test/tui-resilience.test.mjs` | ad's slash commands don't collide with Codex's (`src/tui/codex-slash.json` must match the pinned tag); `src/engine/codex/compat.json` lists the pin as tested, with a "what changed" note (`AD_COMPAT_NOTE_PENDING=1` lets the upgrade bot's run pass until a person writes it) |

### The fake engine speaks the pinned protocol

`testkit/fake-codex-app-server.mjs` is a scripted `codex app-server`: a prompt's text picks a scenario (`edit-file`, `two-approvals`, `hang`, `subagent`, `same-id …`, `reject-start`, …). Its messages are checked against the committed protocol snapshot by `testkit/protocol-check.mjs`, so it can't teach the client a message the real Codex can't send. A new scenario must keep passing that check (the `future` scenario, a synthetic newer Codex, is the one deliberate exception).

### The mock model

`testkit/mock-responses.mjs` stands in for the OpenAI Responses API. A keyword in the prompt picks the reply: `PING` (a streamed "pong"), `SHELL` / `ESCALATE` (a command, the second asking to leave the sandbox), `PATCH` (an `apply_patch` adding `hello.txt`), `FAIL`, `HOLD` (streams, then waits for `mock.release()`). A test can pass its own script; the live test adds `STEERED`, `QUEUED` and `EDITMATH` (an Update File patch).

## The live terminal UI tests

`test/tui-live.test.mjs` runs `node src/cli.mjs tui` in a pseudo-terminal (`@lydell/node-pty`; ConPTY on Windows, the same path Windows Terminal uses) and feeds its output to `@xterm/headless`, which also answers the UI's terminal queries. The engine is the real pinned Codex; the model is the mock.

**Isolation.** Each test builds a throwaway world: a temp `HOME`/`USERPROFILE` (so ad's memory, state and locks are temp ones), a temp `AD_CODEX_HOME` with only the mock provider and the ad-managed marker (so ad installs its real hooks and memory server there), and a scratch git repo as the project. The user's `~/.codex` and `~/.agent-daemon` are never read or written.

**What it covers.**
- FC3: header, a streamed answer, exec approval (the 400 ms guard, Esc = "No, and stop", approval), a patch in Auto and `/undo`, an Update File patch and `/undo`, the permissions picker and a read-only patch approval, steer, queue, interrupt, Esc Esc, `/undo` refusing a user's edit and `/undo force`, Ctrl+T, a narrowing resize, `/codex` and back, quit, `ad tui --last`.
- FC4: `/memory`, `/private` (the model receives the wrapper; the transcript shows the prompt as typed), a correction becoming a "Learned:" row, `/schedule`, `/team`, `/proposals`, `/loop` start and stop.

**Writing steps that don't flake.**
- Wait for state, never for time: `t.until(predicate)`. Sleep only where a person would pause (after Esc, so the next key isn't read as Alt+key).
- Text that appeared earlier is still in the scrollback: count occurrences (`t.count(/…/g)`) and wait for the count to grow, instead of matching once.
- Wait for the footer to be idle (`t.idle()`: shows "? shortcuts", no "esc to interrupt") before typing the next prompt; otherwise Enter steers it into the running turn.
- Match long paths with `\s+` between words: a long temp path wraps differently on each OS.
- Close every pseudo-terminal in `finally` (`launched`); an open ConPTY keeps node alive.
- Some runners can't run Codex's sandbox (GitHub's Windows runners): Codex then asks "retry without sandbox?", which `patchTurn` approves.
- The first sandboxed action in a fresh Codex home sets up the Windows sandbox (about 35 s, longer on a busy machine): give it minutes, not seconds.

## Keeping tests honest

- **Mutation checks.** For a guard that matters (a safety check, a fix), break it on purpose (delete the condition, flip it) and run its test: the test must fail. If it passes, the test doesn't cover the guard; add the case that would. Keep the mutation script out of the repo (a scratch file that patches, runs `node --test <file>`, and restores in `finally`).
- **Assert the observable the bug moves.** A count that stays the same with the bug present proves nothing; assert the text, the file contents, the exit code.
- **Reproduce before fixing.** A failing live test or a user's transcript is first reproduced in a temp home (same shell, same PATH), then fixed, then checked with the same reproduction.
- **Never touch real user state.** Tests use temp homes for `~/.agent-daemon`, `CODEX_HOME`, the clipboard and the editor. Never start the real Codex outside `codexEnv()`.

## CI

`.github/workflows/test.yml` runs on every push to `main`, every PR that targets `main`, and on demand:

| Job | Runs |
|---|---|
| `ubuntu / macos / windows · node 22` | `npm test`, the skill linter, and smoke runs of `ad doctor`, `ad init --plan` and the skills-diff script |
| `real engine · ubuntu / macos / windows` | `engine-real` and `tui-live` with `AD_REAL_ENGINE=1` (on Linux after allowing unprivileged user namespaces for Codex's bubblewrap sandbox) |

The real-engine job is non-blocking (`continue-on-error`): **read its result**, don't rely on the run's overall status.

`.github/workflows/codex-upgrade.yml` runs `npm test` and the same real-engine tests in its own Linux job before it opens the PR that bumps the Codex pin, and puts the results in the PR body. The PR's own `test.yml` run (all three OSes) happens only when the repo has a `CODEX_UPGRADE_TOKEN` secret: PRs opened with the default token don't trigger other workflows.

## Pitfalls met in practice

| Symptom | Cause | Fix |
|---|---|---|
| `ENOTEMPTY` removing a temp repo on Linux | a big commit started git's background auto-gc, still writing | `git config gc.auto 0` in test repos; retry `rmSync` |
| A test file never exits | an open pseudo-terminal or a long timer | close ptys in `finally`; keep fake timers short |
| Strings with `\` or `$` mangled in an edit | bash heredocs and `node -e` eat backslashes | edit with an editor tool or a script file; build escape bytes with `"\x1b"` |
| Windows: every command fails with `CreateProcessAsUserW failed` | PowerShell 7 from the Store; the sandbox can't start MSIX apps | handled by the engine's PATH: `withoutStoreAliases()` drops every `WindowsApps` entry ([troubleshooting #16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-access-is-denied-or-createprocessasuserw-failed)) |
| A live step times out after a patch | the first sandboxed action set up the Windows sandbox | allow minutes for the first one |
