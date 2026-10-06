# Research: building an inline terminal UI in Node

Collected 2026-10-04 for the `ad` terminal UI ([plan](../plans/ad-tui.md)). Summaries are ours; follow the links. *(unverified)* marks claims no primary source confirmed (the per-terminal support matrix was not finished).

## Where the industry is (October 2026)

| CLI | Renderer | Default screen | Notes |
|---|---|---|---|
| Codex | ratatui + crossterm, forked inline terminal | fullscreen since 2026-09-22; inline via `--no-alt-screen` | per-terminal history insertion, resize reflow, 120 fps cap |
| Claude Code | own React renderer (replaced Ink) | fullscreen for new users since 2026-05; classic inline kept | cell diffing, damage tracking, sync output; flicker issue #769 |
| Copilot CLI | cell-based renderer (was Ink) | alternate screen only | inline won't return |
| Gemini CLI | Ink fork + own 132 KB text buffer | inline (alternate buffer shipped in 0.15, reverted in 0.17.1) | virtualized list, headless xterm tests |
| Qwen Code | Ink 7 + 61 KB patch, OpenTUI opt-in | in-app virtualized history | measured ~749 erase sequences per 6 s with Ink vs 0 with OpenTUI |
| Cursor CLI | bundled Ink | inline | reprints the conversation into scrollback while streaming |
| Amp | own Flutter-like TS framework | fullscreen | double buffer + diff, 120 fps |
| OpenCode | OpenTUI (Zig core, Solid) | alternate screen; inline `--mini` | memory complaints |
| Crush | Bubble Tea v2 / Ultraviolet | alternate screen | copy/selection complaints |
| pi | own pi-tui | fullscreen since 1.0.0; `regular` for inline | line diff from the first changed line; wipes scrollback on resize |

Most big CLIs moved their default to fullscreen in 2026 but kept inline. Inline users keep asking for native find, select and copy. **Keep the transcript model independent of the display** so either mode can be drawn from the same cells.

## Library options for a zero-dependency Node project

| Option | Verdict |
|---|---|
| Ink 8 (React ≥ 19.3 + Yoga, 39 packages, ~7.8 MB; no-JSX via `createElement`/`htm`) | mature, but its main adopters rewrote or forked it; breaks zero-dep |
| `@earendil-works/pi-tui` 1.0.2 (MIT; `marked`, `get-east-asian-width`, native prebuilds; Node ≥ 22.19) | the best reference design to learn from; not a dependency |
| OpenTUI 0.5 (Zig native) | needs Bun ≥ 1.3 or Node ≥ 26.4 with `--experimental-ffi` |
| blessed / neo-blessed | dead |
| terminal-kit, Rezi, termui | fullscreen-oriented, native, or Ink-based |
| **Own renderer** | ~2.5–4k lines of `.mjs`; pi-tui's core is ~5k lines of TS for scale |

What "own" takes: a terminal I/O layer (modes, one write per frame, restore on every exit path), an input parser (ESC timeout, CSI/SS3/OSC/DCS, CSI-u and modifyOtherKeys, paste state machine, terminal-reply router), width utilities, a line-diff live renderer, a history inserter, and the components (composer, popups, markdown/diff).

## Windows Terminal and Node on Windows

