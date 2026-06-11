---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Use when the user wants to "hand off this work", "save context for the next agent", "create a handoff", "I'm leaving — summarize for the next session", or invokes /handoff. Also auto-fires as part of the session-close protocol (alongside session-log update + digest block). Writes to BOTH per-project AND global locations so future sessions in any project can find prior work.
argument-hint: "What will the next session be used for?"
source: vendored from mattpocock/skills (MIT), adapted for agent-daemon with dual-write (project + global)
---

# Handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the work. **Writes TWO files** — one per-project, one global — so the next session finds the context regardless of where it's opened.

## Where to write — dual-write

### 1. Per-project handoff (committable, lives with the code)

`<cwd>/.agent-daemon/handoffs/handoff-<ISO-timestamp>.md`

- Sits in git alongside the code
- The next dev opening this project sees it
- Indexed by `ad status` and surfaced in future SessionStart context

### 2. Global handoff (your personal trail across all projects)

`~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-timestamp>.md`

- Lives in your home `.agent-daemon/` — outside any single repo
- Project-slug subfolder = lowercased path slug (e.g. `d--projects-my-app`)
- Lets you grep "what was I doing last week" across every project at once
- `ad init` creates this directory tree if missing

**Both files have identical content.** Same template, same data — just two destinations.

## Filename format

Use UTC ISO timestamp, colons replaced with hyphens (Windows-safe):

```
handoff-2026-05-15T14-32-08Z.md
```

## What to write

Required sections, in this order:

1. **Context** — 2–3 sentences. What was this session about? What was the user trying to achieve?
2. **State** — what's done, what's in progress, what's blocked. Reference paths, branches, commit hashes, PR numbers. **Don't restate them** — just point.
3. **Next action** — single most important thing the next agent should do first. Be specific. *"Run npm test in runtime/, see if `digest-lenient.test.mjs:14` regressed after the YAML parser change."*
4. **Open questions / unresolved decisions** — things that needed user input and didn't get it.
5. **Suggested skills** — list 1–3 skill names the next session should reach for. Match to the next-action.
6. **Files touched this session** — bullet list of paths, no diffs

## What NOT to write

- ❌ Duplicate content already captured elsewhere (PRDs, plans, ADRs, issues, commits, diffs, `.agent-daemon/memory/activeContext.md`) — **reference them by path or URL**
- ❌ Every tool call or step taken — the transcript has those, noise here
- ❌ A status report. Write a **next-session brief**.
- ❌ Diffs or full file contents — paths only

## Template

```markdown
# Handoff — <session-summary-in-7-words>

**Project:** <project-name>
**Time:** <ISO-timestamp>
**Branch / commit:** <branch-name> @ <short-sha>

## Context

<2–3 sentences>

## State

- ✅ Done: ...
- 🟡 In progress: ...
- 🔴 Blocked on: ...

## Next action

<one specific, executable instruction>

## Open questions

- ...

## Suggested skills

- `<skill-name>` — <why>

## Files touched

- `path/to/file.mjs`
- ...

## Related

- Plan: `<path or URL>`
- Commits: `<hashes>`
- Memory: `.agent-daemon/memory/activeContext.md` (latest section)
```

## Argument handling

If the user passed arguments after `/handoff`, treat them as a description of what the next session will focus on, and tailor the doc accordingly. Example:

```
/handoff "fix the failing CI on the merge branch"
```

→ the doc emphasizes the CI failure, the branch state, links the relevant logs.

## Pair with agent-daemon

After writing both handoff docs, append a one-line note to `.agent-daemon/memory/activeContext.md` pointing to the per-project handoff path. Future SessionStart will surface it.

## Auto-trigger via session-close

The agent-daemon CLAUDE.md managed section instructs Claude to **automatically** invoke this skill when the user signals end-of-session (`"close session"`, `"end session"`, `"session khatam"`, `"wrapping up"`, etc.) — alongside the session log update + digest block emission. You don't need to ask for /handoff explicitly; it fires as part of the three-action close protocol.
