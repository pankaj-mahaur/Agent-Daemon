# Commands

`ad tui` follows the pinned engine (see `/status` for the version). Every engine slash command either works in `ad` with the same name and meaning, or answers in one line why it isn't in `ad` yet. An engine command is **never sent to the model as a prompt**, with or without text after it, and what you typed stays in the prompt.

The engine's own rules come with the commands:

- **During a task.** The commands the engine disables while a turn runs (`/new`, `/fork`, `/compact`, `/init`, `/export`, `/review`, `/logout`, `/clear`, …) answer `'/new' is disabled while a task is in progress.` in `ad` too, and your draft stays. Esc interrupts the turn first.
- **Aliases.** `/cwd` is `/pwd`, `/clean` is `/stop`, `/pet` is `/pets`, `/btw` is `/side`, `/quit` is `/exit`. The engine hides `/quit` and `/btw` in the popup until you type them, and the debug commands always; `ad` does the same.
- **Plan mode** (`/plan`, Shift+Tab, the proposed plan and "Implement this plan?") runs on a small part of the engine's experimental app-server API that only `ad tui` opts into (see [Plan mode](tui.md#plan-mode)).
- **The list is generated** from the engine's source at the pinned version (`runtime/scripts/codex-slash.mjs`). When an engine release adds a command, a test fails in the upgrade pull request until `ad` decides what to do with it.

## Every command

"During a task" is the engine's rule: whether the command works while a turn is running.

