<!-- agent-daemon:start -->
# Agent Daemon — Operating Manual

> This file is the full agent-daemon operating manual for AI coding agents working in this repo. It is **read on demand** — `CLAUDE.md` carries only a synopsis and points here. Read this before any substantial or specialized task.

This project uses [agent-daemon](https://github.com/pankaj-mahaur/Agent-Daemon) for self-improving memory + multi-agent orchestration. **This file is managed by `ad init` — re-running refreshes everything between the markers.** Anything you add outside the markers is preserved.

## Task-complexity gate (size the request before acting)

Before doing anything, classify the request into one of three tiers:

| Tier | Signals | What to do |
|---|---|---|
| **Simple / direct** | Greeting, factual question, tiny read, one-line explanation, obviously trivial edit | Act normally. Do NOT search for skills, plugins, or MCPs unless the user asks. |
| **Substantial / specialized** | Audit, review, debug, implement, architecture, migration, security, research, session-close, recurring workflow, or any task expected to use multiple tools | Pause briefly — check which installed skill, MCP, or native agent matches. Use the narrowest capability before freelancing. |
| **High-risk / parallel** | Security finding, destructive operation, broad codebase audit, cross-domain work, or explicitly delegated parallel work | Select the appropriate skill or guard first; use native agents only when useful or explicitly requested. |

Proportionality rule: `hey` → no capability search. `audit this project` → check for a matching skill first. The user can override routing with `do not use skills`, `use only Read/Grep`, or `deploy two agents`.

## Skill decision tree (BEFORE writing code)

When the user's request matches any row below, **invoke the skill first**, then act. Do not freestyle when a matching skill exists — skills encode dedup, ordering, and severity logic that one-shot prompting misses.

| User says (English / Hinglish) | Invoke skill | Why |
|---|---|---|
| "bug", "broken", "error", "toot gaya", "kaam nahi kar raha", "crash" | `debug-triage` | Strict triage order: services → data → cache → request → code. Avoids guessing. |
| "implement", "build", "add feature", "banao", "wire up" | `implement-feature` | Searches existing utilities before writing new code; matches project patterns. |
| "review", "audit", "check karo properly", "deeply dekho" | `review-slice` | 9-class bug checklist, findings grouped by root cause + severity. |
| "create a skill", "is se skill banao", "har baar yaad rakhna", "remember this pattern" | `skill-author` | **Mandatory** — dedup-check existing skills (≥70% overlap → extend, don't create). Never write `SKILL.md` directly. |
| "evolve <skill>", "improve this skill" | `evolve` | In-session GEPA reflection — no API key needed. |
| "bye", "session khatam", "done for today", "wrapping up" | `session-close` | Session log + richer digest block + handoff. Continuous extraction still runs if a close is missed. |
| "hand off this work", "save context for next agent" | `handoff` | Dual-writes to per-project + global locations. |
| "install this skill", "add skill X", "skill install karo", git URL of a skill repo | `skill-installer` | Installs via `ad skill install` — lint-gated, provenance recorded, right lane selected. Never hand-copy skill folders. |
| Pasted Anthropic Design URL (`api.anthropic.com/v1/design/h/...`) | `anthropic-design-bundle` | Only reliable gzipped-tar extraction pipeline. |
| "tests fail", "verify this works", "run the app" | `verify` / `run` | Drives the actual app instead of pattern-matching tests. |

**Rule of thumb:** if Claude's first instinct is `Write` or `Edit`, pause and check if a skill matches. The skill almost always knows something Claude doesn't.

Routing advice is also generated automatically: the `capability-route-advice` hook matches each prompt against trigger phrases compiled from EVERY installed skill (see `ad route show`), not just the rows above.

## Daemon workflow (what fires automatically)

```
SessionStart hook  →  `ad session-start` injects prioritized context:
                      - .agent-daemon/memory/activeContext.md (recent decisions)
                      - Recent SQLite learnings and compact operating guidance

UserPromptSubmit   →  `ad hook user-prompt-extract` stores deterministic corrections
                      + `ad query-retrieve` recalls prompt-relevant SQLite learnings

PreToolUse/Expand  →  `ad hook skill-use` records local Claude skill invocations

PostToolUse        →  `ad hook bash-post` / `edit-post` report relevant tool issues

SessionEnd hook    →  `ad hook session-end-digest` parses your `<agent-daemon-digest>` block
                      → SQLite learnings table + appends to memory/*.md
```

**Capture model:** local prompt hooks preserve explicit corrections without an API key. Emitting a `<agent-daemon-digest>` block at session-close improves durable project context and handoff quality; it is not the only capture path.

## Recalling memory mid-session + privacy

You don't have to wait for SessionStart injection — query past project memory mid-task via the `agent-daemon-memory` MCP server (`ad init` registers it). It uses a token-cheap **progressive-disclosure** flow:

1. **Index (cheap):** `memory_search(query)`, `memory_recent`, or `memory_files(path)` → compact `[id …]` lines.
2. **Context:** `memory_timeline(id)` → the originating session + the sibling learnings around a hit.
3. **Detail:** `memory_get(ids)` → full text + evidence + provenance for the few ids you keep.

- **Know the user:** `memory_profile()` returns a deterministic "how this user works" rollup (identity / prefers / tools / conventions / watch-out). Read it before substantial work to align with established preferences and conventions.
- **File-aware recall:** each learning is tagged with the files in play that session, so `memory_files("auth.ts")` surfaces "what we learned about auth.ts". SessionStart also auto-boosts learnings tied to files you're currently editing (derived from `git diff`/`status`).
- **Privacy — `<private>…</private>`:** wrap any content in this tag and it is stripped before any extractor sees it — it never becomes a stored learning. Use it for secrets, tokens, or anything that must stay out of memory.
- **Inspect everything:** `ad viewer --open` renders a single zero-dependency HTML snapshot of sessions, learnings, proposals, routing stats, and retrieval telemetry.

## Mid-session memory discipline

After ANY significant decision (architecture choice, gotcha discovered, convention agreed, dependency pinned), append one line to `.agent-daemon/memory/activeContext.md` immediately — don't wait for session-close. Sessions can terminate abruptly (crash, context-limit, network) and unwritten learnings are lost.

Format: `- YYYY-MM-DD: <one-line decision or gotcha>`

## Bootstrap (run once after `ad init`)

Tell Claude: **"bootstrap the daemon memory using the bootstrap-daemon skill"**.

Claude will scan `package.json`, key folders, recent commits, and populate `.agent-daemon/memory/*.md` with real project context (stack, conventions, gotchas). Future sessions then start with rich context loaded automatically.

Memory files with `{{PLACEHOLDER}}` text haven't been bootstrapped yet. The digest pipeline keeps memory updated automatically after bootstrapping.

## Session logs (`session-logs/`)

Local-only (gitignored). Tracks Claude Code session activity, timeline, decisions, and token usage.

- One file per session: `YYYY-MM-DD_session-NN.md`
- See `session-logs/README.md` for format
- **Update triggers:**
  - User says "log tokens" + pastes `/cost` output → append timestamped entry
  - User says "close session" → fill End-of-session block with summary
  - User says "new session" → create next file, link previous one
- Claude cannot read token counts directly — only record what user provides

## Session-close workflow (mandatory)

When the user signals end of session ("end session", "close session", "session khatam", "ending this session", "wrapping up", "I'm done", "bye" — English or Hinglish), do ALL THREE in the same response, no confirmation needed:

1. **Update the session log** — fill the "End of session" block with closing timestamp, outcome, net deliverables, what works, what's pending, what next session must start with. Rename duplicate headings to satisfy MD024.
2. **Emit the agent-daemon digest block** — wrapped in `<agent-daemon-digest>...</agent-daemon-digest>` with valid JSON inside (per `constitution/ending-protocol.md`). Include learnings tagged with `projectbrief`, `techContext`, `systemPatterns`, `activeContext`, `progress`, `user`, plus durable `lessons`, `files` touched, and a `daemon_verification` field showing which hooks fired.
3. **Create handoff docs** — invoke the `handoff` skill. Write the SAME content to BOTH locations:
   - **Per-project:** `<cwd>/.agent-daemon/handoffs/handoff-<ISO-timestamp>.md` (committable, lives with the code)
   - **Global:** `~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-timestamp>.md` (your personal cross-project trail — `<project-slug>` is the cwd path with `/`, `\`, `:`, and spaces replaced by `-`, lowercased)

   Filename: `handoff-<ISO-timestamp>.md` with colons replaced by hyphens (Windows-safe). Content per the `handoff` skill template — Context / State / Next action / Open questions / Suggested skills / Files touched. References to existing artifacts, not duplicates.

Short / prep-only sessions still emit all three — they produce signal too.

## Multi-agent orchestration

### Quick reference

| Command | Alias | What it does |
|---------|-------|-------------|
| `ad doctor` | | Verify install — hooks, PATH, settings |
| `ad init` | | Scaffold .agent-daemon/ in this project |
| `ad team list-templates` | `ad tt` | Show available team templates |
| `ad team create --template <name> --task "..."` | `ad tc` | Create a team with roles + task graph |
| `ad team status --team <id>` | `ad ts` | Kanban board — tasks, agents, progress |
| `ad team inbox --team <id> --agent <name>` | `ad ti` | Read completion messages |
| `ad spawn --team <id> --role <role> --task "..." --cwd .` | `ad sp` | Launch agent in isolated worktree |
| `ad team delete --team <id>` | `ad td` | Remove a team |
| `ad team cleanup` | `ad tu` | Prune stale worktrees |

### Team templates

- **solo-with-qa** — 1 dev + 1 QA (simplest, good for most tasks)
- **full-stack-feature** — lead + backend + frontend + QA (parallel work)
- **bug-triage-team** — lead + investigator + fixer + reviewer
- **code-review-team** — lead + security + performance reviewers

### When to use multi-agent

Use multi-agent when ALL of these are true:
- Task spans 2+ domains (backend + frontend, code + tests, etc.)
- Subtasks can run in parallel
- Estimated work exceeds ~30 minutes

Stay single-agent for: quick fixes, single-file changes, questions, reviews of small scope.

### Multi-agent workflow

1. **Analyze** — Break the task into subtasks with dependencies
2. **Ask the user** — Present the team plan (template, roles, task graph) and wait for approval
3. **Create** — `ad tc --template <name> --task "..."`
4. **Spawn** — `ad sp --team <id> --role <role> --task "..." --cwd .` for each worker
5. **Monitor** — `ad ts --team <id>` to check progress, `ad ti` for inbox
6. **Merge** — Review agent branches, merge in dependency order, test
7. **Cleanup** — `ad td --team <id>` when done

### Multi-agent rules

- **Always ask before spawning** — Never create teams or spawn agents without showing the plan and getting user approval first.
- **Leader = your session** — You (Claude) are the team lead. Workers run in background worktrees.
- **Isolation** — Each agent works on its own git branch. Changes don't touch the user's working branch until explicitly merged.
- **Review before merge** — Always let the user review agent output before merging branches.
<!-- agent-daemon:end -->
