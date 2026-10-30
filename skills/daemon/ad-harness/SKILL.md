---
name: ad-harness
description: "Use when work should be handed to agent-daemon's own agent harness instead of done inline — \"run this in the background\", \"keep working until it's done\", \"loop on this\", \"schedule this every morning\", \"har roz chalao\", \"background mein karwa do\", \"ad run / ad loop / ad schedule\", \"let the agent do it\", \"spawn a worker\". Picks the command (ad run, ad loop, ad schedule, ad sp; ad tui for the user), sets budgets and the sandbox, and verifies the result yourself afterwards."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.2"
allowed-tools: Bash, Read
---

# Hand work to the ad harness

agent-daemon v2 can run agents itself on its own engine, with the daemon's memory, hooks and skills wired in. This skill decides when to delegate to it, which command fits, and how to check the result. Full reference: `docs/harness.md` in the agent-daemon repo.

## When to use

- The task is long, repetitive or should keep going without the user (fix until green, nightly summaries).
- The user wants something on a schedule.
- The work can run in parallel on separate branches (team workers).

Don't delegate one-line edits or anything that needs back-and-forth design. Do those inline.

## Procedure

1. **Check the harness is ready:**
   ```bash
   ad auth status          # what ad uses now, and whether each account works
   ```
   No working account: ask the user to run `ad auth login <provider>` (`openai`, `openrouter`, `chatgpt`, others in `ad auth login --help`) in their own terminal; keys are typed at a hidden prompt, never put on a command line or in a prompt. On Windows also `ad sandbox status`. Unattended runs refuse to start without a ready sandbox.
   Run in a project folder (`--cwd <repo>`). In a home folder, or a folder under a home that is a git repo, the user's own engine skills and settings would load, so ad refuses (`ad tui`, `ad schedule add`) or runs with a warning that it will need `--allow-home-folder` (`ad run`, `ad chat`, `ad loop`). Pass that flag only when the user asked.
2. **Pick the command:**

   | Need | Command |
   |---|---|
   | one bounded task, no questions | `ad run "<task>" --cwd <repo>` (add `--json` to parse the result) |
   | iterate until an objective is met | `ad loop "<objective>" --max-iterations N --max-minutes M` |
   | recurring | `ad schedule add "<cron>" run\|loop "<prompt>" --cwd <repo>`, which needs `ad watch` or `ad service install` running |
   | parallel workers on branches | `ad tc` (team create), then `ad sp` (an `ad` worker by default, sandboxed; `--engine claude` for Claude Code, which runs unsandboxed with `--dangerously-skip-permissions`; `AD_CLAUDE_BIN` picks the Claude Code) |
   | the user wants to work with the agent themselves, watching and approving | tell them to run `ad tui` (`ad tui --last` continues). It needs an interactive terminal, so you can't drive it from a tool call. Guide: `docs/tui.md` |
   | move ad (memory, settings, accounts list) to another computer or OS | the `ad-state-migrate` skill (`ad state export` / `verify` / `import`); the review and sign-ins stay the user's |

3. **Write the prompt as a spec:** the goal, the files involved, how to verify ("`node --test` passes"), and what *not* to touch. For `ad loop`, state a verifiable finish line. The loop stops only when the agent reports `done` + `exit_signal`, or a brake trips.
4. **Pick the account** when the user named one: `--account <provider>/<label>` (with `--model` and `--effort`) on `ad run`, `ad loop` and `ad sp` (workers run on it too); `ad run` prints the target it used on stderr (`target: …`, and `target` in `--json`), or `AD_ACCOUNT` for a scheduled job (`ad auth use <account> --session` prints the line). `ad auth list` shows what exists. Account changes (`ad auth login/use/logout/remove`) refuse from the agent's own shell: ask the user to run them. Without either, ad uses the project's choice (trusted folders) or the default account. An account that needs its key again stops the start: tell the user the command it prints. API keys stay in ad's local gateway and never reach the engine. Providers that speak only Chat Completions go through a translation there, and what they can't carry (live web search, images for a text-only model) is refused before anything is sent: pick another model or `ad tools disable web-search`. The fallback order (`ad fallback`, where a task may continue when a limit runs out) is the user's too: from the agent's shell you can run `ad fallback`, `ad fallback preview` and the dry `ad fallback test`; `add`, `remove`, `order`, `move`, `set`, `enable` and `test --live` refuse there, and `enable`, a trial endpoint's consent and `test --live` need a terminal even with `--yes`, so ask the user to run them. With the order on, `ad tui` moves a turn that ran out of its limit to the next model by itself; `AD_FALLBACK=0` turns that off for a run. Unattended runs need their own opt-in: `ad run --fallback`, `ad loop --fallback`, a job's `--fallback`, `ad team set <team> fallback on`. Each refuses from the agent's own shell (exit 2), so ask the user to add it; a job or team the user already set uses it.
5. **Set brakes.** Always pass `--max-iterations` / `--max-minutes` for loops. Default sandbox is `workspace-write`; never pass `--sandbox danger-full-access` unless the user asked for it.
6. **Verify yourself.** Read the diff (`git diff`), run the tests, and report what actually changed. The agent's summary is a claim, not proof. Exit codes: `ad run` 0 = turn completed, 1 = failed, 2 = refused; `ad loop` 0 = done, 3 = a brake stopped it; both 4 = fallback paused (read `reason` in `--json` or the `[ad] ⏸ Paused:` line; the session `ses_…` keeps the work, re-run later). With `--fallback`, `--json` also has `target` (who finished) and `fallback` (each switch): say which model did the work when you report. `ad sessions show --last` (or the `ses_…` id) lists each turn's target and every tool call with its effect (`read`, `exec`, `write`) and how it ended: compare it with the agent's summary.
7. **Stop a runaway loop:** `touch .agent-daemon/STOP` (delete it before the next loop).

## Examples

### Example 1: fix until green

User: "tests fail, keep fixing till they pass, I'm going for lunch."

```bash
ad loop "Make 'npm test' pass in this repo. Don't edit test files. Verify by running npm test." --max-iterations 15 --max-minutes 45
git diff --stat && npm test
```

### Example 2: weekday summary

User: "har subah 9 baje kal ke commits summarize karo" (every morning at 9, summarize yesterday's commits).

```bash
ad schedule add "0 9 * * 1-5" run "Summarize yesterday's commits on main in 5 bullets." --cwd ~/code/app
ad schedule list
```

Check that `ad service status` shows the watcher registered; otherwise the job never runs.

## Anti-patterns

- **Unbounded loops.** No `--max-*` flags means up to 20 iterations / 60 minutes of spend.
- **Trusting "done".** Always re-run the verification yourself.
- **Delegating secrets.** Never put keys or passwords in a prompt. Keys ad stores stay in its gateway and the gateway token is hidden from tool shells, but the rest of the user's environment still reaches the agent's shell.
- **Running guarded commands through the agent.** The agent's shell carries `AD_TOOL_SHELL=1`; account changes, fallback changes, memory accepts and `ad state` refuse there by design. Hand the user the command.
- **Scheduling without a watcher.** `ad schedule` jobs only run inside `ad watch` / the service.
- **Windows `node --test` inside the agent.** It hits `spawn EPERM` in the unelevated sandbox; ask the agent to run test files directly, or verify yourself afterwards.
