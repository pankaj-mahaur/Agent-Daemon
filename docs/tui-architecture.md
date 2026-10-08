# How `ad tui` is built

This is the design of the terminal UI: how it is layered, why it is built this way, how it stays working across Codex releases, and the safety model behind `/undo`. For using it, read [tui.md](tui.md). For the engine underneath, read [harness-design.md](harness-design.md). For the tests, read [testing.md](testing.md).

## Goals

- **Codex's reflexes.** Typing `ad` should feel like the OpenAI Codex CLI: the same keys, approvals, slash commands, and history in the terminal's own scrollback.
- **agent-daemon's extras, visible.** Memory you can see ("Learned:" rows, `/memory`), `/undo` for the files a turn changed, background `/loop`s, schedules and teams.
- **Survive Codex releases.** Codex ships several releases a week, with no protocol changelog and no deprecation window. An unknown event must never crash the UI; at worst it shows as a plain row.
- **Never touch the user's own Codex.** A separate pinned copy of Codex, in ad's own home (see [harness-design.md](harness-design.md#isolation)).
- **Zero runtime dependencies** for the UI itself (Node built-ins only).

## Layers

```
runtime/src/cli.mjs            thin launcher: routes `ad tui` / bare `ad` / `ad codex` before loading the full CLI
runtime/src/tui/
  main.mjs                     cmdTui: preflight, engine start, sign-in and trust prompts, header, wiring
  app.mjs                      the app: what is committed to scrollback, what is live, keys, slash commands
  keymap.mjs                   keys as Codex's actions (Codex's names and key spelling; tui.keymap read)
  status.mjs                   the status line and the window title, by Codex's item ids
  prefs.mjs                    settings: Codex's tui.* in its config.toml (shared with /codex), ad's in prefs.json
  codex-slash.json             Codex's slash commands and their rules at the pin (generated)
  ad-layer.mjs                 ad's own capabilities: memory, learned rows, /loop, /team, /schedule, proposals
  undo.mjs                     checkpoint wiring for /undo (hooks on the session)
  commands.mjs                 /mcp, /hooks, /skills, /usage, /export, clipboard, image paths, terminal setup
  flip.mjs, preflight.mjs      when bare `ad` opens the TUI; whether this terminal can run it
  view/                        pure renderers: composer, markdown, cells (items), chrome (header/footer, picker,
                               checklist), modals (Codex's requests, ad's confirm), theme (every colour)
  terminal/                    io (raw mode, input decoding, handoff), renderer (inline frames), width, sanitize
runtime/src/harness/
  session.mjs                  the session controller: one thread, turns, queue/steer, approvals, items, restarts
  checkpoints.mjs              git-tree snapshots, plan and restore for /undo
runtime/src/engine/codex/
  app-server.mjs               JSON-RPC client for the pinned `codex app-server`
  events.mjs                   protocol → normalized events and items (the only place that knows the wire shapes)
  home.mjs                     ad's isolated CODEX_HOME and the engine's environment
```

The rule between layers: **only `engine/codex/` knows Codex's protocol.** Everything above sees normalized events (`turn.started`, `item.completed`, `request.opened`, …) and normalized items (`kind: "agentMessage" | "commandExecution" | "fileChange" | …`). A protocol change is absorbed in one place.

### The session controller

`harness/session.mjs` owns one conversation on one engine:

- **Turns.** `submit()` starts a turn, or steers the running one, or queues; `interrupt()`; an epoch counter drops results from a turn or thread the session has already left.
- **Items.** A map of everything Codex reported, keyed per turn: some providers reuse item ids across turns (`msg-1`, `call_0`), so a later turn's item gets its own key and never merges into, or hides behind, an earlier one.
- **Requests.** Approvals, permission requests, user input and MCP elicitations land in `state.requests`; the app answers them with the options Codex offered.
- **Recovery.** If Codex exits, the controller restarts it (a bounded budget), resumes the thread, and settles every item that was in flight.
- **Hooks.** `beforeTurn`, `turnStarted`, `turnStartFailed`, `itemStarted`, `itemCompleted`, `turnCompleted`: how `/undo` and the learned rows plug in without the controller knowing about them.
- **Locks.** A thread open in one `ad tui` is locked (heartbeat file) so a second window can't drive it at the same time.

### The renderer: inline, not fullscreen

The UI draws **inline**, like Codex's default mode: finished output is written into the terminal's own scrollback (so it scrolls, searches and copies like any terminal output), and only a small live region at the bottom is redrawn.

- **Committed vs live.** An item is committed once it can no longer change (a finished command, a closed message). A streaming answer commits line by line as newlines arrive; only the unfinished tail stays live. Committed lines are never repainted.
- **Markdown streams safely.** The rendering of the committed lines plus the live tail always equals the rendering of the text so far; tables and an open code fence stay live until complete.
- **Resizes.** Terminals reflow scrollback behind the program's back. The renderer debounces, re-anchors with a cursor-position query, and never reflows text that has already been committed.
- **One exception to "history is never erased": `/clear`.** Codex's `/clear` wipes the screen and the scrollback (`ESC[2J ESC[3J`, Codex's own bytes); the renderer's `clear()` drops whatever was pending (queued history, a resize wait, a re-anchor waiting for its cursor report) and starts over with the header.
- **Colours** come from one module (`view/theme.mjs`); a golden keeps every span's style, so a colour can't change unnoticed.
- **The status line and the window title** are computed from Codex's item ids (`status.mjs`), from 12 rows. The title is written with OSC 0, at most 4 times a second, only when it changes; the terminal's own title is saved (XTWINOPS 22) and put back (23) on exit and around handoffs, and nothing is written while another program has the terminal. Every value passes `titleSafe` (no escapes, line breaks or invisible format characters).
- **Untrusted text is sanitized.** Model output and command output can carry escape sequences; they are shown as visible `<U+…>` forms, never sent to the terminal.

Why not a fullscreen (alternate-screen) UI: it hides the terminal's own scrollback, search and copy, and it is what users of Codex's inline mode moved away from. A fullscreen mode is a possible later addition, only on demand.

### Keys and terminals

- Input is decoded from raw bytes (keys, bracketed paste, terminal replies), so a reply to a query or a pasted text is never taken for keystrokes.
- On Windows, Node 22.17+ (or 24.2+) is needed for bracketed paste in raw mode; `preflight.mjs` says so instead of misbehaving.
- Shift+Enter isn't distinguishable from Enter in some terminals; Ctrl+J always inserts a newline, and `/terminal-setup` explains the per-terminal fix.
- Every exit path restores the terminal (modes, cursor, colours), including a crash.
- Terminal replies (OSC, DCS, APC strings) are recognised anywhere in the input and dropped; Alt+], Alt+Shift+P and Alt+_ still type.
- **Keys are Codex's actions** (`tui/keymap.mjs`): Codex's contexts, action names and key spelling, so `tui.keymap` (set with the stock UI's `/keymap`) means the same in ad. ad reads it and never writes it; a key it can't use (a chord, a clash, one of the prompt's editing keys) is skipped with a note in `/warnings`.
- **The topmost layer takes the key.** Tested cell by cell (`test/tui-app.test.mjs`, "key routing table"):

| Layer | Esc | Ctrl+C | Tab | Shift+Tab | Enter |
|---|---|---|---|---|---|
| Codex's approval or question | declines | declines | — | — | the focused choice, once armed |
| ad's confirm | no | no | — | — | the focused choice, once armed |
| Ctrl+T pager | closes | closes | — | — | — |
| `?` shortcuts | closes | closes | closes, then acts | closes, then acts | closes, then acts |
| command or file popup | closes | closes | fills in | — | runs or inserts |
| checklist | cancels (undoes the preview) | cancels | — | — | saves |
| composer, turn running | interrupts | clears the draft, then interrupts | queues | — (never queues) | steers |
| composer, idle | rewind (twice, on an empty prompt) | clears the draft, then arms quit | pulls back a queued prompt | — | sends |

### Handoffs

`/codex` (the stock Codex UI on the same conversation), the external editor (Ctrl+G) and `/login` hand the terminal to a child process: input is detached, modes restored, and everything re-entered afterwards. SIGINT/SIGBREAK during (and briefly after) a handoff belong to the child.

For `/codex`, ad's own engine first unloads the conversation (`thread/unsubscribe`, then `thread/closed`; the TUI's engine runs with `thread_unload_delay_secs=0`), so only the stock UI runs it and nothing is written twice; on return ad resumes it from disk, with the turns taken there. If the unload doesn't finish in 15 s, ad restarts its engine instead.

## Staying working across Codex releases

- **Pinned engine.** `@openai/codex` is pinned exactly in `runtime/package.json`; the TUI only talks to that binary.
- **Stable protocol surface only.** No experimental methods or fields.
- **Snapshot + checks.** A committed protocol snapshot (`engine/codex/protocol-snapshot.json`) records every method and notification the client relies on; the test suite checks the fake server's messages against it.
- **Generic fallbacks.** An unknown item type renders as a plain row; an unknown notification is ignored; an unknown request is declined with a note.
- **Weekly upgrade PR.** The `codex-upgrade` workflow bumps the pin, diffs the protocol (removals flagged as breaking), regenerates Codex's slash-command names, and runs the suite and the live TUI tests on the real binary in its own Linux job before opening the PR. The PR's own CI on Linux, macOS and Windows runs only when the repo has a `CODEX_UPGRADE_TOKEN` secret ([testing.md](testing.md#ci)).
- **Slash commands.** `src/tui/codex-slash.json` is generated from Codex's own source at the pin (`scripts/codex-slash.mjs`): every command with its aliases, whether it runs during a task, whether it works in a side conversation, and whether the popup hides it. ad's own commands must never take a Codex name, and every Codex command is either run by ad (with Codex's rules) or listed in `NOT_IN_AD` with what ad says instead; a Codex command is never sent to the model. A command Codex adds fails a test in the upgrade PR until ad decides.
- **Requests checked both ways.** The fake app-server rejects any request of ad's that the pinned stable protocol doesn't accept (an unknown method or field, a wrong type); `SENT_METHODS` lists every method ad sends, checked against the source. Experimental calls must be on `EXPERIMENTAL_ALLOWLIST` (`engine/codex/surface.mjs`, empty today).

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
- A turn gets no checkpoint when the "before" snapshot isn't done within 10 s, when a snapshot fails (before or after the turn), when a turn is started by Codex itself (a review, a goal), or when an edit's result can't be read.
- Rare refusals (never wrong restores): two equally small diffs that name different lines (a swap), an Add File over an existing file, two edits to one file landing before the first is hashed.

## Testing

Each layer is tested where it is cheapest, and the whole is tested live. Details: [testing.md](testing.md).

- Pure units: width tables, sanitizing, markdown (property: streamed equals full), input decoding.
- Golden screens at 40, 80 and 120 columns through `@xterm/headless`.
- The app against a fake `codex app-server` (`runtime/testkit/fake-codex-app-server.mjs`), whose messages are checked against the protocol snapshot.
- `/undo` against real temporary git repos, including adversarial cases (mid-turn saves, moves, binary files, CRLF, 8.3 paths).
- **Live:** `runtime/test/tui-live.test.mjs` runs the real `ad tui` in a real pseudo-terminal (ConPTY on Windows) on the real pinned Codex with a mock model: the terminal UI script of the manual test (section 6) and ad's own TUI features, on Linux, macOS and Windows in CI's non-blocking real-engine job.
- Guards that matter are mutation-checked: each is broken on purpose and a test must fail.

## Decisions and their reasons

| Decision | Why |
|---|---|
| Own zero-dependency renderer | Ink and similar libraries repaint whole frames and fight inline scrollback; a small renderer that only redraws the live region is simpler to make correct on Windows. |
| Inline mode by default | Keeps the terminal's scrollback, search and copy. |
| Codex app-server, stable surface only | Codex owns the agent loop, sandbox and login; ad stays a client and survives releases. |
| Bare `ad` opens the TUI | Flipped in 2.1.0, after the manual test's terminal UI script ran green live on all three OSes. `AD_TUI=0` keeps the old help. |
| Codex's names and rules for Codex's commands, keys and settings | Codex users aren't surprised; settings and keys are shared with `/codex` (ad never writes `tui.keymap`: the stock UI refuses to start on a keymap conflict ad couldn't check). |
| `/clear` purges the scrollback | Codex's meaning; `/new` keeps it, and `clear.keepScrollback` in `prefs.json` turns the purge off. |
| `ad chat`, `ad web`, `ad acp` stay on their own turn loop | Moving them onto the session controller would change what Zed sees over ACP (one session per engine, approvals checked against offered options) for little shared code. Revisit with a multi-session design if needed. |
| Windows sandbox and Store PowerShell | The Windows sandbox can't start a Store (MSIX) app, and Codex runs commands in the first `pwsh` on PATH. On Windows, every Codex spawn drops every `WindowsApps` entry from PATH (the app-alias folder and the Store package folders), so Codex uses an MSI PowerShell 7 or Windows PowerShell 5.1, inside the sandbox. |
