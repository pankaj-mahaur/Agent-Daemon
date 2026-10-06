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
   The fallback uses your local `claude` CLI to extract learnings post-hoc, or the Codex engine with `--llm codex` (`--llm auto` falls back to Codex when `claude` isn't installed).

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
- `type: "correction"` → queued in `proposals/`

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
ad auth login chatgpt                          # ChatGPT plan (browser; --device for a code)
ad auth login openai                           # or an OpenAI API key
ad auth login openrouter --model <slug>        # or an OpenRouter key
ad auth status
```

---

## 15. Harness: `Windows sandbox is …; unattended runs need it`

**Symptom:** `ad loop`, team workers or scheduled `loop` jobs refuse to start on Windows.

**Cause:** unattended runs never ask for approval, so on Windows they require a ready sandbox.

**Fix:** `ad sandbox setup` (unelevated), or `ad sandbox setup --elevated` for stronger isolation (one UAC prompt; machine-wide, so your own Codex shares the sandbox accounts it creates). `ad sandbox status` shows the current state.

---

## 16. Harness on Windows: every agent command fails with "Access is denied"

**Symptom:** `ad run` / `ad chat` finish, but the agent says its shell was denied and changes nothing. Codex's log (`logs_2.sqlite` in the harness home) shows `CreateProcessAsUserW failed: 5 (Access is denied.)` for `...\Microsoft\WindowsApps\pwsh.exe`.

**Cause:** PowerShell 7 from the Microsoft Store is an app-execution alias, and the sandbox's restricted token can't launch aliases.

**Fix:** upgrade to agent-daemon **2.0.1** or later, which keeps `WindowsApps` off the engine's PATH so Codex uses an installed pwsh 7 or `powershell.exe`.

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

## 19. Harness: `refusing to run Codex in …: that is your own Codex home`

**Symptom:** a harness command stops before Codex starts, with one of:

- `refusing to run Codex in <path>: that is your own Codex home`
- `refusing CODEX_HOME "<path>": Windows ignores a trailing dot or space …`
- `refusing CODEX_HOME <path>: network (UNC) paths are not supported`

**Cause:** the harness only runs Codex in its own home, `~/.agent-daemon/codex-home`, or wherever `AD_CODEX_HOME` points. It refuses any of these:

- `~/.codex`;
- a `CODEX_HOME` your shell sets for your own Codex;
- any path that leads to one of those (a junction, symlink, `\\?\` prefix, a trailing dot or space, a network share).

Your own Codex keeps its login, sessions and config to itself.

**Fix:** unset `AD_CODEX_HOME`, or point it at a new folder of its own. Leaving `CODEX_HOME` set for your own Codex is fine: the harness never passes `CODEX_*` variables to its engine (except `CODEX_CA_CERTIFICATE`).

---

## 20. Harness: `Codex engine not installed — run: cd runtime && npm install`

**Symptom:** `ad doctor` or any harness command reports the engine missing, even though `codex` works in your terminal.

**Cause:** the harness runs only the Codex version it pins (`runtime/package.json`), installed under `runtime/node_modules`. It never falls back to your global or PATH `codex`, so your own install and its version stay yours.

**Fix:** re-run the installer, or `cd runtime && npm install`. `AD_CODEX_BIN` can point at a specific binary for testing.

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

- On Windows, Node older than 22.17 (or 24.0–24.1) has no bracketed paste. Upgrade within your major version.
- Windows Terminal 1.24 and the VS Code terminal send Shift+Enter as plain Enter; use Ctrl+J for a newline. Windows Terminal 1.25 supports the keyboard protocol that tells them apart.

---

## 23. `ad tui` says it needs an interactive terminal or Node 22.17+

**Symptom:** `ad tui` (or bare `ad`) exits at once with one of:

- `ad tui needs an interactive terminal. Use ad chat for pipes and scripts.`
- `This terminal (TERM=dumb) can't show the UI. Use ad chat.`
- `ad tui needs Node 22.17+ or 24.2+ on Windows (this is …)`
- `mintty (Git Bash's window) can't pass keys to ad. Run winpty ad tui, or use Windows Terminal.`

**Cause:** the terminal UI needs a real terminal on both stdin and stdout. On Windows it also needs a Node with VT input in raw mode (22.17+ or 24.2+, not 23.x or 24.0–24.1); older ones turn a multi-line paste into one message per line. mintty doesn't pass keys to Windows console programs.

**Fix:**

- Run it in a terminal window, not through a pipe, `nohup` or a script. For scripts use `ad run` or `ad chat`.
- Upgrade Node within your major version (22.x stays ABI-compatible, nothing to rebuild), then check with `node -v`.
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

- `changed since the agent's edit`: the agent edited it, and it changed after that: you, your editor's format-on-save, or a formatter the agent ran, during the turn or after it. Undoing would throw that away; `force` does exactly that.
- `not changed by the agent's edits`: it changed during the turn some other way, for example through a command the agent ran (`npm install`, a formatter, `sed`) or your editor.
- `a folder is there now`: a folder stands where the file was.
- `a file is where its folder was`: a file or symlink now stands where one of the path's folders was. `force` doesn't override this.
- `not in the checkpoint`: the agent edited a file the snapshots leave out (untracked and over 2 MB, or in a heavy folder like `build/` or `node_modules/`). There is nothing to put back; `force` doesn't change that.

With any of these, nothing is undone.

**Fix:**

- Look at the files first (`/diff`, or `git diff`).
- If later changes to the agent's files can go, `/undo force` puts those files back too. Even forced, files the agent's edits didn't report are never touched, and folders are never removed or replaced; those are reported as left alone.
- If you want to keep them, fix the files by hand. Esc Esc rewinds just the conversation and leaves the files alone.

**Other `/undo` messages:**

- `The last turn has no checkpoint (…)`: the agent's first edit started before the snapshot taken when you sent the prompt was done (a very large working folder, a busy machine), snapshots fail in this repo (git's message follows), or the turn ran before `ad tui` started.
- `Not a git repo`: checkpoints need a git repo.
- `A turn started meanwhile`: a prompt was sent while `/undo` was checking. Run `/undo` again once that turn finishes.
- Ignored files, submodule contents and LFS files are never restored. With git older than 2.40, or with `.git/info/attributes` or `core.attributesFile` set, files with eol rules may come back normalized.

