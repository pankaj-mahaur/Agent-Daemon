# `ad tui`: the terminal UI

`ad tui` is a Codex-style terminal UI for agent-daemon's harness. It drives the same pinned Codex engine as `ad chat`, in ad's own Codex home (`~/.agent-daemon/codex-home`), with ad's memory, hooks and skills wired in. Your own `~/.codex` is never used.

It runs inline, like Codex's own UI. Finished output goes into your terminal's normal scrollback, so scrolling, selecting and copying work as usual. Only the bottom of the screen (the running turn, the composer and the footer) is redrawn.

It is new. If something gets in the way, `ad chat` is the plain line mode and stays available. The design is in [plans/ad-tui.md](plans/ad-tui.md).

- [Starting it](#starting-it)
- [First run](#first-run)
- [The screen](#the-screen)
- [Keys](#keys)
- [Approvals and questions](#approvals-and-questions)
- [Slash commands](#slash-commands)
- [Images](#images)
- [`/undo`](#undo)
- [ad's own features](#ads-own-features)
- [`ad codex` and `/codex`](#ad-codex-and-codex)
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
| `--resume <id>` | resumes that conversation |
| `--cwd <dir>` | works in another folder |
| `--model <name>` | the model for new turns (`/model` changes it later) |
| `--sandbox <mode>` | `read-only`, `workspace-write` (default) or `danger-full-access` |

A conversation is open in one `ad` at a time. Resuming one that another `ad` has open says so and changes nothing.

On exit, ad prints how to continue: `ad tui --resume <id>`, with the tokens used.

**Bare `ad`** (and `ad --last`) opens the TUI whenever the terminal can show it. `AD_TUI=0` turns that off, so bare `ad` prints the help. If the TUI can't run here, bare `ad` prints the reason and the help instead. `ad chat` stays the plain line mode.

**Requirements.** An interactive terminal (stdin and stdout are TTYs), `TERM` not `dumb`, and on Windows Node 22.17+ or 24.2+ (not 23.x or 24.0–24.1). Otherwise `ad tui` exits with the reason and a command that works:

| Where | What ad says |
|---|---|
| a pipe or a script | needs an interactive terminal: use `ad chat` |
| `TERM=dumb` | this terminal can't show the UI: use `ad chat` |
| Windows, older Node | needs Node 22.17+ or 24.2+: upgrade within 22.x, or use `ad chat` |
| mintty (Git Bash's window) | run `winpty ad tui`, or use Windows Terminal |

`ad tui --preview` still runs the earlier walking skeleton.

---

## First run

1. **Sign in.** If ad isn't signed in to Codex yet, a sign-in panel opens:

   | Choice | Runs |
   |---|---|
   | ChatGPT | `ad auth login chatgpt` (browser) |
   | OpenAI API key | `ad auth login openai` (kept in ad's secret store) |
   | OpenRouter | `ad auth login openrouter` (key and model) |

   The terminal is handed to that command and comes back when it finishes. Esc closes the panel and exits. `/login` does the same later; `/logout` signs out.
2. **Trust the folder.** The first time in a folder, ad asks whether you trust it. Trusted folders may load their own `.codex` config, hooks and skills. The answer is saved once per folder in ad's Codex home (`config.toml`, `projects`). Your home folder is never asked about.
3. **The header** appears, then the composer. Type and press Enter.

---

## The screen

```
╭────────────────────────────────────────────────────────────────────────────╮
│ >_ Agent Daemon (v2.1.0) · on Codex 0.160.0 (tested)                       │
│                                                                            │
│ model:     gpt-5.x-codex medium · ChatGPT Go        /model to change       │
│ directory: D:\…\my-projects\app · git: dev                                 │
│ memory:    142 learnings                            /memory                │
│ sandbox:   workspace-write · asks first                                    │
╰────────────────────────────────────────────────────────────────────────────╯
  Since last time: loop ran (6 iter) · schedule daily ran · 2 skill proposals

  Try /review · /goal · /resume · /codex = stock Codex UI · ? for shortcuts

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
- **Cells.** Prompts (`›`), answers, commands (Explored, Ran, Failed (exit N), Declined, with the last lines of output), edits (`Edited N files (+A -R)` with a diff), plans, tool calls and notices. A turn ends with "Worked for Ns".
- **ad rows** are one dim line each, and only when something happens: recalled learnings, a guard that blocked a command, a hook that failed, what ad learned, loop iterations.
- **Status line** (while a turn runs): what Codex is doing, the time, and `esc to interrupt`. Queued prompts are listed under it; the last one says `tab: edit`.
- **Footer.**
  - Left: key hints. Idle: `? shortcuts · @ files · <newline key> newline`. While a turn runs: `enter steer · tab queue · <newline key> newline`.
  - Right: meters and chips.
    - `ctx N%` is the context left in this conversation.
    - `5h N%` is how much of the current usage window is used.
    - A meter turns amber at 80 % used.
    - `private` shows while `/private` is on, and `loop N` while a background loop runs.
  - **When the footer is too narrow**, the key hints go first (from the end), then chips shorten (`loop 3` → `L3`, `private` → `P`), then chips go, and the meters go last.

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
| `!cmd` | run `cmd` in the shell, **unsandboxed** (like Codex's `!`). One line only; a multi-line paste starting with `!` is a prompt |
| Ctrl+T | page through the whole transcript (↑ ↓, PgUp, PgDn or Space, Home, End; Esc, `q` or Ctrl+T closes) |
| Alt+, / Alt+. | lower / raise the reasoning effort for the next turn, through the current model's own levels |

The terminal bell rings when an approval waits, and when a turn ends while the terminal window isn't focused.

---

## Approvals and questions

When Codex wants to do something it needs permission for, the request opens as a box over the composer. Its full text also goes into the scrollback, and so does your answer ("approved", "approved for this session" or "declined").

| Request | Choices (key) |
|---|---|
| Run a command | Yes (`y`) · Yes, and don't ask again this session (`a`) · Yes, and don't ask again for commands starting with `<prefix>` (`p`) · Yes, and always allow `<host>` (`h`) · No, and tell Codex what to do instead (`n`) · No, and stop (`esc`) |
| Edit files (the diff is shown) | Yes (`y`) · Yes, and don't ask again for these files this session (`a`) · No, and tell Codex what to do instead (`n`) · No, and stop (`esc`) |
| More permissions | Yes, for this turn (`y`) · Yes, for this session (`a`) · No (`n`) |

A command request lists only what Codex offers for that command, so `p` and `h` appear only sometimes.

- **Answering:** press the key, press the option's number, or move with ↑ / ↓ and press Enter.
- **Arming.** An answer that grants something is taken only 400 ms after the box opened and after your last key. A key pressed too early restarts the wait. Type-ahead, a held key or a paste never approves. Declining works at once.
- **Hidden characters** in a command or a diff (control characters, bidi marks, zero-width or look-alike spaces) are shown as `<U+XXXX>`, so a command can't hide part of itself.
- **Long requests** scroll inside the box with PgUp / PgDn.
- **Questions** from Codex list numbered options plus Skip (`esc`), or take free text. Secret answers are masked and never stored in history.
- **Forms** from an MCP server offer Submit (`y`; "Open it, then continue" for a link), Decline (`n`) and Cancel (`esc`).
- A request ad doesn't support yet is declined, and ad says "This needs the stock UI: /codex".

---

## Slash commands

Type `/` to see them with a one-line hint each. Commands marked "Codex" keep Codex's meaning; the others are ad's own.

**Conversations**

| Command | What it does |
|---|---|
| `/new` | start a new conversation (Codex) |
| `/resume` | continue an earlier conversation (Codex) |
| `/fork` | continue in a copy of this conversation (Codex) |
| `/rename <name>` | name this conversation (Codex) |
| `/compact` | summarize the conversation to free context (Codex) |
| `/export [name]` | save the conversation as markdown in this folder (Codex). Never overwrites, never writes outside the folder |
| `/quit`, `/exit` | exit ad (Codex) |

**Settings**

| Command | What it does |
|---|---|
| `/model` | choose the model and reasoning effort (Codex) |
| `/permissions` | what Codex may do without asking: Read only, Auto (default: edits this folder, asks for the rest), Full access (Codex) |
| `/login [chatgpt\|openai\|openrouter]` | sign in (ChatGPT, OpenAI key, OpenRouter); Codex restarts with the new login |
| `/logout` | sign out of Codex in ad's home (Codex) |

Model, effort and permission changes apply from the next turn.

**Work**

| Command | What it does |
|---|---|
| `/goal [<objective>\|clear]` | set a goal for this conversation (`/goal clear`); alone, shows it (Codex) |
| `/review` | review your uncommitted changes (Codex) |
| `/diff` | show git changes, untracked files included (Codex) |
| `/init` | create an AGENTS.md for this repo, with Codex's own prompt (Codex) |
| `/image <path>` | attach an image file to the next prompt |
| `/undo [force]` | put back the files the last turn changed, and rewind it (below) |

**Output**

| Command | What it does |
|---|---|
| `/copy` | copy the last answer to the clipboard (Codex) |
| `/raw` | print the last answer as plain text, for selecting (Codex) |

**Inspection**

| Command | What it does |
|---|---|
| `/status` | account, model, sandbox, tokens, limits, and the Codex version line (Codex) |
| `/usage` | usage limits and tokens (Codex) |
| `/mcp` | MCP servers and their status (Codex) |
| `/hooks` | hooks and whether they are trusted; ad's own are marked (Codex) |
| `/skills` | skills Codex can use here (Codex) |
| `/warnings` | notices kept from this session, and events this ad doesn't know (Codex) |

**ad**

| Command | What it does |
|---|---|
| `/remember <text>` | save a note to ad's project memory |
| `/memory [search <words>\|recent\|forget <id>\|profile]` | ad's memory (not Codex's `/memories`) |
| `/private` | toggle: prompts are wrapped in `<private>` (ad never learns from them) |
| `/proposals` | skill changes ad proposes (review with `/ad review`) |
| `/loop "<objective>"` | work toward an objective in the background (`/loop stop`) |
| `/team [id]` | the team board |
| `/schedule [run <id>]` | scheduled jobs |
| `/tools [list\|enable\|disable <tool>]` | optional agent tools (`/tools enable browser`) |
| `/codex [args]` | open the stock Codex UI on this conversation |
| `/ad <command>` | run an ad command, e.g. `/ad doctor` |

**Help**

| Command | What it does |
|---|---|
| `/help` | what you can do here: every command and shortcut |
| `/terminal-setup` | how to make Shift+Enter add a newline in this terminal |

A Codex command ad doesn't have yet answers "Unknown command … /help lists them"; `/codex` runs the stock UI, which has it.

---

## Images

- **Paste or drag** an image file's path into the prompt: it attaches to the next prompt. Quoted paths, `file:///C:/…` and `%20` work. A file name inside a sentence stays text.
- **`/image <path>`** does the same; a plain file name in this folder works too. Types: `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`.
- **Esc** on an empty prompt removes the attachments.
- **A clipboard image** (a screenshot you copied) can't be pasted into a terminal. ad says so: save it as a file, then use its path. Windows Terminal keeps Ctrl+V for its own paste.

---

## `/undo`

`/undo` puts back the files the last turn's edits changed, then rewinds the conversation to before that turn. Your prompt comes back in the composer.

**How it works.** In a git repo, while `ad tui` runs, ad takes a snapshot of your working folder before and after each turn.
- The "before" snapshot is started when you press Enter, so everything you saved before sending is in it. Sending doesn't wait for it. If the agent starts an edit before the snapshot is done, that turn gets no checkpoint: ad never guesses. (Snapshots while you type only warm git's caches.)
- The "after" snapshot is started once the turn has ended.
- Snapshots are git trees under `refs/ad/checkpoints/<thread>/`. Nothing goes into Codex's session files.
- ad uses its own index (`.git/ad-checkpoint-index`). Your index, HEAD, branches and stash are never touched.
- `.gitignore` is respected. Untracked files over 2 MB and heavy folders (`node_modules`, `.venv`, `dist`, `build`, `target`, …) are skipped.
- The last 20 turns per conversation are kept, and about 200 turns over all conversations.

**What it undoes.** Only the last finished turn, and only the files the agent's own edits reported. Anything else that changed during the turn is a conflict, not something to undo blindly:

| Conflict | Means |
|---|---|
| `not changed by the agent's edits` | the file changed during the turn some other way: a command the agent ran, your editor, another tool |
| `changed since the agent's edit` | the agent edited it, and it changed after that: you, your editor's format-on-save, a formatter the agent ran, during the turn or after it. Each edit is hashed as it lands |
| `a folder is there now` | a folder stands where the file was |
| `a file is where its folder was` | a file (or symlink) now stands where one of the path's folders was |
| `not in the checkpoint` | the agent edited a file the snapshots leave out (over 2 MB, or in a heavy folder): there is nothing to put back |

With any conflict, `/undo` changes nothing and lists them:

```
Not undone: src/app.js (changed since the agent's edit). /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched.
```

`/undo force` overrides "changed since the agent's edit" only: those files are put back too, discarding what changed after the agent's edit (yours or a formatter's). Every other conflict stays: forced or not, `/undo` never touches those files and never removes or replaces a folder; they are reported as left alone. Only edits that were applied count: a patch you declined isn't the agent's change.

**When there is no checkpoint,** `/undo` says why: the snapshot before the turn wasn't ready in time, snapshots fail in this repo (with git's message), or the turn ran before `ad tui` started.

**Limits.**
- Only turns that ran in `ad tui`, in a git repo, can be undone. Outside a git repo `/undo` says it isn't available.
- Ignored files, submodule contents and LFS files are not restored.
- Restores are byte for byte with git 2.40 or later. With older git, or with `.git/info/attributes` or `core.attributesFile` set, files with eol rules may come back normalized, and `/undo` says so.
- Wait for the turn to finish (or Esc) before `/undo`.
- `/undo` never takes your git index lock: you can run git while it works.

To drop every checkpoint in a repo:

```bash
git for-each-ref --format="delete %(refname)" refs/ad/checkpoints | git update-ref --stdin
```

Esc Esc rewinds the conversation only; `/undo` rewinds the conversation **and** the files.

---

## ad's own features

- **Memory in.** ad's hooks run as in every harness session. When they recall learnings for your prompt, a row says "Recalled N learnings". The header shows how many learnings ad has.
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

## `ad codex` and `/codex`

```bash
ad codex                         # the pinned Codex's own UI, on ad's home
ad codex resume --last           # any codex arguments
```

`ad codex` runs the stock Codex UI from the same pinned Codex, with `CODEX_HOME` set to ad's home (never `~/.codex`) and `--no-daemon`, so it never talks to your own Codex or its daemon. Provider keys come from ad's secret store.

Codex reads skills only from its home, so your `~/.claude/skills` are mirrored into the home's `skills/` folder first. Only folders ad created there are ever replaced or removed. Project `.claude/skills` aren't visible in `ad codex`.

**`/codex`** inside `ad tui` opens the stock UI on the **same conversation**. ad lets go of the conversation meanwhile (one writer at a time), and resumes it when you quit the stock UI. What was already in the scrollback stays; only the new turns show. Use it for a Codex feature ad doesn't have yet.

---

## Files ad writes

| Path | What |
|---|---|
| `~/.agent-daemon/tui/history.jsonl` | your prompt history (owner-only, 0600). Masked answers are never stored |
| `~/.agent-daemon/tui/state.json` | when you last used each folder, for "Since last time" |
| `~/.agent-daemon/tui/chat-hint-shown` | marks the one-time `ad chat` hint as shown (after the TUI becomes the default) |
| `~/.agent-daemon/locks/` | conversation locks, so two `ad`s never write one conversation |
| `~/.agent-daemon/codex-home/config.toml` | folder trust (`projects`), as Codex keeps it |
| `~/.agent-daemon/codex-home/skills/` | the mirror of `~/.claude/skills` for `ad codex` |
| `<repo>/.git/ad-checkpoint-index`, `refs/ad/checkpoints/` | `/undo` snapshots |
| `<project>/.agent-daemon/loop-tui.log`, `STOP` | `/loop` output, and its stop file |
| `<folder>/ad-conversation-<time>.md` | `/export` (or the name you give) |
| a temp folder `ad-prompt-*` | the Ctrl+G file; removed afterwards |

Everything else (conversations, logs, login) is Codex's own, in ad's Codex home; see [harness.md](harness.md#files-and-environment-variables).

---

## Terminals

| Terminal | Notes |
|---|---|
| Windows Terminal | The main target. 1.24 sends Shift+Enter as Enter: use Ctrl+Enter, or add the binding `/terminal-setup` prints. 1.25 tells them apart. Ctrl+V and Alt+Enter belong to the terminal. |
| Zed | The main target. Shift+Enter is a newline with no setup. |
| VS Code | Shift+Enter is Enter until you add the keybinding `/terminal-setup` prints; Ctrl+J always works. |
| Git Bash (mintty) | Can't pass keys to ad: run `winpty ad tui`, or open Git Bash inside Windows Terminal. |
| `TERM=dumb` | No UI: use `ad chat`. |

- **Windows needs Node 22.17+ or 24.2+.** Older versions turn a multi-line paste into one message per line. Upgrade within 22.x (same ABI, nothing to rebuild).
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
| "Codex stopped (exit N)" | [#27](troubleshooting.md#27-ad-tui-codex-stopped-exit-n) |
| Ctrl+G returns at once | [#28](troubleshooting.md#28-ad-tui-the-editor-ctrlg-returned-at-once) |
| Windows: the first command or edit takes ~35 s | [#29](troubleshooting.md#29-windows-the-first-command-or-edit-after-installing-takes-35-s) |
| keys or paste behave oddly | [#22](troubleshooting.md#22-keys-or-paste-behave-oddly-in-a-terminal) |
| not signed in, sandbox, hooks, "Access is denied" | [harness.md](harness.md#when-something-goes-wrong), troubleshooting #14–21 |

`/warnings` lists the notices of this session and any events this ad doesn't know (a newer Codex). `/status` shows the Codex version ad was tested with. `ad doctor` checks the engine, login, hooks and sandbox.
