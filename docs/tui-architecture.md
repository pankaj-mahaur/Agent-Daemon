# How `ad tui` is built

This is the design of the terminal UI: how it is layered, why it is built this way, how it stays working across engine releases, and the safety model behind `/undo`. For using it, read [tui.md](tui.md). For the engine underneath, read [harness-design.md](harness-design.md). For the tests, read [testing.md](testing.md).

## Goals

- **The engine's reflexes.** Typing `ad` should feel like the engine's own terminal UI: the same keys, approvals, slash commands, and history in the terminal's own scrollback.
- **agent-daemon's extras, visible.** Memory you can see ("Learned:" rows, `/memory`), `/undo` for the files a turn changed, background `/loop`s, schedules and teams.
- **Survive engine releases.** The engine ships several releases a week, with no protocol changelog and no deprecation window. An unknown event must never crash the UI; at worst it shows as a plain row.
- **Never touch the user's own install.** A separate pinned copy of the engine, in ad's own home (see [harness-design.md](harness-design.md#isolation)).
- **Zero runtime dependencies** for the UI itself (Node built-ins only).

## Layers

```
runtime/src/cli.mjs            thin launcher: routes `ad tui` / bare `ad` before loading the full CLI
runtime/src/tui/
  main.mjs                     cmdTui: preflight, engine start, sign-in and trust prompts, header, wiring
  app.mjs                      the app: what is committed to scrollback, what is live, keys, slash commands
  keymap.mjs                   keys as the engine's actions (the engine's names and key spelling; tui.keymap read), chords, the leader
  status.mjs                   the status line and the window title, by the engine's item ids
  prefs.mjs                    settings: the engine's tui.* in its config.toml, ad's in prefs.json
  screen-mode.mjs              inline or fullscreen, and the mouse default, from the flag, settings and terminal (pure)
  accounts.mjs                 what /model, /account, /login and /logout need over the account list and the engines
  fallback-editor.mjs          /fallback: the order's editor (pure state and keys; the app draws it)
  home-launcher.mjs            "Pick a project folder", before the engine starts in a home folder
  history.mjs                  the prompt history (history.jsonl)
  upstream-commands.json       the engine's slash commands and their rules at the pin (generated, in engine/codex/)
  ad-layer.mjs                 ad's own capabilities: memory, learned rows, /loop, /team, /schedule, proposals
  undo.mjs                     checkpoint wiring for /undo (hooks on the session)
  commands.mjs                 /mcp, /hooks, /skills, /usage, /export, clipboard, image paths, terminal setup
  flip.mjs, preflight.mjs      when bare `ad` opens the TUI; whether this terminal can run it
  recap.mjs                    /recap: the engine's prompt, the conversation it reads (the engine's byte budget), the strict parse
  view/                        pure renderers: composer, markdown, cells (items), chrome (header/footer, picker,
                               checklist), modals (the engine's requests, ad's confirm, choices), theme (every colour),
                               highlight (the syntax lexer, one table per language), vim (the engine's Vim mode)
  terminal/                    io (raw mode, input decoding, handoff), renderer (inline frames), width, sanitize;
                               fullscreen (the alternate-screen renderer), alt-screen (its guard), transcript (the
                               re-wrapping buffer), selection, find, clipboard, detect (what the terminal is)
runtime/src/harness/
  session.mjs                  the session controller: one thread, turns, queue/steer, approvals, items, restarts
  checkpoints.mjs              git-tree snapshots, plan and restore for /undo
  sandbox.mjs                  Windows sandbox setup and readiness (`ad sandbox`, /setup-default-sandbox)
runtime/src/engine/
  index.mjs                    the engine: threads, turns, subagent routing, structuredRequest (temporary threads)
runtime/src/engine/codex/
  app-server.mjs               JSON-RPC client for the pinned app-server
  events.mjs                   protocol → normalized events and items (the only place that knows the wire shapes)
  surface.mjs                  the stable surface ad uses, and the experimental allowlist (ad tui only)
  protocol-snapshot.*          the pinned protocol, generated: requests are checked against it in the tests
  home.mjs                     ad's isolated engine home and the engine's environment
```

The rule between layers: **only `engine/codex/` knows the engine's protocol.** Everything above sees normalized events (`turn.started`, `item.completed`, `request.opened`, …) and normalized items (`kind: "agentMessage" | "commandExecution" | "fileChange" | …`). A protocol change is absorbed in one place.

### The session controller

`harness/session.mjs` owns one conversation on one engine:

- **Turns.** `submit()` starts a turn, or steers the running one, or queues; `interrupt()`; an epoch counter drops results from a turn or thread the session has already left.
- **Items.** A map of everything the engine reported, keyed per turn: some providers reuse item ids across turns (`msg-1`, `call_0`), so a later turn's item gets its own key and never merges into, or hides behind, an earlier one.
- **Requests.** Approvals, permission requests, user input and MCP elicitations land in `state.requests`; the app answers them with the options the engine offered.
- **Diagnostics.** Engine errors and warning/config/deprecation notices use the façade's messages. Their raw details stay separate from live rendering and appear only in `/warnings`, sanitized and limited to eight lines per entry. Session notices and command errors each retain at most 50 entries; `/warnings` shows the newest 20, including detail-bearing side-conversation notices preserved when the side closes.
- **Recovery.** If the engine exits, the controller restarts it (a bounded budget), resumes the thread, and settles every item that was in flight.
- **Hooks.** `beforeTurn`, `turnStarted`, `turnStartFailed`, `itemStarted`, `itemCompleted`, `turnCompleted`: how `/undo` and the learned rows plug in without the controller knowing about them.
- **Locks.** A thread open in one `ad tui` is locked (heartbeat file) so a second window can't drive it at the same time.
- **Modes.** The engine's collaboration modes (plan mode): the presets the engine lists, and the mode's mask on each turn (the experimental allowlist).
- **Background terminals.** A command still running after its turn (the engine's unified exec) is tracked by the engine's `processId`; `stopTerminals()` ends them all.
- **The folder.** `state.config.cwd` is mutable: `changeDir()` forks the conversation into the new folder (`/cd`).
- **Side conversations.** `openSide()` forks an ephemeral, read-only thread and returns a second session on the same engine: no requests, no lock, ad's hooks off.
- **Subagents and denials.** `state.agents` (first seen, running, closed) for `/subagents`; `state.denials` (the engine's auto-review denials, the last 10) for `/approve`, sent back as the engine's core event.
- **Identity.** The agent learns who it is from the identity block: on a managed engine home it is the first line of the managed instructions block in `<home>/AGENTS.md`; on a home ad didn't create, the TUI injects it as a developer message into each new thread.

### The renderer: inline or fullscreen

Two renderers share one interface (`start`, `frame`, `commit`, `suspend`, `resume`, `redraw`, `clear`, `onResize`, `dispose`); the app doesn't know which one it has. Inline is the default. Fullscreen runs when the engine's settings say `[tui] fullscreen_transcript = true` in a layer the user set (`screen-mode.mjs`; the engine's packaged default doesn't count).

**Inline.** The UI draws like the engine's default mode: finished output is written into the terminal's own scrollback (so it scrolls, searches and copies like any terminal output), and only a small live region at the bottom is redrawn.

- **The prompt at the bottom.** The live region ends on the screen's last row from the start (ad's choice; the engine's inline mode lets it follow the transcript, which `"prompt.atBottom": false` brings back). Committed lines fill the blank rows above it from the top, then scroll as usual. The renderer counts those blank rows as a lower bound: after a width change, which may reflow history into them, it counts none, so it never writes over history.
- **Committed vs live.** An item is committed once it can no longer change (a finished command, a closed message). A streaming answer commits line by line as newlines arrive; only the unfinished tail stays live. Committed lines are never repainted.
- **Markdown streams safely.** The rendering of the committed lines plus the live tail always equals the rendering of the text so far; tables and an open code fence stay live until complete.
- **Resizes.** Terminals reflow scrollback behind the program's back. The renderer debounces, re-anchors with a cursor-position query, and never reflows text that has already been committed.
- **One exception to "history is never erased": `/clear`.** The engine's `/clear` wipes the screen and the scrollback (`ESC[2J ESC[3J`, the engine's own bytes); the renderer's `clear()` drops whatever was pending (queued history, a resize wait, a re-anchor waiting for its cursor report) and starts over with the header.
- **Colours** come from one module (`view/theme.mjs`); a golden keeps every span's style, so a colour can't change unnoticed.
- **The status line and the window title** are computed from the engine's item ids (`status.mjs`), from 12 rows. The title is written with OSC 0, at most 4 times a second, only when it changes; the terminal's own title is saved (XTWINOPS 22) and put back (23) on exit and around handoffs, and nothing is written while another program has the terminal. Every value passes `titleSafe` (no escapes, line breaks or invisible format characters).
- **Untrusted text is sanitized.** Model output and command output can carry escape sequences; they are shown as visible `<U+…>` forms, never sent to the terminal.

**Fullscreen** (`terminal/fullscreen.mjs`). ad takes the alternate screen, as the engine's fullscreen mode and Claude Code do: the shell's earlier output is hidden while ad runs and comes back exactly as it was on exit.

- **The guard** (`terminal/alt-screen.mjs`) is one state per process, marked active *before* `?1049h` is written, so a signal that lands mid-write still finds something to undo. `io.restore()` (every exit path: exit, signals, an uncaught error or rejection), `handoff()` and `suspend()` release it first: `?2026l`, mouse off, the alternate screen's keyboard pop, then `?1049l`. Release is synchronous, idempotent and never throws.
- **The write gate.** Every write goes through `io.writeSync` (synchronous, so a frame can never land after the leave bytes) and through `writable()`: nothing is written while suspended, while a resize settles, after dispose, or once the guard was released by a crash path. A blocked draw marks the screen dirty and the next one repaints it whole.
- **The transcript buffer** (`terminal/transcript.mjs`) keeps committed entries as render functions over the width (or fixed lines, re-wrapped), so a resize re-wraps history. Layout is lazy from the bottom (a resize renders about two screens, not the whole history); past 5,000 entries the oldest tenth goes behind a "trimmed" line. The app commits cells as functions over a **commit-time snapshot** (`commitView`), never a live item, so a resize can't rewrite history; a streamed answer's pieces are swapped for one entry when it completes (`settle`).
- **Drawing.** History fills from the top, the live region sits on the bottom rows. Only changed rows are rewritten, one write per frame inside `?2026`, autowrap off; an idle frame writes nothing. `clear()` uses `2J` (the alternate screen only) and **never `3J`**, which would wipe the shell's scrollback.
- **stderr** written while fullscreen would land on the frame: it is held, noted once in the window, and printed when ad leaves the alternate screen.
- **Start-up.** `prefs.json` caches `screen.lastMode`. When the last run was fullscreen, ad starts on the alternate screen at once (nothing touches the shell's screen); otherwise it boots inline and swaps just before the app appears, after draining the inline erase.
- **Scrolling** (P2.2). The transcript keeps a view anchor (an entry and a row in it), so new output never moves a scrolled view; while scrolled, its last row is the follow control (the engine's texts). PageUp/PageDown use the pager bindings' steps, Ctrl+Home/Ctrl+End (also Alt+< / Alt+>, and Alt+Shift+, / Alt+Shift+. under CSI-u) jump, matched with exact modifiers before the effort keys. The wheel moves `tui.mouse_scroll_speed` rows per notch with a fractional carry reset on a direction change. Mouse events are decoded from SGR reports only; a legacy X10 report is dropped by byte count, never typed.
- **Selecting, copying, Find** (P2.3). `wrap()` marks soft-wrapped rows with how they join the row before (a non-enumerable `cont`; `withPrefix` keeps it), so a copy or a Find sees the wrapped text as the line it was. `selection.mjs` holds the model (click count, word and line units, the copied text); a selection holds the view while output arrives. `clipboard.mjs` copies through the native tool first (killed after 2 s), adds tmux's buffer or OSC 52 inside tmux and over SSH, and writes OSC 52 only as a fallback. `find.mjs` searches each entry's copy text, literal and case-insensitive, newest first, 200 entries per tick. Highlights reach the renderer as `setMarks(ref → ranges)` and are drawn with `restyle()` and the theme's `selection`, `findMatch` and `findCurrent` tokens.
- **Which mode** (P2.5): `resolveScreenMode` in `screen-mode.mjs`, fed by `--no-alt-screen`, the engine's `tui.alternate_screen` and `tui.fullscreen_transcript` (only a value the user set), Apple Terminal over SSH (DA1 `1;2` and DA2 `1;95;0`, DA2 asked only over SSH outside a multiplexer) and tmux's `#{mouse}` (one probe, 1 s). Its reason ids become the `/status` screen line. `/tui` writes `tui.fullscreen_transcript`.
- **The mouse** is captured (`?1000h ?1002h ?1006h`, no any-motion) where reports reach ad: Windows Terminal and Zed were probed; the legacy console host is off (QuickEdit can't be turned off); `"screen.mouse": false` in `prefs.json` turns it off anywhere.

### Keys and terminals

Key chords (`"ctrl-x ctrl-s"`, `"leader c"`) are matched before every layer by `keymap.chords().feed(ev, contexts, now)` (`tui/keymap.mjs`). The result is pass, pending (the footer shows the hint), cancelled, or done. A done chord becomes a synthetic `{type: "chord", ctx, action}` event, routed through `onInput` like a key, and `keymap.is()` answers it, so no call site changes. The contexts are `[]` under a modal, ad's confirm or the key inspector.

- Input is decoded from raw bytes (keys, bracketed paste, terminal replies), so a reply to a query or a pasted text is never taken for keystrokes.
- On Windows, Node 22.17+ (or 24.2+) is needed for bracketed paste in raw mode; `preflight.mjs` says so instead of misbehaving.
- Shift+Enter isn't distinguishable from Enter in some terminals; Ctrl+J always inserts a newline, and `/terminal-setup` explains the per-terminal fix.
- Every exit path restores the terminal (modes, cursor, colours), including a crash.
- Terminal replies (OSC, DCS, APC strings) are recognised anywhere in the input and dropped; Alt+], Alt+Shift+P and Alt+_ still type.
- **Keys are the engine's actions** (`tui/keymap.mjs`): the engine's contexts, action names and key spelling, so `tui.keymap` (set in the engine's settings file) means the same in ad. ad reads it and never writes it; a key it can't use (a clash, one of the prompt's editing keys, a chord the engine refuses) is skipped, summed up in one `/warnings` line and listed by `/keymap`.
- **The topmost layer takes the key.** Tested cell by cell (`test/tui-app.test.mjs`, "key routing table"):

| Layer | Esc | Ctrl+C | Tab | Shift+Tab | Enter |
|---|---|---|---|---|---|
| the engine's approval or question | declines | declines | — | — | the focused choice, once armed |
| ad's confirm | no | no | — | — | the focused choice, once armed |
| Ctrl+T pager | closes | closes | — | — | — |
| `?` shortcuts | closes | closes | closes, then acts | closes, then acts | closes, then acts |
| command or file popup | closes | closes | fills in | — | runs or inserts |
| checklist | cancels (undoes the preview) | cancels | — | — | saves |
| Find editing (fullscreen) | cancels: the view goes back | cancels | — | — | keeps the match in view |
| Find reading (fullscreen) | back to the bottom | as below | as below | as below | nothing, on an empty prompt |
| selection (fullscreen) | clears (never interrupts) | copies (never arms quit) | clears, then acts | clears, then acts | copies, back to the bottom |
| transcript scrolled up (fullscreen) | back to the bottom (the next Esc goes on down) | as below | as below | as below | back to the bottom, on an empty prompt |
| composer, turn running | interrupts | clears the draft, then interrupts | queues | — (never queues) | steers |
| composer, idle | rewind (twice, on an empty prompt) | clears the draft, then arms quit | pulls back a queued prompt | — | sends |

### Handoffs

The external editor (Ctrl+G) and `/login` hand the terminal to a child process: input is detached, modes restored, and everything re-entered afterwards. SIGINT/SIGBREAK during (and briefly after) a handoff belong to the child.

In fullscreen (P2.4) there are two kinds. The editor is a **keep-screen** handoff: ad leaves its screen (mouse off, its keyboard push popped), io restores the main screen's modes, then the renderer `freeze()`s: back on the alternate screen with the last frame but with no keyboard push and no mouse, so a GUI editor leaves ad visible; `unfreeze()` leaves it again before io re-applies the main modes, so every screen's keyboard stack ends where it began. `/login` and `/ad <command>` are **restore** handoffs: the child runs on the main screen, so its output stays in the shell's scrollback, and "Press Enter to return to ad." waits after `/ad` and after a failed `/login`. Nothing is written while frozen (commits, frames, resizes and OSC 52 are kept for the repaint). If io was restored during a handoff (a signal), the renderer stays out. Ctrl+Z (POSIX) leaves ad's screen and stops; on SIGCONT io cycles raw mode and the renderer repaints.

## Staying working across engine releases

- **Pinned engine.** `@openai/codex` is pinned exactly in `runtime/package.json`; the TUI only talks to that binary.
- **Stable protocol surface, plus an allowlist.** No experimental methods or fields, except the allowlist `ad tui` opts into (`EXPERIMENTAL_ALLOWLIST`: the engine's collaboration modes for plan mode, `thread/backgroundTerminals/clean`); every other experimental notification is opted out at `initialize`. The session asks for the mode presets at start and after a restart, and every `turn/start` carries the mode's mask from one place (`startTurn`), so submit, the queue, a steer that falls back and the re-send after a restart all agree.
- **Snapshot + checks.** A committed protocol snapshot (`engine/codex/protocol-snapshot.json`) records every method and notification the client relies on; the test suite checks the fake server's messages against it.
- **Generic fallbacks.** An unknown item type renders as a plain row; an unknown notification is ignored; an unknown request is declined with a note.
- **Weekly upgrade PR.** The `engine-upgrade` workflow bumps the pin, diffs the protocol (removals flagged as breaking), regenerates the engine's slash-command names, and runs the suite and the live TUI tests on the real binary in its own Linux job before opening the PR. The PR's own CI on Linux, macOS and Windows runs only when the repo has an `ENGINE_UPGRADE_TOKEN` secret (the old `CODEX_UPGRADE_TOKEN` also works) ([testing.md](testing.md#ci)).
- **Slash commands.** `engine/codex/upstream-commands.json` is generated from the engine's own source at the pin (`scripts/codex-slash.mjs`) and reached through the façade as `engineCommands`: every command with its aliases, whether it runs during a task, whether it works in a side conversation, and whether the popup hides it. ad's own commands must never take an upstream name, and every upstream command is either run by ad (with upstream's rules) or listed in `NOT_IN_AD` with what ad says instead; an upstream command is never sent to the model. A command the engine adds fails a test in the upgrade PR until ad decides.
- **Requests checked both ways.** The fake app-server rejects any request of ad's that the pinned stable protocol doesn't accept (an unknown method or field, a wrong type); `SENT_METHODS` lists every method ad sends, checked against the source. Experimental calls must be on `EXPERIMENTAL_ALLOWLIST` (`engine/codex/surface.mjs`), and the fake refuses them without the opt-in.

## `/undo`: the safety model

`/undo` puts back the files the last turn's edits changed and rewinds the conversation. Its one hard rule: **plain `/undo` never destroys or reverts the user's own work. When in doubt, it refuses; it never guesses.** Only `/undo force`, typed on purpose after a refusal, discards changes made after the agent's edit to a file the agent edited.

### Snapshots

- In a git repo, ad snapshots the working folder as git **trees** in a private index (`.git/ad-checkpoint-index`) and keeps them under `refs/ad/checkpoints/<thread>/`. The user's index, HEAD, branches and stash are never touched; restores run on a scratch index, so the user's `.git/index.lock` is never taken.
- Untracked files over 2 MB, heavy folders (`node_modules`, `dist`, `build`, `target`, …), ignored files and ad's own `.agent-daemon/` are never snapshotted.
- **"Before"** is taken when the prompt is sent, and the turn starts only after it is done (up to 10 s), so nothing the agent does can be in it. **"After"** is taken once the turn has ended.
- Every snapshot, comparison and restore runs with eol conversion off, so restores are byte for byte (git 2.40+ also ignores `.gitattributes` there).

### What counts as the agent's change

- Only the paths named by the turn's **applied** `fileChange` items (a declined patch isn't the agent's change). Paths are resolved to real paths, so an 8.3 short name, a junction or a `subst` drive still match git's view of the repo.
- Each applied edit is hashed the moment it completes, and its own diff lines are recorded.
- **The chain check.** For every edit, in order, the lines that changed from the previous version of the file (the "before" snapshot for the first edit, the previous edit's result after that; moves included) must all be lines of that edit's own diff. Any other line means someone else changed the file during the turn: the user's save, a formatter, a command. That file is the conflict `changed during the turn`, and `/undo` won't touch it. Comparing lines (not totals) matters: a summed count let an agent's own add-then-remove of a debug line hide a user's change, and equal counts let a user's `B → X` hide beside the agent's `A → B`.

### Conflicts

| Conflict | Means | `force` |
|---|---|---|
| `not changed by the agent's edits` | the file changed during the turn some other way | never |
| `changed during the turn` | more changed than the agent's edits account for (a save of the user's before or between them) | never |
| `changed since the agent's edit` | the file changed after the agent's last edit to it | puts it back |
| `changed since the turn` | (when no per-edit hashes exist) the file changed after the turn | puts it back |
| `a folder is there now` | a folder stands where the file was | reported, never removed |
| `a file is where its folder was` | a file or symlink stands where one of its folders was | never |
| `not in the checkpoint` | snapshots never held it (too big, heavy folder, ignored, moved in from outside the repo) | never |

With any conflict, plain `/undo` undoes nothing. `/undo force` overrides only the two "changed since…" kinds, and the force hint appears only when force can act. Forced, the turn is undone except for the files with any other conflict: those are left alone and counted as "left alone (not the agent's edit, changed during the turn, not in the checkpoint, or a folder or file stands in the way)", and a folder is never removed or replaced.

### Known limits

- Ignored files, submodule contents and LFS files are not restored.
- A turn gets no checkpoint when the "before" snapshot isn't done within 10 s, when a snapshot fails (before or after the turn), when a turn is started by the engine itself (a review, a goal), or when an edit's result can't be read.
- Rare refusals (never wrong restores): two equally small diffs that name different lines (a swap), an Add File over an existing file, two edits to one file landing before the first is hashed.

## Testing

Each layer is tested where it is cheapest, and the whole is tested live. Details: [testing.md](testing.md).

- Pure units: width tables, sanitizing, markdown (property: streamed equals full), input decoding.
- Golden screens at 40, 80 and 120 columns through `@xterm/headless`.
- The app against a fake app-server (`runtime/testkit/fake-codex-app-server.mjs`), whose messages are checked against the protocol snapshot.
- `/undo` against real temporary git repos, including adversarial cases (mid-turn saves, moves, binary files, CRLF, 8.3 paths).
- Fullscreen: the guard, transcript, selection, Find, clipboard and screen-mode rules as units; the app in fullscreen on the fake app-server; and in a real pseudo-terminal (`test/tui-pty-smoke.test.mjs`), each crash path leaving the alternate screen, the editor handoff, and Ctrl+Z under bash job control (POSIX).
- **Live:** `runtime/test/tui-live.test.mjs` runs the real `ad tui` in a real pseudo-terminal (ConPTY on Windows) on the real pinned engine with a mock model: the terminal UI script of the manual test (section 6) and ad's own TUI features, on Linux, macOS and Windows in CI's non-blocking real-engine job.
- Guards that matter are mutation-checked: each is broken on purpose and a test must fail.

## Decisions and their reasons

| Decision | Why |
|---|---|
| Own zero-dependency renderer | Ink and similar libraries repaint whole frames and fight inline scrollback; a small renderer that only redraws the live region is simpler to make correct on Windows. |
| Inline mode by default | Keeps the terminal's scrollback, search and copy. |
| The engine's app-server, stable surface (plus a small experimental allowlist for `ad tui`) | The engine owns the agent loop, sandbox and login; ad stays a client and survives releases. |
| Bare `ad` opens the TUI | Flipped in 2.1.0, after the manual test's terminal UI script ran green live on all three OSes. `AD_TUI=0` keeps the old help. |
| The engine's names and rules for the engine's commands, keys and settings | No surprises; settings and keys live in the engine's settings file (ad never writes `tui.keymap`). |
| `/clear` purges the scrollback | The engine's meaning; `/new` keeps it, and `clear.keepScrollback` in `prefs.json` turns the purge off. |
| `ad chat`, `ad web`, `ad acp` stay on their own turn loop | Moving them onto the session controller would change what Zed sees over ACP (one session per engine, approvals checked against offered options) for little shared code. Revisit with a multi-session design if needed. |
| Windows sandbox and Store PowerShell | The Windows sandbox can't start a Store (MSIX) app, and the engine runs commands in the first `pwsh` on PATH. On Windows, every engine spawn drops every `WindowsApps` entry from PATH (the app-alias folder and the Store package folders), so the engine uses an MSI PowerShell 7 or Windows PowerShell 5.1, inside the sandbox. |
