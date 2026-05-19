---
name: grill-with-docs
description: Grilling session that challenges your plan against project conventions (constitution + activeContext.md) and updates documentation inline as decisions crystallise. Use when user wants to stress-test a plan against their project's documented decisions, conventions, or memory.
source: vendored from mattpocock/skills (MIT), adapted to agent-daemon's constitution + memory layout
---

# Grill With Docs

Interview the user relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask questions one at a time, waiting for feedback on each before continuing.

If a question can be answered by exploring the codebase or the daemon's memory, do that instead — don't waste a question.

## Awareness during the session

Read these before the first question, and keep them in mind throughout:

- `constitution/core.md` and `constitution/karpathy-guidelines.md` — universal rules
- `.agent-daemon/memory/activeContext.md` — recent decisions, in-flight work, known gotchas
- `.agent-daemon/memory/techContext.md` — stack, conventions, dependencies
- `.agent-daemon/memory/systemPatterns.md` — design patterns this project uses
- `CLAUDE.md` / `AGENTS.md` — project-specific overrides

## During the session

### Challenge against the docs

When the user proposes something that conflicts with documented conventions, call it out immediately:

> "Your `activeContext.md` says we always rebase before pushing, but you're describing a merge workflow — which is it?"

> "The constitution says 'never commit without explicit user OK' — your plan has the agent auto-committing. Override that intentionally?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term:

> "You're saying 'process' — do you mean the digest pipeline or the watch daemon? Those are different things."

### Discuss concrete scenarios

Stress-test relationships with specific scenarios. Invent edge cases that force precision about boundaries.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it:

> "Your plan says the hook fires before every user turn, but the code in `runtime/src/hooks/user-prompt-extract.mjs` only fires when transcript_path is set — which is right?"

### Update memory inline

When a decision crystallises, append it to `.agent-daemon/memory/activeContext.md` right there — don't batch. Format:

```markdown
### YYYY-MM-DD — <one-line decision>

- **Context:** <why it came up>
- **Decision:** <what we chose>
- **Tradeoffs accepted:** <what we gave up>
- **Open questions:** <what's unresolved>
```

### Offer proposals sparingly

Only suggest a proposal to `.agent-daemon/proposals/` (high-risk learnings queued for review via `ad status`) when **all three** are true:

1. **Hard to reverse** — cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **Result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the proposal — a memory append is enough.

## How this differs from `grill-me`

`grill-me` is pure conversation. `grill-with-docs` is conversation **plus** continuous reference to documented project memory + continuous updates back to that memory. Use `grill-me` for new/exploratory work; use `grill-with-docs` when the project has accumulated history.
