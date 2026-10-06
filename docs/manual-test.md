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

## 6. Terminal UI (`ad tui`)

Run this in each terminal you use: Windows Terminal, Zed and the VS Code terminal. Stay in the scratch project from step 0, never a real repo. Start with `git checkout math.js` so the bug is back.

**Live script** (the FC3 sign-off):

| # | Do | Expect | If not |
|---|---|---|---|
| 1 | `ad tui` | the sign-in panel if needed, then "Do you trust …?" on the first run (answer Yes), then the header card: version, Codex version, model, directory with `git: <branch>`, memory, sandbox | [troubleshooting #23](troubleshooting.md#23-ad-tui-says-it-needs-an-interactive-terminal-or-node-2217) |
| 2 | **Ask:** *"What does math.js do? Don't change anything."* | Explored / Ran rows, a streamed answer, "Worked for Ns"; `ctx N%` in the footer | — |
| 3 | `/permissions` → **Read only**. Then: *"Run `echo hi > hello.txt` in the shell."* | **exec approval:** a box with the full command. `y` within 400 ms of it opening does nothing; `n` declines at once and the agent carries on | — |
| 4 | Still Read only: *"Fix the bug in math.js."* | **patch approval:** a box with the diff of `math.js`. `y` → "approved", and the file changes. Then `/permissions` → **Auto** | — |
| 5 | **Steer:** ask *"Explain node:test in 40 lines."*, and while it runs type *"make it 5 lines"* + Enter | the footer reads `enter steer`; your text joins the running turn and the answer follows it | — |
| 6 | **Queue:** while a turn runs, type *"now run node --test"* + Tab | `↳ queued: now run node --test` under the status line. Tab on an empty prompt pulls it back; Tab again queues it. It runs when the turn ends | — |
| 7 | **Interrupt:** start a long answer, press Esc | "Interrupting…", and the turn ends as interrupted. Ctrl+C on a running turn does the same | — |
| 8 | **`/codex` and back:** `/codex`, ask one thing there, quit the stock UI | the stock Codex UI opens on the same conversation; back in ad, "Back from the stock Codex UI (exit 0)", the new turn shows, and nothing earlier is printed twice | — |
| 9 | **Quit:** Ctrl+C on an empty prompt, then Ctrl+C again | "Ctrl+C again quits", then ad exits with `To continue: ad tui --resume <id>` and the tokens. The terminal works normally (cursor, echo) | `reset` the terminal and report it |
| 10 | `ad tui --last` | the same conversation; *"What did we change?"* answers from it | — |

**Quick checks** (same scratch project):

| Do | Expect | If not |
|---|---|---|
| Type, then send *"Add a subtract function to math.js."*; when it is done, `/undo` | "Undid the last turn: 1 file put back …"; the prompt is back in the composer; `git diff math.js` shows no `subtract` | — |
| Ask the same again, edit `math.js` yourself, then `/undo` | "Not undone: math.js (changed since the turn). /undo force overrides …"; nothing changed. `/undo force` puts it back | [troubleshooting #26](troubleshooting.md#26-undo-refuses-not-undone) |
| Esc Esc on an empty prompt while idle | "Esc again to rewind…", then a "Rewind to" picker. Pick one: "Rewound to before … Files on disk weren't changed.", and that prompt is back in the composer | — |
| Ctrl+T | the whole transcript in a pager (↑ ↓ PgUp PgDn); Esc closes it and the scrollback is unchanged | — |
| `?`, then `/terminal-setup` | the shortcuts with the newline key for this terminal; advice for this terminal | [troubleshooting #24](troubleshooting.md#24-ad-tui-shiftenter-sends-instead-of-adding-a-newline) |
| Make the window narrower, then wider, while `ad tui` runs | no stray copies of the bottom lines; if there are, Ctrl+L redraws | [troubleshooting #25](troubleshooting.md#25-ghost-copies-of-the-bottom-lines-after-narrowing-the-window) |

**Terminal probes** (from the repo). They change nothing but the terminal's modes, which they restore on exit.

| Run | Expect | If not |
|---|---|---|
| `node runtime/scripts/tui-probe.mjs keys`, press a few keys and paste two lines, then `qqq` | each key named. On Windows with Node 22.17+ the paste shows as one `PASTE (… line breaks)` row | [troubleshooting #22](troubleshooting.md#22-keys-or-paste-behave-oddly-in-a-terminal) |
| `node runtime/scripts/tui-probe.mjs screen --bottom`, make the window narrower then wider, then `qqq` | wrap and autowrap verdicts, plus one line per resize | attach `~/.agent-daemon/logs/tui-probe-screen-*.log` and a screenshot to an issue |

## 7. Clean up

```bash
cd .. && rm -rf ad-manual-test
```

The harness login stays in `~/.agent-daemon/codex-home`. Use `ad auth logout` to remove it.
