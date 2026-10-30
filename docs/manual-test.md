# Manual test checklist

An end-to-end check of an install: Claude Code mode first, then the agent harness and its terminal UI. Each step says what to run, what you should see, and where to look if it fails. Work in a **throwaway project**, not in a real repo: steps 2, 4 and 6 write test learnings into that project's memory.

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
| `ad doctor` | settings, hooks and dirs OK; an "Engine version" line with the pinned version | re-run the installer; `cd runtime && npm install` |

## 2. Claude Code mode (v1 features)

| Run | Expect | If not |
|---|---|---|
| `ad init --plan` | a preview of what init will write | — |
| `ad init` | `.agent-daemon/memory/`, a managed block in `CLAUDE.md`, `AD-INSTRUCTIONS.md`, hooks in `~/.claude/settings.json` | [troubleshooting #8](troubleshooting.md#8-ad-doctor-shows-hooks-missing-right-after-ad-init) |
| Open `claude` here and say: *"actually we use tabs, not spaces"* | a new line in `.agent-daemon/learning-journal.jsonl` | `ad doctor`; check the UserPromptSubmit hook is registered |
| End the session, then `ad digest-latest --verbose` | extract → classify → apply steps, or "already digested" | [troubleshooting #4](troubleshooting.md#4-agent-daemon-no-agent-daemon-digest-block-found-in-transcript), [#12](troubleshooting.md#12-ad-digest-latest-says-no-transcripts-found-for-a-project-with-active-chats) |
| `ad memory stats` | non-zero learnings | — |
| `ad memory held` | the notes waiting for you (written by the agent) or held back (flagged), or none | [troubleshooting #51](troubleshooting.md#51-my-note-isnt-used-yet) |
| `ad review` | pending notes and proposals; accepting asks you to type `accept`. From inside an agent's shell it refuses | [troubleshooting #52](troubleshooting.md#52-ad-review-accepting-notes-cant-run-from-the-agents-own-shell-or--needs-an-interactive-terminal) |
| `ad memory report` | corrections captured, repeats, what memory showed, what waits for review | — |
| `ad viewer` | path to an HTML snapshot of the memory store | — |

## 3. Harness: login and setup

| Run | Expect | If not |
|---|---|---|
| `ad auth login openai` (or `openrouter --model <slug>` / `chatgpt`) | API-key prompt or browser sign-in, then `logged in: …` | `--device` for a code instead of the browser |
| `ad auth status` | every account and which one is the default, no secrets printed | — |
| Windows: `ad sandbox status` | `ready` (it's set up on first use) | `ad sandbox setup` |
| `ad doctor` | engine login OK, harness hooks `N/N trusted`, Windows sandbox ready | the next `ad run` re-trusts hooks |

## 4. Harness: real turns

| Run | Expect | If not |
|---|---|---|
| `ad run "The test in math.test.js fails. Fix the bug in math.js."` | the agent shows its commands, edits `math.js`, ends with a summary | [troubleshooting #16](troubleshooting.md#16-harness-on-windows-every-agent-command-fails-access-is-denied-or-createprocessasuserw-failed) if every command is denied or fails with `CreateProcessAsUserW failed` |
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

**Live script** (the FC3 sign-off). It also runs automated, on the real engine with a mock model, together with checks of ad's own TUI features: `cd runtime && AD_REAL_ENGINE=1 node --test --test-concurrency=1 --test-force-exit test/tui-live.test.mjs` (a few minutes; the first run on Windows adds ~35 s once). It needs the devDependencies, which the one-liner skips: run `npm install` in `runtime/` first.

| # | Do | Expect | If not |
|---|---|---|---|
| 1 | `ad tui` | the sign-in panel if needed, then "Do you trust …?" on the first run (answer Yes), then the header card: `>_ Agent Daemon (v…)`, model, directory with `git: <branch>`, memory, sandbox | [troubleshooting #23](troubleshooting.md#23-ad-tui-says-it-needs-an-interactive-terminal-or-node-2217) |
| 2 | **Ask:** *"What does math.js do? Don't change anything."* | Explored / Ran rows, a streamed answer, "Worked for Ns"; the status line under the prompt shows the model, the folder and `ctx N%` | — |
| 3 | `/permissions` → **Read only**. Then: *"Run `echo hi > hello.txt` in the shell."* | **exec approval:** a box with the full command and the choices the engine offers (`y`, `p` for "don't ask again", Esc = "No, and stop"; `n` when the engine offers "No, and say what to do instead"). `y` within 400 ms of it opening does nothing; Esc declines and ends the turn | — |
| 4 | Still Read only: *"Fix the bug in math.js."* | **patch approval:** a box with the diff of `math.js`. `y` → "approved", and the file changes. Then `/permissions` → **Auto** | — |
| 5 | **Steer:** ask *"Explain node:test in 40 lines."*, and while it runs type *"make it 5 lines"* + Enter | the footer reads `enter steer`; your text joins the running turn and the answer follows it | — |
| 6 | **Queue:** while a turn runs, type *"now run node --test"* + Tab | `↳ queued: now run node --test` under the status line. Tab on an empty prompt pulls it back; Tab again queues it. It runs when the turn ends | — |
| 7 | **Interrupt:** start a long answer, press Esc | "Interrupting…", and the turn ends as interrupted. Ctrl+C on a running turn does the same | — |
| 8 | **Quit:** Ctrl+C on an empty prompt, then Ctrl+C again | "Ctrl+C again quits", then ad exits with `To continue: ad tui --resume <id>` and the tokens. The terminal works normally (cursor, echo) | `reset` the terminal and report it |
| 9 | `ad tui --last` | the same conversation; *"What did we change?"* answers from it | — |

**Quick checks** (same scratch project):

| Do | Expect | If not |
|---|---|---|
| Type, then send *"Add a subtract function to math.js."*; when it is done, `/undo` | "Undid the last turn: 1 file put back …"; the prompt is back in the composer; `git diff math.js` shows no `subtract` | — |
| Ask the same again, edit `math.js` yourself, then `/undo` | "Not undone: math.js (changed since the agent's edit). /undo force puts the agent's files back anyway, discarding the changes made after its edit; the rest are never touched."; nothing changed. `/undo force` puts it back | [troubleshooting #26](troubleshooting.md#26-undo-refuses-not-undone) |
| Esc Esc on an empty prompt while idle | "Esc again to rewind…", then a "Rewind to" picker. Pick one: "Rewound to before … Files on disk weren't changed.", and that prompt is back in the composer | — |
| Ctrl+T | the whole transcript in a pager (↑ ↓ PgUp PgDn); Esc closes it and the scrollback is unchanged | — |
| `?`, then `/terminal-setup` | the shortcuts with the newline key for this terminal; advice for this terminal | [troubleshooting #24](troubleshooting.md#24-ad-tui-shiftenter-sends-instead-of-adding-a-newline) |
| Make the window narrower, then wider, while `ad tui` runs | no stray copies of the bottom lines; if there are, Ctrl+L redraws | [troubleshooting #25](troubleshooting.md#25-ghost-copies-of-the-bottom-lines-after-narrowing-the-window) |
| `/remember tests use node:test`, then `/memory recent` | a "Learned:" row, then the note listed with its `#id` | `/ad doctor` |
| `/import` | "/import isn't planned for ad.", and the text stays in the prompt; nothing is sent | — |
| `/plan`, then *"How would you add a subtract function to math.js?"* | **Plan mode** in the footer and a magenta prompt; the model explores without editing, then a **Proposed Plan** and "Implement this plan?". "Yes, implement this plan" implements it. Shift+Tab switches back | [troubleshooting #33](troubleshooting.md#33-ad-tui-plan-says-plan-mode-unavailable-right-now) |
| *"Start `node -e "setInterval(() => {}, 1000)"` in the background."* | the footer counts "1 background terminal running"; `/ps` lists it with its last lines; `/stop` ends it | — |
| `mkdir sub` in the project, then `/cd sub` | the trust question, then "Working directory changed to: …sub"; `/pwd` agrees | — |
| While a turn runs: `/side What does node:test do?` | a side panel answers under the main conversation; Ctrl+/ moves between the prompts; Ctrl+C closes it | — |
| `/vim`, type, Esc, `0`, `dw`, `i` | "Vim mode enabled."; **Vim: Normal** / **Vim: Insert** in the footer; the bar cursor in Insert; `/vim` again turns it off | — |
| `/theme`, ↓, Enter | **Select Syntax Theme** with a code sample and a diff recoloured as you move; Enter saves it ("Saved.") | — |
| `/recap` | "Generating conversation recap…", then a dim **↳ Recap:** and, when there is one, **Next:** | [troubleshooting #34](troubleshooting.md#34-ad-tui-recap-says-could-not-generate-a-recap-please-try-again) |
| `/subagents` | "No agents available yet.", or, after the model used subagents, **Subagents**: pick one to watch it live; Alt+← / Alt+→ move between them | — |
| `/keymap`, then `/keymap debug` and a few keys | the keys in effect; the Keypress Inspector names each key and its actions | [troubleshooting #30](troubleshooting.md#30-ad-tui-keys-set-outside-ad-dont-work-in-ad) |
| `/statusline`, Space on an item, Esc; then again, Space, Enter | the status line changes as you toggle; Esc puts it back; Enter saves ("Saved.") | — |
| `/title`, turn on `activity`, Enter; send a prompt | the window or tab title shows a spinner while the turn runs; after quitting, the terminal's own title is back | — |
| `/clear test` | the screen and scrollback are cleared; "New conversation: test. The one before: /resume …" | — |
| `/archive` (wait a moment, then `y`), then `/resume archived` and Enter | "Archived. /resume archived brings it back.", then "Unarchived and resumed." | — |
| Ctrl+O, Alt+R, F2 | the last answer copied; printed as plain text; the warnings | — |
| `/private`, send *"What does math.js export?"*, then `/private` again | "Private: your prompts are wrapped in <private> …"; the prompt shows as typed, marked "(private)"; then "Private is off." | — |
| In the engine's settings file (`ad about` shows where) add `[tui.keymap.global]` `open_transcript = "leader t"`, restart, press Ctrl+X | the footer lists what can follow (`… t …` and `esc cancel`); `t` opens the Ctrl+T pager; Ctrl+X then Esc cancels and types nothing. `/keymap` names the leader. Remove the line afterwards | [troubleshooting #30](troubleshooting.md#30-ad-tui-keys-set-outside-ad-dont-work-in-ad) |
| `/subagents` after the model used subagents | each row shows the agent's model and effort when the engine reports them | — |

**Fullscreen** (early; same scratch project). Do it in Windows Terminal and Zed at least, and in tmux or over SSH if you use them.

| Do | Expect | If not |
|---|---|---|
| `/tui` → **Fullscreen**, quit (Ctrl+C twice), then `ad tui --last` | "Saved: fullscreen from the next start."; ad now fills the window and the shell's earlier output is hidden. `/status` shows `screen  fullscreen` | [troubleshooting #88](troubleshooting.md#88-ad-tui-fullscreen-doesnt-start-or-the-mouse-doesnt-reach-ad) |
| Ask for a long answer (*"Explain node:test in 60 lines."*); while it streams, PgUp, then the wheel | the view stays where you scrolled while output arrives; the last row says "↓ Back to bottom". Ctrl+End, Esc or a click on that row goes back | — |
| Drag over a few lines, then Ctrl+C | the lines are highlighted; "Copied." (or "Copied (through the terminal).") and ad doesn't quit. Paste somewhere to check the text, wrapped lines joined as one | [troubleshooting #87](troubleshooting.md#87-ad-tui-couldnt-reach-a-clipboard-in-fullscreen) |
| Double click a word, triple click a line, Shift+click; Esc | word, line, extended selection; Esc clears it without interrupting | — |
| F3, type `test`, Ctrl+P / Ctrl+N, Enter, Esc | matches highlighted, the current one in view; Enter keeps it; Esc goes back to the bottom | — |
| Ctrl+T, drag in the pager, Ctrl+C; then Esc | the pager's lines selected and copied, the pager still open; Esc closes it | — |
| Ctrl+G with a terminal editor (`EDITOR=vi`), edit, save and quit | the editor gets the whole window; back in ad, the edited prompt is in the composer and the screen is repainted | [troubleshooting #28](troubleshooting.md#28-ad-tui-the-editor-ctrlg-returned-at-once) |
| `/ad doctor` | the doctor's output on the shell's screen, then "Press Enter to return to ad."; Enter brings ad back; after quitting, that output is still in your scrollback | — |
| macOS and Linux: Ctrl+Z between turns, then `fg` | the shell's screen comes back with a stopped job; `fg` brings ad back repainted. During a turn Ctrl+Z only says it works between turns | — |
| Resize the window narrower, then wider | history re-wraps to the new width; nothing is duplicated | — |
| Quit | the shell's earlier output is back as it was, with the `ad tui --resume` hint under it; clicks don't print `[<0;…M` | [troubleshooting #86](troubleshooting.md#86-ad-tui-the-terminal-is-stuck-in-ads-screen-after-a-crash) |
| `ad tui --no-alt-screen`, then `/status` | inline; `screen  inline (started with --no-alt-screen)` | — |
| `/tui` → **Inline**, quit, `ad tui --last` | back to inline (the default) | — |

**Terminal probes** (from the repo). They change nothing but the terminal's modes, which they restore on exit.

| Run | Expect | If not |
|---|---|---|
| `node runtime/scripts/tui-probe.mjs keys`, press a few keys and paste two lines, then `qqq` | each key named. On Windows with Node 22.17+ or 24.2+ the paste shows as one `PASTE (… line breaks)` row | [troubleshooting #22](troubleshooting.md#22-keys-or-paste-behave-oddly-in-a-terminal) |
| `node runtime/scripts/tui-probe.mjs mouse`, click, drag, scroll the wheel, Shift+click, then `qqq` | one `mouse: …` line per report (press, drag, release, wheel), never text | attach `~/.agent-daemon/logs/tui-probe-mouse-*.log` to an issue about fullscreen clicks or scrolling |
| `node runtime/scripts/tui-probe.mjs screen --bottom`, make the window narrower then wider, then `qqq` | wrap and autowrap verdicts, plus one line per resize | attach `~/.agent-daemon/logs/tui-probe-screen-*.log` and a screenshot to an issue |

## 7. Accounts, limits and fallback

Needs at least one real sign-in or key; skip the rows for providers you don't have. Stay in the scratch project.

| Run | Expect | If not |
|---|---|---|
| `ad auth list` | each account with its label, owner and a limits column (blank when unknown, never `0%`); no key printed, only its last 4 characters | [troubleshooting #91](troubleshooting.md#91-ad-cant-read-its-account-list-or-doctor-says-account-repair--run-ad-auth-repair) |
| `ad auth login <provider>` for a provider you have a key for | the key is asked at a hidden prompt, never on the command line; a refused key isn't saved | [troubleshooting #63](troubleshooting.md#63-the-key-was-refused-http-401-so-it-wasnt-saved) |
| `ad tui`, `/login` | the provider list, a label and owner, then a masked key field; the key never appears in the prompt history | — |
| `/account`, pick another account | its models, then "continues this conversation" or "continues in a new conversation (history carried over)"; the footer names the account | [troubleshooting #74](troubleshooting.md#74-couldnt-switch-to--still-on-) |
| `/status`, `/usage` | a `limits` row with reset times, or "not reported by this provider"; a `session ses_…` line | [troubleshooting #82](troubleshooting.md#82-limits-are-blank-or-not-reported-by-this-provider) |
| `/fallback` | the order editor below the prompt, off by default. `p` previews what would happen now; `e` lists every destination before turning it on | [troubleshooting #77](troubleshooting.md#77-fallback-never-switches-or-a-target-says-skipped-now) |
| `ad fallback preview`, `ad fallback test` | what fallback would do now, step by step; each target checked without sending anything | — |
| Quit, then `ad sessions show --last` | the session's account and model per turn and its tool calls; no answers, command output or keys | [troubleshooting #73](troubleshooting.md#73-this-session-is-open-in-another-ad-window-or-ad-couldnt-write-this-sessions-record) |
| Only if your own `~/.codex` has skills: `cd ~ && ad` | **Pick a project folder**, your last project first; Esc exits | [troubleshooting #48](troubleshooting.md#48-pick-a-project-folder-or-run-this-in-a-project-folder) |

## 8. Moving ad: state export and import

Use a throwaway home for the import side (a second OS user, or `HOME=$(mktemp -d)` on Linux and macOS), so your own ad state is never changed.

| Run | Expect | If not |
|---|---|---|
| In the scratch project: `ad state inspect` | what an export would hold for this project only; no secret opened | — |
| `ad state export --out ../scratch.adstate` | one bundle; a row shaped like a key stops it and names the row | [troubleshooting #84](troubleshooting.md#84-export-stopped--look-like-keys-or-a-name-cant-go-into-a-bundle) |
| `ad state verify ../scratch.adstate` | no problems; nothing changed | — |
| In the throwaway home: `ad state import ../scratch.adstate --dry-run` | where the project would go and any conflict; nothing written | [troubleshooting #85](troubleshooting.md#85-an-import-was-refused-interrupted-or-held-something-back) |
| `ad state import ../scratch.adstate` | "Imported (imp_…). Next: ad review --import imp_… …"; schedules come in switched off, accounts need a sign-in | [troubleshooting #85](troubleshooting.md#85-an-import-was-refused-interrupted-or-held-something-back) |
| `ad review --import <id>`, then `ad state verify --import <id>` | the imported notes wait for your typed accept; verify reports counts, integrity and recall | — |
| `ad state rollback <id>` | the import's own writes undone | — |

## 9. Clean up

```bash
cd .. && rm -rf ad-manual-test scratch.adstate
```

Your accounts stay. `ad auth logout <account>` signs one out and keeps it; `ad auth remove <account>` forgets it.

---

## 10. Stranger's walk (G8)

A first-time user with a fresh machine state walks the whole path and captures everything, then searches the capture for the engine's name. Do this once per release, by hand (it needs a real sign-in).

1. Start with a fresh `HOME` and `USERPROFILE` (a new OS user, or `HOME=$(mktemp -d)` on Linux/macOS), so no ad state and no engine home exists.
2. Install with the one-liner, then `cd` into a scratch project.
3. Run `ad`: expect the sign-in panel. Sign in, then answer the folder-trust question.
4. Run `/status`: note the engine version line.
5. Run `/cd` into an untrusted folder: expect the trust question first.
6. Ask for something that needs an approval: answer it, and check the scrollback shows the full command.
7. Run `/quit`, then `ad tui --last`: expect the same conversation back.
8. Save the whole terminal transcript (script, screen recording transcript, or copy from scrollback).
9. Search the transcript for the engine's name (case-insensitive). Allowed hits only:
   - model names (`gpt-5.x-codex` and the like);
   - OpenAI's sign-in page text;
   - the attribution texts (`ad about`, the managed `AGENTS.md` block);
   - a `codex-home` path where a path is printed;
   - raw engine text surfaced in `/warnings` (unknown events, with their details).

Anything else is a Part 6 leak: file it against the engine-originated text mapping.
