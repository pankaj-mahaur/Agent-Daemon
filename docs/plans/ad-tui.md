# Plan — `ad`: a Codex-style terminal UI with agent-daemon's powers

> Status: **final v4.9** (2026-10-06; v4 on 2026-10-04 after three review rounds). Changes from here on need a revision-log entry.
> Progress: **Part 0** — code done and reviewed twice:
> - Codex 0.160.0 pinned.
> - Isolation guard in place (see "Your own Codex is never touched").
> - Installers fixed.
> - Real-engine tests running.
> - S2 (local), S3 and S4 answered.
>
> - S2 CI matrix done. Windows and macOS are green; on Linux, the sandboxed shell needs the userns sysctl (see S2).
>
> - **Part 1b** (width + text + sanitize) built ahead of FC0, since it doesn't depend on it. Reviewed, fixed and mutation-checked; this is v4.1.
>
> - **FC0 done** (2026-10-05, v4.2):
>   - Node is 22.23.2.
>   - S1/S1b recorded for Windows Terminal and Zed.
>   - The user chose inline mode, the LF newline rule and the full boxed header.
>   - Zed is a primary target.
>
> - **Part 1a** (io + input) built and reviewed (v4.3).
>
> - **Part 1c** (inline renderer) built, reviewed, and checked live by the user in Windows Terminal and Zed (v4.4). **Part 1 is done.**
>
> - **Part 2** (`ad tui --preview`) built and reviewed. **FC1 pending (user):** live use in Windows Terminal and Zed.
> - From 2026-10-06 the plan is being worked solo (user instruction). Items that need the user are marked **pending (user)** and don't block later parts.
>
> - **Part 3** (engine events: adapter, routing, real-engine CI) built and reviewed (v4.5).
>
> - **Part 4** (session controller) built (v4.6).
> - **Part 5** (view components) built (v4.7). **FC2 pending (user).**
> - **Part 6** (app shell MVP: `ad tui`, `ad codex`) built (v4.8). **FC3 pending (user).**
> - **Part 7** (resilience) built (v4.9). **Narrowing-ghost probe runs pending (user).**
>
> **Next:** Part 8 (Codex parity++).
> Research: [Codex TUI + app-server](../research/codex-tui-and-app-server.md) · [terminal engineering](../research/terminal-engineering.md) · [harness landscape](../research/harness-landscape.md).

## Goal

Typing `ad` opens an interactive TUI that looks and works like the OpenAI Codex CLI, runs on the pinned Codex engine, and shows from day one what agent-daemon adds: project memory you can see, skills routing, logins for ChatGPT / OpenAI keys / OpenRouter, goals, loops and teams that work while you're away, and an `ad`-owned undo. When Codex ships a release, `ad` keeps working:
- unknown things degrade to plain rows;
- the real engine is tested on every platform before the pin moves;
- the stock Codex UI is one command away.

**Success criteria**
1. **Startup:** `ad tui` routes before the CLI's heavy imports. TUI module start → first frame written ≤ 150 ms (asserted in CI via `AD_TUI_TRACE=1`). Whole process start → first frame ≤ 1.2 s on this machine, where Node's own boot is ~0.8 s. Codex starts in the background; a prompt typed early waits for it.
2. **Live MVP checklist** (Part 6) passes on Windows Terminal 1.24 and 1.25 and the VS Code terminal on Windows. Linux is covered too: run it under WSL in Windows Terminal if available; otherwise only in headless CI.
3. **No crash from protocol input.** An exhaustiveness test forces every notification, server request, item type, decision and error variant in the snapshot to be handled or explicitly ignored.
4. **Codex bumps are tested.** A bump that changes behaviour `ad` depends on fails a named test. The real pinned binary runs against a mock model on Windows, macOS and Linux CI.
5. **The terminal is always restored** on quit, crash, SIGTERM, SIGHUP and SIGBREAK, and around every handoff to a child UI, using synchronous writes. Tests check that every mode we turn on is turned off again.
6. **No regressions:** `node --test` is green on all CI platforms; `ad chat/run/loop/web/acp` are unchanged.
7. **No new runtime dependencies.** devDependencies are allowed; installers stop installing them (`npm install --omit=dev && npm link --omit=dev`).
8. **Speed:** only the live region is redrawn; keystrokes echo immediately; streaming renders at most every 33 ms (commits at least 150 ms apart where synchronized output is missing).

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Two front ends on one engine home.** `ad` is our TUI. `ad codex` / `/codex` run the official Codex TUI on the harness home. They ship in the MVP, and `/codex` returns to `ad` on the same thread. | Full parity takes time. The stock UI is the escape hatch for Codex features we haven't adopted yet (Happy, Sculptor and Warp do the same). |
| D2 | **Inline first.** History goes into the terminal's own scrollback and is never repainted. Only the live region (≤ `rows − 1`) is redrawn. History is pre-wrapped at word boundaries (readable, like Codex). `/raw` switches to copy-friendly unwrapped output and `/copy` copies the last answer. Fullscreen is a later opt-in. ✅ FC0 (2026-10-05): the user chose inline. | Native scrollback, selection and copy matter most to users, and alternate screens drew backlash. Windows Node has no mouse in raw mode (libuv#5155). Terminal soft-wrap breaks words mid-word. |
| D3 | **Our own zero-dependency renderer**, using Codex's architecture and pi-tui's algorithms (MIT, credited). | House style. pi-tui needs Node ≥ 22.19 and native code; OpenTUI needs Bun or Node 26; Ink's adopters rewrote or forked it. |
| D4 | **One event layer, one session controller.** `engine/codex/events.mjs` turns protocol traffic into `ad` events. `harness/session.mjs` is UI-agnostic and is tested through a headless subscriber. ACP, chat and web move onto it after the MVP, once ACP has been verified live in Zed. | Every wrapper that survived normalizes behind a per-engine adapter. Refactoring an integration nobody has seen working is a needless risk. |
| D5 | **Stable protocol only; `experimentalApi` stays false.** Errors are classified by code plus message: -32600 with "unknown variant" naming the method = missing; "requires experimentalApi capability" = gated; any other "Invalid request:" = shape changed (params are parsed before the experimental gate is checked, verified live); -32601 = unsupported operation. **Steer errors:** only "not steerable" carries `error.data.codexErrorInfo` (→ queue). Any other steer error means the turn ended, so the text is submitted as a new turn. **One known leak:** exec approvals carry the experimental `availableDecisions`, because upstream strips only `additionalPermissions`. We use it when present, with Codex's own fallback otherwise (Part 3a). A real-engine test fails by name when it disappears. | Hard rule. Verified against `message_processor.rs`, `experimental_api.rs`, `turn_processor.rs` and `v2/item.rs` at 0.160.0. |
| D6 | **`ad` features live in two layers.** First-class UI in our TUI, plus engine-level surfaces (hooks, the memory MCP server, AGENTS.md, skills) that also work in `ad codex`. Skills reach Codex only through `skills/extraRoots/set`, so `ad codex` gets them mirrored into `$CODEX_HOME/skills`; spike S3 decides how. | Capabilities must not depend on the front end. |
| D7 | **Entry.** `ad tui [prompt] [--last \| --resume <id>]` opens the TUI. `cli.mjs` becomes a thin launcher at the same path, so the npm-link shims stay valid: it routes `tui` before loading the heavy command module. **Bare `ad` keeps printing help until the user signs off at FC3.** After that, bare `ad` opens the TUI when all of these hold: stdin and stdout are TTYs, `TERM` ≠ `dumb`, `AD_TUI` ≠ `0`, and Node is 22.17+ or 24.2+. Otherwise it prints help with a one-line reason and a working alternative. `ad --last` then resumes the last thread. `ad chat` stays the plain line mode. | The global `ad` is npm-linked to this repo. Flipping it early would hand the user a half-built UI. |
| D8 | **Node:** the TUI needs 22.17+ or 24.2+ (not 23.x or 24.0–24.1), where `setRawMode` uses VT input on Windows. Below that the TUI says why and everything else keeps working. `engines` and the installers' hard floor stay at 22. Installers warn below 22.17 and recommend upgrading within 22.x (same ABI, no rebuild). `ad doctor` detects a `better-sqlite3` ABI mismatch and prints the fix. | Older 22.x turns a multi-line paste into one turn per line. A hard floor would block updates that don't need VT input. |
| D9 | **Engine-in-the-loop CI.** The real pinned `codex app-server` runs against a zero-dependency mock Responses server (`node:http`, scripted SSE, responses chosen by request content) on all three platforms. The fake app-server stays for crashes and synthetic future traffic. | Replays can't catch behaviour changes in a new version. A mock model makes real-engine traffic deterministic, private and login-free. Codex's own tests work this way. |
| D10 | **Codex command names keep Codex's meaning.** A reserved list is generated from `slash_command.rs` at the pinned tag. `ad` commands never collide with it, and the upgrade PR fails on a collision. CLI-only tools run through `/ad <subcommand>` with their output in a cell. A Codex command we don't support answers "not in ad yet → /codex". | No surprises for Codex users; one rule instead of case-by-case naming. |
| D11 | **The `ad` layer is visible in the MVP:** header memory/login/sandbox lines, recall/skill/guard rows from `hook/completed`, `/remember`, `/login` for all three backends, a provider-aware `/model`, `/goal`, and a "since last time" line. | Without it the user would rationally pick `ad codex`. |
| D12 | **Upgrade to Codex 0.160.0 first.** | The protocol is byte-identical to 0.159.2, so the upgrade path gets exercised first. |
| D13 | **The user's own Codex is never touched.** Our Codex is a separate binary in a separate home; the code refuses to run it anywhere else. Details in the next section. | The user runs Codex daily (global install + `~/.codex` with its own daemon, login and sessions). |

## Your own Codex is never touched

| What | Yours | ad's |
|---|---|---|
| Binary | global `codex` (`%APPDATA%\npm`), updated by you or its daemon | `runtime/node_modules/@openai/codex`, pinned exactly; never `npm -g`, never `codex update` |
| Home (config, login, sessions, logs, hooks, daemon socket, sandbox SID) | `~/.codex` | `~/.agent-daemon/codex-home` (or `AD_CODEX_HOME`) |

**Guard (in code since Part 0):**
- Every real Codex process gets its environment from `codexEnv()`. That is enforced by a test that fails when a new spawn site skips it.
- `codexEnv()` refuses three homes:
  - a missing `CODEX_HOME`;
  - `~/.codex`, for both the current HOME and the OS account's home;
  - a `CODEX_HOME` inherited from your shell, unless ad created that folder.
- Paths are compared by their real location, so junctions, symlinks, `\\?\`, 8.3 names, case and relative paths can't sneak through.
- On Windows it also refuses homes with a trailing dot or space in any segment, and network (UNC) homes.
- It drops every `CODEX_*` variable (`CODEX_SQLITE_HOME`, `CODEX_EXEC_SERVER_URL`, `CODEX_API_KEY`, …), inherited or passed in, because those override config. The exception is `CODEX_CA_CERTIFICATE` (TLS trust behind proxies).
- It stamps `AD_ENGINE_HOME`, so ad processes that Codex starts (hooks) recognise that home as ad's.
- Every guard is mutation-tested: removing it fails a test.
- The home is checked before ad writes anything into it.
- ad runs only the pinned binary (or `AD_CODEX_BIN`), never your global or PATH install.
- `ad doctor` and schema generation run Codex in throwaway temp homes.
- Tests use temp homes, an explicit `test-double` fake, or a harmless stand-in.
- **What ad does read:** the optional `ad watch` watcher reads `~/.codex/sessions` to learn from your own Codex transcripts. This is read-only and an existing feature; it can be switched off in its watch config. Nothing else of yours is read.

**Rules for the rest of this plan:**
- Probes, spikes and live smokes use the harness home or a temp home, in a scratch directory.
- `ad codex` / `/codex` use the harness home with `--no-daemon`, so they never attach to your daemon.

**The one machine-wide piece is the elevated Windows sandbox.** Its setup creates OS-level sandbox accounts and rules that your Codex shares. `ad` never runs elevated setup without asking you first and saying exactly what it changes. The unelevated sandbox keeps its capability SID per home.

## Screen design (80 columns, lines ≤ 78)

```
╭────────────────────────────────────────────────────────────────────────────╮
│ >_ Agent Daemon (v2.1.0) · on Codex 0.160.0 (tested)                       │
│                                                                            │
│ model:     gpt-5.x-codex medium · ChatGPT Go        /model to change       │
│ directory: D:\…\my-projects\DriveYO · git: dev                             │
│ memory:    142 learnings · profile loaded           /memory                │
│ sandbox:   workspace-write · asks first · Windows sandbox ready            │
╰────────────────────────────────────────────────────────────────────────────╯
  Since last time: loop "docs build green" done (6 iter) · 09:00 schedule
  failed · 2 skill proposals to review (/proposals)

  Try /review · /goal · /loop <objective> · /resume · /codex = stock Codex UI

