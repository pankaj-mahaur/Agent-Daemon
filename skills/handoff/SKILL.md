---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Use when the user wants to "hand off this work", "save context for the next agent", "create a handoff", "I'm leaving — summarize for the next session", or invokes /handoff. Solves the /compact problem with a durable on-disk artifact.
argument-hint: "What will the next session be used for?"
source: vendored from mattpocock/skills (MIT), adapted for agent-daemon
---

# Handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

## Where to write

Save it to `<cwd>/.agent-daemon/handoffs/handoff-<ISO-timestamp>.md`. Create the `handoffs/` directory if it doesn't exist (`ad init` scaffolds it on fresh installs).

Filename example: `handoffs/handoff-2026-05-15T14-32-08Z.md`.

## What to write

Required sections:

1. **Context** — 2–3 sentences. What was this session about? What was the user trying to achieve?
2. **State** — what's done, what's in progress, what's blocked. Reference paths, branches, commit hashes, PR numbers — don't restate them.
3. **Next action** — single most important thing the next agent should do first. Be specific.
4. **Open questions / unresolved decisions** — things that needed user input and didn't get it.
5. **Suggested skills** — list 1–3 skills the next session should reach for. Match to the next-action.

## What NOT to write

- Don't duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs, `.agent-daemon/memory/activeContext.md`). **Reference them by path or URL instead.**
- Don't list every tool call or step taken — that's noise. The next agent has the transcript if they need it.
- Don't write a status report. Write a *next-session brief*.

## Argument handling

If the user passed arguments after `/handoff`, treat them as a description of what the next session will focus on, and tailor the doc accordingly. Example:

```
/handoff "fix the failing CI on the merge branch"
```

→ the doc emphasizes the CI failure, the branch state, and links to the relevant logs.

## Pair with agent-daemon

After writing the handoff doc, append a one-line note to `.agent-daemon/memory/activeContext.md` pointing to the handoff path. Future SessionStart will surface it.
