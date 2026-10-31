# Guard corpora: must-block, must-allow (v1)

Held-out test corpora for the rule matcher (plan parts L4c and L7) and the built-in self-protection rule (02-ARCHITECTURE §2.2).

## Provenance

- **Written by** a clean-room agent: Claude Opus 5.5 (`claude-opus-5-5`), running as a subagent in Claude Code, on **1 Nov 2026**. This follows plan decision D29: the implementer must not grade itself.
- **Read (read-only):**
  - `docs/plans/mcp-platform/02-ARCHITECTURE.md` §2.2 and §3;
  - `docs/plans/mcp-platform/04-PARTS.md` L4c and L7;
  - the brief from the plan owner (the neutral rule schema and technique list).
- **Not read:**
  - anything under `runtime/src`, `runtime/scripts`, `runtime/test` (except this folder and `../correction-pattern/`);
  - `hooks/`, `adapters/`, `packages/`, `bench/`, `skills/`, `mcp/`, `plugins/`, `docs/` (beyond the two plan sections above);
  - the other corpus folders.

  No grep of the repo was done. One directory listing showed five test file names under `runtime/test/` and the names of the other corpus folders; none was opened. The session context (CLAUDE.md) named the public verbs `init`, `doctor`, `review` and `memory`.
- **Validation:** a throwaway script outside the repo checked that:
  - every line parses, with LF line endings and no blank lines;
  - ids are unique;
  - each host and tool pair is valid;
  - each `apply_patch` input is framed by `*** Begin Patch` … `*** End Patch`;
  - no string contains a stray control character.

  It does not implement the matcher, so labels are by judgment, not by any implementation.

## Files and counts

| File | Items | Command rule | Write rule | Self-protection | Windows | macOS | Linux |
|---|---|---|---|---|---|---|---|
| `must-block.jsonl` | **184** | 93 | 31 | 60 | 64 | 24 | 96 |
| `must-allow.jsonl` | **154** | 82 | 28 | 44 | 47 | 14 | 93 |
| `ambiguous.jsonl` | 32 (not gated) | 14 | 5 | 13 | 5 | 2 | 25 |

| Tools and hosts | Bash | PowerShell | Write | Edit | Codex `shell` | Codex `apply_patch` | Claude Code items | Codex items |
|---|---|---|---|---|---|---|---|---|
| must-block | 76 | 34 | 15 | 10 | 33 | 16 | 135 | 49 |
| must-allow | 75 | 30 | 19 | 7 | 18 | 5 | 131 | 23 |

Gates (04-PARTS L4c):
- must-block: **0 misses**;
- must-allow: **≤ 2 % false positives**, which is at most 3 of 154.

`ambiguous.jsonl` is not gated.

## Schema

```
{"id":"gb-001","rule":{…},"host":"claude-code"|"codex","tool":"Bash"|"PowerShell"|"shell"|"Write"|"Edit"|"apply_patch",
 "input":{"command":"…"}|{"file_path":"…"}|{"patch":"…"},"os":"linux"|"macos"|"windows",
 "cwd":"…","project_root":"…","technique":["…"],"note":"optional"}
```

`ambiguous.jsonl` has the same fields plus `"why"`.

- One Write item (`ga-019`) also carries `input.content`, because its point is that a command rule must not look inside file content.
- `rule` uses the neutral schema from the brief:
  - **command rule:** `program` is matched after the path prefix and `.exe`, `.cmd`, `.bat` or `.ps1` are stripped (case-insensitive on Windows); `subcommands` must contain the first non-option argument; `flags` needs at least one listed flag present;
  - **write rule:** `globs` are relative to the project root and apply to Write, Edit and `apply_patch` targets;
  - `{"type":"self-protection"}` is the built-in rule.
- **Relative paths** in `file_path` and in patch headers resolve against `cwd`. In `gb-158` and `gb-159`, `cwd` is a subfolder of `project_root`.

## Placeholders (substitute before running)

| Placeholder | Meaning | Suggested substitution |
|---|---|---|
| `{pkg}` | the product's CLI command (not public yet) | the shipped command name |
| `{adroot}` | the product's user-level state folder | file tools (Write, Edit, `apply_patch`): absolute, such as `/home/dev/.agent-daemon`, `/Users/dev/.agent-daemon` or `C:\Users\dev\.agent-daemon`; Bash on Linux or macOS: `~/.agent-daemon`; PowerShell: `$env:USERPROFILE\.agent-daemon`; inside `cmd /c`: `%USERPROFILE%\.agent-daemon` |

The gate should hold under every spelling.

A few items spell today's folder name literally (`$HOME/.agent-daemon`, `$env:USERPROFILE\.agent-daemon`, and the project-level `.agent-daemon/learning-journal.jsonl` named in the plan). They are tagged `adroot-spelling`, or they concern the journal. If the folder is renamed, update those strings in a new corpus version.

