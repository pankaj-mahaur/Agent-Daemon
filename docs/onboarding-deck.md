---
marp: true
theme: gaia
class: invert
paginate: true
backgroundColor: '#1a1a1a'
color: '#e8e8e8'
header: 'agent-daemon · zero-to-one onboarding'
footer: 'Mobiux · v0.2.0 + Phase 5 · 2026-05'
style: |
  /* Inline theme — see docs/onboarding-deck.css for the full version.
   * Loaded inline here so the deck is self-contained for one-off exports.
   */
  section {
    background: #1a1a1a;
    color: #e8e8e8;
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    padding: 60px 80px;
  }
  h1 { color: #5fb6f7; font-weight: 700; }
  h2 { color: #a0e88a; border-bottom: 1px solid #2a2a2a; padding-bottom: 0.3em; }
  h3 { color: #e8e8e8; }
  h4 { color: #9a9a9a; text-transform: uppercase; letter-spacing: 0.08em; }
  code, pre, kbd { font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace; }
  code { background: #0f0f0f; color: #c397f0; padding: 0.15em 0.4em; border-radius: 4px; }
  pre { background: #0f0f0f; border-left: 4px solid #5fb6f7; padding: 14px 18px; font-size: 18px; }
  pre code { background: transparent; color: #e8e8e8; }
  pre.ascii { font-size: 13px; line-height: 1.2; border-left: 4px solid #c397f0; white-space: pre; }
  blockquote { border-left: 4px solid #ff8a65; padding: 8px 18px; background: rgba(255,138,101,0.06); }
  table { border-collapse: collapse; font-size: 20px; width: 100%; }
  th, td { border: 1px solid #2a2a2a; padding: 8px 12px; text-align: left; }
  th { background: #232323; color: #a0e88a; }
  .check { color: #a0e88a; font-weight: 700; }
  .warn  { color: #ff8a65; font-weight: 700; }
  .key   { color: #5fb6f7; font-weight: 700; }
  .muted { color: #9a9a9a; }
  .stat  { display: inline-block; font-size: 90px; font-weight: 800; color: #5fb6f7;
           font-family: 'JetBrains Mono', monospace; line-height: 1; }
  .stat-label { display: block; font-size: 18px; color: #9a9a9a;
                text-transform: uppercase; letter-spacing: 0.08em; margin-top: 0.4em; }
  ul li::marker { color: #5fb6f7; }
  ol li::marker { color: #a0e88a; font-weight: 700; }
  strong { color: #e8e8e8; }
  em { color: #c397f0; font-style: normal; }
  a { color: #5fb6f7; }
  section.lead { text-align: center; background: linear-gradient(180deg, #1a1a1a 0%, #0a0a0a 100%); }
  section.lead h1 { font-size: 72px; }
  section.lead h2 { border: none; color: #9a9a9a; font-size: 28px; font-weight: 400; }
  section.cta { text-align: center; }
  section.cta h1 { font-size: 64px; }
---

<!-- _class: lead -->
<!-- _paginate: false -->

# agent-daemon

## A self-improving runtime for Claude Code

<br>

<span class="muted">Mobiux Internal · 2026-05 · v0.2.0 + Phase 5</span>

---

## The problem

Every Claude Code session starts from **zero memory**. You — and Claude — repeat the same conversation, the same mistakes, the same context-setting.

<br>

> *"Hey Claude, this project uses pnpm not npm."*

> *"Hey Claude, the migrations live in `prisma/`, not `src/db/`."*

> *"Hey Claude, we don't use `console.log` in production code."*

<br>

Same words. Different session. Same mistakes tomorrow.

---

## The cost

<div style="display: flex; justify-content: space-around; text-align: center; margin-top: 40px;">

<div>
<span class="stat">5–10</span>
<span class="stat-label">min / session re-explaining context</span>
</div>

<div>
<span class="stat">10×</span>
<span class="stat-label">sessions per dev / week</span>
</div>

<div>
<span class="stat">5+</span>
<span class="stat-label">devs in our team</span>
</div>

</div>

<br>

### ≈ <span class="warn">4+ hours / week lost</span> on re-explaining things Claude could have remembered.

<br>

Plus the harder-to-measure cost: Claude repeating the same wrong choice that already got corrected last Tuesday.

---

## What is agent-daemon?

<br>

1. **Persistent memory across sessions** — corrections, conventions, decisions captured automatically. Next session starts with this context already loaded.

2. **229 ready-made skills** auto-triggered by what you say. Type *"kuch toot gaya"* → `debug-triage` skill activates with a 9-class bug checklist.

3. **Self-improves over time** — skills evolve based on real failure traces. Memory grows. The agent gets better at your project, your codebase, your team's style.

<br>

> <span class="key">Open source · MIT · No API key required for daily use</span>

---

## How it works — three nested loops

```
┌────────────────────────────────────────────────────────────────┐
│ OUTER LOOP — sessions getting smarter                          │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐   │
│   │ MIDDLE LOOP — skills evolving (GEPA)                 │   │
│   │                                                       │   │
│   │   ┌────────────────────────────────────────────┐   │   │
│   │   │ INNER LOOP — multi-agent orchestration     │   │   │
│   │   │   (when 1 agent isn't enough)              │   │   │
│   │   └────────────────────────────────────────────┘   │   │
│   │                                                       │   │
│   └──────────────────────────────────────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Outer**: each SessionEnd → digest pipeline → memory updates → next session loaded smarter.
**Middle**: skills with ≥3 failures → propose improvements → human review → roll forward.
**Inner**: complex tasks → spawn parallel agents in isolated git worktrees → merge.

---

## Before / after

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 30px;">

<div style="background: #232323; border-left: 4px solid #ff8a65; padding: 16px 20px; border-radius: 6px;">

#### <span class="warn">Vanilla Claude Code</span>

- Empty memory every session
- Same explanations every day
- Same mistakes repeated
- Skills available, no learning loop
- No multi-agent coordination

</div>

<div style="background: #232323; border-left: 4px solid #a0e88a; padding: 16px 20px; border-radius: 6px;">

#### <span class="check">Daemon-enabled</span>

- Memory pre-loaded on session start
- Conventions remembered automatically
- Past corrections surface as context
- Skills improve from real failures
- Teams of agents on big tasks

</div>

</div>

<br>

> Same Claude. Same model. Different starting position.

---

## Prerequisites — fresh laptop checklist

| Tool | Required? | Install |
|---|---|---|
| <span class="check">Node.js 22+</span> | <span class="check">Required</span> | `winget install OpenJS.NodeJS.LTS` · `brew install node` · apt |
| <span class="check">git</span> | <span class="check">Required</span> | comes with `winget install Git.Git` · `brew install git` |
| <span class="check">Claude Code CLI</span> | <span class="check">Required</span> | `https://docs.anthropic.com/claude-code` |
| <span class="muted">qmd</span> | Recommended | `npm install -g @tobilu/qmd` (speeds up skill lookups) |
| <span class="muted">graphify</span> | Optional | `pip install graphifyy` (codebase graph for architecture Qs) |
| <span class="muted">sqlite3 CLI</span> | Optional | for inspecting `episodic.db` manually |

<br>

> **No ANTHROPIC_API_KEY needed for daily use.** GEPA evolve runs inline in your active session.

---

## Step 0a — Install Claude Code

```bash
# Mac
brew install --cask claude

# Windows
winget install Anthropic.Claude

# Linux — download from
# https://docs.anthropic.com/claude-code/quickstart
```

<br>

### Verify

```bash
claude --version
# Expected: 1.x.y (build 2026-...)

claude  # launch interactively, log in via browser OAuth
```

<br>

> First-time browser OAuth login → stays cached locally. Free / Pro / Max plans all work for daily use.

---

## Step 0b — Install Node + git

<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 20px;">

<div style="background: #232323; padding: 14px; border-radius: 4px;">

#### Windows

```pwsh
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

</div>

<div style="background: #232323; padding: 14px; border-radius: 4px;">

#### macOS

```bash
brew install node git
```

</div>

<div style="background: #232323; padding: 14px; border-radius: 4px;">

#### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y nodejs npm git
```

</div>

</div>

<br>

### Verify

```bash
node --version    # v22.0.0 or higher
git  --version    # git version 2.x
```

---

## Step 1 — Clone the agent-daemon repo

```bash
# Pick any location you like — examples:
# Windows:  D:\Program Files\Agent-Daemon\
# macOS:    ~/code/Agent-Daemon/
# Linux:    ~/projects/Agent-Daemon/

git clone https://github.com/Pankaj-mobiux/Agent-Daemon.git
cd Agent-Daemon
```

<br>

> The repo is where `ad` itself lives, not where your projects live. You'll point it at projects later via `ad init <cwd>`.

> Remember the path — `npm link` (next step) connects the `ad` CLI to this folder.

---

## Step 2 — Register `ad` globally

```bash
cd runtime
npm install                  # installs deps for the runtime
npm link                     # registers `ad` command globally

# Now `ad` works from ANY directory:
ad --version
# agent-daemon v0.2.0
```

<br>

### Windows note

If `npm link` fails with permission errors, run PowerShell as Administrator once, or set up scoop / `corepack` so global npm doesn't need elevation.

<br>

> `ad` is the short alias for `agent-daemon`. Both work — `ad` saves keystrokes.

---

## Step 3 — Verify with `ad doctor`

```bash
ad doctor
```

Expected output:

```
  ✓  agent-daemon CLI                  running from .../Agent-Daemon/runtime/src/cli.mjs
  ✓  claude on PATH                    .../claude.exe
  ✓  Auth                              no API key or OAuth — digest works via agent-emitted blocks
  ✓  better-sqlite3 (episodic memory)  installed
  ✓  episodic DB                       .../episodic.db — 0 rows total
  ✓  Claude Code settings.json         .../.claude/settings.json
  ✓  SessionStart hook → agent-daemon  wired
  ✓  SessionEnd hook → agent-daemon    wired
  ✓  constitution/                     present
  ✓  memory-templates/                 present
  ✓  skills/                           present
  ✓  hooks/                            present

agent-daemon: all checks passed.
```

> Any red ✗? See `docs/troubleshooting.md` — every common failure is documented.

---

## Step 4 — Optional add-ons

```bash
# QMD — fast hybrid keyword + semantic search over markdown skills.
# Cuts skill retrieval cost by ~10x. Auto-detected by `ad init`.
npm install -g @tobilu/qmd

# Graphify — knowledge graph of your codebase for architecture Qs.
# Optional, install only when needed.
pip install graphifyy
```

<br>

### How they're wired in

Both tools are detected by `ad init` automatically. If present:

- `qmd` → registered as MCP server in `~/.claude.json`, project collection created + embedded
- `graphify` → triggered via `/graphify` slash command in any session

<br>

> Neither is required. Daemon works fine without them.

---

## Step 5 — `ad init` in your project

```bash
cd /path/to/your-project              # any project — even non-Node ones

ad init --plan --skills-mode smart    # preview first
ad init                                # apply
```

<br>

### 4 install modes

| Mode | What it installs |
|---|---|
| `smart` <span class="muted">(default)</span> | Detects stack (React, FastAPI, Eleventy, etc.) → only relevant skills |
| `all` | Every skill (229) — heavy but everything available |
| `minimal` | Just the `always` block (bootstrap, orchestrate, skill-author, session-close, handoff) |
| `manual` | Profile-listed skills only (legacy behavior) |

<br>

> Smart mode is the default for a reason. Eleventy site doesn't need `db-migrations`. React Native needs `multiplatform-parity`.

---

## What `ad init` creates

```
your-project/
├── .agent-daemon/
│   ├── memory/                  ← 7 markdown files
│   │   ├── projectbrief.md
│   │   ├── productContext.md
│   │   ├── activeContext.md     ← most updates land here
│   │   ├── systemPatterns.md
│   │   ├── techContext.md
│   │   ├── progress.md
│   │   └── user.md
│   ├── handoffs/                ← per-project handoff trail
│   └── sessions.jsonl           ← per-session audit ledger
├── .claude/skills/              ← project-local skills (if smart mode)
├── AGENTS.md                    ← multi-agent orchestration guide
├── session-logs/                ← gitignored journal
└── CLAUDE.md                    ← managed block appended
```

<br>

### Plus globally
- `~/.claude/skills/<name>/` — copies of relevant skills (Claude Code reads these)
- `~/.claude/settings.json` — 4 hooks added (SessionStart, SessionEnd, etc.)
- `~/.claude/CLAUDE.md` — managed daemon block (idempotent, additive only)
- `~/.claude/commands/` — `/evolve` and `/skill-author` slash commands

---

## Step 6 — Bootstrap memory

In your **first** Claude Code session for the project, type:

```
bootstrap the daemon memory using the bootstrap-daemon skill
```

<br>

What happens:

1. The `bootstrap-daemon` skill auto-triggers
2. Claude scans: `package.json`, `README.md`, `CLAUDE.md`, key folders, recent git log
3. Memory files get **filled with real project context** — not just templates
4. Conventions, stack, architecture decisions all captured

<br>

> **One-time cost: ~$0.05–$0.10 in tokens.** After this, daily sessions are essentially free.

> Subsequent sessions: digest pipeline keeps memory updated automatically. No manual bootstrap again.

---

## Memory files — what each holds

| File | Holds | Updates |
|---|---|---|
| `activeContext.md` | Current focus, recent corrections, gotchas | <span class="key">High-touch</span> — most sessions |
| `techContext.md` | Stack, deps, env vars, build commands | <span class="muted">Occasional</span> — deps change |
| `systemPatterns.md` | Architecture decisions, conventions | <span class="muted">Occasional</span> — when conventions form |
| `progress.md` | Done / in-progress / planned | <span class="muted">Per-session</span> — closing-time updates |
| `projectbrief.md` | What this project is (one-paragraph) | <span class="warn">Rare</span> — bootstrap only |
| `productContext.md` | Who uses it, why it exists | <span class="warn">Rare</span> — bootstrap only |
| `user.md` | Your personal preferences (cross-project) | Per-developer |

<br>

> Files are plain markdown. You can read them, edit them, git-track them.

---

## The session lifecycle

```
Claude Code launches
       ↓
   SessionStart hook fires → ad session-start
       │
       ├─ Load constitution (12 cardinal rules)
       ├─ Load .agent-daemon/memory/*.md (project context)
       └─ Load recent learnings from episodic.db (cross-session)
       ↓
   Claude has full context. You start working.
       │
       ├─ Tools fire silently (edit-post, bash-post)
       ├─ UserPromptSubmit hook captures learnings as you go
       └─ Skills auto-trigger on what you say
       ↓
   You say "bye, aaj ka kaam ho gaya"
       ↓
   session-close skill fires (no API key needed)
       │
       ├─ Update session-logs/<date>_session-N.md
       ├─ Emit <agent-daemon-digest> block
       └─ Write handoff doc (per-project + global)
       ↓
   SessionEnd hook fires → ad digest
       │
       └─ Extract → classify → dedupe → apply to memory + episodic.db
       ↓
   Next session starts smarter.
```

---

## Skills — auto-triggered, English + Hinglish

<div style="text-align: center; margin: 30px 0;">

<span class="stat">229</span>
<span class="stat-label">skills shipped — 43 curated + 186 vendored</span>

</div>

<br>

| You say | Skill that fires | What it does |
|---|---|---|
| *"kuch toot gaya footer mein"* | `debug-triage` | Triage ladder: services → data → cache → request → code |
| *"contact form ka naya feature banao"* | `implement-feature` | Search-existing-utility pass + correctness checklist |
| *"is page ko review karo properly"* | `review-slice` | 9-class bug checklist + severity grouping |
| *"har baar yaad rakhna pnpm use karna"* | `skill-author` | Dedup-first skill creation (≥70% overlap → append) |
| *"evolve skill debug-triage"* | `gepa-evolve-inline` | No-API GEPA — active session reflects + proposes |
| *"bye, aaj ka kaam ho gaya"* | `session-close` | Session-log + digest + handoff + GEPA queue |

> Auto-trigger = substring match on each skill's `description:` frontmatter field. Claude reads it natively.

---

## Session-close — saying "bye" (no API key needed)

<div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; line-height: 1.8; margin: 20px 0;">

You: <span class="key">"bye, aaj ka kaam ho gaya"</span>
&nbsp;&nbsp;&nbsp;&nbsp;↓
<span class="muted">session-close skill auto-triggers — 7 phases:</span>

</div>

1. <span class="check">Read</span> `CLAUDE.md` managed block (grounds protocol)
2. <span class="check">Check</span> idempotency flag (5-min throttle, re-trigger re-emits digest only)
3. <span class="check">Update</span> `session-logs/<N>.md` with End-of-session block
4. <span class="check">Emit</span> `<agent-daemon-digest>` JSON block with structured learnings
5. <span class="check">Write</span> handoff at `.agent-daemon/handoffs/<ts>.md` (also global mirror)
6. <span class="check">Query</span> episodic.db for failing skills → write stubs to `gepa-queue/`
7. <span class="check">Touch</span> idempotency flag

> Everything happens in the active Claude session. **No headless spawn. No API key.**

---

## What gets persisted

```
your-project/
├── session-logs/2026-05-21_session-01.md     ← journal (gitignored)
├── .agent-daemon/
│   ├── sessions.jsonl                         ← per-session audit line
│   ├── handoffs/handoff-2026-05-21T14-32Z.md ← next-session brief
│   ├── memory/activeContext.md                ← learnings appended
│   └── gepa-queue/debug-triage.md             ← if failures > threshold
```

<br>

```
~/                                             ← cross-project, your personal trail
├── .agent-daemon/
│   ├── episodic.db                            ← SQLite FTS5 — searchable lessons
│   ├── user.md                                ← cross-project preferences
│   └── handoffs/<project-slug>/               ← every project's handoffs, indexed
```

<br>

> All local. No cloud sync. No external service.

---

## Self-improving — proof in 7 days

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px;">

<div style="background: #232323; border-left: 4px solid #ff8a65; padding: 16px 20px; border-radius: 6px;">

#### Day 1 <span class="muted">(fresh init)</span>

```
.agent-daemon/memory/activeContext.md
```

<br>

```
# Active Context

{{PLACEHOLDER — bootstrap pending}}
```

<br>

`sessions.jsonl`: empty
`episodic.db`: 0 rows

</div>

<div style="background: #232323; border-left: 4px solid #a0e88a; padding: 16px 20px; border-radius: 6px;">

#### Day 7 <span class="muted">(15 captured learnings)</span>

```
# Active Context

- **correction** (0.85): use pnpm, not npm
  > "actually we use pnpm here"
- **gotcha** (0.7): Eleventy paths in _includes
  > "the bug was relative-path resolution..."
- **convention** (0.7): images org by page-name
- (+ 12 more)
```

`sessions.jsonl`: 12 lines
`episodic.db`: 47 rows

</div>

</div>

<br>

> Run yourself: `git log --since="7 days ago" --oneline -- .agent-daemon/memory/`

---

## `skill-author` — dedup-first skill creation

<br>

You: *"har baar yaad rakhna pnpm use karna in this project"*
&nbsp;&nbsp;&nbsp;&nbsp;↓
**skill-author** auto-fires. 5 phases:

<br>

1. **Classify scope** — generic / language-agnostic → `~/.claude/skills/` (global). Project-specific → `<cwd>/.claude/skills/` (project-local).
2. **Dedup search** — Glob existing SKILL.md files. Compute trigger + body overlap. If <span class="warn">≥70%</span> → **append-mode** instead of new file.
3. **Cross-session log check** — read `skill-author-log.jsonl` for prior near-misses.
4. **Write or append** — extend existing skill OR create new one with standard template.
5. **Log** — JSONL line to both per-project and global logs.

<br>

> Solves the **"I keep creating 5 near-duplicate skills across sessions"** failure mode.

---

## GEPA inline — skills that improve themselves (no API key)

<br>

The normal `ad evolve <skill>` spawns a headless `claude` CLI (needs auth). The **inline path** is auth-free:

<br>

```bash
ad evolve --list-candidates --json
# {"candidates":[{"skill_name":"debug-triage","failure_count":5}]}

ad evolve debug-triage --export-traces
# Wrote .agent-daemon/skill-traces/debug-triage.jsonl (5 failures, 12 successes)
```

Then in any Claude Code session:

> *"evolve skill debug-triage"*

`gepa-evolve-inline` skill fires. **Active Claude session itself does the reflection** — reads traces, groups by outcome, hypothesizes root cause, writes proposal to `.agent-daemon/proposed/`.

```bash
ad review    # interactive accept/reject — accepted proposals update the skill
```

> Zero API cost. Zero auth. The Claude you're already talking to does the work.

---

## Multi-agent orchestration

When one Claude isn't enough. Parallel agents on isolated git worktrees:

```bash
ad tt                                          # list templates
ad tc --template full-stack-feature --task "JWT auth"
# Team: lead + backend + frontend + qa, each with own worktree

ad sp --team <id> --role backend  --task "JWT endpoints"
ad sp --team <id> --role frontend --task "Login UI"

ad ts --team <id>                              # kanban board
ad ti --team <id> --agent lead                 # inbox

# When backend completes, frontend auto-unblocks (dependency graph)
# QA waits for both, then runs

ad team retry --team <id> --task <task-id>     # manual retry on failure
ad td --team <id>                              # cleanup when done
```

<br>

> File-conflict pre-detection warns if two parallel tasks touch the same file. Templates have schema versioning. Failed tasks auto-retry with exponential backoff. Acked inbox messages purge weekly.

---

## TOS safety — Anthropic-ban-safe?

<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px;">

<div style="background: #232323; border-left: 4px solid #ff8a65; padding: 16px 20px; border-radius: 6px;">

#### <span class="warn">❌ What Anthropic banned (Feb–Apr 2026)</span>

- OpenClaw / OpenCode / Crush — **extracting OAuth tokens** from Claude.ai subscription to make API calls outside official CLI
- Spoofing the Claude Code harness
- Subscription auth on VPS / shared server
- Token arbitrage: sub-priced subscription → API workload

</div>

<div style="background: #232323; border-left: 4px solid #a0e88a; padding: 16px 20px; border-radius: 6px;">

#### <span class="check">✓ What agent-daemon does</span>

- Uses Claude Code's **documented hooks** (SessionStart, SessionEnd, etc.)
- Uses native **Skills convention** (`~/.claude/skills/`)
- Shells out to the **official `claude` CLI** for GEPA (or active session)
- Uses **ANTHROPIC_API_KEY** for advanced features (Commercial Terms)
- **No token extraction. No harness spoofing.**

</div>

</div>

<br>

### Per-developer install on own laptop = <span class="check">100% safe</span>

<span class="muted">Verified 2026-05-21. Re-check if Anthropic updates policy.</span>

---

## Troubleshooting — top 6 issues

| Problem | Fix |
|---|---|
| `ad: command not found` | `cd Agent-Daemon/runtime && npm link` (or re-run in PowerShell-as-admin on Windows) |
| `ad doctor` shows ✗ on `claude on PATH` | Install Claude Code, restart terminal, re-run |
| `ad init` doesn't add `~/.claude/CLAUDE.md` block | `~/.claude/CLAUDE.md` might already have an old marker — check `grep agent-daemon: ~/.claude/CLAUDE.md` |
| `sessions.jsonl` stays empty | Did Claude emit the digest block? Say *"emit the agent-daemon digest block"* before ending, or run `ad digest-latest --fallback-to-llm` |
| Hooks not firing on Windows | Check `ad doctor` — Windows path encoding sometimes breaks. See `docs/troubleshooting.md` |
| Memory files keep growing | WS-8 auto-rotates `activeContext.md` weekly when >32KB AND >7d old. Archive lands in `.agent-daemon/archive/` |

<br>

> Full troubleshooting: [`docs/troubleshooting.md`](../docs/troubleshooting.md) — 13 documented failure modes with fixes.

---

<!-- _class: cta -->

# Try it today

```
git clone https://github.com/Pankaj-mobiux/Agent-Daemon.git
cd Agent-Daemon/runtime
npm install && npm link
ad doctor
```

<br>

<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; text-align: left; margin: 30px 60px;">

<div>

#### Get started
- Repo: `github.com/Pankaj-mobiux/Agent-Daemon`
- Quickstart: `README.md`
- Verification: `docs/manual-test-v0.2.0.md`

</div>

<div>

#### Docs
- `CHANGELOG.md` — Phase 5 section
- `docs/workflow.md`
- `docs/architecture.md`
- `docs/troubleshooting.md`

</div>

<div>

#### Channels
- Slack: `#agent-daemon`
- Weekly dogfood sync
- GitHub issues for bugs

</div>

</div>

<br>

## <span class="key">Questions?</span>
