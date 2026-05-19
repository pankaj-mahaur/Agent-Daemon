# No first-class AGENTS.md adapter (yet)

## What was proposed

Generate and maintain a top-level `AGENTS.md` from the daemon's memory + constitution + skills index, on every `ad init`, so any IDE / CLI that reads AGENTS.md (Cursor, OpenAI Codex, future harnesses) automatically inherits the daemon's context. Treat AGENTS.md as a first-class output the same way `~/.claude/CLAUDE.md` is.

## Why we said no

1. **AGENTS.md spec is still settling.** Different consumers expect different conventions — Cursor reads it as documentation, Codex treats it as instructions, some treat it as memory. Building an adapter today means picking one interpretation and re-doing it when the consensus shifts.

2. **CLAUDE.md is already the source of truth.** Our `ad init` injects a managed section into the project's `CLAUDE.md` (and the user's `~/.claude/CLAUDE.md`). That file works in Claude Code today, and Claude Code is our primary surface. Duplicating into AGENTS.md before the spec stabilises just creates a sync problem.

3. **Cursor users have the `.cursor/rules/` adapter.** Phase 4 Group C ships a constitution-mirror script that writes our `constitution/*.md` to `.cursor/rules/*.mdc` with proper frontmatter. That covers the Cursor side cleanly — without AGENTS.md.

4. **No user has asked.** The daemon's audit ledger shows zero sessions where the agent needed AGENTS.md and couldn't find it. Build for measured demand, not for the marketing page.

5. **Adapter generators are easy to retro-fit.** If/when AGENTS.md becomes load-bearing, our content is already in `constitution/` and `skills/` — generating AGENTS.md from those sources is a one-script project, not a redesign.

## What would change our mind

- OpenAI Codex / Cursor / a third major harness **mandates** AGENTS.md (not "supports" — mandates, with degraded behavior in its absence).
- We have **5+ users** running the daemon and concretely identify a case where the agent was missing context that AGENTS.md would have provided.
- The AGENTS.md spec stabilises with a documented format (frontmatter, sections, file references) such that the generator output isn't a coin-flip on whether downstream readers like it.

## Date

2026-04-30 (initial deferral) — re-confirmed 2026-05-19 (Phase 4 Group C)
