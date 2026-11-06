# The mistakes report (`ad mistakes`)

`ad mistakes` reads your Claude Code and Codex history and tells you which corrections you keep typing: how often you corrected your agents, which corrections came back, and in which agent. It is read-only and offline. It makes no model call, opens no network connection, starts no process and writes no file.

```bash
ad mistakes                  # this project
ad mistakes --all-projects   # every project
ad mistakes --share          # a redacted Markdown summary to post
ad mistakes --json           # the numbers as JSON
```

Without ad, the memory package runs the same report: `npx agent-daemon-memory mistakes` (same flags).

## What you see first

Before it reads anything, ad shows what it will read and asks:

```
ad mistakes counts the corrections you typed to your coding agents.

It will read, without changing anything:
  Claude Code  ~/.claude/projects                       3 project folders, 214 sessions, 4 Oct 2026 to 5 Nov 2026
  Codex        ~/.codex/sessions and archived_sessions  88 sessions in all projects (only this project's are counted), 12 Sep 2026 to 4 Nov 2026
  Also: the CLAUDE.md and AGENTS.md files of this project and in your user folders, Claude Code's settings.json (how long it keeps history) and Codex's config.toml.

Scope: this project only (~/work/app). --all-projects reads every project.
Offline: no model call, no network. Nothing is stored or sent.

Read these files now? [y/N]
```

Without a terminal (a script, CI, a pipe into stdin), pass `--yes`: ad won't read your history without an answer. When stdout goes to a file or a pipe, the screen and the question go to stderr and stdout gets only the report.

## The report

```
Mistakes report: this project (app). Offline: no model call, nothing stored.

4 of your top 10 repeats could become rules; replayed on your history, they would have asked before 37 commands. The other 6 are reminders, recalled and counted.
Claude Code and Codex together: 3 of your repeated corrections came up in both.
Codex sees none of your 42 CLAUDE.md rules.

Corrections per week
  13 Oct    8 ████████████████
  20 Oct   12 ████████████████████████
  ...

You corrected your agents 61 times in 412 typed prompts; 9 corrections repeated 3+ times.

Your top repeated corrections
  ×14 use pnpm, not npm  (Claude Code 9 · Codex 5)  → rule: would have asked before 21 commands
  ×6  stop adding comments to every function  (Claude Code 6)

Claude Code: 27 days of history, 214 sessions, 301 typed prompts.
Codex: 54 days of history, 41 sessions, 111 typed prompts.
Claude Code deletes transcripts after 30 days by default; raise "cleanupPeriodDays" in ~/.claude/settings.json to keep more.
```

