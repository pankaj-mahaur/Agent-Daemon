---
name: ad-tui-dev
description: "Use when working on agent-daemon's own terminal UI (maintainers, this repo): \"continue the TUI\", \"TUI ka kaam\", \"ad tui\", \"next TUI part\", \"renderer\", \"composer\", \"input parser\", \"tui-probe\", \"terminal UI bug\", \"/undo\", \"ad codex\", \"the fake app-server\". Loads the plan's state, the module map, tests and goldens, and the rules the TUI must keep: isolation from the user's own Codex, inline-renderer terminal rules, Windows input facts, and the per-part loop."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.1"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# Work on the `ad` terminal UI

The TUI (`ad tui`, later bare `ad` → a Codex-style terminal UI on the pinned Codex engine) is built from a final, reviewed plan, one part at a time. This skill puts the plan's state and its hard-won rules in front of you before you touch code, so a new session continues the work instead of re-deriving it. User docs: `docs/tui.md`.

## When to use

Any change under `runtime/src/tui/`, `runtime/src/harness/{session,checkpoints,codex-ui}.mjs`, `runtime/src/engine/codex/events.mjs`, `runtime/testkit/`, the probe, `docs/tui.md`, or the TUI parts of the plan.

## Module map

All paths under `runtime/`.

| Path | What |
|---|---|
| `src/cli.mjs` | thin launcher: routes `tui`, `codex` and bare `ad` / `ad --last` before loading `cli-full.mjs` (the rest of the CLI). Keep it light |
| `src/tui/flip.mjs` | bare `ad` → TUI (D7). `TUI_IS_DEFAULT` stays `false` until the user's FC3 sign-off; `AD_TUI=1` opts in, `AD_TUI=0` opts out after the flip; the one-time `ad chat` hint |
| `src/tui/preflight.mjs` | why the TUI can't run here (TTY, `TERM=dumb`, Node on Windows, mintty), with a working alternative |
| `src/tui/main.mjs` | `cmdTui`: preflight → terminal → engine (sign-in panel) → folder trust → session + checkpoints → header and "since last time" → app → exit hint. Builds `actions` (file search, git diff, editor, handoffs to `ad …` and `/codex`) |
| `src/tui/app.mjs` | the app: input → intents, session events → frames, scrollback commits, keys, `SLASH_COMMANDS` (each marked `source: "codex"` or `"ad"`), `slashCollisions` |
| `src/tui/commands.mjs` | Part 8 renderers: `/mcp`, `/hooks`, `/skills`, `/usage`, `/terminal-setup`, transcript pager, `/export` markdown, `/copy` clipboard, image paths |
| `src/tui/ad-layer.mjs` | Part 9: `/memory`, learned rows, `/proposals`, `/loop`, `/team`, `/schedule`, scheduler warning |
| `src/tui/undo.mjs` | Part 10 wiring: "before" started at Enter (1 s wait), "after" after the turn, applied edits only, `/undo` |
| `src/tui/history.mjs` | prompt history JSONL (`~/.agent-daemon/tui/history.jsonl`) |
| `src/tui/init-prompt.mjs` | Codex's `/init` prompt, vendored (re-copy on Codex upgrades) |
| `src/tui/preview.mjs` | `ad tui --preview`, the Part 2 walking skeleton |
| `src/tui/codex-slash.json` | Codex's slash names at the pinned tag (`scripts/codex-slash.mjs`) |
| `src/tui/terminal/` | `io` (raw mode, caps, handoff, restore), `input` (bytes → key/text/paste events), `renderer` (inline), `sanitize`, `text` (spans, SGR, wrap), `width` + `width-table` (generated), `detect` (terminal name, reflow model, width profile) |
| `src/tui/view/` | pure views: `composer`, `markdown` (streaming), `cells` (items, diffs, ad rows), `chrome` (header, status, footer, shortcuts, picker), `modals` (approvals with arming, questions, forms) |
| `src/harness/session.mjs` | UI-agnostic session controller: submit / steer / queue, requests, restarts, thread locks (`~/.agent-daemon/locks`) |
| `src/harness/checkpoints.mjs` | git-tree snapshots under `refs/ad/checkpoints/`, private index, restore with conflict check, `UNDO_LIMITS` |
| `src/harness/codex-ui.mjs` | `ad codex` / `/codex`: stock Codex UI on the harness home, `--no-daemon`, skills mirror |
| `src/engine/codex/events.mjs` | protocol traffic → `AdEvent`s; `compat.json` holds tested versions and "what changed" |
| `testkit/protocol-check.mjs` | validates messages against the pinned protocol snapshot |
| `testkit/tui-fake.mjs` | runs `ad tui` on `fake-codex-app-server.mjs` in a temp root (pty smoke) |
| `testkit/golden.mjs` | byte-for-byte goldens; `AD_UPDATE_GOLDEN=1` rewrites them |
| `testkit/screen.mjs` | test terminals: `xtermScreen` (xterm.js, reflows) and `modelScreen` (clips); `cprDelayMs` for races |
| `scripts/tui-probe.mjs`, `scripts/tui-demo.mjs` | live probes (`keys`, `screen`, `screen --bottom`) and the engine-free renderer demo |

