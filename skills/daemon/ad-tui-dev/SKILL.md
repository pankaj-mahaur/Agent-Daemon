---
name: ad-tui-dev
description: "Use when working on agent-daemon's own terminal UI (maintainers, this repo): \"continue the TUI\", \"TUI ka kaam\", \"ad tui\", \"next TUI part\", \"renderer\", \"composer\", \"input parser\", \"tui-probe\", \"terminal UI bug\", \"/undo\", \"ad codex\", \"the fake app-server\". Loads the plan's state, the module map, tests and goldens, and the rules the TUI must keep: isolation from the user's own Codex, inline-renderer terminal rules, Windows input facts, and the per-part loop."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.2"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# Work on the `ad` terminal UI

The TUI (`ad tui` and bare `ad`: a Codex-style terminal UI on the pinned Codex engine, released in 2.1.0) was built from a reviewed plan, one part at a time. This skill puts its hard-won rules in front of you before you touch code, so a new session continues the work instead of re-deriving it. User docs: `docs/tui.md`. Design and the `/undo` safety model: `docs/tui-architecture.md`. Tests: `docs/testing.md`. The maintainer's working plan (`docs/plans/ad-tui.md`) and research notes (`docs/research/`) are local-only, not in the public repo: read them when present.

## When to use

Any change under `runtime/src/tui/`, `runtime/src/harness/{session,checkpoints,codex-ui}.mjs`, `runtime/src/engine/codex/events.mjs`, `runtime/testkit/`, the probe, `docs/tui.md`, or the TUI parts of the plan.

## Module map

All paths under `runtime/`.

