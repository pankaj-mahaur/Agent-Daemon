# v0.2.0 Manual Test Checklist

Step-by-step checklist for you to verify v0.2.0 yourself in `D:\Program Files\Mobiux\redseer-frontend` (or any project). Run each block in order — each step says what to do, what to expect, and what to do if it fails.

> Notation: `$` is your shell prompt. Commands are PowerShell-friendly (also work in Git Bash on Windows). Anything in **bold** is what you're testing.

---

## Section 0 — Pre-flight (one-time)

### 0.1 Confirm `ad` is on PATH and at v0.2.0

```sh
$ ad --version
```

✅ Expected: `0.2.0`
❌ If you see `0.1.0` or "command not found":
- "command not found" → `cd D:\Program Files\my-projects\Agent-Daemon\runtime && npm link`
- `0.1.0` → `cd D:\Program Files\my-projects\Agent-Daemon && git pull --ff-only`, re-run.

### 0.2 Doctor

```sh
$ cd "D:\Program Files\Mobiux\redseer-frontend"
$ ad doctor
```

✅ Expected: 12 ✓ marks, line at bottom says `agent-daemon: all checks passed.`
❌ Any ✗ → it'll print the fix command on the same line. Run that, retry.

### 0.3 Confirm a fresh backup of your Claude settings exists

```sh
$ ls ~/.claude/settings.json.pre-v0.2.0-bak
```

✅ Expected: file exists, ~1.3 KB.
❌ Missing → make one now: `cp ~/.claude/settings.json ~/.claude/settings.json.pre-v0.2.0-bak`

---

## Section 1 — `ad init` works in your real project

### 1.1 Preview the install (read-only)

```sh
$ cd "D:\Program Files\Mobiux\redseer-frontend"
$ ad init --plan --profile developer
```

✅ Expected output ends with:
```
  Will create:
    + .agent-daemon/memory/       (new — 7 memory templates)
    + AGENTS.md  (or "Section in CLAUDE.md..." if AGENTS.md exists)
    + N hook(s) in ~/.claude/settings.json
  [dry-run] No changes made.
```

✅ Check: `CLAUDE.md` shows as **detected** (`✓`). If it shows `✗`, that's a regression — let me know.

### 1.2 Try every profile (read-only)

```sh
$ ad init --plan --profile minimal
$ ad init --plan --profile developer
$ ad init --plan --profile security
$ ad init --plan --profile nonsense
```

✅ Expected:
- `minimal` → no hook adds (memory + lifecycle already wired)
- `developer` → 2 PostToolUse hooks
- `security` → 4 hooks (2 PostToolUse + 2 PreToolUse) + 3 security skills
- `nonsense` → clean error: `unknown profile "nonsense". Known: minimal, developer, security`

### 1.3 Verify `.agent-daemon/` got created

(Already done during E2E earlier — should still be present.)

```sh
$ ls "D:\Program Files\Mobiux\redseer-frontend\.agent-daemon\memory"
```

✅ Expected 7 files: `activeContext.md`, `productContext.md`, `progress.md`, `projectbrief.md`, `systemPatterns.md`, `techContext.md`, `user.md`.

### 1.4 Verify CLAUDE.md was augmented, not destroyed

```sh
$ wc -l "D:\Program Files\Mobiux\redseer-frontend\CLAUDE.md"
```

✅ Expected: ~84 lines (was 72; +12 in the managed section).
✅ Check: open the file, scroll to bottom. Section between `<!-- agent-daemon:start -->` and `<!-- agent-daemon:end -->` is new. Everything above it is your original content, unchanged.

### 1.5 Idempotency — run init again, nothing should break

```sh
$ ad init --profile developer
```

✅ Expected: messages like `"  Nothing to do — agent-daemon is fully initialized"` OR a small no-op summary. No errors, no duplicate hook entries.

---

## Section 2 — Hooks fire correctly in real flow

### 2.1 `edit-post` warns on `console.log` in JS/TS

Create a test file with a `console.log` line:

```sh
$ echo 'function x() { console.log("test"); }' > "D:\Program Files\Mobiux\redseer-frontend\test-hook.js"
```

Then trigger the hook manually (Claude Code will do this automatically next time it edits a file):

```sh
$ echo '{"tool_input":{"file_path":"D:/Program Files/Mobiux/redseer-frontend/test-hook.js"}}' | ad hook edit-post
```

✅ Expected on stderr:
```
[agent-daemon] console.log left in D:/Program Files/Mobiux/redseer-frontend/test-hook.js (1 occurrence):
[agent-daemon]   1: function x() { console.log("test"); }
[agent-daemon] Strip these or replace with a real logger before committing.
```
✅ Expected on stdout: `{}`

