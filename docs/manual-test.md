# Manual test checklist

An end-to-end check of an install: Claude Code mode first, then the agent harness. Each step says what to run, what you should see, and where to look if it fails. Work in a **throwaway project**, not in a real repo: steps 2 and 4 write test learnings into that project's memory.

Commands are shown in bash. They also work in PowerShell unless noted.

---

## 0. Scratch project

```bash
mkdir ad-manual-test && cd ad-manual-test && git init -q
printf 'export function add(a, b) {\n  return a - b;\n}\n' > math.js
printf 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n' > math.test.js
echo '{"type":"module"}' > package.json
node --test            # expect: 1 failing test (the bug the agent will fix in step 4)
```

## 1. Install

| Run | Expect | If not |
|---|---|---|
| `ad --version` | the version in `runtime/package.json` | [troubleshooting #1](troubleshooting.md#1-ad-command-not-found-after-npm-link) |
| `ad doctor` | settings, hooks and dirs OK; a "Codex engine" line with the pinned version | re-run the installer; `cd runtime && npm install` |

## 2. Claude Code mode (v1 features)

| Run | Expect | If not |
|---|---|---|
| `ad init --plan` | a preview of what init will write | — |
| `ad init` | `.agent-daemon/memory/`, a managed block in `CLAUDE.md`, `AD-INSTRUCTIONS.md`, hooks in `~/.claude/settings.json` | [troubleshooting #8](troubleshooting.md#8-ad-doctor-shows-hooks-missing-right-after-ad-init) |
| Open `claude` here and say: *"actually we use tabs, not spaces"* | a new line in `.agent-daemon/learning-journal.jsonl` | `ad doctor`; check the UserPromptSubmit hook is registered |
| End the session, then `ad digest-latest --verbose` | extract → classify → apply steps, or "already digested" | [troubleshooting #4](troubleshooting.md#4-agent-daemon-no-agent-daemon-digest-block-found-in-transcript), [#12](troubleshooting.md#12-ad-digest-latest-says-no-transcripts-found-for-a-project-with-active-chats) |
| `ad memory stats` | non-zero learnings | — |
| `ad viewer` | path to an HTML snapshot of the memory store | — |

## 3. Harness: login and setup

| Run | Expect | If not |
|---|---|---|
| `ad auth login chatgpt` (or `openai` / `openrouter --model <slug>`) | browser sign-in, then `logged in: …` | `--device` for a code instead of the browser |
| `ad auth status` | harness home `~/.agent-daemon/codex-home`, the active login, no secrets printed | — |
| Windows: `ad sandbox status` | `ready` (it's set up on first use) | `ad sandbox setup` |
| `ad doctor` | Codex login OK, harness hooks `N/N trusted`, Windows sandbox ready | the next `ad run` re-trusts hooks |

## 4. Harness: real turns

| Run | Expect | If not |
|---|---|---|
| `ad run "The test in math.test.js fails. Fix the bug in math.js."` | the agent shows its commands, edits `math.js`, ends with a summary | [troubleshooting #16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-with-access-is-denied) if every command is denied |
| `node --test` (you, not the agent) | 1 passing test | read the agent's summary; re-run with `ad chat` |
| `git checkout math.js && ad loop "make the test in math.test.js pass" --max-iterations 3` | 1–2 iterations, then `stopped: objective done`; a log in `.agent-daemon/loops/` | exit code 3 = a brake stopped it (see its reason) |
| `touch .agent-daemon/STOP && ad loop "anything"` | refuses to start: STOP file exists. Then `rm .agent-daemon/STOP` | — |
| `ad chat`, ask for something that needs approval, answer `n` | the agent is told the action was declined and carries on | — |
| `ad web` | prints `http://127.0.0.1:<port>/#t=<token>`; the page loads and chats | — |

## 5. Background work

| Run | Expect | If not |
|---|---|---|
| `ad schedule add "*/5 * * * *" run "list the files here" --cwd .` then `ad schedule list` | the job with an id | — |
| `ad schedule run <id>` | output in `~/.agent-daemon/schedule-logs/<id>.log` | — |
| `ad watch --verbose` (Ctrl+C after a minute) | watcher starts; due jobs run | [troubleshooting #2](troubleshooting.md#2-ad-watch-runs-but-never-logs--add--never-fires-digest) |
| `ad schedule remove <id>` | job gone | — |

## 6. Clean up

```bash
cd .. && rm -rf ad-manual-test
```

The harness login stays in `~/.agent-daemon/codex-home`. Use `ad auth logout` to remove it.