**Synchronized output** (`CSI ?2026h` … `CSI ?2026l`): supported in Windows Terminal from 1.24 (microsoft/terminal#18826). Probe with DECRQM `CSI ?2026$p` → `CSI ?2026;Ps$y` (1 or 2 = supported), timeout ~100 ms. Write each frame with one `write()`.

**Scroll regions:** Codex's source notes that rows scrolled out of a partial DECSTBM region can be discarded instead of entering Windows Terminal's scrollback, so with `WT_SESSION` set it uses no scroll region at all. Never grow content with `CSI n S` either (drops rows in xterm.js, i.e. VS Code).

**Clearing:** `CSI 2J` in Windows Terminal and VS Code first pushes the visible screen into scrollback; `CSI 3J` deletes the user's history. Erase relative to the cursor instead (`CSI nA` + `\r` + `CSI J`).

**Bottom-right cell:** Windows consoles scroll as soon as the bottom-right cell is written instead of deferring the wrap like xterm. Never fill the last column of the last row (Ink #969).

**Node raw mode (the version split that matters):**
- Node ≥ 22.17 / ≥ 24.2: `setRawMode(true)` uses libuv's `UV_TTY_MODE_RAW_VT` (`ENABLE_VIRTUAL_TERMINAL_INPUT`), so the terminal's own VT input arrives: bracketed paste markers, focus events, CSI-u.
- Node 22.0–22.16: legacy raw mode; libuv synthesizes sequences itself. No paste markers (pasted newlines look like Enter), no focus events, no CSI-u, Shift+Tab arrives as `\t`.

**Key bytes in RAW_VT mode** (conhost encoder): Enter `\r`, **Shift+Enter `\r` (same as Enter)**, Ctrl+Enter `\n`, Alt+Enter `ESC \r`, Shift+Tab `ESC[Z`, Ctrl+Backspace `0x08`. **Ctrl+C arrives as byte `\x03`, not SIGINT** (Ctrl+Break still sends SIGBREAK).

**Kitty keyboard protocol:** in Windows Terminal from **1.25** (stable 2026-10-02), not 1.24. VS Code stable doesn't have it (xterm.js 6.1 betas do) *(unverified)*. Negotiate like pi-tui: push `CSI >flags u`, query `CSI ?u`, send DA1 `CSI c` as a sentinel; if only DA1 answers, fall back to modifyOtherKeys `CSI >4;2m`; on exit pop with `CSI <u` and `CSI >4;0m`. With the protocol on, Shift+Enter is `CSI 13;2u`. Without it, offer Ctrl+Enter / Ctrl+J / Alt+Enter / `\`+Enter for a newline. Codex also decodes `CSI 13;2u` from a Windows Terminal `sendInput` keybinding users can add.

**Other Windows gaps:**
- Mouse: libuv raw mode clears `ENABLE_MOUSE_INPUT`, so mouse reports are dropped (libuv#5155 open). Don't capture the mouse inline anyway: it breaks native scroll and selection.
- Resize: SIGWINCH can arrive late; a stale width was reported under ConPTY. Debounce and re-read the size.
- Colour: `getColorDepth()` on win32 only checks the OS build (≥ 14931 → 24-bit).
- Timers: `setTimeout(0)` can take a 16 ms tick; echo keystrokes immediately rather than through the frame throttle.
- A child process sharing the console can put it back into cooked mode while libuv's cached state makes `setRawMode(true)` a no-op (libuv#5156 open); toggling `false` → `true` recovers. Children spawned without a console avoid it.

## History insertion and resize

**Codex inline insertion:**
- Windows Terminal: clear from the top of the live viewport down (`CSI J`), write the history lines separated by `\r\n`, scroll the whole screen with newlines, then redraw the live region, all in one synchronized frame.
- xterm-like terminals: set the region to the rows above the live area (`CSI 1;{top} r`), write each history row as `\r\n` + row at the region's bottom, reset with `CSI r`; reverse index (`ESC M`) moves the live viewport down first when needed.

**Resize:**
- pi-tui: on any width/height change, or a change above the viewport, it clears screen and scrollback (`\x1b[2J\x1b[H\x1b[3J`) and re-renders everything, which wipes what the user was reading (pi #7304).
- Codex: cells are the source of truth. After 75 ms of no resizing it purges and replays the transcript at the new width, capped near each terminal's default scrollback (Windows Terminal 9,001 rows, VS Code 1,000, WezTerm 3,500, Alacritty 10,000). Resizes during streaming wait for one final rebuild.
- Claude Code did the same clear-and-redraw and attributes most of its flicker to it ("80% of sessions hit at least one").

**Implication for us:** keep the live region small (at most `rows − 1`), never repaint rows already in scrollback, debounce resizes and re-anchor before redrawing, and treat history reflow as an opt-in later feature.

## Other escape sequences

- Focus `CSI ?1004h` → `CSI I` / `CSI O`; cursor shape `CSI Ps SP q` (reset `CSI 0 SP q`); visibility `CSI ?25l` / `?25h`.
- Hyperlinks (OSC 8) `ESC]8;;URL ESC\ text ESC]8;; ESC\`.
- Notifications: OSC 9 `ESC]9;msg BEL` (clashes with ConEmu/Windows Terminal progress), OSC 777 `ESC]777;notify;title;body BEL`; progress OSC 9;4.
- Clipboard (OSC 52) `ESC]52;c;BASE64 BEL`.
- Prompt marks (OSC 133) give native "jump to prompt" in inline mode; stable in Windows Terminal since 1.21.
- Terminal support for these is *(unverified)*; feature-detect or make them optional.

**Unicode width:** copy string-width's approach: `Intl.Segmenter` graphemes, `/^\p{RGI_Emoji}$/v` → 2 columns, an East Asian Width table (wide/fullwidth → 2), ambiguous → 1. Node has no public width API, so the table is vendored.

**Colour:** honour `NO_COLOR` / `FORCE_COLOR`; `util.styleText` respects them since 22.8 (`{validateStream:false}` when building frames off-screen).

## Streaming markdown

- **Codex:** a collector releases source only up to the last newline; each newline re-renders the accumulated source but queues only newly stable lines. Two regions: stable (committed to scrollback) and a mutable tail (live). Tables stay in the tail until complete (each row can change column widths); a code fence stays mutable while it is the last block. Commit pacing: "Smooth" drains one line per tick, switching to "CatchUp" (drain all) at 8 queued lines or 120 ms age, back at ≤ 2 lines / ≤ 40 ms held for 250 ms. A test asserts that a chunked stream renders exactly like the full text.
- **Toad:** every block but the last is final; re-parse only from the last block's start; coalesce tokens.
- **Streamdown:** splits blocks with a lexer and memoizes them; turns off reuse when link-reference definitions exist; auto-closes unterminated markdown to preview the tail.
- For zero deps: a line-based block splitter (fences, tables, lists, headings, quotes, paragraphs) and our own inline renderer. Skip syntax highlighting in v1.
- Diffs (Codex): line numbers, `+`/`-` gutter, background tints per colour depth, per-hunk highlighting, hard wrapping that keeps styles.

## Testing

- **`@xterm/headless` works in plain Node** (6.0.0, MIT, no deps, ~1.9 MB). Pass `allowProposedApi: true`. `write(data, cb)` is async. Read `buffer.active` (`baseY`, `viewportY`, `getLine(y).translateToString(true)`, cells with width and colour), `modes.synchronizedOutputMode`, `onData` for replies (CPR, DA, DECRQM), and `resize()` which reflows. Add `@xterm/addon-unicode11` for emoji/CJK widths. It emulates xterm.js (VS Code), **not** Windows Terminal or conhost.
- Codex tests: 192 snapshot tests of ratatui output, plus a VT100 backend that checks history really lands in scrollback.
- PTY end-to-end: `@lydell/node-pty` has prebuilds; Windows issues include a leaked conhost per pty and a `kill()` race. `@microsoft/tui-test` was rewritten a day ago (pin it if used). VHS fails to record on Windows 11.
- **Pyramid:** unit tests (parser fixtures incl. split chunks and terminal replies, width, wrap, frame diff, "streamed equals full" fuzzing) → golden screens through `@xterm/headless` (viewport, scrollback, styles, balanced modes; property: screen = history + last frame) → optional PTY end-to-end on CI → a manual matrix (Windows Terminal 1.24/1.25, conhost, VS Code, a macOS terminal, tmux).

## Performance

- Coalesce deltas; render at most every 16–33 ms; handle keystrokes immediately.
- Diff only the live region; history is append-only. Cache component lines by width.
- Cap tool output (Codex shows 5 lines; 50 for user shell commands).
- Keep the transcript as source cells and render on demand when replaying.

## Top pitfalls

1. Repainting rows that already scrolled into scrollback forces clear-and-redraw: flicker and jump-to-top.
2. DECSTBM or `CSI S` without a per-terminal strategy loses rows.
3. `2J`/`3J` clears push or delete the user's history.
4. Row maths go stale after a resize because the terminal reflows behind you: debounce, re-anchor, never reflow mid-stream.
5. The Windows bottom-right cell auto-scroll.
6. Windows input gaps: no paste markers before Node 22.17; Shift+Enter = Enter on Windows Terminal 1.24 and VS Code.
7. Not restoring terminal state on every exit path (kitty pop, `CSI >4;0m`, `?2004l`, `?1004l`, `?25h`, `CSI 0 SP q`, `CSI r`), or leaving terminal replies unread at exit.
8. Parsing terminal replies or pasted text as keystrokes.
9. Unicode width disagreements; untrusted output carrying control sequences.
10. Unbounded work: re-rendering per delta, unthrottled frames, unbounded tool output, rendered strings kept for the whole transcript.

Sources: [microsoft/terminal#18826](https://github.com/microsoft/terminal/pull/18826) · [nodejs/node#58358](https://github.com/nodejs/node/pull/58358) · [Codex scrollback.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/tui/scrollback.rs) · [Codex insert_history.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/insert_history.rs) · [Codex markdown_stream.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/markdown_stream.rs) · [pi tui-main-screen.ts](https://github.com/earendil-works/pi/blob/main/packages/tui/src/tui-main-screen.ts) · [pi terminal.ts](https://github.com/earendil-works/pi/blob/main/packages/tui/src/terminal.ts) · [Ink ink.tsx](https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx) · [xterm-headless typings](https://github.com/xtermjs/xterm.js/blob/6.0.0/typings/xterm-headless.d.ts) · [Claude Code #769](https://github.com/anthropics/claude-code/issues/769)
