# Research: the official Codex TUI and the app-server protocol

Collected 2026-10-04 for the `ad` terminal UI ([plan](../plans/ad-tui.md)). Pinned engine: `@openai/codex` 0.159.2; npm `latest` is 0.160.0 (2026-10-01). Source paths are relative to `openai/codex` at tag `rust-v0.160.0`. Items marked *(local)* were checked against the pinned binary on this machine; *(unverified)* means the source didn't settle it.

## Versions and cadence

- Stable releases land every 1–3 days (0.155.1 on 09-18 → 0.160.0 on 10-01). Alphas run ahead (0.162.0-alpha.12 on 10-04).
- 0.159.2 → 0.160.0: **no protocol change**. The whole `codex-rs/app-server-protocol` crate, `app-server-client`, the TUI terminal layer, `slash_command.rs`, `footer.rs` and `approval_overlay.rs` are byte-identical between the two tags. 0.159.3 only adds account-security reminders; 0.160.0 changes are TUI-side (queued input survives reconnect, projectless sessions, Windows console fixes).
- Coming on `main` (unreleased): `thread/prediction/*`, `thread/attachmentOwner/list`, an `origin` field on goal set/clear, an open-ended `CodexErrorInfo` fallback, and the **removal** of `ModelProviderCapabilitiesReadResponse.namespaceTools` from a non-experimental type.

## How the official TUI is built (`codex-rs/tui`, ratatui + crossterm)

**It is an app-server client.** The `tui_app_server` feature is `removed` (always on) *(local: `codex features list`)*. `AppServerTarget` picks one of:

| Target | How | Notes |
|---|---|---|
| Embedded | in-process client, typed channels | fallback |
| LocalDaemon | shared background app-server over a socket scoped to `CODEX_HOME` | `daemon_auto_start` is stable and on; `--no-daemon` opts out; on Windows needs a non-elevated terminal and a socket path ≤ 108 bytes |
| Remote | `codex --remote ws://… \| wss://… \| unix://PATH` *(local)* | auth via `--remote-auth-token-env`; the TUI identifies as `codex-tui` with `experimentalApi: true` |

`codex app-server --listen` accepts `stdio://` (default), `unix://[PATH]` (WebSocket over a Unix socket), `ws://IP:PORT` ("experimental and unsupported", token or signed-JWT auth) and `off` *(local)*.

**Module map:**
- `app.rs` + `app/`: run loop, exhaustive `AppEvent` router, per-thread routing with buffering and replay, reconnect (uncertain submissions are reconciled before the unsent queue is resent).
- `chatwidget.rs`: turns protocol events into `HistoryCell`s. One mutable `active_cell` (a coalesced exec/tool group) plus committed cells. `streaming/controller.rs` splits streamed markdown into a stable, committed prefix and a mutable tail.
- `bottom_pane/`: `ChatComposer` (13k lines: textarea, vim mode, paste-burst detection) plus a stack of popups/modals (command popup, mentions, file search, approval overlay, request-user-input, MCP elicitation, footer, shortcut overlay, pending-input preview).
- Rendering: `history_cell/`, `exec_cell/`, `diff_render.rs`, `markdown_render.rs` (pulldown-cmark incl. tables and task lists), `render/highlight.rs` (syntect).
- Terminal layer: `tui.rs`, `custom_terminal.rs` (forked ratatui terminal with an inline viewport), `insert_history.rs`, `tui/{scrollback,alternate_screen,keyboard_modes,size_monitor,windows_console,tmux}.rs`.
- `file_search.rs` calls the local file-search crate directly; an RPC client must use `fuzzyFileSearch` instead.

## Two render modes

- **Fullscreen ("owned transcript") is the default** (`tui.fullscreen_transcript = true`). The TUI holds the alternate screen for the whole session and draws its own scrollable, selectable, searchable transcript with mouse capture.
- **Scrollback (inline)** with `--no-alt-screen` *(local)*, `tui.alternate_screen = "never"` or `/tui`: the normal screen with a bottom viewport; finished history goes into the terminal's own scrollback.

**Inline history insertion** (`insert_history.rs`), all inside one synchronized update (`ESC[?2026h` … `ESC[?2026l`):
1. If the viewport isn't at the screen bottom: set `ESC[{top+1};{H}r`, move to the viewport top, send `ESC M` (reverse index) n times to push the viewport down, then reset with `ESC[r`.
2. Set `ESC[1;{viewport_top}r`, put the cursor on the region's last row and, per pre-wrapped line, write `\r\n` + SGR spans + OSC 8 links + `ESC[K`.
3. `ESC[r`, restore the cursor.