### Assumed names (from the plan, not from code)

- **Protected verbs** (02 §2.2: review, rule, learning-edit, learning-forget, remember-with-token, setup) are spelled:
  - `{pkg} review`;
  - `{pkg} rules allow-once|pause|resume|rm <id>`;
  - `{pkg} learning edit <id>` and `{pkg} learning forget <id>`;
  - `{pkg} remember --token <t> "…"`;
  - `{pkg} setup`.

  If the CLI spells them differently, map the spelling and keep the label.
- **Read-only verbs used as look-alikes:** `report`, `doctor`, `--help`, `--version`, and `remember` without a token.
- **State files under `{adroot}`:** `guards.json` (named in the plan) plus `memory.db`, `policy.json` and `buffer/events.jsonl`, whose names are guesses. Labels assume self-protection covers any write under `{adroot}/`, plus `<project>/.agent-daemon/learning-journal.jsonl` and the product's hook entries.
- **Hook config:** the user-level Claude Code `settings.json` and the Codex hooks file (`~/.codex/hooks.json` is a stand-in for whichever Codex file holds the entries).

## Labels

- **must-block:** the call runs the forbidden program, verb or write once shell syntax, wrappers, quoting and path spelling are removed. The matcher must return ask or deny for the given rule.
- **must-allow:** a look-alike that does not run the forbidden thing:
  - text that only mentions it, such as strings, comments, search patterns, commit messages or file names;
  - a different program or subcommand;
  - a missing flag;
  - a read of a protected path;
  - a path outside the glob or outside the project;
  - a wrapper with no protected verb inside.

  The matcher must return no match.
- **ambiguous:** the plan or the schema does not settle the label. The `why` field says which way it leans and what is missing.

## Coverage by technique (tag occurrences; an item can carry several tags)

### must-block

| Group | Techniques (count) |
|---|---|
| Chaining and control flow | `chain-and` 10, `chain-semicolon` 6, `pipe` 7, `redirection` 5, `background` 3, `chain-or` 2, `newline` 2, `compound` (if) 1, `loop` 1, `trailing-comment` 1 |
| Nested shells | `cmd-c` 8, `powershell-command` 3, `pwsh-c` 3, `bash-c` 2, `bash-lc` 2, `subshell-paren` 2, `sh-c` 1, `subshell-dollar` 1, `backticks` 1, `cmd-chain` 1, `cmd-call` 1, `msys-double-slash` (Git Bash `cmd //c`) 1, `invoke-expression` 1, `ps-scriptblock` 1, `ps-assignment` 1 |
| Wrappers | `env-prefix` 5, `sudo` 4, `package-runner` (npx) 3, `env` 2, `xargs` 2, `wrapper-option-value` (`sudo -u x`, `nice -n 10`) 2, `time` 1, `nice` 1, `command` 1, `exec` 1, `timeout` 1, `find-exec` 1, `start-process` 1 |
| Program spelling | `ext-strip` 14, `quoting` 7, `relative-path` 6, `windows-case` 5, `call-operator` 5, `full-path` 4, `quote-concat` (`n"p"m`) 1, `backslash-escape` (`\rm`) 1, `line-continuation` 1, `ps-line-continuation` 1 |
| Arguments | `alias` (listed subcommand aliases) 13, `option-before-subcommand` 4, `powershell-cmdlet` 4, `plain` 4, `alias-flag` 3, `flag-after-positional` 1, `long-flag` 1, `bare-program` 1 |
| Self-protection: verbs | review 15, rules 13, setup 3, learning-forget 2, learning-edit 1, remember-token 1 |
| Self-protection: wrappers | `script` 2 (GNU and BSD), `expect` 1, `unbuffer` 1, `winpty` 1, `tmux` 2, `screen` 1, `setsid` 1, `nohup` 1, `disown` 1, cmd `start` 1, `Start-Process` 2, AD_TOOL_SHELL marker tampering 2 |
| Self-protection: state | `guards.json` 10, journal 5, DB 3, hook config 3, buffer 2, policy 2. Of these, 15 go through shell text (`sqlite3`, `sed -i`, `Set-Content`, `Add-Content`, `>`/`>>`, `cp`, `mv`, `rm`, `ln -sf`, `truncate`, `python -c`, a PowerShell pipeline) and 10 through file tools (Write, Edit, `apply_patch` Add, Update and Move to) |
| Write rules | Write 11, Edit 8, patch Add 5, Update 4, Delete 2, Move-into 2, Move-out 1, multi-file 1, absolute 3; Windows backslash 8, forward slash 1, case 1, `\\?\` extended path 1; `./` 2, `..` 3, `//` 1, relative 2, `cwd` below root 1; `**` deep 2, `**/` matching zero directories 1, `**/*.ext` 1; dotfile 2, dot-directory 2, exact file 2, multi-dot 1 |