› fix the flaky login test

• Recalled 3 learnings: "login.spec uses fake timers" +2
• Skill suggested: debug-triage
• Explored
  └ Read login.spec.ts, auth.ts
• Ran npm test -- login.spec.ts
  └ 1 failing: expected 200, got 401
    … +12 lines

◦ Checking token refresh (14s • esc to interrupt)
  ↳ queued: also run the signup test                              tab: edit

› Ask ad to do anything
  enter steer · tab queue · ctrl+j newline        ctx 91% · 5h 38% · loop 3/20
```

**Layout rules:**
- `ad` rows appear only when something happens, one dim line each.
- Footer chips (loop, team) appear only while active.
- **Newline rule (FC0, 2026-10-05):** `0d` (Enter) submits and `0a` (LF) inserts a newline. That gives Shift+Enter in Zed, Ctrl+Enter in Windows Terminal, Ctrl+J everywhere and `\`+Enter as a fallback. Under CSI-u, Shift+Enter and Ctrl+Enter are decoded directly.
  - The hint adapts to the terminal: `shift+enter` in Zed or when CSI-u was negotiated, `ctrl+enter` in Windows Terminal, otherwise `ctrl+j`.
  - Alt+Enter is never advertised: it is Windows Terminal's fullscreen toggle.
- **Header (FC0):** the full boxed header above, shown once at start; it then scrolls into history like any other output.
- Idle footer: `? shortcuts · @ files · ctrl+j newline   ctx 100% · 5h 34%`.
- **When the footer is too wide, drop in this order:** key hints first, then shorten the chips (`loop 3/20` → `L3`), and the meters (ctx, usage) last.
- `/memory` (ad's project memory) and Codex's `/memories` both appear in the popup, each with a one-line hint so they aren't confused.
- Under 40×10: one-line header, no footer; approvals still show the full command (scrolling inside their box).

**Failure UX** (each case says what happened, what was kept, and one next step):

| Case | What the user sees |
|---|---|
| Not logged in (`requiresOpenaiAuth && !account`) | Login panel: ChatGPT (browser or device code), OpenAI key (masked), OpenRouter (key + model) |
| First-run Windows sandbox setup and engine restart | "Setting up Windows sandbox (one time)…". On failure the header shows `sandbox: not ready · /ad sandbox setup` |
| "Access is denied" / `spawn EPERM` in command output | A hint row pointing to troubleshooting #16 / #17 |
| Usage limit | Reset time plus three ways out: `/login openrouter`, `/model`, or wait. The prompt goes back into the composer. Footer meter turns amber at ≥ 80 % |
| `model/rerouted` | "OpenAI switched X → Y"; the header updates |
| Memory MCP failing | Header `memory: MCP down · /ad doctor` |
| Offline / stream errors | "Reconnecting 2/5"; after the final failure the prompt is restored |
| Codex crash | "Codex stopped (exit N). Your text is kept. Enter restarts and resumes.", the log path, and a cap on restarts |
| Non-git folder, home folder or drive root | "Not a git repo: /diff and /undo unavailable". In the home folder (Windows Terminal's default start) a recent-projects picker opens |
| mintty / old Node / `TERM=dumb` | The D7 reason plus a command that works (`winpty ad tui` checked against the npm shim, Node upgrade within 22.x, or `ad chat`) |
| Codex asks for something we don't support yet | "This needs the stock UI → /codex" (the request is declined with -32601) |

## Interfaces (fixed before code; changes need a revision-log entry)

```js
// engine/codex/events.mjs → AdEvent (every event: {type, threadId?, turnId?, itemId?, raw? (debug only)})
thread.started {thread} | thread.status {status} | thread.name {name} | thread.goal {goal|null}
thread.tokens {usage:{total,last,contextWindow}} | thread.compacted | thread.closed | thread.archived
thread.reverted {thread} | turn.started {turn} | turn.completed {status, error?} | turn.plan {steps, explanation?}
turn.diff {diff} | item.started {item: ViewItem} | item.completed {item: ViewItem}
item.delta {kind: text|reasoning|reasoningPart|output|patch|progress|terminal, delta}
request.opened {request: PendingRequest} | request.resolved {requestId}
hook.started|hook.completed {run:{id,event,status,source,sourcePath,entries:[{kind,text}]}}
account {account} | rateLimits {limits} | notice {level, code, message, details?} | unknown {method}

ViewItem       = {id, kind: <ThreadItem type>|"unknown", ...normalized fields}
PendingRequest = {id /* JSON-RPC id */, kind: approval-exec|approval-patch|approval-permissions|
                  user-input|elicitation|tool-call|unknown, threadId, turnId, itemId, agentLabel,
                  params, options /* per kind: exec = availableDecisions verbatim if present, else
                  Codex's default_available_decisions(); patch = accept|acceptForSession|decline|cancel;
                  permissions = turn|session|decline */}
// item.delta kinds also include `plan` (item/plan/delta). Hook rows come from hook.* events only.

// harness/session.mjs
createSession({engine, cwd, model, sandbox, approvalPolicy, hooks:{beforeTurn, turnStarted, turnCompleted}})
  → {state: SessionState, on(event, fn), submit(input) → {clientUserMessageId, accepted: Promise, done: Promise},
     steer(input), queue(input), editQueued(index, text|null), interrupt(), resolve(requestId, answer),
     setNextTurn({model, effort, approvalPolicy, sandboxPolicy}), review(target), compact(), shell(cmd),
     setGoal(text|null), revert(turnId), newThread(), resume(id), close()}
SessionState = {thread, turns, items(Map), activeTurnId, requests(FIFO by JSON-RPC id), queue,
                config:{model, effort, sandbox, approvalPolicy, cwd}, account:{account, requiresOpenaiAuth},
                goal, agents: Map<threadId,{label, parentThreadId}>, mcp: Map<server,status>,
                tokens, plan, diff, rateLimits /* read once at startup, then updated */, notices,
                engine:{state: starting|ready|crashed, exitCode, logPath, restarts}}

// tui/terminal/renderer.mjs
createRenderer({io, caps, depth, reflow, resizeSource}) → {start(), frame({lines, cursor}), commit(lines), suspend(), resume(),
                                                     onResize(fn), redraw(), dispose(), state}
// tui/terminal/io.mjs (v4.3 adds close, suspend, cpr, onResume; caps = {kitty, modifyOtherKeys, sync, focus, da1})
createIo({stdin, stdout}) → {caps, write, enter(), restore(), close(), handoff(async fn), suspend(),
                             cpr() → {row, col}|null, onInput(fn), onResume(fn), size()}