| Command | In ad | During a task | What it does in ad |
|---|---|---|---|
| `/model` | yes | yes | choose the model and reasoning effort |
| `/ide` | no | yes | needs an editor link that `ad` doesn't have |
| `/permissions` | yes | yes | what the engine may do without asking |
| `/keymap` | yes | no | shows the keys in effect, yours marked; `/keymap debug` is the engine's Keypress Inspector. Keys are changed in the engine's settings file under `[tui.keymap]` (`ad about` shows where), and `ad` uses them (see [Keys](#keys)) |
| `/vim` | yes | no | the engine's Vim mode for the prompt (Normal, Insert, Replace; its motions, operators, text objects, search, undo and `.`); `tui.vim_mode_default` starts it on |
| `/setup-default-sandbox` | yes | no | Windows: set up the engine's elevated sandbox after a confirm that says it is machine-wide (your own install uses it too); then this conversation gets ad's Auto permissions (the "Default" preset: edits here, asks for the rest). Not in an engine home ad didn't create. Elsewhere it says the OS sandbox is used |
| `/experimental` | not yet | no | isn't in `ad`. Features are set under `[features]` in the engine's settings file (`ad about` shows where); features you turned on keep working |
| `/approve` | yes | yes | **Auto-review Denials**: approve one retry of a recent denial (the last 10 of this conversation) |
| `/memories` | not yet | no | the engine's own memories; `ad`'s memory is `/memory` |
| `/skills` | yes | yes | skills the engine can use here |
| `/import` | not yet | no | isn't planned for `ad` |
| `/hooks` | yes | yes | hooks and whether they are trusted |
| `/review` | yes | no | review your uncommitted changes |
| `/rename` | yes | yes | name this conversation |
| `/new` | yes | no | start a new conversation (the scrollback stays) |
| `/archive` | yes | no | archive this conversation, after asking; `/resume archived` brings it back |
| `/delete` | yes | no | delete this conversation for good, after asking |
| `/resume` | yes | yes | continue an earlier conversation; `/resume archived` for the archived ones |
| `/fork` | yes | no | continue in a copy of this conversation |
| `/worktree` | not yet | no | isn't in `ad`. For parallel work in worktrees, use `/team` or `ad sp` |
| `/app` | no | yes | isn't in `ad`: the desktop app keeps its own folder, not `ad`'s, so it can't continue this conversation |
| `/init` | yes | no | create an AGENTS.md for this repo (the engine's prompt) |
| `/compact` | yes | no | summarize the conversation to free context |
| `/recap` | yes | no | the engine's catch-up (**↳ Recap:** and **Next:**), from a temporary read-only thread with no tools, the engine's prompt and limits. Automatic recaps aren't in ad |
| `/plan` | yes | no | Plan mode (the model explores read-only and proposes a plan); `/plan <prompt>` sends the prompt there. Shift+Tab switches between Plan and Default. See [Plan mode](tui.md#plan-mode) |
| `/voice` | not yet | yes | isn't planned for `ad` |
| `/goal` | yes | yes | set a goal for this conversation (`/goal clear`) |
| `/agents` | yes | yes | the engine's answer without its shared background server ("Shared agents unavailable"), which ad never runs; points to `/subagents` and `/team` |
| `/side`, `/btw` | yes | yes | a side conversation in an ephemeral fork, in a panel under the main one; nothing merges back. See [Side conversations](tui.md#side-conversations) |
| `/copy` | yes | yes | copy the last answer to the clipboard |
| `/export` | yes | no | save the conversation as markdown in this folder |
| `/raw` | yes | yes | print the last answer as plain text (for selecting) |
| `/tui` | no | no | chooses the engine's own UI mode; `ad` has only its inline mode so far |
| `/diff` | yes | yes | show git changes, untracked files included |
| `/mention` | yes | yes | an `@` in the prompt, and the file picker |
| `/status` | yes | yes | account, model, sandbox, tokens, limits |
| `/daemon` | no | yes | manages the engine's background server; `ad` runs its own engine and never uses it |
| `/warnings` | yes | yes | notices kept from this session, unknown events, settings `ad` couldn't use |
| `/cd` | yes | no | continue the conversation in another folder (the engine forks it there); asks first if the folder isn't trusted yet |
| `/pwd`, `/cwd` | yes | yes | show the current working directory |
| `/usage` | yes | yes | usage limits and tokens |
| `/debug-config` | yes | yes | config layers (lowest precedence first) and requirements, from the engine; values under secret-named keys, header and env maps, URL credentials and token-like arguments masked (the engine prints them). Hidden from the popup, as in the engine's own UI |
| `/title` | yes | yes | choose what the terminal window's title shows |
| `/statusline` | yes | yes | choose what the status line shows |
| `/theme` | yes | no | choose the syntax colours, with a live preview: `ansi` (your terminal's colours, the default) or the engine's `catppuccin-mocha` / `catppuccin-latte`; saved as `tui.theme`. A theme `ad` doesn't ship shows as `ansi` in `ad` (the engine's own UI still uses it) |
| `/pets`, `/pet` | no | no | `ad` doesn't draw terminal pets (they need Kitty or Sixel images) |
| `/mcp` | yes | yes | MCP servers and their status |
| `/apps` | not yet | yes | aren't planned for `ad` |
| `/plugins` | not yet | yes | aren't planned for `ad`. `/mcp` lists MCP servers; add one in the engine's settings file |
| `/logout` | yes | no | sign out in `ad`'s home |
| `/quit`, `/exit` | yes | yes | exit `ad` |
| `/feedback` | no | yes | for `ad` problems, open an issue on the `ad` repository; the engine's own UI uploads the whole conversation to OpenAI, `ad`'s memory context and `/private` prompts included |
| `/rollout` | yes | yes | the conversation's rollout file. A debug command of the engine's own UI: typed only |
| `/ps` | yes | yes | the background terminals the engine runs for this conversation (a dev server, a watcher), with their last output lines. See [Background terminals](tui.md#background-terminals) |
| `/stop`, `/clean` | yes | yes | stop all background terminals (the engine's experimental call, which only `ad tui` makes) |
| `/clear` | yes | no | clear the terminal (scrollback too) and start a new conversation |
| `/test-approval` | no | yes | a debug command of the engine's own UI |
| `/subagents` | yes | yes | the engine's **Subagents** picker; ad shows the agent's transcript live in a pager instead of switching the conversation. Alt+← / Alt+→ go round them |
| `/debug-m-drop`, `/debug-m-update` | no | no | debug commands of the engine's own UI |

`ad` also has commands of its own, with names the engine doesn't use: `/help`, `/remember`, `/memory`, `/private`, `/proposals`, `/loop`, `/team`, `/schedule`, `/tools`, `/login`, `/ad`, `/image`, `/undo`, `/terminal-setup`. (Typing the removed `/codex` hand-off answers what to use instead.) See [tui.md](tui.md#slash-commands).

## Keys

`ad` uses the engine's names for the key actions it has, and the engine's default keys:

| Action | Keys |
|---|---|
| the transcript | Ctrl+T |
| edit the prompt in your editor | Ctrl+G |
| copy the last answer | Ctrl+O |
| the last answer as plain text | Alt+R |
| the warnings | F2 |
| redraw (the engine's own UI: clear) | Ctrl+L |
| interrupt the turn | Esc |
| reasoning effort down / up | Alt+, / Alt+. (or Shift+↓ / Shift+↑) |
| queue for after this turn | Tab |
| the shortcuts | `?` |
| transcript pager | ↑ ↓ (`k` `j`), PgUp / PgDn, Shift+Space / Space, Ctrl+B / Ctrl+F, Ctrl+U / Ctrl+D, Home, End, `q` |

Keys you set in the engine's settings file under `[tui.keymap]` apply in `ad` for these actions. `ad` never changes them itself. A key it can't use there (a two-key chord, a key that would mean two things, or one of the prompt's editing keys) is skipped, and `/warnings` says why. Shift+Tab never queues.

## Settings shared with the engine's own UI

These live in the engine's `config.toml` in `ad`'s engine home (`~/.agent-daemon/engine`, never your `~/.codex`), with the engine's names and values, so the engine's own UI shows the same:

| Setting | Set with | Notes |
|---|---|---|
| `tui.status_line` | `/statusline` | the engine's item ids; `[]` turns the status line off. An item `ad` can't show stays in the setting and `/warnings` lists it |
| `tui.terminal_title` | `/title` | the window title's items; `[]` leaves the title alone |
| `tui.keymap` | `[tui.keymap]` in the settings file | read by `ad`, never written |

`ad`'s own preferences, for what the engine has no setting for, are in `~/.agent-daemon/tui/prefs.json` (for example `"clear.keepScrollback": true`).
