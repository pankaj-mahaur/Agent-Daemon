# `ad tui`: the terminal UI

`ad tui` is a terminal UI for agent-daemon's harness. It drives the same pinned engine as `ad chat`, in ad's own engine home (`~/.agent-daemon/engine`), with ad's memory, hooks and skills wired in. Your own `~/.codex` is never used.

It runs inline: finished output goes into your terminal's normal scrollback, so scrolling, selecting and copying work as usual. Only the bottom of the screen (the running turn, the composer and the footer) is redrawn. The composer sits on the screen's last rows from the start, and the conversation fills the space above it. To have it follow the conversation instead, as in the engine's own inline mode, set `"prompt.atBottom": false` in `~/.agent-daemon/tui/prefs.json`.

If something gets in the way, `ad chat` is the plain line mode and stays available. How it is built, and the safety model behind `/undo`: [tui-architecture.md](tui-architecture.md).

- [Starting it](#starting-it)
- [First run](#first-run)
- [The screen](#the-screen)
- [Keys](#keys)
- [Approvals and questions](#approvals-and-questions)
- [Slash commands](#slash-commands)
- [Switching model, account or provider](#switching-model-account-or-provider)
- [Automatic fallback](#automatic-fallback)
- [Plan mode](#plan-mode)
- [Syntax highlighting](#syntax-highlighting)
- [Vim mode](#vim-mode)
- [Side conversations](#side-conversations)
- [Background terminals](#background-terminals)
- [Subagents](#subagents)
- [Recaps](#recaps)
- [Auto-review denials](#auto-review-denials)
- [Images](#images)
- [`/undo`](#undo)
- [ad's own features](#ads-own-features)
- [`/codex` is gone](#codex-is-gone)
- [Files ad writes](#files-ad-writes)
- [Terminals](#terminals)
- [When something goes wrong](#when-something-goes-wrong)

---

## Starting it

```bash
ad tui                              # in the current folder
ad tui "fix the flaky login test"   # send a first prompt right away
ad tui --last                       # continue the newest conversation in this folder
ad tui --resume <thread-id>         # continue a given conversation
ad tui --cwd ../other-repo --model <name> --sandbox read-only
```

| Option | Effect |
|---|---|
| `"<prompt>"` | sent as the first prompt as soon as the UI is up |
| `--last` | resumes the newest conversation for this folder |
| `--resume <id>` | resumes that conversation (in whichever engine folder holds it) |
| `--account <provider>/<label>` | the account for new conversations (see [harness.md](harness.md#safety-model)) |
| `--effort <level>` | the reasoning effort with `--model` |
| `--cwd <dir>` | works in another folder |
| `--model <name>` | the model for new turns (`/model` changes it later) |
| `--sandbox <mode>` | `read-only`, `workspace-write` (default) or `danger-full-access` |

A conversation is open in one `ad` at a time. Resuming one that another `ad` has open says so and changes nothing.

On exit, ad prints how to continue: `ad tui --resume <id>`, with the tokens used, and `--account <provider>/<label>` when the conversation isn't on your default account.

**Bare `ad`** (and `ad --last`) opens the TUI whenever the terminal can show it. `ad chat` stays the plain line mode.
- `AD_TUI=0` turns that off: bare `ad` prints the help. `ad --last` exits (code 2) saying that `ad tui --last` still reopens the last conversation in the TUI.
- If the TUI can't run here, bare `ad` prints the reason and the help. `ad --last` exits (code 2) with the reason, and suggests `ad chat` with `/resume`.

**Requirements.** An interactive terminal (stdin and stdout are TTYs), `TERM` not `dumb`, and on Windows Node 22.17+ or 24.2+ (not 23.x or 24.0–24.1). Otherwise `ad tui` exits with the reason and a command that works:

| Where | What ad says |
|---|---|
| a pipe or a script | needs an interactive terminal: use `ad chat` |
| `TERM=dumb` | this terminal can't show the UI: use `ad chat` |
| Windows, older Node | needs Node 22.17+ or 24.2+: upgrade 22.x to 22.17+, 24.x to 24.2+, 23.x to 24.2+ (then `npm rebuild` in `runtime/`), or use `ad chat` |
| mintty (Git Bash's window) | run `winpty ad tui`, or use Windows Terminal |

`ad tui --preview` runs a minimal earlier preview instead: plain streamed text and `y` / `a` / `n` approvals on the same engine.

---

## First run

0. **Pick a project folder** (only in some folders). Started in your home folder, or under a home folder that is a git repository, when your own `~/.codex` has skills, `ad` first lists your recent projects, the last one selected: Enter opens it. **Open home anyway** and **Always open home without asking** (saved as `allowHomeFolder` in `prefs.json`) are the other rows; Esc exits. See [harness.md](harness.md#working-in-your-home-folder) for why and the other overrides.
1. **Sign in.** If ad isn't signed in yet, a sign-in panel opens:

   | Choice | Runs |
   |---|---|
   | OpenAI API key | `ad auth login openai` (kept in ad's own folder) |
   | OpenRouter | `ad auth login openrouter` (key and model; the key goes to ad's secret store) |
   | ChatGPT | `ad auth login chatgpt` (browser) |

   The terminal is handed to that command and comes back when it finishes. Esc closes the panel and exits. `/login` does the same later; `/logout` signs out.
   2. **Trust the folder.** The first time in a folder, ad asks whether you trust it. Trusted folders can run their own hooks, skills and settings. The answer is saved once per folder in ad's engine home (`config.toml`, `projects`). Your home folder is never asked about.
3. **The header** appears, then the composer. Type and press Enter.

---

## The screen

```
╭────────────────────────────────────────────────────────────────────────────╮
│ >_ Agent Daemon (v2.1.1)                                                   │
│                                                                            │
│ model:     gpt-5.x-codex medium · ChatGPT Plus      /model to change       │
│ directory: D:\…\work\app · git: dev                                        │
│ memory:    142 learnings                            /memory                │
│ sandbox:   workspace-write · asks first                                    │
╰────────────────────────────────────────────────────────────────────────────╯
  Since last time: loop ran (6 iter) · schedule daily ran · 2 skill proposals

  Try /review · /goal · /resume · /memory · ? for shortcuts

› fix the flaky login test

• Recalled 3 learnings
• Explored
  └ Read login.spec.ts, auth.ts
• Ran npm test -- login.spec.ts
  └ 1 failing: expected 200, got 401

◦ Checking token refresh (14s · esc to interrupt)
  ↳ queued: also run the signup test                              tab: edit

› Ask ad to do anything
  enter steer · tab queue · ctrl+j newline                     ctx 91% · 5h 38%
```

- **Header.** Shown once at the start, then it scrolls into history like everything else. Under 40 columns it is one line.
  - **Since last time** lists, for this folder, loops that ran, scheduled jobs that ran or failed, and skill proposals waiting for review. It appears only when there is something new since your last visit.
  - Setup warnings (a sandbox that isn't ready, a trust answer that wasn't saved) show in yellow under it. So does "the scheduler isn't running" when an enabled job is more than 5 minutes overdue.
- **Cells.** Prompts (`›`), answers, commands (Explored, Ran, Failed (exit N), Declined, with the last lines of output), edits (`Edited N files (+A -R)` with a diff), the model's checklists (**Updated Plan**, each time it changes them), proposed plans ([Plan mode](#plan-mode)), tool calls and notices. A turn ends with "Worked for Ns".
- **ad rows** are one dim line each, and only when something happens: recalled learnings, a guard that blocked a command, a hook that failed, what ad learned, loop iterations.
- **Activity row** (while a turn runs): what the engine is doing, the time, and `esc to interrupt`. Queued prompts are listed under it; the last one says `tab: edit`.
- **Status line** (under the prompt, from 12 rows): the engine's status line items, joined with ` · `. By default the model and its reasoning effort, the folder, `ctx N%` (the context left in this conversation) and `5h N%` (how much of the current usage window is used); a percentage turns amber at 80 % used. `/statusline` chooses the items and their order, with the engine's ids (`git-branch`, `branch-changes`, `run-state`, `weekly-limit`, `task-progress`, …); it's saved as the engine's `tui.status_line`. When it's too wide, items drop from the end. Under an approval it shows only where the approval doesn't need the room.
- **Footer.**
  - Left: key hints. Idle: `? shortcuts · @ files · <newline key> newline`. While a turn runs: `enter steer · tab queue · <newline key> newline`.
  - Right: chips: `private` while `/private` is on, `loop N` while a background loop runs.
  - **When the footer is too narrow**, the key hints go first (from the end), then chips shorten (`loop 3` → `L3`, `private` → `P`), then chips go.
- **Window title.** By default a spinner while a turn runs ("action required" while an approval waits), the conversation's name and the project. `/title` chooses the items (the engine's `tui.terminal_title`). The terminal's own title is saved when ad starts and put back when it ends and around the editor. `/private` keeps the conversation's name out of it.

---

## Keys

`?` on an empty prompt shows the shortcuts; `/help` lists them too.

**Sending and newlines**

| Key | What it does |
|---|---|
| Enter | send. While a turn runs, Enter **steers** it: the text goes into the running turn |
| newline key | a new line in the prompt (see below) |
| `\` then Enter | a new line, in every terminal |
| Tab | while a turn runs: **queue** the prompt for after this turn. On an empty prompt: pull the last queued prompt back to edit |

The newline key depends on what the terminal sends. ad treats Enter as send and a line feed as a newline; the footer shows the right key for your terminal.

| Terminal | Newline key |
|---|---|
| Zed | Shift+Enter |
| Windows Terminal 1.24 | Ctrl+Enter (Shift+Enter after `/terminal-setup`) |
| Windows Terminal 1.25+ | Shift+Enter or Ctrl+Enter |
| VS Code | Ctrl+J (Shift+Enter after `/terminal-setup`) |
| any terminal | Ctrl+J, or `\` then Enter |

Alt+Enter is never used: it is Windows Terminal's fullscreen toggle.

**Stopping and quitting**

| Key | What it does |
|---|---|
| Esc | interrupt the running turn |
| Esc Esc | on an empty prompt, while idle: rewind to an earlier prompt (below) |
| Ctrl+C | in this order: close a popup, clear the prompt, interrupt the turn. A second Ctrl+C within 1.5 s quits |
| Ctrl+L | redraw the screen |

With an approval open, Ctrl+C declines it. Clearing the prompt or closing a popup doesn't arm the quit; only an interrupt or a press on an idle, empty prompt does.

**Esc Esc: rewind.** A "Rewind to" picker lists your earlier prompts (latest first). Picking one rewinds the conversation to just before it and puts that prompt back in the composer to edit. **Files on disk are not changed.** To put files back too, use `/undo`. The first Esc says "Esc again to rewind".

**Editing the prompt**

| Key | What it does |
|---|---|
| ← / → | move; with Ctrl or Alt, by word (also Alt+B / Alt+F) |
| Home / End, Ctrl+A / Ctrl+E | start / end of the line |
| Ctrl+K / Ctrl+U | cut to the end / start of the line |
| Ctrl+W | cut the word before the cursor |
| Ctrl+Y | paste what was cut |
| ↑ / ↓ | move between rows; at the first or last row, walk your prompt history |
| Ctrl+R | search the prompt history (Ctrl+R again: older match; Enter takes it; Esc leaves) |
| Ctrl+G | edit the prompt in your editor (below) |

Big pastes (more than 5 lines or 1000 characters) show as `[Pasted N lines]` and are expanded when you send.

**Ctrl+G** opens `$VISUAL`, else `$EDITOR` (arguments allowed), else Notepad on Windows and vi elsewhere, on a private temp file. Save and close the editor to come back. If the editor fails, nothing changes. An editor that returns at once (it opened the file in a window that was already running) keeps your prompt and says so: set `EDITOR` to one that waits, such as `code --wait`.

**More**

| Key | What it does |
|---|---|
| `?` | the shortcuts (on an empty prompt) |
| `@` | complete a file name in this folder |
| `/` | complete a command; Enter runs the highlighted one, Tab fills it in |
| `!cmd` | run `cmd` in the shell, **unsandboxed** (like the engine's own UI `!`). One line only; a multi-line paste starting with `!` is a prompt |
| Ctrl+T | page through the whole transcript: ↑ ↓ (or `k` `j`), PgUp / Shift+Space / Ctrl+B, PgDn / Space / Ctrl+F, Ctrl+U / Ctrl+D (half a page), Home, End; Esc, `q`, Ctrl+C or Ctrl+T closes |
| Alt+, / Alt+. | lower / raise the reasoning effort for the next turn, through the current model's own levels (Shift+↓ / Shift+↑ too) |
| Alt+← / Alt+→ | with the prompt empty: watch the previous / next [subagent](#subagents) (the engine's fixed keys) |
| Shift+Tab | switch between Plan and Default mode ([Plan mode](#plan-mode)); not while a turn runs |
| Ctrl+/ | with a [side conversation](#side-conversations) open: move between its prompt and the main one |
| Esc (Vim on) | Insert → Normal; in Normal with nothing pending, the usual Esc ([Vim mode](#vim-mode)) |
| Ctrl+O | copy the last answer (`/copy`) |
| Alt+R | print the last answer as plain text (`/raw`) |
| F2 | the warnings (`/warnings`) |

The terminal bell rings when an approval waits, and when a turn ends while the terminal window isn't focused.

**Changing keys.** ad uses the engine's names for the actions it has. Set keys in the engine's settings file, under `[tui.keymap]` (ad about shows where); for example:

```toml
[tui.keymap.global]
open_transcript = "alt-y"
```

ad reads them and never writes them. A key ad can't use there (a chord like `ctrl-x f`, a key that would mean two things, or one of the prompt's editing keys) is skipped, and `/warnings` says why. `/keymap` lists the keys in effect (yours marked) and `/keymap debug` shows what your terminal sends for a key and what it does in ad (Ctrl+C closes it). Shift+Tab never queues: it switches [Plan mode](#plan-mode).

### Settings in the engine's settings file

The status line, the window title, the keys and the theme are stored in the engine's settings file (`config.toml` in the engine home; `ad about` shows where). ad reads them and never writes `tui.keymap`; `/warnings` lists what ad can't show.

**Chords and the leader key** work as in the engine's own UI (0.163):
- A binding can be two keys, `"ctrl-x ctrl-s"`, or the **leader** then a key, `"leader c"`.
- The leader is `tui.keymap.global.leader`. Its default is `ctrl-x`, unless you bound `ctrl-x` to something else. A character leader needs ctrl or alt, and `ctrl-z` can't be the leader outside Windows.
- After the first key, the footer lists what can follow (`ctrl+x … c copy · esc cancel`).
- A leader chord waits until you press its second key. Any other two-key chord gives up after one second.
- Esc, or the leader again, cancels a waiting chord.
- A key that completes nothing works as it normally would, so typing is never lost.
- Chords are off while an approval or one of ad's questions is open.
- `/keymap` lists your chords and names the leader.
- Not in ad: the engine's leader menu panel, and keys `f13`–`f24`.

---

## Approvals and questions

When the engine wants to do something it needs permission for, the request opens as a box over the composer. Its full text also goes into the scrollback, and so does your answer ("approved", "approved for this session" or "declined").

| Request | Choices (key) |
|---|---|
| Run a command | Yes (`y`) · Yes, and don't ask again this session (`a`) · Yes, and don't ask again for commands starting with `<prefix>` (`p`) · Yes, and always allow `<host>` (`h`) · No, and tell the engine what to do instead (`n`) · No, and stop (`esc`) |
| Edit files (the diff is shown) | Yes (`y`) · Yes, and don't ask again for these files this session (`a`) · No, and tell the engine what to do instead (`n`) · No, and stop (`esc`) |
| More permissions | Yes, for this turn (`y`) · Yes, for this session (`a`) · No (`n`) |

A command request lists only what the engine offers for that command, so `p` and `h` appear only sometimes.

- **Answering:** press the key, press the option's number, or move with ↑ / ↓ and press Enter.
- **Arming.** An answer that grants something is taken only 400 ms after the box opened and after your last key. A key pressed too early restarts the wait. Type-ahead, a held key or a paste never approves. Declining works at once.
- **Hidden characters** in a command or a diff (control characters, bidi marks, zero-width or look-alike spaces) are shown as `<U+XXXX>`, so a command can't hide part of itself.
- **Long requests** scroll inside the box with PgUp / PgDn.
- **Questions** from the engine list numbered options plus Skip (`esc`), or take free text. Secret answers are masked and never stored in history.
- **Forms** from an MCP server offer Submit (`y`; "Open it, then continue" for a link), Decline (`n`) and Cancel (`esc`).
- A request ad doesn't support yet is declined, and ad says "ad declined a request it can't show here.".

---

## Slash commands

Type `/` to see them with a one-line hint each. Commands marked "engine" keep the engine's meaning; the others are ad's own.

**Conversations**

| Command | What it does |
|---|---|
| `/new` | start a new conversation (engine). The scrollback stays |
| `/clear [name]` | clear the terminal, **scrollback included**, and start a new conversation, named if you give a name (engine). The one before stays resumable. To keep the scrollback, set `"clear.keepScrollback": true` in `~/.agent-daemon/tui/prefs.json` |
| `/resume` | continue an earlier conversation in this folder (engine). `/resume archived` (or the last entry of the list) shows the archived ones; resuming one unarchives it |
| `/archive` | archive this conversation, after asking (engine). ad stays open on a new one; `/resume archived` brings it back |
| `/delete` | delete this conversation for good, its subagents too, after asking (engine). Its `/undo` snapshots go with it; ad's memory from it is kept |
| `/pwd` | show the current working directory (engine; `/cwd` too) |
| `/cd [folder]` | continue in another folder (engine): the conversation is forked there, and from then on everything works in it (edits, commands, `@` files, git facts, ad's memory, `/undo`). Alone, it goes home. A folder you haven't trusted yet is asked about first. Not while a turn runs, prompts are queued, background terminals run or a subagent (one seen start in this session) is still working; never into an engine home. `/undo` can't undo turns from before the change |
| `/fork` | continue in a copy of this conversation (engine) |
| `/rename <name>` | name this conversation (engine) |
| `/compact` | summarize the conversation to free context (engine) |
| `/recap` | a short catch-up on this conversation: what it is for, what is done, what is next (engine). See [Recaps](#recaps) |
| `/export [name]` | save the conversation as markdown in this folder (engine). Never overwrites, never writes outside the folder |
| `/quit`, `/exit` | exit ad (engine) |

**Settings**

| Command | What it does |
|---|---|
| `/model` | choose the model and reasoning effort; with several accounts, the account first (grouped by provider; each row says how this conversation continues there; see [Switching model, account or provider](#switching-model-account-or-provider)). `/model default` makes this window's account and model the default for new sessions |
| `/account` | pick this window's account (then its model) |
| `/permissions` | what the engine may do without asking: Read only, Auto (default: edits this folder, asks for the rest), Full access (engine) |
| `/login [provider]` | add or sign in an account: pick the provider, give it a label and an owner, then paste the key into a masked field (never kept in the prompt history). ChatGPT signs in through `ad auth login chatgpt` |
| `/logout [account]` | sign out one account; the others stay signed in. Signing out this window's account opens `/account` |
| `/statusline` | choose the status line's items and their order: Space toggles, ← → move, Enter saves, Esc puts it back (engine) |
| `/title` | choose what the terminal window's title shows, the same way (engine) |
| `/vim` | toggle the engine's Vim mode for the prompt (engine). See [Vim mode](#vim-mode) |
| `/theme` | choose the syntax colours, with a live preview; Esc keeps the old one (engine). See [Syntax highlighting](#syntax-highlighting) |
| `/keymap [debug]` | the keys in effect; `debug` shows what a key sends (engine) |
| `/setup-default-sandbox` | Windows: set up the engine's elevated sandbox, after asking: machine-wide, so your own install uses it too. Nothing else is sent while it runs; then the conversation gets the Auto permissions. Not in an engine home ad didn't create (`ad sandbox setup --elevated --force` there) (engine) |

Model, effort and permission changes apply from the next turn.

**Work**

| Command | What it does |
|---|---|
| `/goal [<objective>\|clear]` | set a goal for this conversation (`/goal clear`); alone, shows it (engine) |
| `/side [question]` | a side conversation in an ephemeral fork, in a panel; works while a turn runs (engine; `/btw` too). See [Side conversations](#side-conversations) |
| `/plan [prompt]` | switch to Plan mode; with a prompt, send it there (engine). See [Plan mode](#plan-mode) |
| `/review` | review your uncommitted changes (engine) |
| `/ps` | list the background terminals and their last output lines (engine). See [Background terminals](#background-terminals) |
| `/stop` | stop all background terminals (engine; `/clean` too) |
| `/subagents` | watch this conversation's subagents, live; Alt+← / Alt+→ go from one to the next (engine). See [Subagents](#subagents) |
| `/approve` | approve one retry of an action the engine's auto-review denied (engine). See [Auto-review denials](#auto-review-denials) |
| `/mention` | put an `@` in the prompt and open the file picker (engine) |
| `/diff` | show git changes, untracked files included (engine) |
| `/init` | create an AGENTS.md for this repo, with the engine's own prompt (engine) |
| `/image <path>` | attach an image file to the next prompt |
| `/undo [force]` | put back the files the last turn changed, and rewind it (below) |

**Output**

| Command | What it does |
|---|---|
| `/copy` | copy the last answer to the clipboard (engine) |
| `/raw` | print the last answer as plain text, for selecting (engine) |

**Inspection**

| Command | What it does |
|---|---|
| `/status` | account, model, sandbox, tokens, limits, and the engine version line (engine) |
| `/usage` | usage limits and tokens (engine) |
| `/mcp` | MCP servers and their status (engine): the ones in ad's engine settings; a trusted project's own start with its conversation |
| `/hooks` | hooks and whether they are trusted; ad's own are marked (engine) |
| `/skills` | skills the engine can use here (engine) |
| `/warnings` | notices and raw engine details kept from this session (a repeated one shows once, with `×n`), key settings ad can't use (one summary line; `/keymap` lists each), and events this ad doesn't know |
| `/debug-config` | the engine's config layers (lowest precedence first, the session's flags listed) and its requirements. Values under secret-named keys, header and env maps, a URL's user:password and token-like arguments show as `****`. Typed only, as in the engine's own UI |
| `/rollout` | the conversation's rollout file (the engine's debug command; typed only) |
| `/agents` | the engine's agent command center needs its shared background server, which ad doesn't run: it says so, and points to `/subagents` and `/team` (engine) |

**ad**

| Command | What it does |
|---|---|
| `/remember <text>` | save a note to ad's project memory |
| `/memory [search <words>\|recent\|forget <id>\|profile]` | ad's memory (not the engine's `/memories`) |
| `/private` | toggle: prompts are wrapped in `<private>` (ad never learns from them) |
| `/proposals` | skill changes ad proposes (review with `/ad review`) |
| `/loop "<objective>"` | work toward an objective in the background (`/loop stop`) |
| `/team [id]` | the team board |
| `/schedule [run <id>]` | scheduled jobs |
| `/tools [list|enable|disable <tool>]` | optional agent tools (`/tools enable browser`) |
| `/ad <command>` | run an ad command, e.g. `/ad doctor` |
| `/fallback [on\|off]` | the fallback order: where a task may continue when a limit runs out; `on`/`off` for this window only (see [Automatic fallback](#automatic-fallback)) |
| `/retry` | try again after automatic fallback paused (on the current model) |

**Help**

| Command | What it does |
|---|---|
| `/help` | what you can do here: every command and shortcut |
| `/terminal-setup` | how to make Shift+Enter add a newline in this terminal |

A command ad doesn't have yet is never sent to the model as a prompt. It answers in one line why ("/import isn't planned for ad."), and what you typed stays in the prompt. Where the engine's own UI can't help either (`/ide`, `/app`, `/daemon`), the answer says so instead. Upstream commands keep upstream's rules: the ones disabled while a task runs (`/new`, `/fork`, `/compact`, `/init`, `/export`, `/review`, `/logout`, …) answer "'/new' is disabled while a task is in progress.", and the draft stays. Upstream's aliases work (`/cwd`, `/clean` for `/stop`, `/pet`), and `/quit` shows in the popup only once you type it.

---

## Switching model, account or provider

Pick another account (or its model) in `/model` or `/account` while a conversation is open, and it moves there, mid-task, with its history. Each row says what Enter does: "continues this conversation" or "continues in a new conversation (history carried over)".

- **How it moves.** Another model on the same account takes effect from the next turn. Another key of the same provider, same model, continues in a copy of the conversation (a fork). Anything else (another provider, a ChatGPT account, ad's chat translation on either side, another model with the account) starts a new conversation on that account, seeded with the history so far as ad's note plus the messages; the old one stays in `/resume`.
- **When.** At a safe point: idle, no open approval, no subagent still working. During a turn you choose **Switch after this turn** or **Stop the turn and switch now** (ad then tells the new model to continue). Prompts you send meanwhile wait and run once, on the new account. The footer says **switch pending**; `/model` or `/account` then offers to cancel it.
- **What carries over.** The history (as text: tools as `[done] $ npm test → exit 1` lines, no reasoning, no internal ids), the folder, permissions, the queue and the mode. Files on disk are as they are.
- **Goals** pause during the switch and resume after the first answer on the new account; no turn starts there by itself first.
- **Background terminals** keep running with the old conversation. The new model is told which they are and not to restart them; `/ps` lists them under "Still running from before the switch" and `/stop` ends them too.
- **Not carried:** "for this session" approvals, the side conversation, `/undo` of turns from before the switch ("That turn ran before the switch to …").
- **When a tool's end is unknown** (the last turn may still have started `npm run deploy`), ad asks first: **Switch anyway** or **Cancel**.
- **If it can't**, nothing moves: "Couldn't switch to … Still on …" says why (sign-in, model, engine, the engine kept the old provider). See [troubleshooting #74](troubleshooting.md#74-couldnt-switch-to--still-on-).
- `/status` shows `session ses_… · binding 2 (switched 14:02, you asked)`; `ad sessions show --last` lists the bindings.
- **Turn it off:** `"switching.crossAccount": false` in `~/.agent-daemon/tui/prefs.json` brings back P3.8b's behaviour (another provider starts a new, empty conversation; the row says "starts a new conversation").

## Automatic fallback

When a model's limit runs out or its provider fails, ad can continue the task on the next model in an order you chose, by itself, once the turn has ended. It is off until you turn it on in `/fallback`, which opens the order below the prompt.

### What happens when a limit runs out

- **Only at the end of a turn.** ad never moves a turn that is still working. A turn that keeps retrying a dead connection is stopped at the end of the order's "give up after" time (a goal is paused first), then moved.
- **Only for a used-up limit, a rate limit, a network failure or a provider's server error.** Never for a sign-in problem, a plan that doesn't include the use, a request the model refused, or your own Esc.
- **The line says what happened:** `↪ Switched to Gemini API · gemini-2.5-flash: OpenRouter's daily limit is used up (resets 05:30). Fallback 1 of 3.` It replaces the engine's own message, which can mislead (a free daily limit arrives as "Quota exceeded. Check your plan and billing details."); that message stays in `/warnings`. The bell rings when the terminal isn't focused.
- **ad continues the work there:** the next model gets the conversation (tools that ran are marked done, never run again) and one line from ad asking it to carry on. That line shows as `• Fallback: ad continued the task here`, never as your words, and ad's memory never learns from it. Prompts you queued run after it, once.
- **Another account of the provider that ran out is never next:** every account of it waits for the reset, in every window.
- **A ChatGPT sign-in is checked first:** ad asks its engine who is signed in before moving there. A signed-out one is skipped (`Couldn't switch to …: that account needs signing in again: ad auth login <name>`).
- **A short wait instead of a move:** a rate limit with a known wait of 30 s or less is retried once on the same model (`↻ Rate limited by OpenRouter; retrying in 8 s (1 of 1).`).
- **Before your prompt:** if the model you are on ran out since (or the provider of a model fallback chose was benched), ad switches first and your prompt runs there (`↪ Using … for this prompt: …`). A model you picked yourself is kept, with one notice.

### When it pauses

ad stops and asks you instead of moving when it can't be sure the move is safe or useful: `⏸ Paused: <why>. Your work is saved. /retry tries again · /model picks a model · /fallback shows the order.` The reasons:

- a command from the failed turn may still be running (ad can't tell whether it finished);
- a command is still running in the background and isn't one you allowed to keep running (the rules' keep-running list, for dev servers and watchers);
- a subagent is still working;
- no other model in your order can take over now (each one's reason is listed);
- the order's budget is used up (moves per task, or the time to keep trying), or fallback is switching too often (moves per hour);
- the order no longer matches what you confirmed.

While paused, nothing you queued runs. **`/retry`** tries again on the current model; a prompt you type, or a model you pick in `/model`, ends the pause. `/status` shows `fallback  1 switch this session (14:02, …)`.

### The order

`/fallback` shows and edits it:

```text
Fallback order        off · no extra spend
› 1  OpenRouter · work · qwen/qwen3-coder:free    free (checked 3 min ago) · today 41/50  ✓
  2  Gemini API · personal · gemini-2.5-flash     free (checked 3 min ago)                ✓
  3  ChatGPT · personal · gpt-5.5 medium          your plan · weekly 64% used             ✓
    + add a target (a)
 Switch on: limit used up · rate limit · network error · provider error
 Cost: no extra spend   Moves per task: 3 (6 an hour)   Give up after: 2 min   Trial endpoints: ask
 enter rules · a add · d remove · [ ] move · t test · l live test · p preview · e turn on · esc close
```

- **↑/↓** choose a row; **[** and **]** move it; **d** removes it; **a** adds a target (an account, then one of its models; a trial or free-tier endpoint asks first).
- **enter** on the rules line: what it switches on, the cost rule, moves per task, how long to keep trying, the trial rule.
- **t** checks each target without sending anything. **l** sends one tiny request to each API target, after asking. **p** previews what would happen now (**tab**: another kind of error).
- **e** shows every destination and what its provider does with your data, then **Turn on**, **Save, keep off** or **Cancel**. When on, **e** turns it off.
- Each change is saved at once. One that would add a problem shows the reason under the rows and stays a draft until you fix it; **esc** then asks "Discard changes?".
- Changing the order, a target, the cost or trial rule, or the account behind a target turns fallback off until you confirm again ("Changed: fallback is off until you turn it on again (e).").
- **`/fallback off`** stops it for this window only, until you quit; **`/fallback on`** brings it back (refused while it is off in your settings: "Fallback is off in your settings. /fallback opens them.").
- The rules, the words and the agent-shell refusal are the same as `ad fallback` in a terminal: see [harness.md](harness.md#the-fallback-order-ad-fallback).

## Plan mode

The engine's own plan mode: the model explores without changing anything, asks you what it can't find out, and ends with a plan you can implement.

- **Switching.** `/plan` switches to Plan mode; `/plan <prompt>` switches and sends the prompt there. Shift+Tab switches between Plan and Default. Neither works while a turn runs (as in the engine's own UI). In Plan mode the footer shows **Plan mode (shift+tab to cycle)** and the prompt turns magenta.
- **What the model does.** It gets the engine's plan-mode instructions: read and search but don't edit, ask questions (they come up in the usual question dialog), and end with one **Proposed Plan**, shown as its own block.
- **Implement this plan?** When a plan arrives and nothing else waits, ad asks, with the engine's choices:
  1. **Yes, implement this plan**: switches to Default and sends "Implement the plan.".
  2. **Yes, clear context and implement**: a new conversation in Default whose first message is the plan (the choice shows how much context the current one uses). The scrollback stays.
  3. **No, stay in Plan mode** (or Esc): keep refining it.

  If you're typing when the plan arrives, your draft stays: ad says "A plan is ready: clear the prompt to choose." and asks once the prompt is empty. A queued prompt runs instead of the question.
- **Settings.** Plan mode's reasoning effort is the engine's `plan_mode_reasoning_effort` (else medium, the engine's default); Default keeps your own model and effort. A new conversation starts in Default.
- **Limits.** Like in the engine's own UI, Plan mode is instructions to the model, not a sandbox: a model that edits anyway isn't stopped. For a hard stop, also set `/permissions` to read-only. Plan mode uses part of the engine's experimental app-server API (only `ad tui` uses it, only for this and `/stop`); if the engine can't list its modes, `/plan` answers "Plan mode unavailable right now." ([troubleshooting #33](troubleshooting.md#33-ad-tui-plan-says-plan-mode-unavailable-right-now)).
- **Memory.** The clear-context message is written by the client, not by you: ad's memory hooks skip it, so the model's plan is never learned as your words.

## Syntax highlighting

Code in answers (a fenced block that names its language) and the unchanged lines of an edit's diff are coloured by language, as in the engine's own UI: JavaScript and TypeScript (with JSX), Python, Rust, Go, C, C++, C#, Java, JSON (and JSON with comments), YAML, TOML, shell (here-documents too), console sessions (the commands after a `$ ` prompt; their output stays plain), PowerShell, HTML and XML, CSS, SQL and diff. A block in another language, or one over 2,000 lines or 200,000 characters (or a line over 2,000 characters), stays in the plain code colour. Added and removed lines of a diff keep the diff colours; its unchanged lines are coloured as the new file reads, hunk by hunk.

`/theme` chooses the colours: **Select Syntax Theme**, with a code sample and a diff previewing each theme as you move (only the preview: what a running turn adds meanwhile keeps the current theme); Enter saves it as `tui.theme` in the engine's config, Esc keeps the old one. ad ships three: `ansi` (the default: your terminal's own colours, readable on light and dark backgrounds), and `catppuccin-mocha` (dark) and `catppuccin-latte` (light), which become the nearest 256 or 16 colours where the terminal has no truecolor. A theme from the engine's longer list that ad doesn't ship shows as `ansi` in ad, and `/warnings` says so. With `NO_COLOR` set, code has no colours. What is already in the scrollback keeps the colours it was drawn with.

## Vim mode

`/vim` turns on the engine's Vim mode for the prompt (it starts in Normal; `/vim` again turns it off). `tui.vim_mode_default = true` in ad's engine config turns it on from the start, in Insert, as in the engine's own UI. The footer shows **Vim: Normal**, **Vim: Insert** or **Vim: Replace**, and the cursor is a bar in Insert.

- **What the engine's own UI has, ad has:** `i a A I o O R`; `h j k l` and the arrows, `w b e`, `0 $`, `f F t T`, `gg`, `G`; `x s D C r Y p u`, Ctrl+R to redo, `.` to repeat the last change; `d y c` with those motions, `dd yy cc`, and the text objects `iw aw iW aW`, `i( a(` (also `)` and `b`), `i[ a[`, `i{ a{` (also `B`), `i" a" i' a' i` a``; `/` `?` `n` `N` to search (also after an operator: `d/word`). One register, shared with the prompt's Ctrl+K/U/W/Y.
- **What the engine's own UI doesn't have, ad doesn't either:** counts (`3w`), Visual mode, `P`, `X`, `;` and `,`.
- **Keys:** Enter sends in Normal and in Insert (a new line is your newline key, as without Vim); Tab queues. Esc in Insert goes to Normal, never interrupts; in Normal with nothing pending it does what Esc always does (interrupt a turn, Esc Esc to rewind). In Normal `/` and `?` search, so the command popup and the `?` shortcuts open from Insert. `j`/`k` on an empty prompt walk the prompt history. After you send, the new prompt starts in Insert.
- **Undo:** one step is one Normal command, or everything typed between entering Insert and Esc.
- **Not yet like the engine's own UI:** search matches aren't highlighted in the prompt; Backspace in Replace mode only moves left (the engine's own UI puts the old character back); a "[Pasted N lines]" token is plain text to Vim's motions (the engine's own UI moves over it as one character).

## Subagents

When the engine spawns subagents, `/subagents` lists them as the engine's own UI does: **Subagents**, the main conversation first (`Main [default]`), then each agent in the order it appeared, by its nickname and role (`Ada [explorer]`), with its thread id and whether it is running or closed. Pick one to watch it: its own transcript, live, in a pager (↑ ↓, PgUp PgDn; at the bottom it follows what comes in). Alt+← and Alt+→ go to the previous or next agent, round to the main conversation, which closes the pager; from an empty prompt they open the pager on the last or first agent, as in the engine's own UI (⌥← ⌥→ on macOS). q or Esc closes it. With none yet: "No agents available yet."; with subagents switched off (`features.multi_agent = false`), the engine's "Enable subagents?" saves it on for new threads.

The engine's own UI switches its whole view to the agent's thread; ad keeps your conversation where it is and shows the agent beside it, so watching one never changes what your prompts go to.

## Recaps

`/recap` asks for a short catch-up on this conversation, as the engine's own does: what it is for, what is done, and an agreed next step or an open question. It reads the last 8 exchanges (prompts and answers, not tool output; never a `/private` prompt), within the engine's size budget, and asks the engine in a separate, temporary thread that is read-only, has every tool and MCP server off, and runs none of ad's hooks. "Generating conversation recap…" shows meanwhile; the answer is a dim, italic **↳ Recap:** with **Next:** under it. Sending a prompt meanwhile, or any other turn running first (`/compact`, `/review`), drops it, as in the engine's own UI. Not while a turn runs. The engine gets 30 seconds to start the temporary thread and 30 more to answer. The engine's automatic recaps (`tui.auto_recap`, after 30 idle minutes) aren't in ad.

## Auto-review denials

When the engine's automatic approval reviewer (its "auto-review") denies an action, the notice says so and `/approve` lists the denials of this conversation, newest first (the engine keeps the last 10): **Auto-review Denials**, each with its rationale. Picking one records an approval for one retry: the model sees it, and the retry still goes through auto-review. It leaves the list (and stays on it if the engine refuses). Each conversation has its own list, kept while ad runs: a conversation resumed later starts with none. A subagent's denials aren't on it.

## Side conversations

`/side` (or `/btw`) asks something on the side without disturbing the main conversation, as in the engine's own UI: it works while a turn runs, and nothing from it goes back.

- **What it is.** An ephemeral fork of the conversation: the model sees the history as reference, gets the engine's side-conversation instructions, and answers. It runs **read-only, with no approvals and no ad hooks** (the engine's own side conversations keep the main one's permissions; ad's are read-only). It is never saved, so `/resume` doesn't list it.
- **The panel.** It opens under the main conversation's status, with **Side from main thread · <main's state> · ctrl+/ to switch · ctrl+c to close**. The main conversation keeps going above it (its finished output still goes into the scrollback); its approvals come first and hide the panel until answered.
- **Keys.** Enter sends to the side; Esc interrupts only the side's turn; Ctrl+/ moves between the side prompt and the main one; Ctrl+C on an empty prompt closes it. Only the engine's side commands work there (`/copy` copies the side's last answer, `/status`, `/diff`, `/pwd`…); `!` shell commands don't. Images can't be attached to a side question. The side's failures and queued prompts show in the panel.
- **Closing.** The side transcript goes into the scrollback as one block ("Side conversation"), and the fork ends. A new conversation, `/resume` or an engine restart closes it too. One at a time: `/side` from the main prompt goes back to the open one.

## Background terminals

A command the model starts that keeps running, such as a dev server or a watcher, becomes a **background terminal**, as in the engine's own UI. It doesn't hold up the conversation: what the model says after starting it goes into the scrollback at once, and the turn can end while it runs.

- The footer says **N background terminal(s) running · /ps to view · /stop to close**.
- `/ps` lists them with their last 3 output lines (16 at most, then "... and N more running").
- `/stop` (or `/clean`) stops them all: "Stopping all background terminals.". Both work while a turn runs.
- They belong to ad's engine: a new conversation, `/resume` or an engine restart leaves them behind (the engine ends them when it ends), and no other UI sees them.

## Images

- **Paste or drag** an image file's path into the prompt: it attaches to the next prompt. Quoted paths, `file:///C:/…` and `%20` work. A file name inside a sentence stays text.
- **`/image <path>`** does the same; a plain file name in this folder works too. Types: `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`.
- **Esc** on an empty prompt removes the attachments.
- **A clipboard image** (a screenshot you copied) can't be pasted into a terminal. ad says so: save it as a file, then use its path. Windows Terminal keeps Ctrl+V for its own paste.

---

## `/undo`

`/undo` puts back the files the last turn's edits changed, then rewinds the conversation to before that turn. Your prompt comes back in the composer.

**How it works.** In a git repo, while `ad tui` runs, ad takes a snapshot of your working folder before and after each turn.
- The "before" snapshot is started when you press Enter, so everything you saved before sending is in it. The turn starts once it is done (usually well under a second; up to 10 s on a very large folder or a busy machine), so nothing the agent does can be in it. Not done in 10 s: that turn gets no checkpoint, ad never guesses. (Snapshots while you type only warm git's caches.)
- The "after" snapshot is started once the turn has ended.
- Snapshots are git trees under `refs/ad/checkpoints/<thread>/`. Nothing goes into the engine's session files.
- ad uses its own index (`.git/ad-checkpoint-index`). Your index, HEAD, branches and stash are never touched.
- `.gitignore` is respected. Untracked files over 2 MB and heavy folders (`node_modules`, `.venv`, `dist`, `build`, `target`, …) are skipped, and so is ad's own `.agent-daemon/` (its hooks write there during every turn).
- The last 20 turns per conversation are kept, and about 200 turns over all conversations.

**What it undoes.** Only the last finished turn, and only the files the agent's own edits reported. Anything else that changed during the turn is a conflict, not something to undo blindly:

| Conflict | Means |
|---|---|
| `not changed by the agent's edits` | the file changed during the turn some other way: a command the agent ran, your editor, another tool |
| `changed during the turn` | more of the file changed during the turn than the agent's own edits account for: you saved it (or a command changed it) before or between the agent's edits. `force` doesn't override this: your change would go too |
| `changed since the agent's edit` | the agent edited it, and it changed after that: you, your editor's format-on-save, a formatter the agent ran, during the turn or after it. Each edit is hashed as it lands |
| `a folder is there now` | a folder stands where the file was |
| `a file is where its folder was` | a file (or symlink) now stands where one of the path's folders was |
| `not in the checkpoint` | the agent edited a file the snapshots leave out (over 2 MB, or in a heavy folder): there is nothing to put back |

With any conflict, plain `/undo` changes nothing and lists them:

```
Not undone: src/app.js (changed since the agent's edit). /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched.
```

`/undo force` overrides the "changed since…" conflicts only: those files are put back too, discarding what changed after the agent's edit (yours or a formatter's), and the rest of the turn is undone. Files with any other conflict are left alone, forced or not, and `/undo` never removes or replaces a folder. The result says how many were "left alone (not the agent's edit, changed during the turn, not in the checkpoint, or a folder or file stands in the way)". Only edits that were applied count: a patch you declined isn't the agent's change.

**Your own work.** A save of yours during the turn, or after the agent's edit, is a conflict, so plain `/undo` never takes it. `/undo force` does discard changes made after the agent's edit to a file the agent edited; look at `/diff` first.

**When there is no checkpoint,** `/undo` says why:
- the snapshot before the turn wasn't ready in time;
- snapshots fail in this repo (with git's message), or the snapshot after the turn failed;
- the turn wasn't started from a prompt here (the engine started it: a review, a goal);
- one of the agent's edits couldn't be read back;
- the turn ran before `ad tui` started.

**Limits.**
- Only turns that ran in `ad tui`, in a git repo, can be undone. Outside a git repo `/undo` says it isn't available.
- Ignored files, submodule contents and LFS files are not restored.
- Restores are byte for byte with git 2.40 or later. With older git, or with `.git/info/attributes` or `core.attributesFile` set, files with eol rules may come back normalized, and `/undo` says so.
- Wait for the turn to finish (or Esc) before `/undo`.
- `/undo` never takes your git index lock: you can run git while it works.

To drop every checkpoint in a repo, delete the refs, then the private index file:

```bash
git for-each-ref --format="delete %(refname)" refs/ad/checkpoints | git update-ref --stdin
rm -f .git/ad-checkpoint-index
```

Esc Esc rewinds the conversation only; `/undo` rewinds the conversation **and** the files.

---

## ad's own features

- **Memory in.** ad's hooks run as in every harness session. When they recall learnings for your prompt, a row says "Recalled N learnings". The header shows how many learnings ad has. The agent can also search ad's memory itself through the `agent-daemon-memory` MCP tools (`memory_search` …); they run without an approval prompt unless you set an approval mode for that server.
- **Memory out.** After a turn, a "Learned:" row shows what ad recorded from it. What the hooks capture is saved to memory when ad next starts; until then `/memory` lists it as captured.
- **`/remember <text>`** saves a note straight to the project's memory.
- **`/memory`** summarizes the store. `search <words>` and `recent` list learnings with their `#id`. `forget <id>` archives one of this project's (or global) learnings: it is never deleted, just no longer recalled. `profile` shows what ad knows about how you work.
- **`/private`** wraps every prompt in `<private>…</private>` until you turn it off. ad's extractors drop private text, so nothing in it is learned. The footer shows `private`, and the transcript shows each such prompt as typed, marked "(private)".
- **Guards.** When one of ad's guard hooks blocks a command, a row says why.
- **`/proposals`** lists skill changes ad proposes (`.agent-daemon/proposed/`). Review them with `/ad review`.
- **`/loop "<objective>"`** starts `ad loop` in the background, with its own engine and all of `ad loop`'s brakes (and on Windows its sandbox check). The TUI shows one row per iteration, a `loop N` chip, and a row when it ends. `/loop` alone shows its state. `/loop stop` writes `.agent-daemon/STOP`, so it stops after its current turn; ad removes that STOP file once the loop has ended. The loop keeps working if you quit the TUI. A STOP file you wrote yourself (here or in `~/.agent-daemon/`) is respected, and refuses a new `/loop`. Its output goes to `.agent-daemon/loop-tui.log`.
- **`/team [id]`** shows the team board (the newest team, or the one you name).
- **`/schedule`** lists scheduled jobs; `/schedule run <id>` runs one now. The header warns when jobs are overdue because nothing runs the scheduler (`ad watch` or `ad service install`).
- **`/tools`** runs `ad tools …`, and `/ad <command>` runs any ad command (`/ad doctor`, `/ad sandbox status`). The terminal is handed to the command and comes back when it ends.

---

## `/codex` is gone

`ad codex` and `/codex` (the engine's own UI) were removed in 3.0. Typing `/codex` prints what to use instead: `ad --last` resumes a conversation, and the engine's settings file holds the settings.

---

## Files ad writes

| Path | What |
|---|---|
| `~/.agent-daemon/tui/history.jsonl` | your prompt history (owner-only, 0600). Masked answers are never stored |
| `~/.agent-daemon/tui/state.json` | when you last used each folder, for "Since last time" |
| `~/.agent-daemon/tui/chat-hint-shown` | marks the one-time `ad chat` hint (that bare `ad` opens the TUI) as shown |
| `~/.agent-daemon/locks/` | conversation locks, so two `ad`s never write one conversation |
| `~/.agent-daemon/sessions/` | the session record: which account and model ran each turn, and what each tool call did (`/status` names the session; `ad sessions show --last` prints it). Never reasoning, a question's or form's answer, file contents, command output, headers or keys; see [harness.md](harness.md#the-session-record-ad-sessions-show) |
| `~/.agent-daemon/tui/prefs.json` | ad's own TUI preferences (owner-only), for what the engine has no setting for: `clear.keepScrollback`, `prompt.atBottom` |
| `~/.agent-daemon/engine/config.toml` | folder trust (`projects`), as the engine keeps it, and the engine's own TUI settings (`tui.status_line`, `tui.terminal_title`, `tui.theme`, `tui.vim_mode_default`): an item ad can't show stays there (`/warnings` lists it). `tui.keymap` is read, never written by ad |
| `~/.agent-daemon/engine/skills/` | the mirror of `~/.claude/skills` for the engine |
| `<repo>/.git/ad-checkpoint-index`, `refs/ad/checkpoints/` | `/undo` snapshots |
| `<project>/.agent-daemon/loop-tui.log`, `STOP` | `/loop` output, and its stop file |
| `<folder>/ad-conversation-<time>.md` | `/export` (or the name you give) |
| a temp folder `ad-prompt-*` | the Ctrl+G file; removed afterwards |

Everything else (conversations, logs, login) is the engine's own, in ad's engine home; see [harness.md](harness.md#files-and-environment-variables).

---

## Terminals

| Terminal | Notes |
|---|---|
| Windows Terminal | The main target. 1.24 sends Shift+Enter as Enter: use Ctrl+Enter, or add the binding `/terminal-setup` prints. 1.25 tells them apart. Ctrl+V and Alt+Enter belong to the terminal. |
| Zed | The main target. Shift+Enter is a newline with no setup. |
| VS Code | Shift+Enter is Enter until you add the keybinding `/terminal-setup` prints; Ctrl+J always works. |
| Git Bash (mintty) | Can't pass keys to ad: run `winpty ad tui`, or open Git Bash inside Windows Terminal. |
| `TERM=dumb` | No UI: use `ad chat`. |

- **Windows needs Node 22.17+ or 24.2+.** Older versions turn a multi-line paste into one message per line. Upgrade 22.x to 22.17+ or 24.x to 24.2+ (same native-module ABI, nothing to rebuild); from 23.x, move to 24.2+ and run `npm rebuild` in `runtime/`.
- **`/terminal-setup`** prints the exact setting for your terminal. It changes nothing itself.
- **Resizing.** History in the scrollback is never repainted. If a terminal leaves stray copies of the bottom lines after you make the window narrower, Ctrl+L redraws (see [troubleshooting #25](troubleshooting.md#25-ghost-copies-of-the-bottom-lines-after-narrowing-the-window)).
- **Check what your terminal sends:** `node runtime/scripts/tui-probe.mjs keys` and `screen` ([troubleshooting #22](troubleshooting.md#22-keys-or-paste-behave-oddly-in-a-terminal)).

---

## When something goes wrong

| Symptom | See |
|---|---|
| "needs an interactive terminal" or "needs Node 22.17+" | [troubleshooting #23](troubleshooting.md#23-ad-tui-says-it-needs-an-interactive-terminal-or-node-2217) |
| Shift+Enter sends instead of adding a newline | [#24](troubleshooting.md#24-ad-tui-shiftenter-sends-instead-of-adding-a-newline) |
| ghost copies of the bottom lines after narrowing | [#25](troubleshooting.md#25-ghost-copies-of-the-bottom-lines-after-narrowing-the-window) |
| `/undo` refuses: "Not undone: …" | [#26](troubleshooting.md#26-undo-refuses-not-undone) |
| "ad's engine stopped (exit N)" | [#27](troubleshooting.md#27-ad-tui-ads-engine-stopped-exit-n) |
| Ctrl+G returns at once | [#28](troubleshooting.md#28-ad-tui-the-editor-ctrlg-returned-at-once) |
| Windows: the first command or edit takes ~35 s | [#29](troubleshooting.md#29-windows-the-first-command-or-edit-after-installing-takes-35-s) |
| Windows: every command fails with `CreateProcessAsUserW failed` or "Access is denied" | [#16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-access-is-denied-or-createprocessasuserw-failed) |
| keys or paste behave oddly | [#22](troubleshooting.md#22-keys-or-paste-behave-oddly-in-a-terminal) |
| keys set elsewhere → `/keymap` don't work in ad | [#30](troubleshooting.md#30-ad-tui-keys-set-outside-ad-dont-work-in-ad) |
| `/clear` wiped the scrollback | [#31](troubleshooting.md#31-ad-tui-clear-wiped-my-scrollback) |
| the window title still says ad's after it ended | [#32](troubleshooting.md#32-the-terminals-title-still-says-ads-after-ad-ended) |
| `/plan` says "Plan mode unavailable right now." | [#33](troubleshooting.md#33-ad-tui-plan-says-plan-mode-unavailable-right-now) |
| `/recap`: "Could not generate a recap. Please try again." | [#34](troubleshooting.md#34-ad-tui-recap-says-could-not-generate-a-recap-please-try-again) |
| `/approve` lists nothing, or "invalid Guardian denial event" | [#35](troubleshooting.md#35-ad-tui-approve-says-no-recent-auto-review-denials-in-this-thread-or-invalid-guardian-denial-event) |
| `/setup-default-sandbox` refuses or fails | [#36](troubleshooting.md#36-ad-tui-setup-default-sandbox-refuses-or-fails) |
| "The engine reported a problem", or an upstream name in raw details or an OS prompt | [#39](troubleshooting.md#39-what-ad-cant-rename) |
| "Pick a project folder" at start, or `/cd` says a folder would load your own skills from `~/.codex/` | [#48](troubleshooting.md#48-pick-a-project-folder-or-run-this-in-a-project-folder) |
| "This session is open in another ad window", "couldn't write this session's record" | [#73](troubleshooting.md#73-this-session-is-open-in-another-ad-window-or-ad-couldnt-write-this-sessions-record) |
| "Couldn't switch to …", "the engine kept the old provider", "history carried over … left out" | [#74](troubleshooting.md#74-couldnt-switch-to--still-on-) |
| `/fallback` shows "skipped" rows, or "None of these targets fits …" | [#77](troubleshooting.md#77-fallback-never-switches-or-a-target-says-skipped-now) |
| "Fallback is off: … changed since you confirmed the order" | [#78](troubleshooting.md#78-fallback-is-off--changed-since-you-confirmed-the-order-or-it-turned-itself-off) |
| "⏸ Paused: … may still be running from the failed turn" | [#79](troubleshooting.md#79-fallback-paused-may-still-be-running-from-the-failed-turn) |
| "⏸ Paused: … is still running in the background" | [#80](troubleshooting.md#80-fallback-paused-still-running-in-the-background) |
| "⏸ Paused: fallback is switching too often", "the fallback budget is used up" | [#81](troubleshooting.md#81-fallback-paused-switching-too-often-or-the-fallback-budget-is-used-up) |
| an engine command says "isn't in ad yet" | [commands.md](commands.md) |
| not signed in, sandbox, hooks, your own install's home refused | [harness.md](harness.md#when-something-goes-wrong), troubleshooting #14–21 |

`/warnings` lists the notices of this session, the engine's raw error and notice details (up to eight lines each), and any events this ad doesn't know (a newer engine). The main screen uses ad's words; raw details appear only when requested. `/status` shows the engine version ad was tested with. `ad doctor` checks the engine, login, hooks and sandbox.
