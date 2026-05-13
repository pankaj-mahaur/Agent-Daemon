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
   The fallback uses your local `claude` CLI to extract learnings post-hoc.

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

**Tracking:** This is a known issue with `runtime/src/claude.mjs` flag compatibility; fix slated for v0.2.1.

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
agent-daemon: no transcripts found for D:\Program Files\Mobiux\redseer-frontend
  searched: C:\Users\panka\.claude\projects\d-Program-Files-Mobiux-redseer-frontend
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

## Still stuck?

Open an issue at the repo with:

1. Output of `ad doctor`
2. Output of `ad --version`
3. OS + Node version (`node --version`)
4. The exact command you ran + verbatim error
5. Last 30 lines of `~/.agent-daemon/logs/` if any exist