| Path | What |
|---|---|
| `src/cli.mjs` | thin launcher: routes `tui`, `codex` and bare `ad` / `ad --last` before loading `cli-full.mjs` (the rest of the CLI). Keep it light |
| `src/tui/flip.mjs` | bare `ad` → TUI (D7). `TUI_IS_DEFAULT` is `true` (flipped after FC3); `AD_TUI=0` opts out; the one-time `ad chat` hint |
| `src/tui/preflight.mjs` | why the TUI can't run here (TTY, `TERM=dumb`, Node on Windows, mintty), with a working alternative |
| `src/tui/main.mjs` | `cmdTui`: preflight → terminal → engine (sign-in panel) → folder trust → session + checkpoints → header and "since last time" → app → exit hint. Builds `actions` (file search, git diff, editor, handoffs to `ad …` and `/codex`) |
| `src/tui/app.mjs` | the app: input → intents, session events → frames, scrollback commits, keys, `SLASH_COMMANDS` (each marked `source: "codex"` or `"ad"`), `slashCollisions` |
| `src/tui/commands.mjs` | Part 8 renderers: `/mcp`, `/hooks`, `/skills`, `/usage`, `/terminal-setup`, transcript pager, `/export` markdown, `/copy` clipboard, image paths |
| `src/tui/ad-layer.mjs` | Part 9: `/memory`, learned rows, `/proposals`, `/loop`, `/team`, `/schedule`, scheduler warning |
| `src/tui/undo.mjs` | Part 10 wiring: "before" started at Enter and awaited (10 s cap) so no agent action can be in it, "after" after the turn, applied edits only (hashed + line-counted per file), edit paths resolved to real paths, `/undo` |
| `src/tui/history.mjs` | prompt history JSONL (`~/.agent-daemon/tui/history.jsonl`) |
| `src/tui/init-prompt.mjs` | Codex's `/init` prompt, vendored (re-copy on Codex upgrades) |
| `src/tui/preview.mjs` | `ad tui --preview`, a minimal preview UI on the same engine (the first walking skeleton) |
| `src/tui/codex-slash.json` | Codex's slash commands at the pinned tag with their rules: aliases, inline args, allowed during a task, side-conversation allowlist, visibility, popup (`scripts/codex-slash.mjs --file slash_command.rs --popup command_popup.rs`) |
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
- **Slash names:** a new command needs `source`, a check against `codex-slash.json` (`slashCollisions`), a row in `docs/tui.md`, and `/help` coverage. Every Codex command is either a `source: "codex"` row in `SLASH_COMMANDS` or an entry in `NOT_IN_AD` (what ad says instead; never sent to the model): implementing one means removing it from `NOT_IN_AD`. Codex's "during a task" rule and popup hiding come from the generated metadata, not by hand.
- **Status line and title:** items are Codex's ids in `tui/status.mjs`; every value through `titleSafe`; the title is never written while `holdTitle(true)` (a handoff). A new item needs Codex's id (or it stays "unsupported").
- **Test pitfalls met:** match long paths and hints with `\s+` (they wrap); give "too soon" assertions a long arm delay (500 ms) and waits that end early on success a generous cap (a 50 ms query timeout flaked under load); `until()` must await async predicates; if a mutation isn't caught, change the setup until the old and new behaviour differ on screen.
- **Keys:** a key ad handles is an action in `tui/keymap.mjs` (Codex's context, action name and default keys from `codex-rs/tui/src/keymap.rs`), checked with `keymap.is(ctx, action, ev)`, never a hard-coded test. A new key needs a row in `docs/tui.md` (a test checks every default key is named there) and a cell in the key routing table test when a layer is involved. Colours come from `tui/view/theme.mjs` only (a test fails on a colour literal elsewhere).
- **Requests to Codex:** a new `request("method")` call needs the method in `SENT_METHODS` (`engine/codex/protocol-snapshot.mjs`) and a regenerated snapshot (`node scripts/codex-schema-snapshot.mjs`, pinned binary, temp home). The fake app-server rejects params the stable protocol lacks; an experimental method or field must be on `EXPERIMENTAL_ALLOWLIST` (`engine/codex/surface.mjs`) on purpose.

## Procedure

1. **Load the state.**
   - Read `docs/tui-architecture.md` (layers, invariants, decisions); when present locally, the status block of `docs/plans/ad-tui.md`.
   - Read `.agent-daemon/memory/activeContext.md`.
   - Check `git status -sb`: work happens on `feat/tui`, never on main.
2. **Follow the plan's loop** for the (sub-)part, and finish its Done-when. Interfaces are fixed; changing one needs a revision-log entry. If the plan and the code disagree, verify against the code and fix whichever is wrong.
3. **Never touch the user's own Codex.**
   - Every real Codex process starts through `codexEnv()` (`runtime/src/engine/codex/home.mjs`).
   - Tests use temp homes, a `source: "test-double"` fake, or the real-engine suite (`AD_REAL_ENGINE=1`).
   - Never use `~/.codex` or the user's global `codex`.
   - Elevated Windows sandbox setup is machine-wide: ask first.
4. **Renderer rules** (inline mode; why: `docs/tui-architecture.md`):
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
   - Stable surface, except `EXPERIMENTAL_ALLOWLIST` (`engine/codex/surface.mjs`): only the TUI's engine sends `experimentalApi: true` (`experimentalCapabilities()`, which also opts out of every experimental notification ad doesn't handle). A new experimental use needs the user's OK, the allowlist, a regenerated snapshot (its `experimental` section) and a real-engine test.
   - **Plan mode** (Codex's collaboration modes): the session owns it (`state.mode`, `setMode`, `cycleMode`, `modeMask`); every `turn/start` gets the mask in `startTurn` only, so no turn path can miss it. Default's mask carries the user's own model/effort (never values read back after a plan turn); `thread/settings/updated` and the resume response set the mode; `newThread()` resets to Default. "Implement this plan?" opens from `draw()` via `maybeOfferPlan()` in a microtask (opening a dialog redraws), never over a draft, a popup or a request.
   - **Background terminals** (Codex's unified exec): a `commandExecution` with `source: "unifiedExecStartup"` is one until its `item/completed`, which comes only when the process exits (possibly long after the turn). `session.state.terminals` keys them by Codex's `processId`; `flush()` never stops at a running one: once anything follows it (or its turn ends) its cell is committed as it is, "Running" while the process lives, and its end is drawn as a new cell during a task (Codex's rule; every exec_command is such an item while it runs, so never drop one silently); `/stop` = `thread/backgroundTerminals/clean` (allowlisted), after which Codex completes them as failed, exit -1.
   - **The folder is mutable** (`/cd`): the session's `state.config.cwd` is what every thread start, resume and restart uses (never a captured `cwd`); `session.changeDir()` forks with `cwd` + `excludeTurns: true` (the history is on screen) and moves the lock; `main.mjs` `actions.setCwd()` rebuilds the ad layer and `/undo`'s checkpoints (`session.setHooks`). A new folder-bound helper must read the current folder when used.
   - **Side conversations**: a second `createSession({secondary: true})` on the same engine (no requests, no global events, no lock, no restarts; `adopt(threadId)`), made by the main session's `openSide()`. Codex 0.160 ignores a fork's `developerInstructions`, so the side texts go in through `thread/inject_items` (developer + user items). The app keeps one composer; `side.focus` decides where Enter, Esc, Ctrl+C and /commands go; the panel replaces main's live items (main shows only its status rows).
   - Prompts the client writes (Codex's clear-context plan hand-off) must be skipped by ad's prompt hooks: `hooks/generated-prompts.mjs`.
   - Errors are -32600 with distinct messages; -32601 only means an operation is unsupported.
   - `availableDecisions` leaks through on exec approvals only. Codex's fallback applies otherwise. A real exec approval offers `y` / `p` ("don't ask again for commands starting with …") / Esc ("No, and stop": declines and ends the turn); `n` only when Codex offers "No, and tell Codex what to do instead" (patch approvals).
   - **Item ids are not unique across turns** with some providers (`msg-1`, `call_0`): the session keys a later turn's item `<id>@<turn>`, the app keys shown items per turn, and requests resolve Codex's id with `session.itemFor(id, turnId)`.
   - **The `turn/start` response can arrive before the `turn/started` notification:** never rely on `state.starting` inside `turnStarted`.
   - **`item/started` is not ordered before the disk write** of a patch: nothing safety-related may depend on that race.
   - Codex's own diff of an applied patch matches git's line counts (verified live for Update File).
   - MCP tool approval per server: `default_tools_approval_mode` = `auto` | `prompt` | `writes` | `approve` (and per-tool `approval_mode`).
   - Codex runs commands in the first `pwsh` on PATH (PowerShell 7 adds its own folder to its children's PATH); the Windows sandbox can't start a Store (MSIX) app, so `withoutStoreAliases()` (`engine/codex/app-server.mjs`) drops every PATH entry with a `WindowsApps` segment at every Codex spawn, always on Windows (the alias folder and the Store package folders).
   - The first sandboxed action in a fresh Codex home sets up the Windows sandbox: about 35 s once (longer on a busy machine).
   - Details, when present locally: `docs/research/codex-tui-and-app-server.md`.
6a. **`/undo` invariants** (`docs/tui-architecture.md#undo-the-safety-model`): it never destroys or reverts the user's work on its own (only `/undo force` discards changes made after the agent's edit, and only those), and refuses rather than guesses.
   - The "before" snapshot is awaited before `turn/start` (10 s cap): never let it race the agent.
   - Every applied edit is hashed when it completes and its own diff lines recorded; the chain check compares the **lines** each step changed with that edit's own lines (summed or per-edit counts were both broken by review).
   - Paths go through `realPath()` (8.3 names, junctions, `subst`); ad's own `.agent-daemon/`, heavy folders, ignored and big files are never snapshotted; restores use a scratch index (never the user's `index.lock`).
   - Only the "changed since…" conflicts are forceable; a file moved in from outside the repo is "not in the checkpoint", never deleted.
   - Prove each case on a real temp repo in `test/checkpoints.test.mjs`, and mutation-check it.
6b. **Live tests** (`test/tui-live.test.mjs`, practices in `docs/testing.md`): wait for state not time, count occurrences instead of matching once (the scrollback keeps old text), wait for the idle footer before the next prompt, close every pty in `finally`, approve "retry without sandbox?" on runners that can't sandbox. Reproduce a user's live transcript in a temp home (same shell, same PATH) before fixing it.
7. **Before every commit:** run the project's `ad-pre-push` skill (docs, CHANGELOG, skills, learnings, hygiene, link check). In particular:
   - `cd runtime && node --test`;
   - the goldens (UI changes) and a mutation check of each new guard;
   - the real-engine suite when engine code changed;
   - `npm run lint:skills` when skills changed;
   - `docs/tui.md` (and `docs/troubleshooting.md` #22–30) when keys, commands, messages or files changed: the docs must match the code;
   - read the `git diff` (scripted edits have corrupted files before).
   - Commit by file name. Push only with the user's OK.

## Examples

### Example 1: continuing after a break

The status says Parts 0–11 are built, FC2–FC4 run automated in `test/tui-live.test.mjs`, and bare `ad` opens the TUI. Read the plan's status block for what still waits for the user, pick up what is open without them (a backlog item, a review finding), and run `AD_REAL_ENGINE=1 node --test test/tui-live.test.mjs` after any change to the app, session or views.

### Example 2: a renderer bug report

"Status line duplicates after resizing in VS Code." Ask for a `screen --bottom` probe log and a screenshot (troubleshooting #25), reproduce the sequence in an `@xterm/headless` test under both reflow models, fix the re-anchoring, and add the case to the property tests.

## Anti-patterns

- **Starting the real Codex without `codexEnv()`,** or reading or writing `~/.codex`.
- **Changing what bare `ad` opens** (`TUI_IS_DEFAULT` in `src/tui/flip.mjs`) without the user.
- **Teaching the fake a message the real Codex can't send.** It must pass `protocol-check`.
- **Adding a slash command that takes a Codex name** for something else, or a key without updating the `?` overlay and `docs/tui.md`.
- **Reaching for an experimental protocol method** because it's convenient.
- **Editing files that contain backslashes or `$` through shell heredocs.** Use the Write/Edit tools, and give `replace()` a function.
- **Moving to the next part with a red test or an open medium-or-worse finding** (see `big-feature-flow`).
- **Basing a safety check on a timing race or on totals.** `/undo` went through "awaited 1 s" (busy machines lost checkpoints), "not awaited, race the first edit" (commands slipped into the 'before'), "summed counts" and "per-edit counts" (user changes hid) before the awaited snapshot + per-line chain held up under review.
- **Trusting a green CI run without reading the real-engine job** (it may fail without failing the run).
- **Personal names, paths or client projects in tests, goldens or examples** (use `shop-app`, `work`, `Sam`).