Cleanup:
```sh
$ rm "D:\Program Files\Mobiux\redseer-frontend\test-hook.js"
```

### 2.2 `edit-post` is silent on non-JS files

```sh
$ echo 'console.log("not code")' > "D:\Program Files\Mobiux\redseer-frontend\test.md"
$ echo '{"tool_input":{"file_path":"D:/Program Files/Mobiux/redseer-frontend/test.md"}}' | ad hook edit-post
$ rm "D:\Program Files\Mobiux\redseer-frontend\test.md"
```

✅ Expected: no `[agent-daemon]` message on stderr. Stdout: `{}`.

### 2.3 `bash-post` surfaces `gh pr create` URLs

```sh
$ echo '{"tool_input":{"command":"gh pr create"},"tool_response":{"output":"https://github.com/pankaj-mahaur/Agent-Daemon/pull/42"}}' | ad hook bash-post
```

✅ Expected stderr:
```
[agent-daemon] PR created: https://github.com/pankaj-mahaur/Agent-Daemon/pull/42
[agent-daemon] Review with: gh pr view 42 --repo pankaj-mahaur/Agent-Daemon
```

### 2.4 `bash-post` tags `npm run build` completion

```sh
$ echo '{"tool_input":{"command":"npm run build"},"tool_response":{"output":"compiled in 12.3s"}}' | ad hook bash-post
```

✅ Expected stderr: `[agent-daemon] build completed — sanity-check size diff before pushing`

### 2.5 `bash-pre` blocks `git --no-verify` (security profile only)

This hook only fires if you installed the `security` profile. If you're on `developer`, skip this.

```sh
$ echo '{"tool_input":{"command":"git push --no-verify"}}' | ad hook bash-pre
```

✅ Expected stdout (single line, JSON):
```json
{"decision":"block","reason":"Refusing to skip git hooks via --no-verify..."}
```

### 2.6 `bash-pre` warns on `git push` (no block)

```sh
$ echo '{"tool_input":{"command":"git push origin main"}}' | ad hook bash-pre
```

✅ Expected stderr: `[agent-daemon] git push detected — review changes first with: git diff origin/main...HEAD`
✅ Expected stdout: `{"decision":"approve"}`

### 2.7 `mcp-pre` writes audit log

```sh
$ echo '{"tool_name":"mcp__qmd__search"}' | ad hook mcp-pre
$ tail -1 ~/.agent-daemon/audit/mcp.jsonl
```

✅ Expected last line: JSON with `ts`, `server: "qmd"`, `tool: "search"`.

### 2.8 `mcp-pre` warns on untrusted server (security profile)

```sh
$ echo '{"tool_name":"mcp__random_unknown__exfil"}' | ad hook mcp-pre
```

✅ Expected stderr: `[agent-daemon] MCP call to non-trusted server 'random_unknown' ...`

---

## Section 3 — SessionStart hook injects constitution into Claude Code

### 3.1 Confirm hook is wired

```sh
$ node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8')).hooks.SessionStart, null, 2))"
```

✅ Expected: a JSON array containing an entry with `command: "ad session-start --output-json"`.

### 3.2 Run the SessionStart command manually

```sh
$ cd "D:\Program Files\Mobiux\redseer-frontend"
$ ad session-start --output-json | head -c 500
```

✅ Expected: JSON starting with `{"additionalContext":"<!-- constitution/core.md -->\n# The Constitution — Core Rules\n...`

### 3.3 Open Claude Code in redseer-frontend — real test

1. Close any existing Claude Code session.
2. Open Claude Code in `D:\Program Files\Mobiux\redseer-frontend`.
3. Ask Claude: **"What's in your active context right now? Quote the first line of the constitution."**

✅ Expected: Claude quotes "Verify before reporting done" or similar from `core.md`. That means the SessionStart hook fired and injected our constitution.
❌ If Claude says it has no constitution loaded → the hook didn't fire. Check `~/.claude/settings.json` SessionStart entry exists.

### 3.4 Edit a JS file in Claude Code — confirms `edit-post` hook

While in that Claude Code session:

1. Tell Claude: **"Create a file `src/test-hook.tsx` with a single function that has a `console.log` in it."**
2. After Claude edits, look at Claude Code's terminal/logs panel.

✅ Expected: Somewhere in the output you'll see `[agent-daemon] console.log left in src/test-hook.tsx ...`
❌ If you don't see the warning → Claude Code's output panel may suppress hook stderr. Manual test 2.1 already verified the hook works; this is just a UI sighting.

3. Clean up: tell Claude to delete `src/test-hook.tsx`.