## Tests and goldens

- **TUI tests** (`runtime/test/`): `tui-input`, `tui-io`, `tui-detect`, `tui-width`, `tui-text`, `tui-sanitize`, `tui-renderer` (terminal layer); `tui-composer`, `tui-markdown`, `tui-cells`, `tui-chrome`, `tui-modals` (views); `tui-app`, `tui-main`, `tui-parity`, `tui-ad`, `tui-hardening`, `tui-resilience`, `tui-preview`, `tui-pty-smoke`. Also `session`, `checkpoints`, `codex-events`, `codex-protocol-snapshot`, `engine-real` and `tui-live` (both `AD_REAL_ENGINE=1`; `tui-live` is the FC3/FC4 script on the real `ad tui` in a pty: run it after any app, session or view change).
- **Goldens:** `test/golden/tui/` holds `wrap-{20,40,79}`, `{cells,chrome,markdown,modals,parity}-{40,80,120}` and `modals-small`. They are LF on every platform. After an intended change, run with `AD_UPDATE_GOLDEN=1`, then read the golden diff line by line before committing.
- **Fixtures:** `test/fixtures/tui/s1-keys.json` (real key bytes from Windows Terminal and Zed).
- **The fake must stay honest:** every message `fake-codex-app-server.mjs` sends in the main scenarios must pass `protocol-check` (`tui-resilience` enforces it). When you add a fake message, give it the real shape (full `Thread` objects, `startedAtMs`, the approval's `itemId`, …), not just the fields ad reads.
- **Mutation-check every guard.** For each fix or safety check, break it on purpose (delete the line, flip the condition), run the tests, and confirm a named test fails; then restore it. A guard no test catches isn't done. Record the count in the plan ("N guards mutation-checked").
- **Slash names:** a new command needs `source`, a check against `codex-slash.json` (`slashCollisions`), a row in `docs/tui.md`, and `/help` coverage.

## Procedure

1. **Load the state.**
   - Read the status block at the top of `docs/plans/ad-tui.md`, the part you're on, and the **Interfaces** section.
   - Read `.agent-daemon/memory/activeContext.md`.
   - Check `git status -sb`: work happens on `feat/tui`, never on main.
2. **Follow the plan's loop** for the (sub-)part, and finish its Done-when. Interfaces are fixed; changing one needs a revision-log entry. If the plan and the code disagree, verify against the code and fix whichever is wrong.
3. **Never touch the user's own Codex.**
   - Every real Codex process starts through `codexEnv()` (`runtime/src/engine/codex/home.mjs`).
   - Tests use temp homes, a `source: "test-double"` fake, or the real-engine suite (`AD_REAL_ENGINE=1`).
   - Never use `~/.codex` or the user's global `codex`.
   - Elevated Windows sandbox setup is machine-wide: ask first.
4. **Renderer rules** (inline mode; why: `docs/research/terminal-engineering.md`):
   - **Live region:**
     - never `2J` or `3J`;
     - live rows are drawn with autowrap off (`?7l`) and are at most `cols − 1` wide;
     - the live region never exceeds `rows − 1`;
     - skip cursor moves whose count is 0 (`ESC[0A` moves one row);
     - send `ESC[0m` before every `\r\n`, `ESC[K` and `ESC[J`.
   - **Frames and history:**
     - one `write()` per frame inside `?2026`;
     - history is committed by overpainting, also with autowrap off (lines are pre-wrapped);
     - width: measure with `tui/terminal/width.mjs`, which defaults to the `codepoint` profile (safe). Use `grapheme` only for Windows Terminal or after the CPR probe;
     - without 2026, commit at most every 150 ms.
   - **Resize:** pause, wait 75 ms, then re-anchor with a cursor-position query and the terminal's reflow model. Ctrl+L is re-anchor plus redraw.
     - The rows-above-cursor estimate must be a lower bound: an over-count erases history, an under-count only leaves a ghost row.
     - Any await on CPR is a race. Re-anchors carry a generation, so a resize, redraw or suspend that arrives meanwhile makes them write nothing.
     - Test races with `cprDelayMs` in `testkit/screen.mjs`.
   - **Cursor:** never restyle it or force a blink, and never redraw an idle screen (each write restarts the blink).
   - **Exit:** restore synchronously (`fs.writeSync`) on every exit path.
   - **Untrusted text:** always through `sanitize()` (`tui/terminal/sanitize.mjs`): `"transcript"` strips controls, `"approval"` makes every invisible visible. Sanitize the accumulated text, not each delta.
   - **Source files:** write invisible characters as `\u{...}` escapes. The Write/Edit tools decode 4-hex `\uXXXX` into raw characters. Check with `grep -nP '[^\x00-\x7F]'`.
5. **Windows input facts:**
   - VT input needs Node 22.17+ or 24.2+.
   - Windows Terminal 1.24 and VS Code send Shift+Enter as Enter. Zed sends Shift+Enter as LF (`0a`), and Windows Terminal sends Ctrl+Enter as LF. Rule (FC0): `0d` submits and `0a` is a newline; the footer hint is per terminal.
   - Primary live-check terminals are Windows Terminal and **Zed** (the user's daily terminal). VS Code is secondary.
   - Alt+Enter is taken by Windows Terminal's fullscreen toggle, and Ctrl+V by its paste.
   - The kitty keyboard protocol arrives in Windows Terminal 1.25.
   - When in doubt, run `node runtime/scripts/tui-probe.mjs keys|screen` and read `~/.agent-daemon/logs/tui-probe-*.log`.
6. **Protocol facts:**
   - Stable surface only (`experimentalApi` stays false).
   - Errors are -32600 with distinct messages; -32601 only means an operation is unsupported.
   - `availableDecisions` leaks through on exec approvals only. Codex's fallback applies otherwise.
   - Details: `docs/research/codex-tui-and-app-server.md`.
7. **Before every commit:**
   - `cd runtime && node --test`;
   - the goldens (UI changes) and a mutation check of each new guard;
   - the real-engine suite when engine code changed;
   - `npm run lint:skills` when skills changed;
   - `docs/tui.md` (and `docs/troubleshooting.md` #22–28) when keys, commands, messages or files changed: the docs must match the code;
   - read the `git diff` (scripted edits have corrupted files before).
   - Commit by file name. Push only with the user's OK.

## Examples

### Example 1: continuing after a break

The status says Parts 0–11 are built and FC3 is pending (user). Don't flip `TUI_IS_DEFAULT` yourself. Pick up what is open without the user (a backlog item, a review finding), or prepare the live script in `docs/manual-test.md` section 6 for the user to run in Windows Terminal, Zed and VS Code. Once the user signs off, set `TUI_IS_DEFAULT = true` in `src/tui/flip.mjs`, update `docs/tui.md` ("Bare `ad`") and the README, and record it in the plan.

### Example 2: a renderer bug report

"Status line duplicates after resizing in VS Code." Ask for a `screen --bottom` probe log and a screenshot (troubleshooting #25), reproduce the sequence in an `@xterm/headless` test under both reflow models, fix the re-anchoring, and add the case to the property tests.

## Anti-patterns

- **Starting the real Codex without `codexEnv()`,** or reading or writing `~/.codex`.
- **Flipping bare `ad` to the TUI before the user signs off at FC3** (`TUI_IS_DEFAULT` in `src/tui/flip.mjs`).
- **Teaching the fake a message the real Codex can't send.** It must pass `protocol-check`.
- **Adding a slash command that takes a Codex name** for something else, or a key without updating the `?` overlay and `docs/tui.md`.
- **Reaching for an experimental protocol method** because it's convenient.
- **Editing files that contain backslashes or `$` through shell heredocs.** Use the Write/Edit tools, and give `replace()` a function.
- **Moving to the next part with a red test or an open medium-or-worse finding** (see `big-feature-flow`).
