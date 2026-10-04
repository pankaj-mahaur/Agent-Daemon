---
name: ad-harness
description: "Use when work should be handed to agent-daemon's own agent harness instead of done inline — \"run this in the background\", \"keep working until it's done\", \"loop on this\", \"schedule this every morning\", \"har roz chalao\", \"background mein karwa do\", \"ad run / ad loop / ad schedule\", \"let codex do it\", \"spawn a worker\". Picks the right command (ad run, ad loop, ad schedule, ad sp), sets budgets and the sandbox, and verifies the result yourself afterwards."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read
---

# Hand work to the ad harness

agent-daemon v2 can run Codex-engine agents itself, with the daemon's memory, hooks and skills wired in. This skill decides when to delegate to it, which command fits, and how to check the result. Full reference: `docs/harness.md` in the agent-daemon repo.

## When to use

- The task is long, repetitive or should keep going without the user (fix until green, nightly summaries).
- The user wants something on a schedule.
- The work can run in parallel on separate branches (team workers).

Don't delegate one-line edits or anything that needs back-and-forth design. Do those inline.

## Procedure

1. **Check the harness is ready:**
   ```bash
   ad auth status          # must show an active login; otherwise ask the user to run: ad auth login chatgpt
   ```
   On Windows also `ad sandbox status`. Unattended runs refuse to start without a ready sandbox.
2. **Pick the command:**

   | Need | Command |
   |---|---|
   | one bounded task, no questions | `ad run "<task>" --cwd <repo>` (add `--json` to parse the result) |
   | iterate until an objective is met | `ad loop "<objective>" --max-iterations N --max-minutes M` |
   | recurring | `ad schedule add "<cron>" run\|loop "<prompt>" --cwd <repo>`, which needs `ad watch` or `ad service install` running |
   | parallel workers on branches | `ad tc` (team create), then `ad sp` (Codex worker by default) |

3. **Write the prompt as a spec:** the goal, the files involved, how to verify ("`node --test` passes"), and what *not* to touch. For `ad loop`, state a verifiable finish line. The loop stops only when the agent reports `done` + `exit_signal`, or a brake trips.
4. **Set brakes.** Always pass `--max-iterations` / `--max-minutes` for loops. Default sandbox is `workspace-write`; never pass `--sandbox danger-full-access` unless the user asked for it.
5. **Verify yourself.** Read the diff (`git diff`), run the tests, and report what actually changed. The agent's summary is a claim, not proof. Exit codes: `ad run` 0 = turn completed; `ad loop` 0 = done, 3 = a brake stopped it.
6. **Stop a runaway loop:** `touch .agent-daemon/STOP` (delete it before the next loop).

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
- **Delegating secrets.** Never put keys or passwords in a prompt; the harness passes the user's env through as Codex does.
- **Scheduling without a watcher.** `ad schedule` jobs only run inside `ad watch` / the service.
- **Windows `node --test` inside the agent.** It hits `spawn EPERM` in the unelevated sandbox; ask the agent to run test files directly, or verify yourself afterwards.