### 3.5 PR creation — confirms `bash-post`

If you have an open WIP branch in redseer-frontend, tell Claude:
**"Create a PR for this branch."**

After `gh pr create` runs:

✅ Expected: Claude (or the hook's stderr surface) shows `[agent-daemon] PR created: https://github.com/...` and the review hint.

---

## Section 4 — Cursor adapter (optional — only if you use Cursor)

### 4.1 Install hooks

```sh
$ mkdir -p "D:\Program Files\Mobiux\redseer-frontend\.cursor"
$ cp "D:\Program Files\my-projects\Agent-Daemon\adapters\cursor\hooks.json" "D:\Program Files\Mobiux\redseer-frontend\.cursor\hooks.json"
```

✅ Verify:
```sh
$ node -e "const j=require('D:/Program Files/Mobiux/redseer-frontend/.cursor/hooks.json'); console.log('version:',j.version,'events:',Object.keys(j.hooks).join(','))"
```
Output: `version: 1 events: sessionStart, sessionEnd, beforeShellExecution, afterShellExecution, afterFileEdit, beforeMCPExecution, preCompact`

### 4.2 Generate Cursor `.mdc` rules from our skills

```sh
$ cd "D:\Program Files\Mobiux\redseer-frontend"
$ node "D:\Program Files\my-projects\Agent-Daemon\adapters\cursor\adapt.mjs" --core --out .cursor/rules
```

✅ Expected stderr: `wrote 36 .mdc rules to .cursor/rules`
✅ Verify: `ls .cursor/rules | head -5` shows files like `bootstrap-daemon.mdc`, `debug-triage.mdc`, etc.

### 4.3 Confirm one .mdc has valid Cursor frontmatter

```sh
$ head -5 .cursor/rules/debug-triage.mdc
```

✅ Expected:
```
---
description: "Use when investigating a bug, ..."
alwaysApply: false
---
```

### 4.4 Open the project in Cursor

1. Launch Cursor, open `D:\Program Files\Mobiux\redseer-frontend`.
2. Ask Cursor: **"What auto-applied rules do you have?"** (Cursor's `@Rules` panel also shows them.)

✅ Expected: Cursor lists the skills as available rules.

---

## Section 5 — Codex adapter (optional — only if you use Codex CLI)

### 5.1 Install

```sh
$ mkdir -p ~/.codex/agents
$ cp "D:\Program Files\my-projects\Agent-Daemon\adapters\codex\config.example.toml" ~/.codex/config.toml
$ cp "D:\Program Files\my-projects\Agent-Daemon\adapters\codex\agents\"*.toml ~/.codex/agents/
```

### 5.2 Smoke

```sh
$ codex --help
```

✅ Expected: Codex launches without error. If you have `OPENAI_API_KEY` set, you can run `codex` and ask it to "Use the explorer agent to find the build command for this project."

❌ If Codex complains about a TOML field → could be a Codex schema bump. Open an issue with the error.

---

## Section 6 — Cleanup if something feels off

### 6.1 Restore the pre-install Claude settings

```sh
$ cp ~/.claude/settings.json.pre-v0.2.0-bak ~/.claude/settings.json
```

This removes the v0.2.0 hooks. SessionStart/SessionEnd from earlier setup may still be present (those were wired pre-v0.2.0).

### 6.2 Remove agent-daemon from a project (clean uninstall)

```sh
$ rm -rf "D:\Program Files\Mobiux\redseer-frontend\.agent-daemon"
$ rm "D:\Program Files\Mobiux\redseer-frontend\AGENTS.md"
```

Then open `CLAUDE.md` and remove the lines between `<!-- agent-daemon:start -->` and `<!-- agent-daemon:end -->` (inclusive). Existing content above and below those markers stays.

### 6.3 Wipe the MCP audit log

```sh
$ rm ~/.agent-daemon/audit/mcp.jsonl
```

Rotation files (`.1`, `.2`, `.3`) if any: `rm ~/.agent-daemon/audit/mcp.jsonl.*`

---

## Reporting issues

When you find anything that doesn't match the ✅ Expected output:

1. Note the section number (e.g., "Section 2.4").
2. Copy the command you ran + the actual output you got.
3. Tell me — I'll triage. Most issues will be either a missed sync between worktree and your primary clone, or a real bug.

## Done state

You've gone production when:

- [ ] Section 0: all 3 checks pass
- [ ] Section 1: all 5 init flows work
- [ ] Section 2: all 8 hook flows match expected
- [ ] Section 3: real Claude Code session in redseer-frontend shows the constitution loaded
- [ ] Section 4 (optional): Cursor hooks + rules installed
- [ ] Section 5 (optional): Codex config installed