- **Rules and reminders.** Each top repeat is either a rule a tool call can show, or a reminder ([below](#which-repeats-could-become-rules)). The first line says how many could be rules and what they would have asked before on your own history.
- **Both agents together.** The same correction typed to Claude Code and to Codex counts as one repeat, with a count per agent.
- **Rule coverage.** Claude Code reads `CLAUDE.md` files and Codex reads `AGENTS.md` files. The line says how many rules from one file the other agent never sees. A rule is a list item in those files, outside code blocks and outside ad's own managed block. A bullet that is only a link, only a command, or the heading of a sub-list doesn't count. If `CLAUDE.md` imports `@AGENTS.md`, or Codex's `config.toml` sets `project_doc_fallback_filenames` to read `CLAUDE.md`, ad counts that too.
- **Weekly trend:** corrections per week (weeks start on Monday, UTC), from your first prompt in the history, at most 8 weeks.
- **Top repeats:** the 10 corrections you typed most, at least twice each. Each is shown as one redacted sentence of at most 200 characters, in the wording you used most.
- **History found.** Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Codex keeps its sessions, but compresses older ones (`.jsonl.zst`), which Node reads from 22.15 on.

## What counts as a correction

A correction is something you told an agent that should still hold in a later, unrelated task: "use pnpm, not npm", "never push to main", "the API runs on port 4000", "keep replies short". It is decided offline by fixed rules, in English and romanised Hindi (Hinglish). There's no model and no network.

These don't count, even when they sound like rules:
- something about this turn only: "use the second approach", "revert that", "don't change anything else";
- anything scoped: "for now", "for this PR", "in this file", "yet";
- questions and what-ifs: "should we switch to pnpm?";
- approvals ("looks good"), task requests ("add a login page");
- pasted output: errors, stack traces, lint messages, command help, code blocks, quoted (`>`) text;
- a review comment you quote and don't adopt (it counts once you say "follow that from now on");
- statements about the current bug or output ("the bug is in parse()", "it should return 42");
- status reports ("the build always fails on CI", "we never got the email").

Same rule, other words: "use pnpm, not npm" and "stop using npm, we use pnpm" are one repeat. Opposite rules ("use tabs, not spaces" and "use spaces, not tabs") and different rules ("never use lodash", "never use var") stay apart.

How well this works is measured on a set of prompts written and labelled by someone other than the author of the rules, and checked by the test suite: at least 85% of what it calls a correction must be one, and it must find at least 60% of them. Real history has far fewer corrections per prompt than that set, so expect some misses and a few false hits; `--share` shows you the sentences before anyone else sees them.

## Which repeats could become rules

A correction can become a rule when a single tool call shows whether it was broken:
- **A command rule** names a program, and the verb or flag that matters when the program has many uses: "use pnpm, not npm" asks before `npm install`, `npm i`, `npm ci` and `npm add`, not before `npx` or `npm view`; "never force push" asks before `git push --force` and `git push -f`, not `--force-with-lease`; "don't run terraform apply yourself" asks before `terraform apply`.
- **A file rule** names files or folders the agent must not write: "don't touch src/gen/, it's generated" asks before a Write, an Edit or a patch under `src/gen/`. A folder you name means the project's own folder (`vendor/` is the root `vendor/`); a tool's cache folder (`node_modules`, `.terraform`, `__pycache__`) means any.
- **A reminder** is everything else: what code should look like ("no console.log in production code"), how to write or talk ("commit messages in English", "keep answers short"), something to do afterwards ("run the tests after a change"), a one-off ("don't push yet"), or advice too vague to check. Reminders are recalled and counted, never enforced.

The report replays each rule over the shell commands and file writes your agents ran in this history: "would have asked before 21 commands" means 21 of them ran what the rule names. A rule sees through how the command was written: chains (`cd web && npm i`), nested shells (`bash -lc "…"`, `cmd /c`, `powershell -Command`, an encoded command), wrappers (`sudo`, `env`, `xargs`, `timeout`, `npx`, `bundle exec`, `Start-Process`), quoting, paths and `.exe`/`.cmd`, Windows case and PowerShell's built-in aliases. It doesn't fire on text that only mentions the command (a string, a comment, a search, a commit message, data in a here-document).

Limits: a file rule checks the agent's file tools (Write, Edit, `apply_patch`), not a shell command that writes a file (`echo … > src/gen/x.ts`). A command built at run time (a variable, `eval` of a downloaded script) can't be read in advance. Both match how the coming rules will work: they ask before a tool call, from what the call shows.

How well this works is checked on held-out sets written by someone other than the author of the rules: corrections become the right rule or reminder at least 80% of the time, and on a set of tool calls a rule must catch every one that runs the forbidden thing and match at most 2% of the look-alikes.

## What is read, and what isn't

| Agent | Read | Left out |
|---|---|---|
| Claude Code | `projects/<folder>/<session>.jsonl` in `~/.claude` (or `CLAUDE_CONFIG_DIR`): the prompts you typed, including ones you sent while the agent was working, and the agent's Bash, PowerShell, Write and Edit calls (for replay) | subagent transcripts, meta and compacted-summary entries, slash-command wrappers, tool results, task notifications, scheduled and looped prompts, prompts a client generated, headless runs (`claude -p`) |
| Codex | `sessions/` and `archived_sessions/` in `~/.codex` (or `CODEX_HOME`): your prompts, and the agent's shell and `apply_patch` calls (for replay) | subagent sessions, the context Codex injects (`AGENTS.md`, environment), prompts a client generated, `codex exec` runs |

- A resumed or forked session repeats earlier messages; each message is counted once.
- Headless runs (`claude -p`, `codex exec`) are usually scripts or CI. They're left out, and the report says how many. A tool that runs `claude -p` for you as you type counts as headless too.
- **"This project"** is the git repository you're in: sessions started in its root or any folder inside it. Outside a git repository, only sessions started in exactly that folder count, and the report says "this folder". Other worktrees of the same repository count as other projects.

## Privacy

- Nothing is stored or sent. The report goes to your terminal.
- The sentences shown are redacted: secrets (keys, tokens, passwords), e-mail addresses, IP addresses, your account name, @handles, the folders of a path (only its last part stays: `<path>\app.log`), and everything after a URL's host (credentials included).
- `--share` adds no project name and no path. **Names of other people inside a sentence aren't found automatically**, so read the summary before you post it.
- `--json` has the numbers and the redacted sentences, plus the project folder's name (not its path).

## When it doesn't work

- "Run it again with --yes to read them": there was no terminal to ask in ([troubleshooting #92](troubleshooting.md#92-ad-mistakes-run-it-again-with---yes-to-read-them)).
- "No Claude Code or Codex history found for this project" ([#93](troubleshooting.md#93-ad-mistakes-no-claude-code-or-codex-history-found-for-this-project)).
- "Skipped N compressed Codex sessions" ([#94](troubleshooting.md#94-ad-mistakes-skipped-n-compressed-codex-sessions)).
