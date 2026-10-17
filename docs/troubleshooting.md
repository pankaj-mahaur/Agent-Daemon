# Troubleshooting

Common failure modes and how to diagnose them. Each entry: **symptom → root cause → fix**.

---

## 0. Daemon ran for days, captured zero learnings (v0.2.x → v0.3 migration)

**Symptom:** Two days of real Claude work, `.agent-daemon/sessions.jsonl` doesn't exist (or only has `digested: false, learnings_extracted: 0` lines), `activeContext.md` is unchanged.

**Root cause (any one of these stacks):**
- You're using the **VS Code Claude Code extension**, which misses ~30% of `SessionEnd` hook fires. Terminal `claude` CLI is more reliable.
- Claude emitted the digest block with the **wrong tag** (`<agent-daemon:digest>` with a colon instead of `<agent-daemon-digest>` with a hyphen) — v0.2 parser silently rejected.
- Claude emitted **YAML** inside the block instead of JSON — v0.2 parser silently rejected.
- Claude **forgot to emit any block** at session end. Most common.

**Fix (v0.3+):**
1. Upgrade: `git pull && npm install && npm link` in the agent-daemon repo.
2. Re-run `ad init` in each project. This wires the new `UserPromptSubmit` hook (`ad hook user-prompt-extract`) — fires before every user turn, extracts learnings from corrections / decisions / gotchas / explicit `"remember: X"` notes via regex. **Works in VS Code extension.**
3. Verify: `cat ~/.claude/settings.json | grep user-prompt-extract` → should match. Then talk to Claude normally and check `.agent-daemon/learning-journal.jsonl` grows.
4. The v0.3 parser also accepts both tag forms + JSON or YAML if Claude does emit a block.

The historical sessions before this upgrade can't be retroactively recovered without a working LLM fallback (see entry #6) — the digest blocks weren't there to parse.

---

## 1. `ad: command not found` after `npm link`

**Symptom:** Newly linked, but the shell can't find `ad`.

**Root cause:** Your global npm bin directory isn't on `PATH`.

**Fix:**

```sh
# Find where npm installs global bins
npm bin -g

# Add it to PATH (PowerShell, persistent)
$npmBin = npm bin -g
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$npmBin", "User")

# Or run from a new shell — sometimes the link only registers there
```

Verify: `Get-Command ad` (PowerShell) or `which ad` (bash).

---

## 2. `ad watch` runs but never logs `+ add` / never fires digest

**Symptom:** `ad watch --verbose` shows `monitoring N path(s)` but no events appear when you create new Claude Code sessions. `sessions.jsonl` doesn't grow.

**Root cause:** `chokidar` (the underlying file-watch library) is unreliable on some Windows configs — particularly when transcript files are deep under `~/.claude/projects/<encoded>/` and the file is written by a different process tree.

**Fix:**

- Confirm transcripts ARE being created:
  ```powershell
  Get-ChildItem "$env:USERPROFILE\.claude\projects\<encoded>" -Filter "*.jsonl" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime
  ```
- If they exist but watch missed them, use the manual one-shot:
  ```sh
  cd /path/to/project
  ad digest-latest --verbose
  ```
- For a longer-term fix, polling can be forced via `AGENT_DAEMON_WATCH_POLL=1`. On Windows it's already on by default in v0.2.0+.