// tui/terminal/input.mjs — events for onInput
key {name, ctrl, alt, shift, super, raw} | text {text} | paste {text} | paste-empty | focus {focused}
isNewline(ev): LF, Shift/Ctrl+Enter (CSI-u, modifyOtherKeys), Ctrl+J in any encoding
```

## How `ad` copes with Codex releases

**Machine side:**
1. **Exact pin plus the weekly upgrade PR** (both exist). The PR runs the engine-in-the-loop suite on all three platforms and the reserved-name check.
2. **Exhaustiveness test.** Every notification, server request, `ThreadItem` type, approval decision and `CodexErrorInfo` variant must be handled or on the documented ignore list. Nothing gets dropped silently.
3. **Typed snapshot.** `shapeOf` records property types and `$ref`s. `surface.mjs` lists what we read, and the diff labels changes that touch it **affects ad**.
4. **Tolerant runtime:** unknown notification → counted and logged; unknown item → generic cell; unknown request → -32601 plus "needs /codex"; unknown fields are ignored.
5. **A synthetic future-Codex fixture** must render without crashing.

**User side:**
6. After a bump, the first launch shows "Engine updated 0.160 → 0.161 — what changed for you". The upgrade PR writes that note into `codex-compat.json`.
7. `/status` shows one line: `Codex 0.160.0 · tested with ad 2.1.0`. An `AD_CODEX_BIN` that differs from the pin warns that it may write threads the pinned engine can't resume.
8. Codex's own update banner is switched off in the harness home (spike S3 verifies the key), so it never tells the user to `npm i -g @openai/codex`.
9. Codex commands we lack answer "not in ad yet → /codex". The `/codex` round trip returns to `ad` on the same thread with the new turns loaded.

## Feedback checkpoints

| FC | When | The user… |
|---|---|---|
| FC0 | end of Part 0 | runs the key and resize probes with me; decides inline vs fullscreen, the newline key and the header lines. ✅ 2026-10-05: inline, LF newline rule, full boxed header |
| FC1 | after Part 2 (walking skeleton) | uses `ad tui --preview` for real for 1–2 days: flicker, scrollback, copy, resize, paste |
| FC2 | after Part 5 | approves the 80-column goldens (header, cells, approval modal, footer) |
| FC3 | after Part 6 (MVP) | uses `ad tui` for a week (notes via `/ad feedback`, a local log; Codex's own `/feedback` keeps its meaning); re-ranks Part 9; approves flipping bare `ad` |
| FC4 | after each Part 9 feature | tries it and says keep, change or cut |

## Parts

Every (sub-)part runs the full implement → test → review loop described below.

| # | Part | Depends on | Milestone |
|---|---|---|---|
| 0 | Housekeeping, Codex 0.160.0, installers, spikes S1–S4 | — | FC0 |
| 1 | Terminal layer: 1a io + input · 1b width + text · 1c inline renderer | 0 | |
| 2 | Walking skeleton: `ad tui --preview` | 1 | FC1 |
| 3 | Engine events: 3a adapter + exhaustiveness · 3b routing + requests · 3c mock model + real-engine CI | 0 | |
| 4 | Session controller: 4a lifecycle + requests · 4b steer / queue / interrupt | 3 | |
| 5 | View: 5a composer · 5b streaming markdown · 5c cells + diff · 5d chrome, popups, modals | 1, 3a | FC2 |
| 6 | App shell (MVP): Codex reflexes + the `ad` layer + `ad codex` | 4, 5 | **MVP**, FC3 |
| 7 | Resilience hardening | 6 | |
| 8 | Codex parity++ | 6 | |
| 9 | `ad` capabilities: 9a see what ad knows · 9b work while you're away · 9c never stuck | 6 | FC4 each |
| 10 | Checkpoints and `/undo` (only if S4 passes) | 6 | |
| 11 | Flip bare `ad`, docs, verification track, release v2.1.0 | 7–10 | **v2.1** |
| 12 | ACP, chat and web onto the controller (after ACP is verified live in Zed) | 11 | |
| 13 | Fullscreen mode + inline reflow (if FC0/FC1 asks for it) | 11 | |

Build order: 0 → 1 → 2 (FC1) → 3 → 4 → 5 (FC2) → 6 (FC3) → 7 → 8 → 9 → 10 → 11 → 12 → 13.

**Verification track** (runs in parallel; each item gates the parts that depend on it):

| Check | Gates | Needs |
|---|---|---|
| OpenRouter login + a turn | Part 6 (`/login openrouter`, the usage-limit row) | the user's key |
| Windows sandbox failure paths (unelevated) | Part 6 (sandbox failure row) | — |
| Elevated sandbox | the `spawn EPERM` troubleshooting advice | **explicit OK first**: it changes machine-wide sandbox accounts your own Codex also uses (D13) |
| `ad loop` and `ad web` end to end | Part 9b | — |
| ACP in Zed | Part 12 | Zed |
| Playwright tool, `ad agy` | Part 11 docs | — |

---

### Part 0 — Housekeeping, Codex 0.160.0, installers, spikes
- ✅ **Codex 0.159.2 → 0.160.0**: the snapshot diff is the version line only; `npm test` 503/503; live `ad run` smoke in a scratch dir passed (session written only to the harness home).
- ✅ **Codex-home isolation guard** (D13): `assertIsolatedHome` in `CodexAppServer.start()`; `ad doctor` and schema generation use temp homes; tests in `codex-home-isolation.test.mjs`.
- ✅ **Installers:**
  - `npm install --omit=dev && npm link --omit=dev`, asserted in `installers.test.mjs`.
  - Node ≥ 22 hard floor (unchanged); warn below 22.17.
- ✅ **CI and repo:** `actions/checkout@v7` and `actions/setup-node@v7` (node24); `.gitattributes` with `eol=lf` for goldens.
- **Prerequisite for S1 and S1b:** this machine's Node goes from 22.14 to 22.17+ first. Otherwise the probes would measure the old Windows input path that D8 rejects. Both probes print `process.version` and the raw-mode kind.
- **S1 — input probe** (interactive, with the user). `runtime/scripts/tui-probe.mjs keys` prints decoded bytes on Windows Terminal 1.24 and 1.25 and VS Code. It checks:
  - Enter with Shift, Ctrl and Alt; Ctrl+J
  - Ctrl+C, Ctrl+Z, Esc, arrows with modifiers
  - Ctrl+V with text and with an image
  - bracketed paste
  - kitty negotiation: `CSI >1u`, `CSI ?u`, DA1 (including a late `?u` reply under ConPTY), and what Ctrl+C / Esc / Shift+Enter send under flag 1
  - CPR replies
- **S1b — output and resize probe** (interactive). `tui-probe.mjs screen` checks:
  - a line of exactly `cols` characters, then `\r\n`, then CPR (deferred or immediate wrap?)
  - a write to the bottom-right cell; DECAWM `?7l`
  - the DECRQM `?2026` reply
  - shrink and grow with a 6-line live region, logging CPR before and after, to learn each terminal's reflow model

  Both probe scripts stay in the repo as troubleshooting tools.
- ✅ **S1/S1b results** (2026-10-05, Node 22.23.2; logs in `~/.agent-daemon/logs/tui-probe-*`). The user works in **Zed** daily, so Zed joins Windows Terminal as a primary target; VS Code drops to secondary.

  | | Windows Terminal (`WT_SESSION`) | Zed (`TERM_PROGRAM=zed`, Alacritty core) |
  |---|---|---|
  | Raw input | VT input; bracketed paste works | VT input; bracketed paste |
  | Kitty keyboard (`?u`) | no reply | no reply |
  | `?2026` (DECRQM) | recognised | recognised |
  | DA1 | `61;4;6;7;14;21;22;23;24;28;32;42;52` | `6` |
  | Enter / Shift+Enter | `0d` / `0d` (same) | `0d` / `0a` |
  | Ctrl+Enter / Ctrl+J | `0a` / `0a` | (no mapping) / `0a` |
  | Alt+Enter | swallowed (fullscreen toggle) | `ESC 0d` |
  | Ctrl+Backspace | `08` (Backspace is `7f`) | `08` |
  | Arrows with Shift/Ctrl/Alt | `CSI 1;2/5/3 A–D` | same (xterm modifier codes) |
  | Ctrl+V with an image | an empty bracketed paste | not measured |
  | Wrap at the last column | deferred (xterm-like) | deferred |
  | DECAWM `?7l` | honoured | honoured |
  | Resize | reflows history; the cursor stays on its cell, so CPR re-anchoring holds | not measured yet (Alacritty reflows); check live in Part 2 |

  - The Zed key column comes from Zed's source (`crates/terminal/src/mappings/keys.rs`, last changed 2026-08-19). Zed's terminal can't be driven from here, and injected bytes would defeat the point of the probe. The `screen` capabilities are from a Zed run.
  - The first Zed resize run was spoiled because the probe printed its results mid-test, which moved the cursor. The probe now logs during the test and prints the results on quit.
  - Not covered: Windows Terminal 1.25 (kitty), and the VS Code terminal. Re-probe when either becomes relevant.
- **S2 — mock model.**
  - Config:
    - `model_provider="mock"`, `[model_providers.mock]` with `base_url="http://127.0.0.1:P/v1"`, `wire_api="responses"` and retries off. No `env_key`, no login.
    - Features `plugins`, `apps` and `shell_snapshot` off.
  - Run it locally, then on all three runners as a job in `test.yml`. That workflow already has `workflow_dispatch`, and a new workflow file can't be dispatched until it is on `main`. Record per-platform behaviour in a table here:
    - Windows: no sandbox vs unelevated setup; whether every command prompts.
    - Linux: bubblewrap under Ubuntu 24.04 AppArmor.
    - All: escalation approvals with `experimentalApi:false`; cold start and cleanup times.
  - Tool shapes: an unknown slug gives `exec_command {cmd, workdir}` with `apply_patch` via heredoc. Test whether a known slug brings the freeform `apply_patch` tool.
  - Record whether exec approvals still carry `availableDecisions` with `experimentalApi:false`.
  - ✅ **Local result (Windows, 2026-10-04, `scratchpad/spike-s2.mjs`):**
    - The real 0.160.0 app-server ran four turns against the mock with no login, in a temp `CODEX_HOME`: message + reasoning, shell, apply_patch (file really written), and escalation.
    - Cold start was 0.75–1 s; 7 model calls for 4 turns (no hidden calls).
    - With `windows.sandbox` unset, every command asked for approval (as predicted).
    - Exec approvals carry `availableDecisions` (`["accept", {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": [...]}}, "cancel"]`). File-change approvals carry none.
    - The unknown slug `mock-model` raises a `warning` ("Model metadata … not found") each turn and gets these tools: `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `multi_agent_v1`, the goal tools and `web_search` (no `update_plan`).
    - In the repo: `testkit/mock-responses.mjs` and `test/engine-real.test.mjs` (opt-in `AD_REAL_ENGINE=1`; 4/4 green on Windows). They cover a turn, an exec approval with `availableDecisions`, a patch, and the D5 error classes.
    - ✅ **CI matrix** (run 37224746807 on `feat/tui`, 2026-10-04):

      | Runner | Result |
      |---|---|
      | Windows | 5/5 |
      | macOS | 5/5 (seatbelt sandbox works) |
      | Ubuntu | 4/5 |

      On Ubuntu, the sandboxed plain shell call produced no `commandExecution` item. Escalated (unsandboxed) commands, patches, streaming and the error classes all passed.

      The likely cause is bubblewrap under Ubuntu 24.04's AppArmor user-namespace restriction. **Next:** in the Linux job, add `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` and re-run. If that doesn't fix it, mark the sandboxed-shell test as expected-unsandboxed on Linux CI.
- **S3 — the stock UI on our home.**
  - ✅ **Skills:** Codex 0.160 reads, in this order:
    - `$CODEX_HOME/skills` (marked deprecated, still supported);
    - `~/.agents/skills` (**shared with your own Codex**: never write there);
    - project `.codex/skills` and `.agents/skills`;
    - plugins;
    - runtime extra roots.

    So `ad codex` copy-syncs `~/.claude/skills` into the harness home's `skills/`. That root then leaves our engine's `extraRoots`, so skills don't appear twice. Project `.claude/skills` are a documented gap in `ad codex`. A real-engine test watches the deprecated root.
  - ✅ **Update banner:** `check_for_update_on_startup = false` in the harness config.
  - ✅ **Trust:** `projects."<path>".trust_level = trusted|untrusted`; it gates project-level `.codex` config, hooks and skills. Our threads set sandbox and approval explicitly, so our TUI mirrors Codex's one-time trust prompt and writes the level into the harness config.
  - **Resume across processes:**
    - Partly verified: a separate stock `codex exec resume <id>` (same isolated home) found our thread (`thread.started` with its id).
    - Its turn never reached the mock model. That was `codex exec`-specific (with stdin closed and a non-temp home too), and `exec` isn't in our design.
    - **Open:** an interactive `codex resume <id> --no-daemon` check, with the user, in Part 6.
  - Gotcha: Codex won't create its PATH helper aliases when `CODEX_HOME` is under `%TEMP%`. It only warns, and `apply_patch` through `exec_command` still worked in S2. Engine tests should expect that stderr line rather than treat it as a failure.
- **S4 — checkpoint timing.** On the largest local repo and a ~50k-file clone, on Windows: temp-index snapshot via `cp index` + `add -A` + `write-tree` + `commit-tree`. Budget: p50 ≤ 300 ms, p95 ≤ 1 s with warm caches. The result decides Part 10.
  - ✅ **Result** (Windows, synthetic repos in scratch, 12 warm runs each; `scratchpad/spike-s4.mjs`):

    | Files | Copied index (p50 / p95) | Persistent private index + untracked cache (p50 / p95) |
    |---|---|---|
    | 2,000 | — | 603 / 649 ms |
    | 10,000 | — | 502 / 633 ms |
    | 50,000 | 826 / 1254 ms | 717 / 928 ms |

  - The cost is mostly a fixed charge: about 4 git processes at ~150 ms each, since process start-up is slow on this machine (`node -e 0` takes ~0.8 s). Repo size matters less. The user's real index stayed untouched in every run.
  - **Decision: Part 10 stays, redesigned so snapshots never sit on the turn's critical path:**
    - Use a persistent ad-owned index (`.git/ad-checkpoint-index`, seeded once from the user's index), so the untracked cache survives between snapshots.
    - Use two git processes (`add -A`, `write-tree`). Refs point at trees and are written in one batched `update-ref --stdin` per turn.
    - Take a snapshot when the composer starts getting input (pre-emptive) and when a turn completes.
    - `turn/start` waits at most 150 ms for one still in flight. If it misses, the checkpoint is marked best-effort and `/undo` says so.
- **User actions:**
  - merge PR #9;
  - upgrade this machine's Node within 22.x (now 22.14);
  - delete the unused clone `D:\Program Files\Agent-Daemon`;
  - FC0 decisions.
- **Done when:** tests and CI are green on 0.160.0, S1–S4 have written answers here, and FC0 decisions are recorded in D2 and the screen design.

### Part 1 — Terminal layer (`tui/terminal/`)
- **1a. io + input**
  - **`io.mjs`:**
    - **Startup:** raw mode, bracketed paste `?2004h`, then the kitty protocol `CSI >1u` + `CSI ?u` + DA1 sentinel. A late `?u` reply still upgrades. Without it, modifyOtherKeys `CSI >4;2m`.
    - **Synchronized output** is used when DECRQM confirms it. Every query has a timeout.
    - **Focus reporting** (`?1004h`) is on where supported (not Windows, as in Codex). "Unfocused" BELs fall back to always ringing when focus is unknown.
    - **`restore()`** is idempotent and writes with `fs.writeSync`. It pops kitty (`CSI <u`), sends `CSI >4;0m`, `?2004l`, `?1004l`, `?7h`, `?25h` and `CSI 0 SP q`, and drains outstanding replies first. Wired to quit, `exit`, SIGTERM, SIGHUP, SIGBREAK, `uncaughtException` and `unhandledRejection`; `process.on('warning')` goes to the err sink.
    - **Ctrl+Z:**
      - POSIX: `restore()`, then SIGSTOP. SIGCONT re-enters with a fresh first frame anchored by CPR.
      - Windows: no SIGTSTP, so Ctrl+Z does nothing there.
    - **`handoff(fn)`** for `/codex`, `ad codex` and Ctrl+G:
      1. Require an idle turn: interrupt first if one is running.
      2. Pause stdin and detach our listeners, so Windows doesn't split keystrokes between us and the child.
      3. Restore; run the child with inherited stdio.
      4. `setRawMode(false)` → `true` (libuv#5156); re-enter modes; re-anchor.
    - **Engine child isolation:**
      - POSIX: the engine child is spawned `detached`.
      - Windows: `windowsHide` + piped stdio gives `CREATE_NO_WINDOW`.
      - On both, raw mode stays on until the engine has exited.
  - **`input.mjs`:**
    - Decodes graphemes, controls, CSI/SS3 with modifiers, CSI-u (incl. `CSI 99;5u` Ctrl+C and `CSI 27u` Esc under flag 1), `CSI 27;m;c~`, focus.
    - **Paste:** one event that can span chunks; keybindings never run on it; flushed after ~1 s idle.
    - **Reply router:** handles CPR, DA1, DECRQM and `?u`. `CSI 1;2R` counts as CPR only while one is outstanding.
    - **ESC timeout:** applies only to a lone trailing ESC (30 ms; 100 ms with `SSH_CONNECTION`). Started sequences wait for their final byte (cap 500 ms).
    - **Paste-burst heuristic:** only when bracketed paste is unavailable.
    - **Newline (FC0):** a bare `0a` is the newline key. That covers Ctrl+J, Ctrl+Enter in Windows Terminal, and Shift+Enter in Zed. Also `\`+Enter, and Shift+Enter / Ctrl+Enter decoded from CSI-u. Enter (`0d`) submits.
    - **Image paste:** an empty bracketed paste (Windows Terminal, image on the clipboard) is reported as `paste-empty`, so the composer can offer to attach the clipboard image.
  - **Tests:** byte fixtures (split chunks, interleaved replies, paste with escapes, flag-1 encodings); restore balance.
  - **Done when:** tests are green and the probe output from S1 replays through the parser unchanged.
  - ✅ **Built 2026-10-05:** 74 input and 34 io tests; S1 bytes in `test/fixtures/tui/s1-keys.json`; 38 mutants killed. Review hardening:
    - **Sequences:** the started-sequence cap counts from the start (not re-armed by a trickle), and a CSI over 256 bytes is dropped.
    - **Paste:** a stalled paste is shown after 1 s but stays a paste until its end marker or 10 s of quiet, so its line breaks never become Enter.
    - **CPR:** a timed-out CPR's late reply is dropped (it can't answer the next query or eat Shift+F3), and expires after 2 s.
    - **Signals:** Ctrl+C / Ctrl+Break during a handoff belong to the child.
    - **Lifecycle:**
      - `restore()` resets the decoder and unhooks the process listeners;
      - concurrent `enter()` calls share one negotiation;
      - `close()` inside a handoff stays closed.
    - **Re-review:** no medium-or-worse finding. Lows fixed:
      - the 10 s paste limit counts from the first stall, and a lone Ctrl+C ends a paste whose end marker was lost;
      - a CRLF split by a stall stays one line break;
      - there is never a second input listener;
      - no modifyOtherKeys while a handoff child owns the terminal;
      - a failed suspend takes the terminal back.
    - **Accepted (odd call orders or reply orders):**
      - a CSI over 256 bytes decodes differently depending on where the chunks split;
      - `restore()` then `enter()` during a negotiation;
      - a lost CPR reply makes the next one count as stale for 2 s.
    - **For Part 5:** with kitty flag 1, numpad digits and operators arrive as keys (`"5"`, `"+"`); the composer inserts them.
    - **Not done:** the paste-burst heuristic is off and unused while both target terminals have bracketed paste.
    - **Engine:** `CodexAppServer` takes `detached: true` (POSIX only) for the TUI.
- **1b. width + text**
  - **Width** (`width.mjs`):
    - Graphemes via `Intl.Segmenter`, measured over a line's joined text (a cluster can straddle spans).
    - Code points:
      - The East Asian Wide/Fullwidth table is vendored from `scripts/gen-width-tables.mjs`, pinned to Unicode 16.0.0. JS regexes have no EAW property.
      - Ambiguous = 1.
      - Mn/Me/Cf and U+1160–11FF = 0.
      - 1F93B and 1F946 are legacy-wide (2).
    - **Two cluster profiles**, because terminals disagree. Windows Terminal draws a ZWJ family as 2 cells; xterm.js (VS Code) adds up its code points (6).
      - `codepoint` (default) gives an RGI emoji max(2, Σ). It is safe everywhere, because over-counting only leaves blank cells.
      - `grapheme` gives an RGI emoji 2. The renderer selects it in 1c when the terminal is known to cluster: `WT_SESSION`, or a CPR measurement at startup.
      - Other clusters are Σ of their code points in both profiles (wcwidth-style; Devanagari conjuncts over-count).
  - **Text** (`text.mjs`):
    - Styled spans; word wrap with hard-break fallback; indentation kept; ellipsis truncation.
    - Tabs go to 8-column stops.
    - `renderLine` ends with `ESC[0m` whenever it styled anything. The renderer adds the reset before `\r\n`, `ESC[K` and `ESC[J`.
    - Colour depth: NO_COLOR; FORCE_COLOR wins and acts as a floor on a TTY; `COLORTERM`; `WT_SESSION`; TERM.
    - `#rrggbb` maps to the nearest xterm-256 cube or grey entry. Very dark tints collapse (#1f3a1f and #3a1f1f both map to grey 235), so Part 5 theme tokens carry explicit 256- and 16-colour fallbacks.
  - **`sanitize(text, mode)`** (`sanitize.mjs`):
    - `transcript`:
      - strips escape sequences, C0 (except tab and newline), DEL, C1 and bidi controls;
      - an unterminated OSC/DCS/SOS/PM/APC ends at the next newline, so one stray introducer can't hide the rest of the output;
      - runs in linear time.
    - `approval` hides nothing:
      - every Cc/Cf/Zl/Zp, default-ignorable, variation selector and non-ASCII space is shown (`␛`, control pictures, `<U+202E>`);
      - tab and newline stay.
  - **Tests** use only cases that are stable across Unicode versions. Width cases are asserted in both profiles; every guard is mutation-checked.
  - **Done when:** width and wrap goldens plus hostile-string tests pass. ✅ 2026-10-05: 120 tests, 3 goldens (widths 20/40/79), 14 mutants killed.
- **1c. Inline renderer** (`renderer.mjs`)
  - **Frame** (live region only, ≤ `rows − 1` lines):
    1. Move to the live top: `\r` then `ESC[pA`. **Skip any cursor move whose count is 0**, because `ESC[0A` and `ESC[0B` move one row.
    2. `ESC[?7l`, then the changed lines from the first changed line, each `…ESC[0m ESC[K`, joined by `\r\n`.
    3. `ESC[J` for leftover rows.
    4. Park the cursor at the composer insertion point.
    5. `ESC[?7h`.

    One `write()` per frame, wrapped in `?2026` when available. With autowrap off, every live line is exactly one row whatever the width tables say, and the bottom-right-cell scroll can't happen.
  - **Commit (overpaint, never erase first):**
    1. Move to the live top as in step 1, then `ESC[?7l`.
    2. Write each history line as `…ESC[0m ESC[K\r\n`, **also with autowrap off** (v4.1). Lines are pre-wrapped to `cols − 1`, so a width disagreement clips a cell instead of adding a hidden row behind the row accounting.
    3. The live lines.
    4. `ESC[J`, park, `ESC[?7h`.

    Without 2026, commits are batched at least 150 ms apart.
  - **Taller content** (a big approval diff, a long streaming table) scrolls inside its own box.
  - **Resize:**
    - From the first resize signal, pause frames and queue commits.
    - After 75 ms quiet, send CPR, read row r, and set `liveTop = max(1, r − p′)`, where p′ comes from the terminal's reflow model:
      - reflowing (per S1b): Σmax(1, ⌈wᵢ/C′⌉) + ⌊(x−1)/C′⌋ (a blank row is still one row);
      - non-reflowing or unknown: p′ = p (may leave ghost rows, never erases history).
    - Then `ESC[{liveTop};1H ESC[J` and redraw.
  - **First frame:** CPR. If the cursor isn't in column 1, emit `\r\n` first.
  - **Width profile** (v4.1): use `grapheme` when `WT_SESSION` is set, or when a startup probe shows clustering. The probe writes a ZWJ family at column 1 and sends CPR: column 3 means clustering, column 7 means summing. It then erases the probe with `\r ESC[K`. Otherwise stay on `codepoint`.
  - **Ctrl+L (`redraw()`):** the same CPR re-anchor plus a full live redraw. Never `2J`/`3J`.
  - **Tests** with `@xterm/headless` + `addon-unicode11` (devDependencies) and a non-reflowing screen model:
    - property: screen = history + last frame after random frame, commit and resize sequences;
    - commits land in scrollback;
    - no row ever erased above the live top;
    - small heights;
    - balanced modes.
    - One Windows CI smoke test drives real ConPTY through `@lydell/node-pty` (devDependency) into headless xterm.
  - **Done when:** the property tests pass under both reflow models, the ConPTY smoke passes, and `scripts/tui-demo.mjs` is clean live on Windows Terminal 1.24 and Zed (the user's daily terminal), and checked once in VS Code.
  - ✅ **Built 2026-10-05/06:**
    - **Files:** `renderer.mjs`, `detect.mjs` (terminal name, reflow model, width probe) and `scripts/tui-demo.mjs`. Test terminals in `testkit/screen.mjs`: real `@xterm/headless`, which reflows like Windows Terminal and Zed, and a VT model that never reflows. Both can delay CPR to expose races.
    - **Tests:** a ConPTY smoke test through `@lydell/node-pty` drives the demo end to end.
    - **Live check:** the user saw the demo clean in Windows Terminal and Zed. VS Code not checked.
    - **Review fixes** (2 critical, 3 high):
      - **Re-anchor races:** every re-anchor carries a generation. A resize, redraw or suspend that lands while it waits for CPR makes it write nothing, and commits made meanwhile stay queued.
      - **Reflow estimate:** the re-anchor row count is a **lower bound**. Each row's width uses the fewest cells any terminal draws, and the cursor's own row doesn't count (xterm.js doesn't re-wrap it). An under-count leaves a ghost row; an over-count would erase history.
      - **Suspend:** cancels a pending resize.
      - **Probe:** never erases text on the cursor's row.
      - **Detection:** `TERM_PROGRAM` wins over an inherited `WT_SESSION`.
    - **Accepted:**
      - Shrinking the height, or a reflow that pushes live rows above the viewport, moves them into scrollback as ghost rows. History is never erased.
      - Measured on xterm.js: when the live region sits at the bottom of the screen and the window narrows, rows below the cursor wrap and scroll the content, but the cursor keeps its screen row. The cursor then lands on a later row of the live region, and the lower-bound re-anchor leaves those rows above as ghost rows in the visible screen until they scroll away. Fixing this needs the live region's screen position tracked across writes, and measurements from Windows Terminal and Zed; that is Part 7.
    - **Cursor:** never styled or made to blink by ad. It follows the terminal's settings (user, 2026-10-06), and an idle screen never redraws.
    - **Re-review fixes** (1 high, 2 medium, 3 low):
      - **Writes in flight:** live rows written less than 250 ms before a resize may reach the terminal after it, so the reflow estimate is skipped for that pause.
      - **Suspend during a resize:** `suspend()` inside a pending resize erases from the reflowed live top, before writing queued history.
      - **Dispose:** `dispose()` writes batched history, erases the live region, and makes a pending re-anchor write nothing.
      - **Missed resize:** a resize that came while suspended re-lays out after `resume()`.

### Part 2 — Walking skeleton (`ad tui --preview`)
- Built on the Part 1 renderer, a plain multi-line composer (no popups), and the existing `engine.turn()` (called with `timeoutMs: 0`; the 600 s default would interrupt long turns) / `onApproval`.
- It streams plain text and handles approvals with y/a/n, Esc (interrupt), and Ctrl+C quit with restore.
- Throwaway glue; the renderer and io are kept.
- **Done when:** a real turn with an approval works live on Windows Terminal and VS Code → **FC1**.
- ✅ **Built 2026-10-06** (`src/tui/preview.mjs`, `ad tui --preview`):
  - It reuses `createChatSession` from `ad chat`. The engine runs `detached` on POSIX. The boxed header is sanitized and cut to fit.
  - **Tests:** fake-engine tests on a test screen cover streaming, approvals, Esc, Ctrl+C, paste and the composer. A ConPTY smoke runs the real `cmdTuiPreview` on the fake engine (`testkit/tui-preview-fake.mjs`).
  - **Review fixes** (1 high, 3 medium):
    - **Arming:** an approval prompt takes y/a only 400 ms after it appears, so type-ahead, a double tap or a held key can't answer it, and only an exact single character counts. Declining (n, Esc, Ctrl+C) works at once.
    - **Open prompts:** a prompt still open when the turn ends or the engine stops is declined and cleared.
    - **Quit:** a second Ctrl+C within 1.5 s quits even if a turn won't stop.
    - **Streaming:** the live region wraps only the tail of an unfinished line, and redraws from output are coalesced to about 30 fps.
    - **History:** shows the whole approved request.
  - **Re-review fixes** (1 high, 2 medium, 4 low):
    - **Long requests:** the whole request goes into history before the prompt is armed. A request too tall for the live region shows its first and last lines with "N more lines: the full request is in the scrollback above".
    - **Arming:** while a prompt is open it owns the input. Any key that doesn't answer it restarts the 400 ms window, so typing, a held key or its auto-repeat can't approve.
    - **Queued prompts:** a prompt queued behind one when the turn ends is declined.
    - **Force-quit:** only Ctrl+C counts, and the count restarts each turn. The notice is drawn at once.
    - **Streaming:** only a chunk with a newline is searched for one.
  - **Pending (user): FC1.** Run a real turn with an approval live in Windows Terminal and Zed, then use it for a day or two (flicker, scrollback, copy, resize, paste). VS Code is secondary.

### Part 3 — Engine events
- **3a. Adapter + exhaustiveness** (`engine/codex/events.mjs`, `surface.mjs`)
  - **Adapter API:**
    - `adaptNotification(method, params)` → `AdEvent[]`
    - `normalizeItem` → `ViewItem`
    - `classifyRequest` → `PendingRequest`
  - **Vocabulary:** derived from the protocol's 85 notifications. 63 are stable and mapped. The 22 marked `#[experimental]` are never sent to us (`should_skip_notification_for_connection`) and sit on the ignore list as "ignored: experimental".
  - **Approvals:**
    - **Exec options:**
      - Use `availableDecisions` when present (experimental, but sent today) and send the chosen element back verbatim (snake_case inner keys).
      - Otherwise use Codex's `default_available_decisions()` from `codex-rs/protocol/src/approvals.rs`:
        - with a network context: accept, acceptForSession, the first proposed allow-amendment, cancel;
        - otherwise: accept, `acceptWithExecpolicyAmendment` when one is proposed, cancel.
      - Tests: a unit test for the fallback, and a real-engine test asserting the field is still sent.
    - **Patch options:** accept / acceptForSession / decline / cancel.
    - **Permission options:** grant for this turn / grant for the session / decline.
    - Network approvals render `networkApprovalContext` (`command` and `cwd` are null).
    - `writeStdin` approvals show the joined command, escaped.
    - "Don't ask again for this prefix" is dropped when the prefix contains CR/LF.
    - `approvals.mjs` learns the amendment decisions; the old `req.kind` is renamed.
  - **Elicitation:** `form` (from `requestedSchema`: string, number, boolean, enum and multi-select fields), `openai/form` / `openaiForm`, and `url`. The answer is `{action, content, _meta}`.
  - Exhaustiveness and surface tests. `shapeOf` gains property types.
  - **Done when:** every stable variant is handled or ignored by name, with unit tests.
  - ✅ **Built 2026-10-06:**
    - **Notification list:** `protocol-notifications.json` (63 stable, 22 experimental) is generated by `scripts/codex-notifications.mjs` from `common.rs` at the pinned tag. The JSON schema and TS bindings don't mark experimental notifications; the `#[experimental]` attribute does.
    - **Adapter:** `events.mjs` has a handler for 49 notifications. `surface.mjs` lists the other 14 stable ones with a reason, and the 22 experimental ones.
    - **Items:** `normalizeItem` covers all 19 `ThreadItem` types, and a test checks that against the protocol snapshot.
    - **Requests:** `classifyRequest` and `defaultExecDecisions` are ported from `default_available_decisions()`.
    - **Elicitation:** form, `openai/form` and url.
    - **Snapshot:** `shapeOf` records property types for objects and union variants, inline objects and inline enum values. A type change is breaking; becoming nullable is info.
    - **Interface additions (v4.5):**
      - event types `thread.unarchived`, `thread.deleted` and `mcp.status {server, status, error, failureReason}`;
      - delta kind `reasoningRaw`, plus `index` on reasoning deltas and `changes` on patch deltas;
      - `at` on item events.
    - **Kept:** `req.kind` in approvals.mjs is not renamed, because `ad chat`, `run`, `web` and `acp` read it. PendingRequest uses its own `kind` values.
    - **Review fixes** (3 medium, plus lows):
      - **Permissions:** grants round-trip as turn or session.
      - **Decision objects:** sent only when they deep-equal an option the request offered. A prefix with control, format or separator characters is never offered.
      - **v1 decline:** sent as `{denied: {rejection}}`.
      - **Snapshot diff:** catches type changes inside variants and inline objects, and dropped enum values.
      - **Hardening:** malformed options and schemas are dropped, not thrown on.
    - **For Parts 5/9:** every text field of items, requests and elicitations (commands, output, diffs, paths, MCP and hook text, elicitation messages and labels from third-party servers) must go through `sanitize()` when drawn.
- **3b. Routing + requests** (`engine/index.mjs`)
  - A global channel for thread-less notifications.
  - Per-thread routing that follows child threads (`collabAgentToolCall.receiverThreadIds`, `subAgentActivity`, `Thread.parentThreadId`).
  - A non-blocking `startTurn()`. `turn()` stays.
  - Pending requests are keyed by JSON-RPC id and removed on `serverRequest/resolved`; a revert cancels them.
  - User input and elicitation are routed to front ends. `run` and `loop` keep auto-declining (regression tests).
  - Library stderr writes become an `err` sink.
  - **Done when:** routing tests cover subagent approvals, and existing harness tests are green and unchanged.
  - ✅ **Built 2026-10-06:**
    - **Engine API:**
      - `Engine.subscribe(threadId | null, fn)` delivers adapted events for a thread and every thread below it. Links come from `thread/started.parentThreadId`, `collabAgentToolCall.receiverThreadIds` and `subAgentActivity`.
      - `threadChain()` returns a thread's ancestry, and `startTurn()` doesn't block.
    - **Requests:**
      - `onRequest(PendingRequest)` opts a front end in. It receives approvals labelled with the subagent's nickname, user input and elicitation.
      - Each request emits exactly one `request.opened` and one `request.resolved`. A request still open when Codex resolves it elsewhere, the thread is reverted or the engine exits is declined (`cancelled` says why).
      - `requestResult()` sends only offered options.
    - **Unchanged:** without `onRequest`, everything works as before (`ad run` / `ad loop` / `chat`), with regression tests.
    - **Not needed:** `err` sinks. The engine library never writes to stderr itself; `startHarnessEngine` already takes `err`.
    - **Shared fix:** `ad chat` and the preview build exec approval text from `events.execDisplay`. A network approval names its host, and a stdin write shows its input escaped.
- **3c. Mock model + real-engine CI** (`testkit/mock-responses.mjs`)
  - **SSE stream:** `event:` + `data:` for `response.created`, deltas, `output_item.done` (message, reasoning, function_call), `response.completed` with full usage, and `response.failed`.
  - **Mock behaviour:**
    - It picks its response from the request content (last input or `call_id`), never from order.
    - It asserts the request's `tools`.
    - It has a control API instead of sleeps.
  - **Real-engine tests:**
    - message, reasoning, exec, escalation approval, patch;
    - the three D5 error cases (`thread/doesNotExist`, `thread/search` without opt-in, `thread/start {sandbox:42}`);
    - steer and interrupt.
  - **Windows hygiene:**
    - Kill the process tree and wait for `close` before deleting a temp `CODEX_HOME`; `rmSync` with retries.
    - Allow 60 s for a first start.
    - Run with `--test-concurrency=1`.
  - **Done when:** CI runs the real engine green on all three platforms, with expected behaviour per platform from S2.
  - ✅ **Built 2026-10-06:**
    - **Mock control API:** a `HOLD` scenario with `held()` / `release()` / `hangups`, so tests don't sleep.
    - **New real-engine tests:** `turn/interrupt` (status interrupted, and the model request is abandoned), `turn/steer` (the model sees the steered input), and the events adapter on real traffic (no `unknown` events from PING, SHELL and PATCH turns).
    - **Results:** 8/8 green locally on Windows. Linux passes since the userns sysctl (S2).

### Part 4 — Session controller (`harness/session.mjs`)
- **4a. Lifecycle + requests**
  - **Thread lifecycle:**
    - Lazy thread start: no thread, hooks or digest until the first prompt. Quitting with zero turns is instant and leaves no trace.
    - `clientUserMessageId` matches the local echo of a prompt to the server's copy.
  - **Locking:** a thread lock (`~/.agent-daemon/locks/<thread>.lock`, pid plus process start time).
  - **Resume:**
    - `thread/resume` with `excludeTurns`.
    - `thread/turns/list` with `itemsView: "full"`, paged; the default is summary, descending.
    - `/model` and `/permissions` become next-turn overrides on `turn/start`.
  - **Engine crash:** error state; restart + resume with a cap; skill roots re-applied.
  - **Hooks for later parts:** `beforeTurn`, `turnStarted` (also for server-started turns), `turnCompleted`.
  - Tested through a headless subscriber (proves the controller is UI-agnostic) on both the fake and the real engine.
  - **Done when:** lifecycle, approval ordering, subagent requests, lock and crash tests are green.
- **4b. Steer, queue, interrupt**
  - Enter while running → `turn/steer` with `expectedTurnId`; "not steerable" (review/compact) falls back to the queue.
  - Tab → a visible, editable client-side queue, drained on completion.
  - Esc → interrupt.
  - Text stays in the composer until the server accepts it.
  - **Done when:** steer accepted / rejected / raced-with-completion tests are green.
- ✅ **Built 2026-10-06** (`harness/session.mjs`, 18 tests on the fake engine through a headless subscriber):
  - **4a, lifecycle:**
    - **Threads:** lazy (no thread or lock until the first prompt). The local echo is replaced by Codex's copy, matched by `clientUserMessageId`.
    - **Locks:** `lockThread()` uses pid + process start. A live holder gives `SessionLockedError`; a stale lock is taken over.
    - **Requests:** FIFO in `state.requests`, answered by `resolve(id, answer)`. Subagent requests are labelled and agents listed.
    - **Resume:** `resume()` sends `excludeTurns`, then pages `thread/turns/list` (`itemsView: "full"`, ascending).
    - **Next-turn overrides:** `setNextTurn()` is sent once on the next `turn/start`.
    - **Commands:** review, compact, shell (`thread/shellCommand`, items without a turn), goal and revert.
    - **Hooks:** `beforeTurn` may change the input. `turnStarted` also fires for server-started turns (review). `turnCompleted`.
    - **Crash:** the running turn ends as failed, open requests are declined, and the state shows `crashed`. With `restart`, the engine is replaced (capped) and the thread resumed; the session is "ready" only after that.
  - **4b, steer / queue / interrupt:**
    - Enter while running sends `turn/steer` with `expectedTurnId`. If the turn can't be steered (review) or has just ended, the prompt is queued and runs as soon as the thread is idle. The queue is editable and drains in order.
    - An interrupt sent before Codex accepted the turn is applied the moment it is.
  - **Bug found by the tests:** Codex can complete a turn before `turn/start` answers. Such a turn is no longer made "active", which had pushed every later prompt into the queue. Items that arrive before their turn is known join it.
  - **Fake engine:** gains turn history, prompt echo, a real `turn/steer`, `turns/list`, `review/start`, `thread/shellCommand` and `thread/revert`, and a `serverRequest/resolved` after every answer, as Codex sends.
  - **Real engine:** the controller runs on the real engine through the same API as the fake. A dedicated real-engine session test comes with Part 6, when the app drives it.
  - **Review and two re-reviews (2026-10-06):** 33 tests; every guard mutation-checked.
    - **Leaving a thread** (`newThread`, `resume`, `close`) bumps an epoch.
      - A running turn is interrupted and its waiters settle as "abandoned" (or "closed").
      - A thread, turn or history page that lands later is dropped, and a late turn is stopped.
      - Requests for any other thread are declined.
    - **One of each:** one `thread/start` at a time, and one session per engine.
    - **Overrides:** `setNextTurn` values stick. A new, resumed or restarted thread gets them again, and the sandbox policy maps to the sandbox mode.
    - **Queue:**
      - The queue drains whenever the thread is idle, including after a turn that ends before `turn/start` answers.
      - While the engine restarts, prompts queue.
    - **Restart:**
      - Every attempt counts toward the cap, with one restart loop at a time.
      - A new engine that dies while resuming counts as a failed attempt.
      - A thread the new engine can't resume is dropped with a notice; the next prompt starts a new thread.
    - **Locks:**
      - A heartbeat (mtime) replaces the pid-only check, so a reused pid can't keep a dead holder's lock.
      - Takeover is serialised by an O_EXCL `.takeover` file; two processes never both win.
      - An unreadable fresh lock is busy, and release goes by token.

### Part 5 — View components (`tui/view/`, pure)
- **5a. Composer:**
  - **Editing:** grapheme cursor; word moves; Ctrl+A/E/K/U/W/Y; Part 1a newline keys.
  - **History:** persisted to `~/.agent-daemon/tui/history.jsonl` (masked input never stored). Up/Down at the edges; **Ctrl+R** reverse search.
  - **Paste:** big pastes become `[Pasted N lines]` and expand on submit.
  - **Tokens:** mentions; a placeholder.
- **5b. Streaming markdown:**
  - **Streaming:**
    - A newline gate; blocks before the last are final.
    - Holdback: tables until complete (showing their last rows while streaming); setext candidates until the next line; an open fence (whose completed lines may commit).
    - Pacing: one line per tick, catching up at 8 lines or 120 ms.
  - **Blocks:** headings, nested lists, quotes, fences, inline styles, links (OSC 8), tables, rules.
  - **Test:** a chunked stream renders exactly like the full text (property).
- **5c. Cells + diff:**
  - **Turn content:** user; agent; reasoning summary (dim).
  - **Commands:** Exploring → Explored; Running → Ran; Failed (exit N); a 5-line tail (50 for `!`); `!` labelled **unsandboxed**.
  - **Edits and plans:** patch `Edited N files (+A -R)` with a gutter diff; plan ✔/□.
  - **Tools and system:** MCP; web search; image; review markers; compaction; subagent activity; hook prompt.
  - **Fallbacks:** notices; unknown.
  - **`ad` rows:** recalled, skill suggested, guard blocked, learned, loop, team.
  - Output is capped per item.
- **5d. Chrome, popups, modals:**
  - **Chrome:** the header card from the screen design; the status indicator; the adaptive footer.
  - **Popups:** the `?` shortcut overlay; a filterable list picker.
  - **Modals:**
    - Approval modal from `PendingRequest.options` (per kind, see 3a), with the full command (approval-sanitized) and the patch diff from the item store.
    - User-input form (masked when `isSecret`).
    - Elicitation forms per mode.
- **Done when:** goldens at widths 40, 80 and 120 and small heights pass → **FC2**.
- ✅ **Built 2026-10-06** (`tui/view/`, `tui/history.mjs`; goldens in `test/golden/tui/`). **FC2: pending (user)**, a look at the goldens and, with Part 6, the live app.
  - **Widths:** every view renders lines that fit the `width` it is given. The app (Part 6) passes `cols - 2`, so lines stay ≤ 78 at 80 columns.
  - **5a, composer** (`composer.mjs`):
    - **Editing:** grapheme cursor and word moves. Up/Down move by visual row, then walk the history at the first or last row.
    - **Rendering:** a soft wrap prefers spaces; a space that overflows stays hidden at the row's end. Tabs show as 4 cells.
    - **Mask:** masked input wraps by cells only, so no word lengths show. It never reaches the history and never searches.
    - **Popups:** `token()` / `replace()` feed the `@` and `/` popups.
    - **History** (`history.mjs`): JSONL, 0600, compacted past twice `max`. A torn line is skipped, and I/O errors keep history in memory.
  - **5b, markdown** (`markdown.mjs`):
    - **Stream property:** everything a stream commits, concatenated, is exactly the full render.
    - **Live property:** committed lines plus `live()` always equal the render of the text received so far.
    - Both are fuzzed with 20 000 random documents.
    - **Links:** a link's URL is shown after its text when they differ. OSC 8 (`renderLine(…, {hyperlinks})`, renderer option `hyperlinks`) is used for http(s)/mailto only.
    - **Pacing:** `createPacer`.
  - **5c, cells** (`cells.mjs`):
    - **Commands:** Explored / Ran / Failed (exit N) / Declined, with the output tail. A user's `!` command is labelled `(unsandboxed)`.
    - **Diffs:** a gutter diff with line numbers.
    - **Also:** plan, tools, web, review, compaction, agents, notices and ad rows. Every line is cut to the width as a last guard.
  - **5d, chrome, popups and modals:**
    - **`chrome.mjs`:** the header card (middle-ellipsis paths), the status line with queued prompts, the footer drop order, the newline hint per terminal, the `?` overlay and the picker.
    - **`modals.mjs`:** approval, user-input and elicitation modals built from `PendingRequest`.
    - **Arming:** the 400 ms window moved into the modal, so every front end gets it.
    - **Scrolling:** a long command scrolls inside the modal (PgUp/PgDn), and the full request goes to history.
    - **openaiForm:** points to `/codex`.
  - **Review (2 high, 5 medium, all fixed; 14 guards mutation-checked):**
    - **Composer:** text from outside (an MCP form's default, a picked file name, the history file) is sanitized like typed text.
    - **Diffs:** they never hide a line.
      - A new or deleted file's `diff` is its content, shown whole.
      - A hunk takes exactly the lines its header counts, so `+++`/`---`/`@@` content stays.
      - A malformed line is shown whole.
    - **Patch approvals:** they render in approval mode, so hidden characters show.
    - **Labels:** one-row labels show tab and newline as symbols, so a label can't draw fake options.
      - Digits pick approval options, and the network-amendment key is `h`.
      - Prefixes with spaces are quoted; option descriptions show; multiselect min/max are enforced.
    - **Markdown speed:**
      - Unmatched openers cost O(n) in total (failure memo, bracket pairs, cached code spans): 20 KB went from 2 s to under 10 ms.
      - The stream sanitizes each line once.
      - `live()` shows only the tail of a held-back block over 8 KB. That view is provisional; what commits stays exact.
    - **Tables:** no hyperlinks in tables, since a cut cell could hide where a link goes.
    - **Tests:** the property tests use mulberry32, and compare styles too.
    - **Accepted:** free text in a question isn't armed (typing then Enter is normal), and the picker title and placeholder are left to the renderer's clip.

### Part 6 — App shell (MVP)
- **`tui/app.mjs`:**
  - Input → intents (immediate echo); session events → reducers; 33 ms frames; finished cells committed.
  - **Ctrl+C:** popup → clear composer → interrupt → quit on the second press.
  - Quit shows "saving…" while SessionEnd hooks run; a further Ctrl+C forces it.
- **Codex reflexes:**
  - Enter / Tab / Esc semantics.
  - `@` file mentions (one-shot `fuzzyFileSearch`, debounced), `!` shell, Ctrl+R, the `?` overlay.
  - BEL when an approval waits or a turn finishes unfocused.
  - Folder-trust prompt per S3.
- **The `ad` layer (D11):**
  - Header lines and "since last time" (loop logs, schedule logs, pending GEPA proposals: file reads, no engine).
  - Recall / skill / guard rows from `hook/completed` (`sourcePath` = harness hooks file).
  - `/remember`.
- **Slash MVP:**
  - Session: `/help`, `/new`, `/resume` (picker: `thread/list` with `modelProviders: []`, source kinds including `appServer`), `/compact`, `/quit` and `/exit`.
  - Settings: `/model` (provider-aware, effort), `/permissions`, `/login`, `/logout`, `/status` (account, model, sandbox, tokens, rate limits, compat line).
  - Work: `/goal`, `/review`, `/diff` (local git, incl. untracked).
  - Handoffs and tools: `/init` (Codex's), `/codex`, `/ad <subcommand>`.
- **`ad codex [args…]`:** the pinned stock TUI with `CODEX_HOME` = harness home, `--no-daemon`, provider env from the secret store, and skills per S3. Runs via `io.handoff`, with one writer per thread. SessionEnd digests are de-duplicated by thread id.
- **Exit:** a resume hint (`ad tui --last`) and a token summary.
- **Done when:** every row of the failure UX table and the live script below pass on Windows Terminal 1.24 and 1.25 and VS Code (plus WSL in Windows Terminal if available):
  1. ask
  2. exec approval
  3. patch approval
  4. steer
  5. queue
  6. interrupt
  7. `/codex` and back
  8. quit
  9. `ad tui --last`

  → **FC3**.
- ✅ **Built 2026-10-06** (`tui/app.mjs`, `tui/main.mjs`, `harness/codex-ui.mjs`; `ad tui`, `ad codex`). **FC3: pending (user)**, the live script on Windows Terminal, Zed and VS Code.
  - **App:**
    - **Scrollback:** finished items commit to scrollback in order. An agent message commits its finished markdown lines as it streams, and a run of exploring commands commits as one cell. What still changes is drawn live, with at most 60 % of the screen used for streaming cells.
    - **Turns:** a turn's end shows "Worked for Ns", plus the error or interrupt notice. A resumed conversation's old turns are never reported as news.
    - **Requests:** an open request becomes a modal (Part 5). Its full text goes to scrollback first, and the answer is logged as "approved", "approved for this session" or "declined".
  - **Keys:**
    - Ctrl+C closes a popup, then clears the composer, then interrupts; a second press within 1.5 s quits.
    - Esc interrupts. Tab queues while a turn runs, and on an empty composer pulls the last queued prompt back.
    - `?` opens the overlay. `@` searches with `fuzzyFileSearch`, debounced. `/` opens the command popup (Enter runs the highlighted command). `!` runs `thread/shellCommand`.
    - A BEL sounds when an approval waits, or when a turn ends while the terminal is unfocused.
  - **Slash MVP:** all listed commands.
    - `/init` sends Codex 0.160's own prompt, vendored in `tui/init-prompt.mjs` (Apache-2.0, re-copied on upgrades).
    - `/codex` releases the thread, runs the stock UI on it, then resumes it; what is already in scrollback stays.
  - **`ad tui`:**
    - preflight (TTY, `TERM=dumb`, Node on Windows, mintty);
    - a sign-in panel that hands off to `ad auth login …`;
    - the folder-trust prompt, written as an `upsert` of `projects` (`writeConfig` gains the strategy);
    - the header card with the "since last time" line (loops, schedules, proposals);
    - setup warnings shown inside the UI;
    - `--last` and `--resume`, and the exit hint `ad tui --resume <id>` with tokens.
  - **ad layer:** hook rows come only from ad's own `hooks.json` (recalled N learnings, guard blocks, hook failures); the session emits `hook` events. `/remember` writes a learning, and `/memory` summarizes the store.
  - **`ad codex`:**
    - The pinned binary with `--no-daemon`, `codexEnv` on the harness home, and provider keys from the secret store.
    - `~/.claude/skills` is mirrored into `$CODEX_HOME/skills` (marker per folder; the user's own folders are never touched). The engine then drops that extra root.
  - **Tests:**
    - app tests on the fake engine (turn, approval with arming, steer, queue, Ctrl+C, slash, `!`, `@`, small screens);
    - helper tests, and a real-pty smoke of `ad tui` (trust → turn → approval → `/status` → quit → resume hint, history written).
  - **Review (1 high, 5 medium, all fixed; 13 guards mutation-checked):**
    - **Scrollback:** it can't wedge any more. An item whose turn has ended commits even if Codex never completed it (shown as "Stopped" / "Not applied"). A crash clears the turn's items, and an agent message behind a running item is drawn live.
    - **Crashes:** a crash the automatic restarts gave up on shows "Codex stopped (exit N). Your text is kept. Enter restarts and resumes." The session gains `restartEngine()`, and prompts typed meanwhile queue.
    - **Resume:** `/resume` no longer resets the view, so a refused (locked) resume duplicates nothing.
    - **Login and sanitizing:** `/login` checks the exit code and restarts Codex after a login. "Since last time" is sanitized (loop logs ship with repos).
    - **Skills:** the mirror refreshes on every engine start, and linked skill folders are followed (links inside are copied as links).
    - **Keys:**
      - Ctrl+C arms quit only after an interrupt or an idle press.
      - A multi-line paste starting with `!` is a prompt.
    - **Smaller fixes:**
      - `/status` tokens fixed, and the timer is kept per turn.
      - Notices land after the items they follow.
      - `--cwd` is resolved before the trust key.
      - The fake launcher keeps locks and schedules in its temp root, and the fake's turn ids are unique per process.
    - **Tests:** the app tests now assert on the scrollback itself, not the screen.
  - **Open (live, with the user):**
    - FC3's script;
    - `codex resume <id> --no-daemon` interactively (S3);
    - that Codex honours the trust key as written on Windows paths;
    - de-duplicating SessionEnd digests by thread id across `/codex` (not done yet).

### Part 7 — Resilience hardening
- **`codex-compat.json`:** tested versions plus a user-facing "what changed" note; `/status` line; `ad doctor`.
- **Reserved slash names:** generated from `slash_command.rs` at the pinned tag; the upgrade PR fails on a collision.
- **Fixtures:** the synthetic future-Codex fixture; fake-server messages validated against the pinned JSON schema (required fields and enums).
- **`/warnings`:** retained notices and unknown-event counts.
- **Upgrade flow:** the upgrade workflow summarizes real-engine failures; the `codex-upgrade` skill gains the TUI smoke steps.
- **Narrowing ghosts (from 1c):**
  - Extend `tui-probe screen` to record, per terminal, where the cursor and the live rows end up after a narrowing resize, with the live region at the bottom of the screen and wrapping rows below the cursor.
  - Track the live region's screen row across writes.
  - Where a terminal keeps the cursor's screen row (xterm.js does), compensate in the re-anchor, but only when the region is known to be flush with the bottom. Keep the lower bound everywhere else.
- **Done when:** the future fixture passes, a collision test fails as expected, and an upgrade dry run is documented.
- ✅ **Built 2026-10-06** (`test/tui-resilience.test.mjs`, `testkit/protocol-check.mjs`, `scripts/codex-slash.mjs`, `engine/codex/compat.json`).
  - **`compat.json`:** pinned and tested versions, plus a user-facing "what changed" per version. It shows in `/status` and `ad doctor` ("Codex compatibility"). A test ties it to the pin.
  - **Slash names:**
    - `codex-slash.json` (65 names at rust-v0.160.0) is generated from `slash_command.rs`.
    - Every ad command is marked `source: "codex"` (it must stay one of Codex's) or `"ad"` (it must never be one).
    - `slashCollisions` is tested both ways, including a simulated Codex `/remember`.
  - **Protocol checks:**
    - The snapshot now records each server notification's and request's params type (83 + 10) and their shapes.
    - `protocol-check.mjs` validates required fields, enums, union variants (`type` or `key=value` tags) and basic types.
    - Every fake-server message in the main scenarios passes. That needed fixes to the fake: `startedAtMs` / `completedAtMs`, full `Thread` objects, and the approval's `itemId`.
  - **Future fixture:** the fake's `future` scenario sends:
    - an unknown notification, item type, item status, action type, extra fields and plan-step status;
    - an unknown request (refused with -32601).

    The turn completes, the item renders as "not shown", and `/warnings` lists the unknown method with a count (`engine.unknownCounts()`).
  - **Upgrade flow** (`codex-upgrade.yml`):
    - regenerates `codex-slash.json`;
    - bumps `compat.json` (the "what changed" note is left for a human, so its test fails until then);
    - runs the real engine against the mock model and lists failures in the PR body (label `real-engine-failing`).

    The skill gains the resilience test, the `/init` re-copy and a live `ad tui` smoke.
  - **Upgrade dry run (2026-10-06, Windows, no-op bump to 0.160.0):**
    - `codex-schema-snapshot --check` → up to date;
    - `codex-slash.mjs` → 65 names, no diff;
    - compat bump → no change;
    - `npm test` green;
    - `AD_REAL_ENGINE=1` engine-real → 9/9, including a new test: a `projects` upsert with Windows paths keeps both folders and reads back.
  - **Narrowing ghosts:** characterized on xterm.js (headless).
    - When rows above the cursor wrap on narrowing, xterm.js also moves the cursor down by more than the re-wrap accounts for, flush with the bottom or not. So a lower-bound re-anchor leaves the old copy of the wrapped rows as a ghost; history is never erased.
    - A compensation needs real per-terminal data. `tui-probe screen --bottom` now records it (CPR after each resize, region flush with the bottom).
    - **Pending (user):** run `node runtime/scripts/tui-probe.mjs screen` and `screen --bottom` in Windows Terminal, Zed and VS Code (narrow, then widen), and share the log and a screenshot. Compensation lands afterwards.

### Part 8 — Codex parity++
- **Turn history:**
  - Esc Esc backtrack (`thread/revert`, only on paginated, durable, idle threads; reload with `thread/turns/list`; says files are not reverted, pointing to `/undo`).
  - Ctrl+T transcript pager.
- **Copy and export:** `/copy` (OSC 52, then clip.exe / pbcopy / wl-copy / xclip), `/raw`, `/export`.
- **Thread commands:** `/fork`, `/rename`.
- **Inspection:** `/mcp`, `/hooks`, `/skills`, `/usage`.
- **Images:** pasted or dragged paths and an `/image` command (Windows Terminal keeps Ctrl+V for itself).
- **Editor:** Ctrl+G external editor.
- **Reasoning:** reasoning-effort keys.
- **Auto-review:** `item/autoApprovalReview/*`, `guardianWarning`, `thread/approveGuardianDeniedAction`.
- **Windows Terminal setup:** a print-only `/terminal-setup` (`sendInput` binding for `CSI 13;2u`, with a tip that Windows Terminal 1.25 fixes Shift+Enter).
- **Done when:** each command has unit and golden tests and a live check.

### Part 9 — `ad` capabilities (one loop each; FC4 after each)
- **9a. See what ad knows:**
  - `/memory`: search, recent, forget, profile.
  - A `[private]` toggle that wraps the prompt in `<private>`.
  - A "learned" row (database poll keyed by thread id).
  - `/proposals` (GEPA review).
- **9b. Work while you're away:**
  - **`/loop <objective>`** spawns a child `ad loop` with its own engine (`AD_WORKER=1`, sandbox check, same brakes). The TUI tails `.agent-daemon/loops/`, shows an iteration banner and brake meters, and `/loop stop` writes STOP.
  - **`/team` board:** worker states (working / needs input / idle / done / failed), needs-input highlighted with a BEL, and peek.
  - A "scheduler not running" warning and `/schedule` list and run.
- **9c. Never stuck:**
  - `/ad doctor`, `/ad sandbox`.
  - `ad tools` toggles.
  - The `/codex` round trip polished.
- **Done when:** each feature passes unit and fake-engine tests, a live check, and the user's FC4.

### Part 10 — Checkpoints and `/undo` (only if S4 passes)
- **Why Codex removed its ghost-commit undo:** answered in writing first (#3914, #5629, now a legacy no-op).
- **Snapshot:**
  - Copy the index (`git rev-parse --git-path index`) to a temp file.
  - `GIT_INDEX_FILE=<tmp> git -c gc.auto=0 add -A`, then `write-tree`, then `commit-tree`, then `refs/ad/checkpoints/<thread>/<n>`.
  - Taken on `turnStarted`.
  - Size limits for untracked files; retention of the last N.
  - The user's index, HEAD and stash are never touched.
- **Restore:**
  - The set is the pre-turn vs post-turn diff, with a conflict check against later user edits.
  - `git restore --source --worktree` per path, plus deleting added files.
  - Then `thread/revert`.
  - The UI says that ignored files, submodule contents and LFS/eol-filtered files are not restored byte-exact.
- **Done when:** tests run on temp repos (including Windows paths, spaces, CRLF, an untracked big file and a conflict), and the S4 budget holds in CI timing.

### Part 11 — Flip bare `ad`, docs, verification, release
- **Flip:** after FC3, apply D7, and add `ad --last`. `ad chat` shows a one-time hint.
- **Docs:**
  - `docs/tui.md` (keys, commands, config, terminal notes).
  - The harness guide, README, troubleshooting, the `manual-test.md` TUI section.
  - Updates to the `ad-harness`, `harness-troubleshoot` and `codex-upgrade` skills.
  - A CHANGELOG entry covering bare `ad`, `AD_TUI=0`, the Node note and `ad codex`.
- **Verification track:** every item in the table under Parts is done before the release.
- **Release:** v2.1.0.
- **Done when:** CI is green, the docs match the code, and the release is tagged by the usual process.

### Part 12 — ACP, chat and web onto the controller
- After ACP is verified live in Zed. Remove the duplicated turn, approval and fileChange logic. Behaviour and tests stay unchanged.
- **Done when:** the existing ACP, chat and web tests pass unchanged and the live checks repeat.

### Part 13 — Fullscreen mode + inline reflow
- **Fullscreen:** `/tui fullscreen|inline`, persisted; an owned transcript on the alternate screen (keyboard scrolling; mouse where the platform delivers it; search; auto-follow that pauses with an "N new" chip; dump to scrollback on exit).
- **Inline reflow:** Codex-style purge and replay, debounced and capped per terminal, opt-in.
- **Done when:** the goldens and the live checks pass in both modes.

## The loop for every (sub-)part

1. Re-read the part, the interfaces and the code it touches. Write tests first for pure modules.
2. Implement in small steps, running focused tests as you go.
3. Run `node --test`, `node --check`, the goldens (UI parts) and the real-engine tests (engine parts).
4. Live smoke where the part has a runtime effect: a scratch directory, the real Codex, Windows Terminal (+ VS Code for terminal parts).
5. Review: a fresh-eyes subagent on the diff (correctness, Windows, terminal restore, escape injection, privacy, error paths, test quality, house style), then my own pass.
6. Fix and repeat 3–5 until no finding of medium severity or above is left.
7. Update this plan's status and `activeContext.md`, commit by file name, and only then move on.

## Testing pyramid

| Layer | What | How |
|---|---|---|
| Unit | events / exhaustiveness, controller logic, input parser, width / wrap / sanitize, markdown (streamed = full), diff, composer, cells, commands | `node:test`; clock, cwd, home and platform injected; NO_COLOR forced |
| Engine-in-the-loop | real pinned `codex app-server` + mock Responses server | `testkit/mock-responses.mjs`; CI on all three platforms; `--test-concurrency=1` |
| Edge cases | crashes, malformed and future traffic | the fake app-server |
| Screen | renderer and app + fake terminal → screen and scrollback; two reflow models; ConPTY smoke | `@xterm/headless`, `@lydell/node-pty` (devDependencies); LF goldens, `AD_UPDATE_GOLDEN=1` |
| Live | Windows Terminal 1.24 and 1.25, VS Code, a macOS/Linux terminal | `docs/manual-test.md` + feedback checkpoints |

## Risks

| Risk | Mitigation |
|---|---|
| Parity scope | MVP subset; `ad codex` in the MVP; "not in ad yet → /codex" |
| Windows input (old Node, Shift+Enter = Enter, Alt+Enter taken, Ctrl+V taken) | D8; S1; adaptive newline hint; `/image` and paths |
| Inline geometry (resize, autowrap, tall content) | `?7l` live rows; CPR re-anchoring with per-terminal reflow model; clamp; overpaint commits; S1b; two-model property tests; ConPTY smoke |
| Escape / bidi tricks in approvals | visible sanitizing; hostile-string tests |
| Two writers on one thread | locks with pid + start time; handoffs close our engine first |
| Experimental drift | D5 |
| Upstream behaviour changes without schema changes | D9 on every bump |
| Windows CI flakiness | process-tree kill, retries, 60 s cold start, serial engine tests, a mock control API |
| Checkpoint cost and safety | S4 budget gate; Part 10 never touches user git state |
| Privacy | mock-model traffic only in fixtures; masked inputs never stored; raw params only in debug |
| Stray stderr on the screen | the err sink; `process.on('warning')` |

## Housekeeping and later

- **Now:** PR #9; Codex 0.160.0; installers; CI majors; the verification track (parallel, see Parts); user actions (Node upgrade within 22.x, old clone, FC decisions).
- **Later (backlog):**
  - an `ad` hub daemon that several clients attach to;
  - an extension API whose UI primitives also work in web and ACP;
  - daemon instructions in Claude Code's per-project memory;
  - a macOS Keychain backend; a native-key Responses translator;
  - themes; voice; `/subagents`; `/statusline` customization;
  - schedule add/remove in the TUI;
  - a `/web` hand-off.

## Revision log

- **v1** (2026-10-04): first draft from the research reports and the code map.
- **v2** (2026-10-04): terminal research plus the first adversarial review (2 critical, 7 high): Node floor and input spike, stable-only D5, approvals from `availableDecisions`, child-thread routing, `thread/revert` limits, checkpoints as their own part, `ad codex` in the MVP, exhaustiveness and engine-in-the-loop CI, sub-parts.
- **v3** (2026-10-04): the second review round, technical and product, with 6 critical and 13 high findings, all addressed:
  - **Rendering:**
    - Autowrap-off live rows.
    - Overpaint commits.
    - CPR-measured re-anchoring with a per-terminal reflow model.
    - The `ESC[0A` rule; SGR resets.
    - Pre-wrapped history plus `/raw`.
    - Spike S1b.
    - A ConPTY smoke test.
  - **Protocol:**
    - Corrected D5 error classification.
    - Corrected elicitation modes (`form`).
    - Verbatim decision payloads; network and `writeStdin` approvals.
    - `itemsView: "full"` on resume.
    - The S2 matrix job and its config.
    - Windows CI hygiene.
  - **Product:**
    - The visible `ad` layer and Codex reflexes moved into the MVP.
    - A walking skeleton and feedback checkpoints FC0–FC4.
    - Bare `ad` stays help until FC3.
    - A soft Node floor.
    - `/loop` as a child process.
    - The failure UX table.
    - The naming rule D10 with `/ad <subcommand>`.
    - Windows Terminal key traps.
    - User-facing update notes.
    - The screen design.
  - **Order and structure:**
    - ACP migration after the MVP.
    - Spike S4 for undo moved into Part 0.
    - Fixed interfaces.
    - Done-when for every part.
- **v4 — final** (2026-10-04): round 3 verification (1 high, 3 medium, lows), plus the user's isolation requirement.
  - **Approvals:** `availableDecisions` is experimental and leaks through today, so options are now built per kind with Codex's fallback, and a real-engine test watches the field.
  - **Interfaces:** the session gained `setNextTurn`, `editQueued`, `review`, `compact`, `shell`, `setGoal` and `revert`; SessionState gained config, account, goal, agents, mcp and engine details; `item.delta` gained the `plan` kind.
  - **Verification track:** now a parallel track that gates Parts 6 and 9b.
  - **Part 0 order:** the Node upgrade comes before S1/S1b; S2 runs inside `test.yml`.
  - **Naming:** `/feedback` becomes `/ad feedback`.
  - **Smaller fixes:** 63 stable + 22 experimental notifications; the steer-error rule; focus reporting; handoff pauses stdin and needs an idle turn; footer drop order; the blank-row and `ESC[0B` rules; a thin `cli.mjs` launcher; one Node range everywhere; a Linux check via WSL.
  - **D13 and its section:** your own Codex is never touched, enforced in code.
- **v4.1** (2026-10-05): Part 1b review (2 high, 4 medium).
  - **Width:**
    - Emoji width now has `codepoint` (default, safe) and `grapheme` profiles, because xterm.js adds up ZWJ sequences while Windows Terminal clusters them.
    - The renderer picks the profile by `WT_SESSION` or a CPR probe.
    - Zero-width is narrowed to Mn/Me/Cf plus conjoining jamo.
  - **Renderer:** history commits are drawn with autowrap off too, so any remaining width disagreement is cosmetic.
  - **Sanitize:** approval mode shows every default-ignorable, variation selector and non-ASCII space; transcript mode ends an unterminated string at the newline.
  - **Colour:** 256-colour uses xterm's real levels; theme tokens carry explicit 256/16 fallbacks.
  - **Re-review** (no critical or high findings):
    - Fixed one medium: a long zero-width run overflowed the stack in `wrap`.
    - Lows fixed:
      - approval also shows private-use, unassigned and blank-glyph characters;
      - an OSC ends at ESC/CAN/SUB.
    - Accepted, cosmetic: marks newer than Unicode 11 count 0 where xterm.js draws 1.
    - Later: wrap speed (1M characters take about 5 s).
- **v4.2** (2026-10-05): FC0.
  - **Probes:** S1/S1b results for Windows Terminal and Zed are in Part 0. The user's daily terminal is Zed, so Zed replaces VS Code as a primary live-check target.
  - **Decisions:**
    - Inline mode (D2).
    - Newline = a bare LF (`0a`): Shift+Enter in Zed, Ctrl+Enter in Windows Terminal, Ctrl+J everywhere. The footer hint is per terminal.
    - The full boxed header.
  - **Input:** an empty bracketed paste is reported as `paste-empty`, so the composer can offer to attach the clipboard image.
  - **Probe fix:** `tui-probe screen` no longer prints during the resize test.
- **v4.3** (2026-10-05): Part 1a.
  - **Interfaces:**
    - `createIo` gains `close()`, `suspend()`, `cpr()` and `onResume()`;
    - the input event shapes and `isNewline()` are fixed;
    - Ctrl+J counts as a newline in every encoding.
  - **Review:** 4 medium findings fixed (sequence cap, stale CPR, signals during handoff, stalled paste), plus 6 of 7 lows.
- **v4.4** (2026-10-06): Part 1c.
  - **Interfaces:** `createRenderer` gains `start()`, `dispose()` and `state`, plus the options `depth`, `reflow` and `resizeSource`. `frame()` takes span lines or strings.
  - **Re-anchor:** guarded by a generation counter, and its rows-above-cursor estimate is a lower bound (ghost rows are acceptable, erased history is not).
  - **devDependencies:** `@xterm/headless`, `@xterm/addon-unicode11` and `@lydell/node-pty` for the screen tests and the ConPTY smoke.
- **v4.5** (2026-10-06): Part 3.
  - **Interfaces:**
    - AdEvent gains `thread.unarchived`, `thread.deleted` and `mcp.status`; item deltas gain `reasoningRaw`, `index` and `changes`; item events gain `at`.
    - The engine gains `subscribe`, `threadChain`, `startTurn`, `onRequest`, `openRequests` and `requestResult`.
  - **Approvals:** decisions are validated against the offered options. The plan's rename of `req.kind` is dropped (compatibility).
  - **Protocol diff:** the snapshot records types.
- **v4.6** (2026-10-06): Part 4.
  - **SessionState (as built):**
    - `turns` holds `{id, status, error, itemIds}` and `items` is a Map of ViewItems (with `threadId`, `turnId`, `streaming` and accumulated delta text).
    - `echoes` is a Map from clientUserMessageId to text.
    - `starting` is true while turn/start is on its way.
    - `engine.state` gains "restarting".
  - **Session API:**
    - `createSession` also takes `lockDir`, `restart` and `maxRestarts`;
    - the session gains `init()` (account and rate limits, read once);
    - `submit()` during a turn steers, and while a turn is starting it queues.
  - **Part 3 re-review:** one `request.resolved` per request, links only from real spawns, and validated answers.
- **v4.7** (2026-10-06): Part 5.
  - **Interfaces added:**
    - `createComposer`, `createHistory`, `renderMarkdown` / `createMarkdownStream` / `createPacer`, `renderCell` and friends, `renderHeader` / `renderStatus` / `renderFooter` / `createPicker`, and `createRequestModal`.
    - `renderLine` and `createRenderer` take `hyperlinks`.
  - **Arming:** the approval window lives in the modal, not the app.
  - **Widths:** views get `cols - 2` from the app.
- **v4.8** (2026-10-06): Part 6.
  - **Interfaces added:**
    - `createApp`, `cmdTui` and `runStockCodex` / `syncSkills`;
    - the session's `hook` event;
    - `engine.writeConfig` edits take an optional `"upsert"` strategy;
    - `skillRoots({engineHome})`.
  - **Flags and commands:** `ad tui` (`--last`, `--resume`) and `ad codex [args…]`; `ad tui --preview` stays for now.
- **v4.9** (2026-10-06): Part 7.
  - **Snapshot:** gains `params` (method → params type), and the shapes of all those types.
  - **Engine:** gains `unknownCounts()`.
  - **Slash commands:** `SLASH_COMMANDS` entries carry `source`, and `/warnings` is added.
  - **Narrowing-ghost compensation:** waits on per-terminal probe data from the user.
