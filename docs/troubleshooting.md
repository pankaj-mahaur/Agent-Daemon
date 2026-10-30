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

**Fix:** log the harness in once. It keeps its own login in `~/.agent-daemon/codex-home`, separate from your own `~/.codex`. With several accounts, `ad auth list` shows which ones need signing in again, and `ad auth login <provider> --label <label>` brings one back ([accounts.md](accounts.md)).

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

**Symptom:** you changed a key under `[tui.keymap]` in the engine's settings file, and ad still uses the old one (or the key does nothing). Or a chord (`"ctrl-x ctrl-s"`, `"leader c"`) does nothing.

**Cause:** ad applies `tui.keymap` only to the actions it has (the transcript, the editor, copy, raw output, clear, Find, interrupt, reasoning effort, queue, the shortcuts, the pager). It skips a key it can't use: a key that would mean two things, one of the prompt's editing keys (Enter, Ctrl+A/E/K/U/W/Y, Ctrl+R, the arrows), `f13` and up, a value that isn't a key, or a chord the engine also refuses (more than two keys, plain Esc in a chord, the leader as its own second key). A `"leader …"` chord needs a leader: when you bound `ctrl-x` to something else and set no `global.leader`, there is none. Chords are off while an approval or one of ad's questions is open.

**Fix:** `/warnings` (or F2) says how many settings were skipped; `/keymap` lists each with the reason and names the leader. Pick another key in the settings file (or set `tui.keymap.global.leader`), then restart ad (it reads the keymap at start). See [tui.md](tui.md#keys).

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

**Cause:** a file or working folder inside is held open: another Agent Daemon window, an editor's agent panel, a background loop, a terminal, or antivirus. The second text means an ad process is using the engine: a session (even one with no conversation yet, or one suspended with Ctrl+Z), `ad run`, `ad loop`, a team worker, a digest, or `ad engine ui`. When it names an `engine pid`, that engine is still running even if the ad that started it has gone.

**Fix:** close it and run `ad migrate` (or `ad migrate --undo`) again. An engine whose ad crashed: end that engine pid (Task Manager, or `kill <pid>`). Records of processes that are gone are cleared by the next `ad migrate` by itself.

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

## 41. `ad sp`: a name "can only use letters, digits, ".", "_" and "-""

**Symptom:** `agent-daemon spawn: --role "dev ops" can only use letters, digits, ".", "_" and "-" (max 64).` (or `--team`, `agentName`), or `--model "…" isn't a model name ad can pass on.`

**Cause:** the team id, role and agent name become a git branch (`team/<team>/<agent>`) and a folder name, so ad accepts only plain names: letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters, not ending in `.` or `.lock`. Model ids may also use `:`, `/`, `@` and `+`.

**Fix:** rename the role in the team (for example `dev-ops`), or pass a plain `--model` id.

## 42. Claude workers: `claude isn't on PATH`, or `Found claude.cmd, but ad can't tell what it runs`

**Symptom:** `ad sp --engine claude` (or a digest that uses Claude Code) says `claude isn't on PATH. Install Claude Code, or set AD_CLAUDE_BIN to its path.`, or `Found …\claude.cmd, but ad can't tell what it runs without a shell. …`

**Cause:** ad starts Claude Code without a shell and, on Windows, only by its full path from PATH (never from the current folder). An npm-installed `claude.cmd` is read to find the `cli.js` it runs; a `.cmd` of another shape can't be run safely without `cmd.exe`, so ad refuses it.

**Fix:** install Claude Code's native build (`claude.exe`), or set `AD_CLAUDE_BIN` to the full path of `claude.exe` or of the `cli.js` your `claude.cmd` starts. `git isn't on PATH.` has the same cause for git: install Git for Windows, or add its `cmd` folder to PATH.

## 43. Claude workers: `Your Claude Code doesn't know --append-system-prompt-file`

**Cause:** ad passes a worker's instructions in a temporary file, not on the command line, and older Claude Code versions don't have that option.

**Fix:** `claude update`, then retry.

## 44. Memory tools say "This memory server isn't bound to a project"

**Cause:** the memory server serves one project, chosen when it starts, and couldn't tell which: no `--project`, no project from ad or Claude Code, and its working folder isn't inside a git repo and holds no `.agent-daemon` folder. Home, a drive root, system folders and ad's own folders never count. It serves nothing rather than guess.

**Fix:** open the session in the project folder (a git repo). In ad's own engine, each conversation binds to its folder, or to the project ad passes (`AD_MEMORY_PROJECT`). A desktop app whose working folder is its install folder never binds by itself: give it `--project <folder>` (`${workspaceFolder}` in hosts that expand it). For Claude Code, register the server with `--host claude-code` (see [mcp/agent-daemon-memory/README.md](../mcp/agent-daemon-memory/README.md#by-hand-claude-code)); for another host, pass `--project <folder>` in its server config.

## 45. A note I expected doesn't show up in memory

**Cause:** one of these, by design:
- it was written by the agent about itself (from its own turn), so it waits as **pending** for your review;
- the injection screen flagged it, or it held a provider key, so it is **held back** (`ad memory scan` holds back older notes like this once);
- it belongs to another project, or it was a "global" note from ad 3.0 written in another project (those stay in their project);
- it is a user fact observed in another project.

**Fix:** `ad memory held` lists what is waiting or held back in this project. Run it in your own terminal: `ad memory held accept L12` serves a waiting note, `release` brings back one the injection screen held (never one holding a secret), `drop` clears it; each asks you to type the id. Or say it again in your own words, or use `/remember` in `ad tui`: what you type yourself applies at once.

## 46. `ad doctor` says older notes from folders that shared one key reach neither

**Symptom:** `ad doctor`'s "Memory keys" line names two folders and a count of rows that "can't be told apart".

**Cause:** memory keys used to come from folder paths with `/`, `\` and `:` turned into `-`, so `/x/a/b` and `/x/a-b` got the same key. Each project now has its own id, and older notes are given theirs by the session or folder they were recorded in (`ad memory migrate`). A note with neither can't be placed, so it reaches neither folder.

**Fix:** nothing is lost. List them with `ad memory assign --list`, then place one with `ad memory assign learnings:<id> --project <folder>` in your own terminal (you type the id to confirm).

## 47. `This editor runs through cmd.exe, which can't take that file name safely`

**Cause:** your `EDITOR` (or `VISUAL`) is a `.cmd` file, such as VS Code's `code.cmd`, which only `cmd.exe` can start, and the file ad asked it to open has `%`, `"` or a line break in its path. `cmd.exe` would read those as commands or variables, so ad refuses instead of guessing.

**Fix:** set `EDITOR` to the editor's `.exe` (for VS Code: `"C:\Users\<you>\AppData\Local\Programs\Microsoft VS Code\Code.exe" --wait`), or use an editor whose command is an `.exe`. `The editor "x" isn't on PATH` means ad looked only on PATH (never in the current folder): set `EDITOR` to the full path.

## 48. `Pick a project folder`, or `Run this in a project folder`

**Symptom:** `ad` opens a "Pick a project folder" list instead of the composer; `/cd` says "That folder would load your own … skills from ~/.codex"; `ad run`/`chat`/`loop` print "ad ran in your home folder, where your own … skills load"; `ad schedule add` refuses; a resumed conversation or a web/editor client gets the "Run this in a project folder" text (code `HOME_FOLDER_REFUSED`).

**Cause:** the folder is your home folder, or a folder under a home folder that is a git repository, and your own `~/.codex/` (from your own install of the engine ad runs on) has skills, or settings that ad's engine trusts. The engine reads a folder's `.codex/` as that project's settings and loads its skills even while the folder isn't trusted, so your own install's skills would join every conversation there. A resumed conversation is checked against the folder it was started in.

**Fix:**
- Open ad in a project folder: in the list, Enter opens your last one; or `cd` to the project first, or pass `--cwd <project>`.
- To work there anyway, add `--allow-home-folder`, or set `AD_ALLOW_HOME_FOLDER=1`. Choosing **Always open home without asking** in the list saves `"allowHomeFolder": true` in `~/.agent-daemon/tui/prefs.json`.
- Scheduled jobs from 3.0 in that folder keep running; `ad doctor` lists them under "Home-folder jobs". To move one, remove it and add it again with `--cwd <project>`.
- If your home folder itself must be a git repository, keep projects in their own repositories; a project with its own `.git` is never affected. In such a home, ad also doesn't ask to trust a folder without its own repository ("ad didn't offer to trust this folder"): trusting it would apply your own settings from `~/.codex/config.toml` there.

See [harness.md](harness.md#working-in-your-home-folder).

## 49. The record tool says "This host's hooks already capture corrections; nothing extra saved."

**Cause:** the memory server runs with `--capture auto` (the default), and this host's ad hooks ran in this project in the last 30 minutes. The hooks already capture what you type, so the record tools don't save a second copy of the agent's version.

**Fix:** nothing to do: the prompt hook has the correction. To record through the tools anyway (for example in a host whose hooks capture nothing), start the server with `--capture tools`.

## 50. `Not saved: that looks like it contains a secret (…)`

**Cause:** the text the agent tried to record holds something shaped like a key, token, password or `user:pass@` URL. A memory note is never the place for one, so nothing was stored.

**Fix:** tell the agent the lesson without the secret ("the staging key is in the vault under `staging/api`", not the key itself). If it isn't a secret at all, say the lesson in your own words: the prompt hook redacts only the secret-shaped part.

## 51. My note isn't used yet

**Symptom:** the agent said `Saved for review: …`, and the next session doesn't know it.

**Cause:** a note the agent recorded is **pending** until you accept it: only this project's `memory_search` and `memory_get` show it, marked `(unreviewed)`. A note it asked to make cross-project also waits for a second OK.

**Fix:** run `ad review` in your own terminal and accept it (type `accept`), or `ad review --accept <file>` / `--accept-all`. Saying the same note yourself also accepts it.

## 52. `ad review: accepting notes can't run from the agent's own shell` or `… needs an interactive terminal`

**Cause:** accepting a memory note changes what reaches your sessions, so only you can do it. `ad review` (and `ad memory promote`, `ad memory held accept`) refuse inside ad's engine tool shells and when stdin or stdout isn't a terminal; there is no `--yes` and no environment variable that skips it.

**Fix:** run it yourself in a terminal window (not through the agent, not piped). Listing works anywhere: plain `ad review` without a terminal lists what is queued.

## 53. The memory installer refused my config

**Symptom:** `✗ Codex: …; add this yourself:` or `✗ Cursor: …` followed by a snippet.

**Cause:** the installer changes only its own entry, and only when it can do that safely. It refuses when the file doesn't parse, when Codex's `mcp_servers` isn't a table, when `agent-daemon-memory` is already defined there and isn't ad's (a TOML table, dotted keys or an inline table all count), when the file is read-only, or when the config is ad's own engine home. The file is left exactly as it was.

**Fix:** fix the file (doctor's `config.parse` shows the parse error), or remove your own `agent-daemon-memory` entry and run `install` again, or paste the printed snippet yourself. If the entry is one ad wrote earlier and you want ad to manage it again: `repair --adopt`.

## 54. The memory tools don't show up after installing

**Cause:** hosts read their MCP config when they start.

**Fix:** restart the host (Claude Code: start a new session, or `/mcp`; Cursor: reload the window; Codex: start a new session). Then `npx agent-daemon-memory doctor` (or `ad memory doctor`): `smoke.legacy` and `smoke.modern` start the entry the way the host does. A failing `node.path` means the Node the entry names moved (a Node upgrade): run `repair`.

## 55. Doctor says `capture.double`

**Cause:** in Claude Code, ad's hooks capture what you type, and the memory server was installed with `--capture tools`, so the agent's record tools save corrections as well.

**Fix:** `install --host claude-code --capture hooks` (or `repair`). With the default `auto`, the record tools stand down while the hooks are capturing.

## 56. `ad skill publish` says a folder "was changed outside ad, so it wasn't overwritten"

**Cause:** the skill's folder in that host (for example `~/.codex/skills/<name>`) has no `.ad-skill.json` from ad, or its SKILL.md changed since ad wrote it. ad never overwrites a folder it doesn't own.

**Fix:** keep your version, or replace it with the accepted one: `ad skill publish <name> --host <id> --replace`. The old folder is backed up to `~/.agent-daemon/memory/backups/<host>/` first.

## 57. `ad review` says a proposal is "in an old format ad can't apply"

**Cause:** the proposal was written before skill proposals had a format ad can check (or by hand).

**Fix:** apply the change to the SKILL.md yourself, then accept to file it; or reject it and run `/evolve` again, which now queues through `ad skill propose`. A file that says it is damaged (its checksum doesn't match) was changed after it was written: reject it.

## 58. "ad: couldn't reach <host>"

**Cause:** ad's gateway couldn't connect to the provider: no network, a proxy it doesn't know about, or a certificate your company adds that Node doesn't trust.

**Fix:** check the network first. A company certificate: point `NODE_EXTRA_CA_CERTS` at it (a `CODEX_CA_CERTIFICATE` you set for the engine is used too). An HTTP proxy: ad's gateway can't go through one yet (it connects directly; support is planned), so API accounts need a direct connection to the provider for now. ad keeps `127.0.0.1` and `localhost` out of any proxy the engine uses.

## 59. "ad: the provider redirected; ad doesn't send keys across redirects"

**Cause:** the provider's address answered with a redirect. ad never follows one with your key, since it could send the key somewhere else.

**Fix:** use the address the provider documents (for a custom endpoint, the final URL with `/v1`), then sign in again with it.

## 60. "ad auth: <account> needs its key again"

**Cause:** the account ad picked (from `--account`, `AD_ACCOUNT`, the project's choice or your default) has no working key or sign-in, so ad stops before starting anything.

**Fix:** run the command the message names (`ad auth login <provider> --label <label>`), or pick another account with `--account`. `ad auth status` shows them all.

## 61. "The engine kept this conversation on <account>" / "This conversation is still busy"

**Cause:** a conversation was asked to move to another account. The engine moves a conversation only when nothing runs in it, and keeps the old account otherwise.

**Fix:** wait for the turn (or a background terminal) to finish, then switch again; or start a new conversation on the other account.

## 62. "This conversation used an account you removed"

**Cause:** the conversation ran on an API-key account that is no longer in your account list.

**Fix:** start a new conversation. Carrying it over to another account comes in a later release.

## 63. "The key was refused (HTTP 401), so it wasn't saved"

**Cause:** the provider said no to the key: a typo, a revoked key, or a key for another provider.

**Fix:** copy the key again from the provider's site and run the command the message names (`ad auth login <provider> --label <label>`). ad never keeps a refused key.

## 64. "Couldn't reach <host> (…). The key is saved; test it later"

**Cause:** ad couldn't talk to the provider while adding the key (no network, a proxy, the provider down). The key is stored and the account waits.

**Fix:** when the network is back, run `ad auth test <provider>/<label>`. Behind a proxy, see #58.

## 65. "This endpoint speaks only Chat Completions"

**Cause:** your endpoint has no Responses API, which ad's engine needs.

**Fix:** let ad test the endpoint when it asks (the one-token test also tries Chat Completions; an endpoint that answers there is added and goes through ad's translation). This message means neither API answered: check the address ends in `/v1`, or use a server with the Responses API (Ollama 0.13.3+, LM Studio, vLLM).

## 66. "Ollama isn't answering on localhost:11434" (or LM Studio on localhost:1234)

**Cause:** the local server isn't running, or listens on another port.

**Fix:** start it (`ollama serve`, `lms server start`) and run the login again. A server on another port: `ad auth login custom --base-url http://127.0.0.1:<port>/v1 --no-key`.

## 67. "This provider can't take … through ad" / "ad can't pass … to this provider"

**Cause:** the provider speaks only Chat Completions, and the request needs something ad can't carry across (live web search, a stored response, an image for a model without vision).

**Fix:** turn that feature off for this chat (for live web search: `ad tools disable web-search`), or pick a model or provider that has it (`/model`).

## 68. "<provider>: the daily limit is used up" (or "the monthly limit")

**Cause:** the provider's free or paid quota for the period is spent. ad stops the turn at once instead of retrying, so it isn't asked again.

**Fix:** wait for the provider's reset, switch accounts (`/model`), or add credit. A per-minute limit is different: ad waits the time the provider asks (up to 60 s) and the turn goes on.

## 69. "OpenCode Go's usage limit is reached"

**Cause:** your Go plan's allowance for that model is used up for its 5-hour, weekly or monthly window. ad stops the turn instead of retrying.

**Fix:** wait for the reset time shown, pick another model or account with `/model`, or turn on Extra Usage on OpenCode's Go page (it then spends your OpenCode balance).

## 70. "This OpenCode Go model isn't available to ad yet. Pick another with /model."

**Cause:** OpenCode serves that model on an API ad can't speak yet (Anthropic's or Gemini's), or answered that the model isn't on the route ad tried (ad then tries the other route for the rest of this run).

**Fix:** pick another Go model in `/model`. Models marked "coming later" arrive with ad's Anthropic and Gemini support.

## 71. "DeepSeek can't read this chat's earlier reasoning any more (ad's key for it changed)"

**Cause:** DeepSeek (and MiniMax) want their earlier reasoning back with every request that has tools. ad keeps it sealed with a key in your secret store; that key changed (the store was reset, or the chat came from another computer), so ad can't give it back.

**Fix:** start a new chat on that model. Chats that began on another provider or model are not affected: their turns go without reasoning, as DeepSeek allows.

## 72. "This chat's earlier Gemini steps can't be replayed"

**Cause:** Gemini checks the thought signature on each tool call of the current turn, and this chat has a call without one (it ran on another provider or model, or before ad kept signatures). ad never makes one up.

**Fix:** start a new chat on Gemini, or continue on the model you were using. If `ad doctor` says ad's secret store isn't available, ad keeps Gemini's signatures only while it runs, so a chat in the middle of a tool step can't continue after ad restarts.

---

## 73. "This session is open in another ad window", or "ad couldn't write this session's record"

**Cause:** ad keeps a record of each session in `~/.agent-daemon/sessions/` (see [harness.md](harness.md#the-session-record-ad-sessions-show)). Only one window writes a session: a second `ad` on the same conversation (a `/resume` of it, or the same thread in two windows) gets the first message, and that window records nothing. The second message means a write failed (a full disk, a folder ad can't write); the details are in `/warnings`. "Repaired the session record after an unclean exit" means ad or the machine stopped in the middle of a write and ad dropped the half line.

**Fix:** nothing is lost from the conversation itself, which goes on in both cases. Close the other window to record the session again. For a failed write, check that `~/.agent-daemon/sessions/` exists and is writable. `AD_LEDGER=0` turns the record off.

---

## 74. "Couldn't switch to … Still on …"

**Cause:** moving a conversation to another account (P4.2) stopped before anything moved, for the reason in the message:
- "that account needs signing in again": its key or sign-in expired; run the `ad auth login` it names;
- "that model isn't available on that account": pick one of the account's models;
- "the engine for that account didn't start": details in `/warnings`; `ad doctor` checks the engine;
- "the engine kept the old provider": the engine answered the fork on the old provider, so ad dropped the copy; switch again (it then starts a new conversation with the history), and report it;
- "the conversation kept starting turns by itself": a goal or a subagent kept starting turns; stop it (`/goal pause`, `/subagents`), then switch.

**Fix:** nothing changed: the conversation, its goal and its files are as they were. Fix the reason and pick the account again. "History carried over: 14 turns, 3 left out" after a switch is not an error: the oldest turns didn't fit the new model's context; they're in the previous conversation (`/resume`).

---

## 75. "price unknown" next to a model

**Cause:** the provider's model list didn't give a price for it (most OpenAI-style lists don't), or the price ad saw is more than a day old. ad never guesses, and never counts an unknown price as free.

**Fix:** `ad auth models <account> --refresh` asks the provider again. If it still says unknown, the provider doesn't publish prices in its list: check its pricing page. Automatic moves that need a price ("free only", a daily budget) skip such a model.

## 76. "… with your ChatGPT plan, upgrade to Plus"

**Cause:** the ChatGPT plan signed in doesn't include this use. It is not a limit that resets, so ad records it as "not eligible", not as a quota, and never waits for it or switches to wait it out.

**Fix:** use an account whose plan includes it (`/model` or `/account`), or an API key account. `ad auth status` shows each account's plan.

## 77. Fallback never switches, or a target says "skipped now"

**Cause:** fallback is off, or no target fits its rules right now. `ad fallback` lists each target with the reason it would be skipped: a price not checked in the last day under "free only", a model that bills per use under "no extra spend", a trial endpoint you haven't confirmed, an account that needs signing in, a provider that hit its limit (every account of it waits for the reset, also when another window saw it), or the per-hour switch cap. "None of these targets fits 'free only' right now" means turning it on would never move anything.

**Fix:** `ad fallback preview --error quotaExhausted` shows what would happen now, step by step. `ad auth models <account> --refresh` checks prices again. Add a free model, or choose `ad fallback set cost noExtraSpend` to allow plans you already pay for. `ad fallback test` checks every target without sending anything.

## 78. "Fallback is off: … changed since you confirmed the order", or it turned itself off

**Cause:** what you confirmed changed: the order, a target, the cost or trial rule, the keep-running list, or the account behind a target (signed in again as someone else, a new key, another base URL). ad never sends your work to a destination you didn't confirm, so it turns fallback off until you look again. Lowering the limits doesn't do this.

**Fix:** `ad fallback` to check the order, then `ad fallback enable` (or `/fallback`, then **e**) to confirm it again.

## 79. Fallback paused: "may still be running from the failed turn"

**Cause:** the turn failed while a command (or an edit) it started had no known end. Moving the conversation now could let the next model run it again, or build on a half-finished change, so automatic fallback stops instead.

**Fix:** check what the command did (`git status`, its output, the service it touches). Then `/retry` to go on with the same model, `/model` to pick another one yourself, or type what to do next. Nothing you queued runs until then.

## 80. Fallback paused: "still running in the background"

**Cause:** a background command from the conversation (a server, a watcher, a migration) is still running, and it isn't on the order's keep-running list. Another model might start it a second time.

**Fix:** stop it in `/ps` and `/retry`. If it is a dev server or a watcher you always run, add it to the keep-running list (`ad fallback set keep-running "npm run dev"`, or the rules line in `/fallback`): the next model is then told it is running and not to start it again. Write the command as you typed it (the pause names it that way): ad matches it inside the shell the engine runs it in (`powershell.exe -Command '…'` on Windows, `bash -lc '…'` elsewhere).

## 81. Fallback paused: "switching too often" or "the fallback budget is used up"

**Cause:** the order's limits stop endless moving: moves per task (`max-hops`), moves per hour across windows (`max-switches`), and how long ad keeps trying (`give-up`). Several providers running out at once reaches them quickly.

**Fix:** wait for a reset (`ad fallback` shows each target's state), add a target that isn't limited, or raise a limit (`ad fallback set max-hops 4`). `/retry` tries the current model again now.

## 82. Limits are blank, or "not reported by this provider"

**Cause:** ad shows only what a provider told it, and drops a number once its reset passed or it is more than 6 hours old. Many API providers report nothing until a limit is hit; OpenRouter's numbers are read after a limit and on request; a ChatGPT sign-in reports through its engine, so a sign-in no window has open keeps its last numbers.

**Fix:** `/usage` reads OpenRouter's numbers again. `ad auth list --refresh` does it for every OpenRouter key, and `--refresh=all` also starts each ChatGPT sign-in's engine that no window is using. A blank cell is "unknown", never "unlimited": nothing is wrong with the account.

## 83. A run exited with code 4, or a scheduled job says "paused"

**Cause:** the run opted in to fallback (`--fallback`, a job's or a team's setting), a limit ran out, and fallback couldn't move safely with nobody to ask: no other model in the order could take over, a command's end was unknown, a background command wasn't on the keep-running list, or a budget was used up. The reason is on stderr (`[ad] ⏸ Paused: …`), in `--json` (`"reason"`), in the job's `schedule-logs/<id>.status.json` and in `ad schedule list`.

**Fix:** nothing was lost: the session (`ses_…`) keeps the work. Run it again after the reset, add a target that can take over (`ad fallback`), or allow the long-running command (`ad fallback set keep-running "…"`). Scripts that treat any non-zero exit as a failure see `4` as one; check for it to tell "paused" from "failed".

## 84. "Export stopped: … look like keys", or a name can't go into a bundle

**Cause:** `ad state export` found text shaped like a key (an API key, a token) in what it would export, or a file whose name another OS can't create (`aux.md`, two names that differ only by case, a name ending in a dot). It lists each one: the row (`learnings #812 (text)`) or the file, never the key itself.

**Fix:** for keys, run again with `--redact` (the export gets `[redacted:…]`, your own memory is unchanged), or clean the row for good with `ad memory redact learnings:812` in your terminal. For names, rename the file it lists and export again.

## 85. An import was refused, interrupted, or held something back

**Cause and fix, by what ad said:**
- *"Import refused: …"*: the bundle has a name that could leave ad's folders, a file that doesn't match its manifest, a database with parts ad didn't make, or rows of a project it doesn't declare. Nothing was written. Export it again with this ad (`ad state export`), and import only bundles you made.
- *"This bundle was made by a newer ad"*: update ad here, then import again.
- *"An import was interrupted (imp_…)"*: finish it with `ad state import --resume imp_…`, or undo it with `ad state rollback imp_…`.
- *"held back: …"*: a memory file read like an instruction or held something shaped like a key. It waits under `~/.agent-daemon/imports/<id>/held/`; read it, then import again with `--accept-held` if it's fine.
- *"not mapped"*: ad couldn't tell where a project lives here. Its memory came in (searchable by its id); map it with `ad state import <file> --map <name>=<dir>`.
- *"… is a link. ad won't write through it."*: that project's `.agent-daemon` points somewhere else. Replace the link with a real folder, then import again.

## 86. ad tui: the terminal is stuck in ad's screen after a crash

**Symptom:** after `ad tui` ran fullscreen (`[tui] fullscreen_transcript = true`), the shell's earlier output is gone, clicks print odd characters such as `[<0;12;5M`, or the cursor is hidden.

**Cause:** ad leaves its screen on every exit it can see: quitting, Ctrl+C, a crash, a closed window, SIGTERM. A process killed outright (`kill -9`, Task Manager's End task, a power loss) can't, so the terminal stays in ad's screen with mouse reporting on.

**Fix:** put the terminal back by hand:
- macOS and Linux: `reset`.
- PowerShell 7: ``Write-Host -NoNewline "`e[?1049l`e[?1006l`e[?1002l`e[?1000l`e[<u`e[?25h"``
- Windows PowerShell 5.1 (no `` `e ``): `$e = [char]27`, then the same string with `$e` in place of each `` `e ``.
- Closing the tab and opening a new one always works.

Stray text on top of ad's screen while it runs (a library writing straight to the terminal): Ctrl+L repaints it.

## 87. ad tui: "Couldn't reach a clipboard" in fullscreen

**Symptom:** in fullscreen, copying a selection says "Couldn't reach a clipboard. Your terminal may select with Shift+drag, or start ad with --no-alt-screen."

**Cause:** ad copies through the system's clipboard tool first (`clip.exe` on Windows and WSL, `pbcopy` on macOS, `wl-copy`, `xclip` or `xsel` on Linux), each stopped after 2 seconds. When none worked, it falls back to OSC 52, which asks the terminal to copy, and it says this when that didn't happen either. Common on Linux without a display (no tool installed, or one waiting for a display) in a terminal that doesn't take OSC 52.

**Fix:**
- Linux: install `wl-copy` (Wayland) or `xclip` (X11).
- Over SSH: use a terminal that accepts OSC 52 (some ask you to allow it in their settings). Inside tmux, ad also puts the text in tmux's own buffer.
- Copy with the terminal itself instead: most terminals select with Shift+drag while a program has the mouse.
- Or start inline (`ad tui --no-alt-screen`, or `/tui` → Inline): the terminal's own selection and copy work as usual there.

## 88. ad tui: fullscreen doesn't start, or the mouse doesn't reach ad

**Symptom:** you picked fullscreen in `/tui`, but ad still starts inline. Or in fullscreen, a click selects text in the terminal, or the wheel scrolls the terminal instead of ad.

**Cause:** `/status` has a `screen` row that says which rule applied:
- `inline (started with --no-alt-screen)`: this run's flag.
- `inline (fullscreen turned off in your settings)`: `tui.alternate_screen = "never"` in the engine's settings file.
- `inline (you picked inline with /tui)`: `tui.fullscreen_transcript = false`.
- `inline (ad's default: /tui to change)`: no fullscreen choice in your own settings. Only a value in the engine's settings file in ad's engine folder counts; one in a project's settings doesn't.
- `inline (Apple Terminal over SSH)`: fullscreen stays off there.
- `mouse off: tmux mouse is off (set -g mouse on)`, `mouse off: screen.mouse is false in prefs.json`, or `mouse off: this terminal doesn't send mouse reports to ad` (the old Windows console window, where a click selects text instead).

**Fix:** follow the reason: drop the flag, remove `tui.alternate_screen = "never"` (or set `"always"` for Apple Terminal over SSH), pick **Fullscreen** in `/tui` and restart, `set -g mouse on` in tmux, or remove `"screen.mouse": false` from `~/.agent-daemon/tui/prefs.json`. In the old console window, use Windows Terminal; without the mouse, PgUp/PgDn scroll and Ctrl+Space starts a selection. `node runtime/scripts/tui-probe.mjs mouse` shows whether the terminal sends mouse reports at all.

## 89. Memory: "no SQLite driver" or "no such module: fts5"

**Symptom:** `ad doctor` (or `npx agent-daemon-memory doctor`) shows "no SQLite driver", or memory writes failed with "no such module: fts5".

**Cause:** memory runs on `better-sqlite3` when it is installed, else on Node's built-in SQLite. The built-in one has full-text search only from Node 22.16, so an older Node has no driver ad can use. Earlier memory packages accepted Node 22.13–22.15 and then failed on every write with "no such module: fts5"; now they say no driver is available, with the version they need.

**Fix:** upgrade Node to 22.16 or newer, or install `better-sqlite3` (`cd runtime && npm install`). `ad doctor` names the driver in use ("SQLite driver"); `AD_SQLITE_DRIVER` picks one.

## 90. Memory server: "the host didn't expand ${…}"

**Symptom:** the memory MCP server stops at start with `agent-daemon-memory: the host didn't expand ${PLUGIN_ROOT}; this host needs the installer route.` (or another `${…}` name), and the host lists no memory tools.

**Cause:** the host started the server with a variable in its arguments it didn't replace with a path, as Cursor does with `${PLUGIN_ROOT}`. ad stops instead of reading a wrong path. A `--project ${workspaceFolder}` left as it is (a window with no folder open) is not this error: ad skips that project with a note.

**Fix:** install memory for that host with the installer, which writes absolute paths: `npx agent-daemon-memory install` (or `ad memory install`). See [docs/memory/install.md](memory/install.md).

## 91. "ad can't read its account list", or doctor says "Account repair: … Run: ad auth repair"

**Symptom:** an `ad auth` command or a start stops with `ad can't read its account list (…registry.json: …). Your keys are untouched. Run: ad auth repair`, or `ad doctor` shows an "Account repair" row. Related: "This account list was written by a newer ad", "Another ad is updating the account list".

**Cause:** the account list (`~/.agent-daemon/accounts/registry.json`) is damaged, or a sign-in or key change was interrupted (a crash, a closed window) and left a half-made account or a key no account names. ad never resets the list by itself. A list from a newer ad is only read, never changed.

**Fix:** run `ad auth repair` in your own terminal. It finishes what it safely can and asks before the rest: restoring the list from its backup (the damaged file is kept), finishing or removing a half-made account, deleting a key no account uses. It never prints a key. "Another ad is updating" passes once the other command ends; "written by a newer ad" means updating ad here.

---

For harness problems, the [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill walks through login → hooks → sandbox → the engine's own log. See also [harness.md](harness.md) and, for the terminal UI, [tui.md](tui.md).

## Still stuck?

Open an issue at the repo with:

1. Output of `ad doctor`
2. Output of `ad --version`
3. OS + Node version (`node --version`)
4. The exact command you ran + verbatim error
5. Last 30 lines of `~/.agent-daemon/logs/` if any exist