**Tracking:** GitHub issue [#TODO] — replacing chokidar with native polling is on the roadmap.

---

## 3. `agent-daemon: skipped (below threshold ...)`

**Symptom:** `ad digest` prints `skipped (below threshold)` and doesn't process.

**Root cause:** The session was too short — under 5 minutes, under 5 tool calls, zero edits. Triage skips trivial sessions by design.

**Fix:**

```sh
ad digest --transcript <path> --cwd <project> --force
# or simpler:
ad digest-latest --verbose  # --force is default-on
```

The `--force` flag bypasses triage. The session log will still record the run.

---

## 4. `agent-daemon: no <agent-daemon-digest> block found in transcript`

**Symptom:** Digest runs but extracts zero learnings.

**Root cause:** Claude didn't follow the ending protocol — never emitted the digest block.

**Fix options** (any one works):

1. **Best — ask Claude explicitly before ending the session:**
   > *"emit the agent-daemon digest block before ending"*

2. **Use LLM fallback** (costs ~$0.005/session):
   ```sh
   ad digest --transcript <path> --cwd <project> --fallback-to-llm --force
   ```
   The fallback uses your local `claude` CLI to extract learnings post-hoc, or ad's engine with `--llm ad` (`--llm auto` falls back to ad's engine when `claude` isn't installed).

3. **Make it stick** — add a reminder to `AGENTS.md` or `CLAUDE.md`:
   ```
   ## Ending protocol
   Before ending any meaningful session, emit a <agent-daemon-digest> block
   as defined in constitution/ending-protocol.md.
   ```

---

## 5. LLM fallback fails with `Error: write EOF`

**Symptom:**
```
[claude] spawn: claude "--print" "--output-format" ...
Error: write EOF
```

**Root cause:** Your local `claude` CLI version doesn't accept one of the flags the digest pipeline passes. Probably a CLI version mismatch.

**Fix:**

- Confirm your CLI version:
  ```sh
  claude --version
  ```
- Update if behind: see the official Claude Code install docs.
- As a workaround, skip the LLM fallback entirely and rely on agent-emitted blocks (see #4).

**Tracking:** This is a known issue with `runtime/src/claude.mjs` flag compatibility.

---

## 6. `SessionEnd` hook never fires (VS Code Claude Code extension)

**Symptom:** You're using the **VS Code extension**. Hooks register correctly in `~/.claude/settings.json`, but `SessionEnd` never executes when you close a chat.

**Root cause:** The VS Code Claude Code extension doesn't reliably fire `SessionEnd` hooks. This is upstream (extension-side) behavior, not a daemon bug. The terminal `claude` CLI fires them correctly.

**Fix:**

- Use `ad watch` to detect transcript files settling instead of relying on hooks
- Or use `ad digest-latest` manually after each session
- Or switch to the terminal `claude` CLI for sessions you want digested

---

## 7. Memory files still show `{{PLACEHOLDER}}` after digest runs

**Symptom:** `.agent-daemon/memory/techContext.md` etc. are unchanged after a successful digest.

**Root cause:** The digest writes to **the correct memory file** based on classification, not the one you might expect.

- `type: "pattern"` + `scope: "project"` → `activeContext.md`
- `type: "tool"` → `systemPatterns.md` or `techContext.md` depending on subtype
- `type: "correction"` → queued in `.agent-daemon/proposed/` (review with `ad review`)

**Fix:** Check `activeContext.md` first — most learnings land there. To see exactly where they went:

```sh
git diff -- .agent-daemon/memory/
```

---

## 8. `ad doctor` shows hooks missing right after `ad init`

**Symptom:**
```
✗  SessionStart hook → agent-daemon    missing
✗  SessionEnd hook → agent-daemon    missing
```

**Root cause:** Sometimes `ad init` skips hook injection if it detects existing entries it doesn't recognize (conservative — never overwrites user's hooks).

**Fix:**

- Inspect `~/.claude/settings.json` and confirm the existing hooks
- If you want the daemon hooks added on top, edit the file manually:
  - Copy entries from `hooks/session-start-load.json`
  - Copy entries from `hooks/session-end-digest.json`
  - Merge into the `hooks` object

Or remove conflicting entries first, then re-run `ad init`.

---

## 9. `npm link` warning: `EBUSY: resource busy or locked`

**Symptom:** `npm link` on Windows fails with `EBUSY`.

**Root cause:** Another process (running `ad` from previous session, or Node Defender / antivirus) is holding the binary.

**Fix:**

```powershell
# Kill any running ad processes:
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Agent-Daemon*" } | Stop-Process

# Try link again
npm link
```

---

## 10. `ad watch` works but writes memory to the wrong directory

**Symptom:** `sessions.jsonl` and memory files appear under `~/.claude/projects/<encoded>/.agent-daemon/` instead of your project root.

**Root cause:** Pre-v0.2.0 bug — `runtime/src/daemon/watch.mjs` passed `dirname(transcript)` as the cwd to `runDigest`.

**Fix:** Upgrade to v0.2.0+:

```sh
cd /path/to/Agent-Daemon
git pull
```

v0.2.0 reads the actual `cwd` field from inside each transcript JSONL.

---

## 11. PowerShell parse errors when pasting commands

**Symptom:**
```
ParserError:
Line | {"ts":"...","session_id":"...","adapter":"claude-code",...
     |       ~~~~~~
     | Unexpected token ':"..."' in expression or statement.
```

**Root cause:** You pasted output (PowerShell prompts + JSON data) back into the terminal as a command.

**Fix:** Just run one command at a time — copy only the command line (no `PS C:\...>` prefix, no output lines below).

---

## 12. `ad digest-latest` says `no transcripts found` for a project with active chats

**Symptom:**
```
agent-daemon: no transcripts found for D:\projects\my-app
  searched: C:\Users\<you>\.claude\projects\d-projects-my-app
```

**Root cause:** The encoded folder name in your search doesn't match the actual one on disk. Usually a case mismatch (`D-` vs `d-`) or hyphen-count mismatch (`d-Program` vs `d--Program`).

**Fix:**

- List what's actually there:
  ```powershell
  Get-ChildItem "$env:USERPROFILE\.claude\projects" -Directory | Select-Object Name
  ```
- v0.2.0+ does case-insensitive matching. If you're on an older build, upgrade:
  ```sh
  cd /path/to/Agent-Daemon && git pull
  ```

---

## 13. `agent-daemon: write error EOF` when running watch on Windows

**Symptom:** Watch starts but crashes after a few file events:
```
node:events:496
      throw er;
      ^
Error: write EOF
```

**Root cause:** The digest spawn's stdout pipe broke. Usually means a child Node process died unexpectedly.

**Fix:**

- Restart watch:
  ```sh
  ad watch --verbose --force
  ```
- If it recurs, the issue is likely in `runtime/src/digest/extract.mjs` LLM fallback path. Run without `--fallback-to-llm`.

---

## 14. Harness: `Not logged in. Run: ad auth login chatgpt`

**Symptom:** `ad chat`, `ad run`, `ad loop` (and the other harness commands) exit with code 2.

**Fix:** log the harness in once. It keeps its own login in `~/.agent-daemon/codex-home`, separate from your own `~/.codex`.

```sh
ad auth login openai                           # OpenAI API key
ad auth login openrouter --model <slug>         # or an OpenRouter key
ad auth login chatgpt                          # or a ChatGPT plan (browser; --device for a code)
ad auth status
```

---

## 15. Harness: `Windows sandbox is …; unattended runs need it`

**Symptom:** `ad loop`, team workers or scheduled `loop` jobs refuse to start on Windows.

**Cause:** unattended runs never ask for approval, so on Windows they require a ready sandbox.

**Fix:** `ad sandbox setup` (unelevated), or `ad sandbox setup --elevated` for stronger isolation (one UAC prompt; machine-wide, so your own install shares the sandbox accounts it creates). `ad sandbox status` shows the current state.

---

## 16. Harness on Windows: every agent command fails ("Access is denied" or `CreateProcessAsUserW failed`)

**Symptom:** one of:

- `ad run` / `ad chat` finish, but the agent says its shell was denied and changes nothing. The engine's log (`logs_2.sqlite` in the harness home) shows `CreateProcessAsUserW failed: 5 (Access is denied.)` for `...\Microsoft\WindowsApps\pwsh.exe`.
- In `ad tui`, each command shows `Failed … Failed to create unified exec process: CreateProcessAsUserW failed: -1073283067`, naming a `pwsh.exe` under `C:\Program Files\WindowsApps\…`, and the agent then asks to run it outside the sandbox.

**Cause:** PowerShell 7 installed from the Microsoft Store. The engine runs commands in the first `pwsh` on PATH, and the Windows sandbox can't start a Store (MSIX) app. Two PATH entries lead to it: the per-user app-alias folder (`…\Microsoft\WindowsApps`), and the package folder (`C:\Program Files\WindowsApps\Microsoft.PowerShell_…`), which that PowerShell puts at the front of PATH when you start ad from it.

**Fix:** update agent-daemon. Fixed in 2.0.1 (the alias folder) and completed in 2.1.1 (the package folder): on Windows, ad leaves every `WindowsApps` folder out of its engine's PATH, so commands run inside the sandbox in a PowerShell 7 installed from the [MSI](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) or in Windows PowerShell 5.1. Your own shell and PATH are unchanged.

- To have the agent use PowerShell 7, install it from the MSI as well.
- Store app aliases (for example `winget`, or the `python` stub) aren't on the agent's PATH either.

---

## 17. Harness on Windows: `spawn EPERM` when the agent runs `node --test`

**Symptom:** in the default (unelevated) sandbox, commands that make Node start child processes, like `node --test`, fail with `spawn EPERM`. Plain `node file.js` works.

**Workaround:** the agent can run test files directly (`node math.test.js`). `ad sandbox setup --elevated` may lift the limit. That's **untested**, so please report back if you try it.

---

## 18. `ad loop` won't stop

**Fix:** create a STOP file. The loop checks it between turns and during a turn:

```sh
touch .agent-daemon/STOP        # this project
touch ~/.agent-daemon/STOP      # every loop on this machine
```

Delete the file before starting the next loop (an existing STOP file refuses to start).

---

## 19. Harness: ad won't run the engine in your own install's home

**Symptom:** a harness command stops before the engine starts, saying the folder is your own install's home (and suggesting `AD_ENGINE_DIR`), or refusing an unusable `CODEX_HOME` value (a trailing dot or space, a network path).

**Cause:** the harness only runs the engine in its own home, `~/.agent-daemon/engine`, or wherever `AD_ENGINE_DIR` points. It refuses any of these:

- `~/.codex`;
- a `CODEX_HOME` your shell sets for your own install;
- any path that leads to one of those (a junction, symlink, `\\?\` prefix, a trailing dot or space, a network share).

Your own install keeps its login, sessions and config to itself.

**Fix:** unset `AD_CODEX_HOME`, or point `AD_ENGINE_DIR` at a new folder of its own. Leaving `CODEX_HOME` set for your own install is fine: the harness never passes `CODEX_HOME`, `CODEX_API_KEY` and the like to its engine (except `CODEX_CA_CERTIFICATE`).

---

## 20. Harness: engine not installed — run: cd runtime && npm install

**Symptom:** `ad doctor` or any harness command reports the engine missing, even though your own install works in your terminal.

**Cause:** the harness runs only the engine version it pins (`runtime/package.json`), installed under `runtime/node_modules`. It never falls back to a global or PATH install, so your own install and its version stay yours.

**Fix:** re-run the installer, or `cd runtime && npm install`. `AD_ENGINE_BIN` can point at a specific binary for testing.

---

## 21. Windows PowerShell 5.1: the one-liner stops at `Node.js >=22 required`

**Symptom:** `irm …/install.ps1 | iex` in Windows PowerShell (the blue 5.1 one) says Node is too old although `node -v` shows 22 or later.

**Cause:** before the fix, the installer asked node to split its version with `node -p '…split(".")…'`. 5.1 strips the inner quotes, so the check always read version 0.

**Fix:** update. The installer now parses `node -v` itself. On an older copy, run the same one-liner in PowerShell 7 (`pwsh`).

---

## 22. Keys or paste behave oddly in a terminal

**Symptom:** for example, Shift+Enter acts like Enter, a multi-line paste sends each line separately, or Esc arrives late.

**Check what your terminal really sends:**

```sh
node runtime/scripts/tui-probe.mjs keys      # each key and paste as raw bytes, with a name
node runtime/scripts/tui-probe.mjs screen    # wrapping, autowrap-off, sync output, resize reflow
```

Quit with `qqq`, or press Ctrl+C three times. Results are saved to `~/.agent-daemon/logs/tui-probe-*.log`; attach that file to a bug report.

**Known causes:**

- On Windows, Node 22 before 22.17, 23.x and 24 before 24.2 have no bracketed paste. Upgrade 22.x to 22.17+ or 24.x to 24.2+; from 23.x, move to 24.2+ and run `npm rebuild` in `runtime/`.
- Windows Terminal 1.24 and the VS Code terminal send Shift+Enter as plain Enter; use Ctrl+J for a newline. Windows Terminal 1.25 supports the keyboard protocol that tells them apart.

---

## 23. `ad tui` says it needs an interactive terminal or Node 22.17+

**Symptom:** `ad tui` (or bare `ad`, or `ad --last`) exits at once with one of:

- `ad tui needs an interactive terminal. Use ad chat for pipes and scripts.`
- `This terminal (TERM=dumb) can't show the UI. Use ad chat.`
- `ad tui needs Node 22.17+ or 24.2+ on Windows (this is …)`
- `mintty (Git Bash's window) can't pass keys to ad. Run winpty ad tui, or use Windows Terminal.`

Bare `ad` then prints the help. `ad --last` adds that you can use `ad chat` and `/resume` instead, and exits with code 2.

**Cause:** the terminal UI needs a real terminal on both stdin and stdout. On Windows it also needs a Node with VT input in raw mode (22.17+ or 24.2+, not 23.x or 24.0–24.1); older ones turn a multi-line paste into one message per line. mintty doesn't pass keys to Windows console programs.

**Fix:**

- Run it in a terminal window, not through a pipe, `nohup` or a script. For scripts use `ad run` or `ad chat`.
- Upgrade Node, then check with `node -v`:
  - 22.x: to 22.17 or later (same native-module ABI, nothing to rebuild);
  - 24.x: to 24.2 or later (nothing to rebuild);
  - 23.x: to 24.2 or later, then run `npm rebuild` in `runtime/` (the native SQLite module is built per Node version).
- In Git Bash: `winpty ad tui`, or open Git Bash as a Windows Terminal profile.
- Everything else in ad keeps working on older Node; only the TUI checks this.

---

## 24. `ad tui`: Shift+Enter sends instead of adding a newline

**Symptom:** pressing Shift+Enter sends the prompt.

**Cause:** Windows Terminal 1.24 and the VS Code terminal send Shift+Enter exactly like Enter, so ad can't tell them apart. ad sends on Enter and adds a newline on a line feed.

**Fix:** any of these:

- Use the key the footer shows: Ctrl+Enter in Windows Terminal, Ctrl+J in any terminal.
- Type `\` and then Enter: that adds a newline everywhere.
- Run `/terminal-setup` in `ad tui`. It prints the binding that makes Shift+Enter send a newline in your terminal (a `sendInput` action in Windows Terminal, a `sendSequence` keybinding in VS Code). Windows Terminal 1.25 and Zed need no setup.

---

## 25. Ghost copies of the bottom lines after narrowing the window

**Symptom:** after making the window narrower while `ad tui` runs, old copies of the status line, composer or footer stay in the scrollback above the live lines.

**Cause:** known, and being characterized. When a terminal re-wraps lines on a resize, some (xterm.js-based ones, like VS Code) also move the cursor further than the re-wrap accounts for. ad then re-draws below the old copy instead of over it. It errs this way on purpose: guessing the other way would erase your history.

**Fix:** press Ctrl+L to redraw. History itself is never lost.

Please help pin it down: in the terminal where it happens, run

```sh
node runtime/scripts/tui-probe.mjs screen --bottom
```

make the window narrower, then wider, quit with `qqq`, and attach `~/.agent-daemon/logs/tui-probe-screen-*.log` plus a screenshot of the window to an issue.

---

## 26. `/undo` refuses: `Not undone`

**Symptom:** `/undo` says `Not undone: <file> (<why>), …. /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched.`

**Cause:** `/undo` only puts back what the agent's own edits changed in the last turn, and only when nothing else touched those files. Each listed file says why it was refused:

- `changed during the turn`: more of it changed during the turn than the agent's own edits account for (you saved it, or a command changed it, before or between the agent's edits). `force` doesn't override this: your change would be lost.
- `changed since the agent's edit`: the agent edited it, and it changed after that: you, your editor's format-on-save, or a formatter the agent ran, during the turn or after it. Undoing would throw that away; `force` does exactly that.
- `not changed by the agent's edits`: it changed during the turn some other way, for example through a command the agent ran (`npm install`, a formatter, `sed`) or your editor.
- `a folder is there now`: a folder stands where the file was.
- `a file is where its folder was`: a file or symlink now stands where one of the path's folders was. `force` doesn't override this.
- `not in the checkpoint`: the agent edited a file the snapshots leave out (untracked and over 2 MB, or in a heavy folder like `build/` or `node_modules/`). There is nothing to put back; `force` doesn't change that.

With any of these, plain `/undo` changes nothing.

**Fix:**

- Look at the files first (`/diff`, or `git diff`).
- If later changes to the agent's files can go, `/undo force` puts those files back too, and undoes the rest of the turn. Even forced, the files with any other conflict are left alone, and folders are never removed or replaced. The result says how many files were "left alone (not the agent's edit, changed during the turn, not in the checkpoint, or a folder or file stands in the way)".
- If you want to keep them, fix the files by hand. Esc Esc rewinds just the conversation and leaves the files alone.

**Other `/undo` messages:**

- `The last turn has no checkpoint (…)`, with the reason:
  - the snapshot taken when you sent the prompt wasn't done within 10 s (a very large working folder, a busy machine);
  - snapshots fail in this repo (git's message follows), or the snapshot after the turn failed;
  - the turn wasn't started from a prompt here: the engine started it itself (a review, a goal);
  - one of the agent's edits couldn't be read back, so ad can't tell its lines from anyone else's;
  - the turn ran before `ad tui` started.
- `… edit(s) outside this repo weren't touched`: the agent edited files outside the repo `ad tui` runs in; `/undo` only covers this repo.
- `Not a git repo`: checkpoints need a git repo.
- `A turn started meanwhile`: a prompt was sent while `/undo` was checking. Run `/undo` again once that turn finishes.
- Ignored files, submodule contents and LFS files are never restored. With git older than 2.40, or with `.git/info/attributes` or `core.attributesFile` set, files with eol rules may come back normalized.

---

## 27. `ad tui`: `ad's engine stopped (exit N)`

**Symptom:** a banner under the composer says `ad's engine stopped (exit N) (details: /warnings). Your text is kept; Enter restarts it and resumes.`

**Cause:** the engine process exited, and ad's automatic restarts (3) didn't bring it back. The running turn is marked failed; your prompt and the scrollback are kept.

**Fix:**

- Press Enter on an empty prompt to try again. A prompt you send meanwhile waits in the queue and goes once the engine is back.
- If it keeps stopping: `/quit`, then `ad doctor`, then `ad tui --last` to continue the conversation.
- To see why: the engine's own log is `logs_2.sqlite` in the harness home (`~/.agent-daemon/engine`, table `logs`). The [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill shows how to read it. Common causes are a lost login (`ad auth status`) and the Windows sandbox (#16).

---

## 28. `ad tui`: the editor (Ctrl+G) returned at once

**Symptom:** Ctrl+G flashes, and ad says `The editor returned at once without waiting. Set EDITOR to one that waits …`.

**Cause:** the editor handed the file to a window that was already open and exited straight away (Notepad from the Microsoft Store, `code` without `--wait`). ad can't know when you finish, so it keeps your prompt unchanged.

**Fix:** point `VISUAL` or `EDITOR` at a command that waits until the file is closed:

```sh
export EDITOR="code --wait"                  # bash / zsh
$env:EDITOR = "code --wait"                  # PowerShell (this session)
```

Other choices: `nvim`, `vim`, `nano`, or Notepad++ with `-multiInst -nosession`. A full path with spaces works without quotes when there are no arguments; with arguments, quote the path (`"C:\Program Files\Notepad++\notepad++.exe" -multiInst -nosession`).

---

## 29. Windows: the first command or edit after installing takes ~35 s

**Symptom:** right after installing (or with a fresh `~/.agent-daemon/engine`), the agent's first command or file edit sits on "Thinking" for about half a minute. Later ones take a second or two.

**Cause:** the engine sets up its Windows sandbox for ad's engine home on the first sandboxed action. It happens once per engine home, not per project folder.

**Fix:** nothing to do; wait it out once. A command you approve to run outside the sandbox doesn't pay it.

## 30. `ad tui`: keys set outside ad don't work in ad

**Symptom:** you changed a key under `[tui.keymap]` in the engine's settings file, and ad still uses the old one (or the key does nothing).

**Cause:** ad applies `tui.keymap` only to the actions it has (the transcript, the editor, copy, raw output, clear, interrupt, reasoning effort, queue, the shortcuts, the pager). It skips a key it can't use: a two-key chord (`ctrl-x f`), a key that would mean two things, or one of the prompt's editing keys (Enter, Ctrl+A/E/K/U/W/Y, Ctrl+R, the arrows).

**Fix:** `/warnings` (or F2) lists what was skipped and why. Pick another key in the settings file, then restart ad (it reads the keymap at start). See [commands.md](commands.md#keys).

## 31. `ad tui`: `/clear` wiped my scrollback

**Symptom:** after `/clear`, the terminal's scrollback (and what was above ad) is gone.

**Cause:** that is the engine's `/clear`: it clears the terminal, scrollback included, and starts a new conversation. The old conversation is kept; `/resume` brings it back.

**Fix:** use `/new` to start fresh and keep the scrollback, or set `"clear.keepScrollback": true` in `~/.agent-daemon/tui/prefs.json` so `/clear` keeps it too (it draws a divider instead).

## 32. The terminal's title still says ad's after ad ended

**Symptom:** the window or tab title shows a spinner, a conversation name or "action required" after ad exited.

**Cause:** ad saves the terminal's title when it first sets one and puts it back on exit, through the terminal's title stack. A terminal without that stack, or a crash, leaves ad's last title (ad sets an empty title before putting it back, so most terminals show their default).

**Fix:** open a new tab, or set the title yourself (PowerShell: `$Host.UI.RawUI.WindowTitle = "..."`). To keep ad off the title, run `/title` and turn every item off (`tui.terminal_title = []`).

## 33. `ad tui`: `/plan` says "Plan mode unavailable right now."

**Symptom:** `/plan` or Shift+Tab answers "Plan mode unavailable right now.", and `/warnings` may say "Plan mode is unavailable: the engine didn't list its modes (…)".

**Cause:** Plan mode is the engine's collaboration mode, part of its experimental app-server API. ad asks the engine for its modes when the engine starts and waits 2 s, as the engine's own UI does. A slow start (a busy machine, antivirus scanning a freshly installed engine) or an engine build that changed or dropped the call leaves ad with none.

**Fix:** quit and start `ad` again (the modes are asked for again, and after every engine restart). If it keeps happening, check `ad doctor` for the engine version: ad is tested with the pinned one.

## 34. `ad tui`: `/recap` says "Could not generate a recap. Please try again."

**Symptom:** after "Generating conversation recap…", that message, with the reason after it in grey.

**Cause:** `/recap` asks the engine in a temporary thread (read-only, no tools, none of ad's hooks), as the engine's own `/recap` does: it must start within 30 s and answer within 30 s more, in the engine's recap format. A sign-in problem, a model error or a slow model ends it. When no recap appears at all, a prompt you sent meanwhile, or another turn (`/compact`, `/review`), dropped it, as in the engine's own UI.

**Fix:** try again while the conversation is idle. Check the sign-in with `/status`. The reason after the message says which of the above it was.

## 35. `ad tui`: `/approve` says "No recent auto-review denials in this thread." or "invalid Guardian denial event"

**Symptom:** `/approve` lists nothing although the engine's auto-review denied something earlier, or the approval is refused.

**Cause:** `/approve` lists the denials of this conversation since ad started (the last 10, as the engine keeps them): a conversation resumed later starts with none, and a subagent's denials aren't on the list. "invalid Guardian denial event" is the engine refusing the approval's format: an engine version ad wasn't tested with. The denial stays on the list.

**Fix:** for an older denial, ask the model to try again (the retry goes through auto-review). For a refusal saying "The engine refused a request from ad", read the raw reason in `/warnings`, check the engine version in `ad doctor`, and report both.

## 36. `ad tui`: `/setup-default-sandbox` refuses or fails

**Symptom:** "… wasn't created by ad, so ad doesn't change its sandbox.", or "Windows sandbox setup failed: …", or "Input disabled until setup completes." while it runs.

**Cause:** it sets up the engine's elevated (admin) Windows sandbox, which is machine-wide (your own install uses it too), so Windows asks for administrator approval once. ad changes only an engine home it created. While setup runs, nothing is sent: prompts, commands and `!` shell commands wait.

**Fix:** approve the Windows prompt. If it is declined or blocked by policy, `ad sandbox setup` sets up the non-admin sandbox instead. For an engine home ad didn't create, `ad sandbox setup --elevated --force` changes it anyway. On macOS and Linux nothing is needed: the engine uses the OS sandbox.

---

## 37. Two engine folders

**Symptom:** `ad doctor` says "two engine folders" and refuses to pick, or a start fails with the two-folders refusal.

**Cause:** an older ad started after the `codex-home` link was removed, so both `codex-home/` and `engine/` are real folders now.

**Fix:** `ad doctor` shows both folders with their last use, conversation count and sign-in. Rename the one you don't want (for example to `engine.old`); delete nothing until you've checked. The terminal UI picks by itself only when one folder holds nothing but ad's first-run files: it renames that one to `<name>.empty-<date>` and says so.

---

## 38. `ad migrate` says something is using the folder

**Symptom:** "Not moved: something is using … Nothing changed.", or "Not moved: an ad session is running (pid …)."

**Cause:** a file or working folder inside is held open: another Agent Daemon window, an editor's agent panel, a background loop, a terminal, or antivirus. The second text means an ad session holds a conversation open.

**Fix:** close it and run `ad migrate` (or `ad migrate --undo`) again.

---

## 39. What ad can't rename

`ad doctor` also labels captured version-probe diagnostics with `details:`; its startup failure line uses ad's words.

ad shows its own words for engine errors and notices. To see the original text, open `/warnings` in the terminal UI or read the labelled `details:` lines in CLI output.

- OpenAI's own sign-in and usage-limit pages may say "Codex".
- The engine's process shows as `codex` / `codex.exe` in Task Manager, UAC prompts and the firewall.
- Raw engine details in `/warnings` and CLI `details:` lines are the engine's own words. They can include its name.
- On-disk names stay: `codex-home` on older installs, a project's `.codex/` folder and the `codex-version` status-line id.
- Model names such as `gpt-5.x-codex` stay as the provider names them.

For browser errors in `ad web`, read the server's terminal log: raw details stay there, and the page points to it.

For "The engine reported a problem", inspect those details first. `ad doctor` shows whether the engine version is one ad was tested with.

---

## 40. A start says `codex-home` points to a folder that doesn't exist

**Symptom:** "…codex-home points to X, which doesn't exist. Reconnect it, or remove that link (only the link: …), and start ad again.", or "…, which can't be read (EACCES)." The same can name `engine`.

**Cause:** `codex-home` (or `engine`) is a link you made, to a drive or folder that isn't there right now: a USB drive, an encrypted volume that isn't unlocked yet, a network share. ad never replaces a link it didn't make, so it doesn't start over in a new, empty folder. It can also be ad's own link from before `~/.agent-daemon` moved (a renamed user profile): it still points at the old place.

**Fix:** connect or unlock the drive and start ad again. If that folder is gone for good, or the link points at your old profile, remove the link (`rmdir codex-home` in `~/.agent-daemon` on Windows, `rm codex-home` elsewhere; this removes only the link). The next start makes the link again, or a new folder if there is none.

---

For harness problems, the [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill walks through login → hooks → sandbox → the engine's own log. See also [harness.md](harness.md) and, for the terminal UI, [tui.md](tui.md).

## Still stuck?

Open an issue at the repo with:

1. Output of `ad doctor`
2. Output of `ad --version`
3. OS + Node version (`node --version`)
4. The exact command you ran + verbatim error
5. Last 30 lines of `~/.agent-daemon/logs/` if any exist

