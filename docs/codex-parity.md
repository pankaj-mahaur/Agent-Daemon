# Codex commands in `ad`

`ad tui` follows the pinned Codex (see `/status` for the version). Every Codex slash command either works in `ad` with the same name and meaning, or answers in one line why it isn't in `ad` yet. A Codex command is **never sent to the model as a prompt**, with or without text after it, and what you typed stays in the prompt. For anything `ad` doesn't have, `/codex` opens the stock Codex UI on the same conversation (see [tui.md](tui.md#ad-codex-and-codex)).

Codex's own rules come with the commands:

- **During a task.** The commands Codex disables while a turn runs (`/new`, `/fork`, `/compact`, `/init`, `/export`, `/review`, `/logout`, `/clear`, …) answer `'/new' is disabled while a task is in progress.` in `ad` too, and your draft stays. Esc interrupts the turn first.
- **Aliases.** `/cwd` is `/pwd`, `/clean` is `/stop`, `/pet` is `/pets`, `/btw` is `/side`, `/quit` is `/exit`. Codex hides `/quit` and `/btw` in the popup until you type them, and the debug commands always; `ad` does the same.
- **The list is generated** from Codex's source at the pinned version (`runtime/scripts/codex-slash.mjs`). When a Codex release adds a command, a test fails in the upgrade pull request until `ad` decides what to do with it.

## Every command

"During a task" is Codex's rule: whether the command works while a turn is running.

| Command | In ad | During a task | What it does in ad |
|---|---|---|---|
| `/model` | yes | yes | choose the model and reasoning effort |
| `/ide` | no | yes | Codex reads your editor's selection over its own IDE link, which `ad` doesn't have |
| `/permissions` | yes | yes | what Codex may do without asking |
| `/keymap` | not yet | no | remap keys; change them in `/codex`, and `ad` uses them (see [Keys](#keys)) |
| `/vim` | not yet | no | Vim mode for the prompt; in `/codex` |
| `/setup-default-sandbox` | not yet | no | `ad sandbox setup --elevated` sets up the elevated sandbox (machine-wide: it also affects your own Codex) |
| `/experimental` | not yet | no | Codex's experimental features; in `/codex` |
| `/approve` | not yet | yes | approve one retry of a recent auto-review denial; in `/codex` |
| `/memories` | not yet | no | Codex's own memories; `ad`'s memory is `/memory` |
| `/skills` | yes | yes | skills Codex can use here |
| `/import` | not yet | no | import setup and chats from Claude Code; in `/codex` |
| `/hooks` | yes | yes | hooks and whether they are trusted |
| `/review` | yes | no | review your uncommitted changes |
| `/rename` | yes | yes | name this conversation |
| `/new` | yes | no | start a new conversation (the scrollback stays) |
| `/archive` | yes | no | archive this conversation, after asking; `/resume archived` brings it back |
| `/delete` | yes | no | delete this conversation for good, after asking |
| `/resume` | yes | yes | continue an earlier conversation; `/resume archived` for the archived ones |
| `/fork` | yes | no | continue in a copy of this conversation |
| `/worktree` | not yet | no | a conversation in a new git worktree; in `/codex` |
| `/app` | no | yes | it opens the Codex Desktop app, which uses your own Codex home, not `ad`'s, so it can't continue this conversation |
| `/init` | yes | no | create an AGENTS.md for this repo (Codex's prompt) |
| `/compact` | yes | no | summarize the conversation to free context |
| `/recap` | not yet | no | a short summary of the conversation; in `/codex` |
| `/plan` | yes | no | Plan mode: Codex's own (the model explores read-only and proposes a plan); `/plan <prompt>` sends the prompt there. Shift+Tab switches between Plan and Default. See [Plan mode](tui.md#plan-mode) |
| `/voice` | not yet | yes | voice; in `/codex` |
| `/goal` | yes | yes | set a goal for this conversation (`/goal clear`) |
| `/agents` | not yet | yes | Codex's agent command center; in `/codex` |
| `/side`, `/btw` | not yet | yes | a side conversation in an ephemeral fork; in `/codex` |
| `/copy` | yes | yes | copy the last answer to the clipboard |
| `/export` | yes | no | save the conversation as markdown in this folder |
| `/raw` | yes | yes | print the last answer as plain text (for selecting) |
| `/tui` | no | no | it chooses the stock UI's mode; `ad` has only its inline mode so far |
| `/diff` | yes | yes | show git changes, untracked files included |
| `/mention` | no | yes | type `@` in the prompt to mention a file |
| `/status` | yes | yes | account, model, sandbox, tokens, limits |
| `/daemon` | no | yes | it manages Codex's background server; `ad` runs its own engine and never uses it |
| `/warnings` | yes | yes | notices kept from this session, unknown events, settings `ad` couldn't use |
| `/cd` | not yet | no | change the working directory; in `/codex` |
| `/pwd`, `/cwd` | yes | yes | show the current working directory |
| `/usage` | yes | yes | usage limits and tokens |
| `/debug-config` | not yet | yes | config layers, for debugging; in `/codex` |
| `/title` | yes | yes | choose what the terminal window's title shows |
| `/statusline` | yes | yes | choose what the status line shows |
| `/theme` | not yet | no | a syntax highlighting theme; in `/codex` |
| `/pets`, `/pet` | no | no | `ad` doesn't draw terminal pets (they need Kitty or Sixel images) |
| `/mcp` | yes | yes | MCP servers and their status |
| `/apps` | not yet | yes | ChatGPT apps; in `/codex` |
| `/plugins` | not yet | yes | Codex plugins; in `/codex` |
| `/logout` | yes | no | sign out of Codex in `ad`'s home |
| `/quit`, `/exit` | yes | yes | exit `ad` |
| `/feedback` | no | yes | for `ad` problems, open an issue on the `ad` repository; the stock UI's `/feedback` uploads the whole conversation to OpenAI, `ad`'s memory context and `/private` prompts included |
| `/rollout` | not yet | yes | the conversation's rollout file; in `/codex` |
| `/ps` | not yet | yes | background terminals; the stock UI's `/ps` sees only its own engine, not `ad`'s |
| `/stop`, `/clean` | not yet | yes | stop background terminals; the stock UI's `/stop` sees only its own engine, not `ad`'s |
| `/clear` | yes | no | clear the terminal (scrollback too) and start a new conversation |
| `/test-approval` | no | yes | a Codex debug command |
| `/subagents` | not yet | yes | switch between subagents; in `/codex` |
| `/debug-m-drop`, `/debug-m-update` | no | no | Codex debug commands |

`ad` also has commands of its own, with names Codex doesn't use: `/help`, `/remember`, `/memory`, `/private`, `/proposals`, `/loop`, `/team`, `/schedule`, `/tools`, `/login`, `/codex`, `/ad`, `/image`, `/undo`, `/terminal-setup`. See [tui.md](tui.md#slash-commands).

## Keys

`ad` uses Codex's names for the key actions it has, and Codex's default keys:

| Action | Keys |
|---|---|
| the transcript | Ctrl+T |
| edit the prompt in your editor | Ctrl+G |
| copy the last answer | Ctrl+O |
| the last answer as plain text | Alt+R |
| the warnings | F2 |
| redraw (Codex: clear) | Ctrl+L |
| interrupt the turn | Esc |
| reasoning effort down / up | Alt+, / Alt+. (or Shift+↓ / Shift+↑) |
| queue for after this turn | Tab |
| the shortcuts | `?` |
| transcript pager | ↑ ↓ (`k` `j`), PgUp / PgDn, Shift+Space / Space, Ctrl+B / Ctrl+F, Ctrl+U / Ctrl+D, Home, End, `q` |

Keys you set in the stock UI's `/keymap` (saved as `tui.keymap` in `ad`'s Codex home) apply in `ad` for these actions. `ad` never changes them itself. A key it can't use there (a two-key chord, a key that would mean two things, or one of the prompt's editing keys) is skipped, and `/warnings` says why. Shift+Tab never queues.

## Settings shared with the stock UI

These live in Codex's `config.toml` in `ad`'s Codex home (`~/.agent-daemon/codex-home`, never your `~/.codex`), with Codex's names and values, so `/codex` shows the same:

| Setting | Set with | Notes |
|---|---|---|
| `tui.status_line` | `/statusline` | Codex's item ids; `[]` turns the status line off. An item `ad` can't show stays in the setting and `/warnings` lists it |
| `tui.terminal_title` | `/title` | the window title's items; `[]` leaves the title alone |
| `tui.keymap` | the stock UI's `/keymap` | read by `ad`, never written |

`ad`'s own preferences, for what Codex has no setting for, are in `~/.agent-daemon/tui/prefs.json` (for example `"clear.keepScrollback": true`).