Per-terminal strategies (`tui/scrollback.rs`):
- **Windows Terminal (`WT_SESSION`) discards rows scrolled out of a partial DECSTBM region** instead of moving them to scrollback, so Codex clears the viewport and scrolls the whole screen with `\r\n` there.
- Zellij uses `scroll_region_up`.
- Never grow the viewport with `CSI S` (drops rows in xterm.js).

**Resize:** history cells are the source of truth. On a width change the TUI clears what it wrote and re-emits it at the new width, capped per terminal; streaming cells get one final rebuild once settled.

## Terminal modes it sets

- Raw mode and bracketed paste (`?2004h`).
- Kitty keyboard enhancement: `CSI > flags u` with DISAMBIGUATE_ESCAPE_CODES | REPORT_ALTERNATE_KEYS (event types except on Ghostty, iTerm2, and tmux without csi-u). Opt-out: `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT`.
- Focus events (`?1004h`): not on Windows.
- Mouse capture only on the alternate screen: `?1000h ?1002h ?1003h ?1006h` and `?1007l`; without capture, `?1007h` so the wheel arrives as arrow keys.
- **Exit and crash must restore everything:** pop keyboard flags, `ESC[<u`, `ESC[>4;0m`, `?1000l ?1002l ?1003l ?1006l`, `?2004l`, `?1004l`, leave the alternate screen, show the cursor. Upstream still has open bugs about mouse reports leaking into the shell after quit.
- Windows: enables VT processing on output, **clears `ENABLE_VIRTUAL_TERMINAL_INPUT`** so crossterm reads console input records, routes mouse through ConPTY with `?1006h`, detects unbracketed paste bursts, and probes colours without eating typeahead.

## UX parity checklist

**Header:** `OpenAI Codex (vX)`, `model: <model> <effort>`, `directory: <cwd>`, then a short "try one of these commands" list. **Composer:** prompt `› `, placeholder "Ask Codex to do anything", idle footer `? for shortcuts · 100% context left`.

**Keys** (from the `?` overlay):

| Key | Action |
|---|---|
| `/` · `@` · `!` | commands · mention files · shell command |
| `shift+enter` (or `ctrl+j`) | newline |
| `ctrl+v` · `ctrl+g` · `ctrl+r` | paste image · external editor · search history |
| `esc` idle / `esc esc` running | edit last message (backtrack) |
| `tab` | send (idle) / queue (running) |
| `enter` while running | **steer** the running turn (`turn/steer`) |
| `ctrl+c` | interrupt when running; quit when idle (press twice) |
| `ctrl+t` · `f3` · `pgup/pgdn` · `ctrl+home/end` | transcript · find · scroll · top/latest |

Ctrl+C goes to the active popup first, then history search, then interrupt/quit.

**While a turn runs:** status row `Working (12s • esc to interrupt)`; the current reasoning-summary heading replaces "Working". Steered text shows as "Messages to be submitted after next tool call". **Backtrack** (Esc Esc): pick a previous prompt with ←/→; Enter calls `thread/revert` to that turn and puts the prompt back in the composer.

**Slash commands** (popup order): model, ide, permissions, keymap, vim, setup-default-sandbox, experimental, approve, memories, skills, import, hooks, review, rename, new, archive, delete, resume, fork, worktree, app, init, compact, recap, plan, voice, goal, agents, side/btw, copy, export, raw, tui, diff, mention, status, daemon, warnings, cd, pwd, usage, debug-config, title, statusline, theme, pets, mcp, apps, plugins, logout, quit/exit, feedback, ps, stop, clear, subagents. Some are behind feature gates.

**Approval modal (exec):**
```
Would you like to run the following command?
Reason: …
$ cmd
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `…` (p)
  3. No, and tell Codex what to do differently (esc)
```
Patch: "Would you like to make the following edits?" with (y) / (a) for these files / (esc). Wire decisions: `accept | acceptForSession | acceptWithExecpolicyAmendment | applyNetworkPolicyAmendment | decline | cancel`. Afterwards a history line `✔`/`✗` names the actor ("You" or "Auto-reviewer").

**Transcript cells:**
- Reads/lists/searches group into `• Exploring` → `• Explored` with `└ Read a.txt, b.txt` rows.
- Other commands: `• Running` → `• Ran <cmd>`, `Failed (exit N)`, output preview under `└`, or `(no output)`.
- Plan: `• Updated Plan · 1/4 complete` with `✔`/`□` items.
- Patches: `• Edited N files (+A -R)` with a line-number gutter, `+`/`-` signs, syntax highlighting.
- MCP: `• Called server.tool(…)`. Web search: `• Searched the web for …`.

