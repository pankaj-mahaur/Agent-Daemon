---
name: ad-tui-dev
description: "Use when working on agent-daemon's own terminal UI (maintainers, this repo): \"continue the TUI\", \"TUI ka kaam\", \"ad tui\", \"next part of the TUI plan\", \"Part 1 / Part 3c / FC0\", \"renderer\", \"composer\", \"input parser\", \"tui-probe\", \"terminal UI bug\". Loads the plan's current state and the rules the TUI must keep: isolation from the user's own Codex, the inline-renderer terminal rules, Windows input facts, and the per-part loop."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent
---

# Work on the `ad` terminal UI

The TUI (`ad` → a Codex-style terminal UI on the pinned Codex engine) is built from a final, reviewed plan, one part at a time. This skill puts the plan's state and its hard-won rules in front of you before you touch code, so a new session continues the work instead of re-deriving it.

## When to use

Any change under `runtime/src/tui/`, `runtime/src/harness/session.mjs`, `runtime/src/engine/codex/events.mjs`, the probe, or the TUI parts of the plan.

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
   - the real-engine suite when engine code changed;
   - `npm run lint:skills` when skills changed;
   - read the `git diff` (scripted edits have corrupted files before).
   - Commit by file name. Push only with the user's OK.

## Examples

### Example 1: continuing after a break

The status says "Part 0 done; waiting on the Node upgrade and FC0". Check `node -v`. If it's ≥ 22.17, run the two probes with the user in Windows Terminal and VS Code, record S1/S1b in Part 0, write the FC0 decisions into D2 and the screen design, then start Part 1a with byte-fixture tests for the input parser.

### Example 2: a renderer bug report

"Status line duplicates after resizing in VS Code." Ask for a `screen` probe log, reproduce the sequence in an `@xterm/headless` test under both reflow models, fix the re-anchoring, and add the case to the property tests.

## Anti-patterns

- **Starting the real Codex without `codexEnv()`,** or reading or writing `~/.codex`.
- **Flipping bare `ad` to the TUI before the user signs off at FC3.**
- **Reaching for an experimental protocol method** because it's convenient.
- **Editing files that contain backslashes or `$` through shell heredocs.** Use the Write/Edit tools, and give `replace()` a function.
- **Moving to the next part with a red test or an open medium-or-worse finding** (see `big-feature-flow`).