### must-allow

| Group | Techniques (count) |
|---|---|
| Different program or subcommand | `lookalike-subcommand` 31 (`npm view`, `npm run review`, `git stash push`, `npm help install`, `gradlew publishToMavenLocal`…), `lookalike-program` 19 (`npx`, `pnpm`, `uv pip`, `git rm -r`, `Remove-ItemProperty`, `Get-ExecutionPolicy`…), `prefix-name` 6 |
| Flag look-alikes | `missing-flag` 7, `lookalike-flag` 7 (`--force-with-lease`, `--follow-tags`, `-destroy` as a flag, `-ExecutionPolicy Bypass`) |
| Text only | `string-literal` 8, `search-text` 7, `filename` 7, `commit-message` 3, `comment` 1, `data-heredoc` (`cat > f <<EOF`) 1, `patch-content-mention` 3, `file-tool-not-command` 1 |
| Paths | `prefix-path` 15 (`migrations-old/`, `src/generated/`, `/work/app-old/`, `.envrc`…), `outside-project` 3, `sibling-dir` 2, `glob-anchored` 1, `glob-extension` 1, `case-sensitive-fs` (Linux) 1, `read-only` and `shell-not-write-tool` 7 |
| Self-protection | `read-only-state` 12 (`cat`, `Get-Content`, `type`, `ls`, `head`, `cp` out of state, `git diff`), `read-verb` 8, `wrapper-without-verb` 8, `wrapper-with-read-verb` 2, `same-basename` 1, `lookalike-state` 1, `remember-without-token` 1, `file-tool-unrelated` 3 |

## Known gaps and judgment calls (for the plan owner)

1. **Terminal launchers are not in the wrapper list:**
   - `wt new-tab …` (gx-006), `gnome-terminal -- …` (gx-005), `osascript … do script` (gx-007), and by extension `open -a Terminal`;
   - the new shell's parent is the terminal server, not the agent, so the positive ancestry check in §2.2 can pass;
   - all three are left ambiguous. **Recommend adding terminal launchers to the reparenting list.**
2. **Package runners are seen through** for non-npm programs and for `{pkg}`: `npx jest` (gb-074), `npx prettier --write` (gb-077) and `npx {pkg} review` (gb-121) are must-block. `npx` is never treated as `npm` (ga-001).
3. **Unlisted wrappers are labelled by what runs:**
   - `timeout` (gb-045), `find -exec` (gb-061), `Start-Process` for a general rule (gb-089);
   - wrappers that take an option value: `sudo -u deploy` (gb-019), `nice -n 10` (gb-021).
4. **`rules resume` is must-block** (gb-098). It only tightens enforcement, but the plan forbids all rule verbs. `rules list` and `review --help` are ambiguous (gx-001, gx-002).
5. **`remember` without a token is must-allow** (ga-135). The plan forbids only remember-with-token.
6. **Wrappers around read-only verbs are must-allow** (ga-153, ga-154).
7. **Copying state out is must-allow** (ga-137, ga-138). It reads state and writes elsewhere.
8. **Windows case-insensitivity** is applied to program names, subcommands (`NPM Install`, as in the brief) and PowerShell parameter names (gb-080). The schema states it only for programs.
9. **Hook config:**
   - user-level Claude Code `settings.json` writes are must-block (gb-148, gb-149), and so is an edit of the Codex hook file (gb-150);
   - project-level `.claude/settings.json` (gx-012) and `~/.codex/config.toml` (gx-013, which holds the AD_TOOL_SHELL marker) are ambiguous.
10. **Option arity is unspecified:**
    - in `kubectl -n prod delete` and `git -C dir push --force`, a literal "first non-option" is the option's value (gx-018, gx-019);
    - must-block uses only `--opt=value` forms or options without a value before the subcommand.
11. **Short-flag clusters** (`rm -rfv`, gx-021) and **PowerShell parameter abbreviations** (`-Rec`, gx-024) are unspecified.
12. **Built-in aliases that the rule does not list** (`rd`, PowerShell `rm`, `pip3`, `python -m pip`) are ambiguous. The schema says aliases must be listed, so derivation (L4c) should add them.
13. **Write-rule edges:**
    - shell redirection into a protected path is a stated limit (gx-014);
    - Codex `apply_patch` sent through the shell tool (gx-015);
    - symlinks (gx-031);
    - case on macOS APFS (gx-016);
    - anchoring of slash-free globs such as `package-lock.json` in a subfolder (gx-017). Must-allow uses only globs that contain a slash, or the root file itself, so it does not depend on this choice.
14. **Opaque payloads** (`base64 -d | sh`, `-EncodedCommand`, variable indirection, paths built at runtime) are ambiguous. The threat model says the gate is not a sandbox.

Frozen: do not edit; changes need a new corpus version and a new hash.