---

## 27. `ad tui`: `Codex stopped (exit N)`

**Symptom:** a banner under the composer says `Codex stopped (exit N). Your text is kept. Enter restarts and resumes.`

**Cause:** the Codex engine process exited, and ad's automatic restarts (3) didn't bring it back. The running turn is marked failed; your prompt and the scrollback are kept.

**Fix:**

- Press Enter on an empty prompt to try again. A prompt you send meanwhile waits in the queue and goes once Codex is back.
- If it keeps stopping: `/quit`, then `ad doctor`, then `ad tui --last` to continue the conversation.
- To see why: Codex's own log is `logs_2.sqlite` in the harness home (`~/.agent-daemon/codex-home`, table `logs`). The [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill shows how to read it. Common causes are a lost login (`ad auth status`) and the Windows sandbox (#16).

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

## 29. Windows: the first command or edit after installing takes ~35 s

**Symptom:** right after installing (or with a fresh `~/.agent-daemon/codex-home`), the agent's first command or file edit sits on "Thinking" for about half a minute. Later ones take a second or two.

**Cause:** Codex sets up its Windows sandbox for ad's Codex home on the first sandboxed action. It happens once per Codex home, not per project folder.

**Fix:** nothing to do; wait it out once. A command you approve to run outside the sandbox doesn't pay it.

---

For harness problems, the [`harness-troubleshoot`](../skills/daemon/harness-troubleshoot/SKILL.md) skill walks through login → hooks → sandbox → Codex's own log. See also [harness.md](harness.md) and, for the terminal UI, [tui.md](tui.md).

## Still stuck?

Open an issue at the repo with:

1. Output of `ad doctor`
2. Output of `ad --version`
3. OS + Node version (`node --version`)
4. The exact command you ran + verbatim error
5. Last 30 lines of `~/.agent-daemon/logs/` if any exist