**Notifications:** OSC 9 (`ESC]9;msg BEL`) on Ghostty/iTerm2/Kitty/Warp/WezTerm, BEL elsewhere including Windows Terminal.

**Theme rules** (`codex-rs/tui/styles.md`): default foreground for most text, an accent for active controls, green = success/additions, red = errors/deletions, magenta = the agent, `dim` for secondary text, never hard-coded white.

## Protocol surface (identical in 0.159.2 and 0.160.0)

171 client requests, 11 server requests, 85 notifications. Split by stability *(local: `generate-ts` with and without `--experimental`)*:

- **Stable and useful for a TUI:** `thread/start|resume|fork|read|list|loaded/list|archive|unarchive|delete|unsubscribe|name/set|metadata/update|revert|compact/start|shellCommand|inject_items|turns/list|items/list|goal/*`, `turn/start|steer|interrupt`, `review/start`, `model/list`, `config/read|value/write|batchWrite`, `skills/list`, `hooks/list`, `mcpServerStatus/list`, `account/*`, `command/exec*`, `fs/*`, `fuzzyFileSearch` (one-shot), `gitDiffToRemote`, `feedback/upload`, `windowsSandbox/*`.
- **Experimental only:** `thread/queue/*`, `thread/search`, `thread/settings/update`, `turn/settings/update`, `thread/backgroundTerminals/*`, `fuzzyFileSearch/session*`, `memory/*`, `process/*`, `thread/realtime/*`, `collaborationMode/list`, `project/*`. On `thread/start`, `dynamicTools` (client-provided tools) is experimental; on `turn/start`, `additionalContext` is experimental. `developerInstructions` is stable.
- **Server → client requests:** command / file-change / permissions approvals, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, plus legacy v1 approvals.
- **Notifications a TUI needs:** `thread/started|status/changed|compacted|tokenUsage/updated`, `turn/started|completed|diff/updated|plan/updated`, `item/started|completed`, deltas (`item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta|summaryPartAdded|textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`), `serverRequest/resolved`, `warning`, `configWarning`, `deprecationNotice`, `error`, `model/rerouted`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated`, `hook/started|completed`.
- **ThreadItem types (19):** userMessage, hookPrompt, agentMessage, functionCallOutput, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction.
- `turn/start` input kinds: `text | image | localImage | audio | localAudio | skill | mention`. `turn/steer` needs `expectedTurnId`, takes no overrides and emits no `turn/started`. `thread/rollback` is gone; use `thread/revert {threadId, beforeTurnId}`.

## Stability policy (or the lack of one)

- v1 is frozen; all new surface goes into v2. Experimental surface is gated per field/method by `experimentalApi`; without the opt-in the server rejects the call.
- **No protocol changelog and no semver.** Removals happen without a deprecation window (`thread/rollback`, soon `namespaceTools`). The public docs at developers.openai.com/codex/app-server lag the code.
- Bindings: `codex app-server generate-ts --out DIR [--experimental]` and `generate-json-schema --out DIR [--experimental]` emit exactly the running version's protocol. Upstream checks the generated schema into `schema/`.
- Other clients: `@openai/codex-sdk` pins Codex exactly; `@agentclientprotocol/codex-acp` vendors `generate-ts` output but floats on `^0.159.1`; Zed's Rust `codex-acp` linked Codex crates directly and is archived.

## Pitfalls to design around

1. Unknown item types, notifications and error codes must render through a generic fallback, never crash.
2. `thread/list` filters to the default model provider unless `modelProviders` is passed (open upstream bug).
3. Never block the JSON-RPC reader; drain notifications while awaiting responses.
4. Session metadata can arrive after the `thread/start` response.
5. Things the official TUI does locally that an RPC client must do itself: `@` file search (`fuzzyFileSearch`), git diff, clipboard image paste (send `localImage`), external editor, notifications.
6. Launching the official `codex` against our harness home may auto-start a shared daemon there: pass `--no-daemon` unless we want that.
7. Windows: no kitty keyboard protocol in conhost (offer Ctrl+J for newline), no reliable focus events, unbracketed paste bursts, AF_UNIX path ≤ 108 bytes.

Sources: [releases](https://github.com/openai/codex/releases) · [source at rust-v0.160.0](https://github.com/openai/codex/tree/rust-v0.160.0) · [app-server docs](https://developers.openai.com/codex/app-server) · [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)
