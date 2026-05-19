# No adapters for Kiro / Trae / CodeBuddy / OpenCode / Gemini

## What was proposed

ECC ships adapter scaffolds for five additional harnesses: Kiro, Trae, CodeBuddy, OpenCode, and Gemini CLI. The proposal: port each one into our `adapters/` directory so daemon users on any of these CLIs get the same memory + skills experience as Claude Code users.

## Why we said no

1. **Real user base is unclear.** ECC supports them defensively — to be a credible cross-harness tool — but we have zero signal that anyone running the daemon uses any of these as their daily driver. Building for hypothetical users is the path to a 10-adapter graveyard.

2. **Maintenance cost is per-harness.** Each adapter means tracking its hook spec, its config file location, its memory-injection convention, and handling its specific permission model. Even an "empty" adapter (no runtime hooks, just config templates) needs CI smoke tests so changes don't silently break it.

3. **Vendored snapshot is enough for the future option.** Stage 1 vendored the full ECC repo (pinned at `841beea4...`). All five adapter dirs (`.kiro/`, `.trae/`, `.codebuddy/`, `.opencode/`, `.gemini/`) are still in `vendored/everything-claude-code/`. If we ever need to port, the reference implementation is one `cp` away.

4. **Stage 5 of the ECC plan was explicit: "Skip new harnesses for this iteration."** The deferral was deliberate at import time; this entry just makes it canonical.

5. **The cross-harness story we *can* tell today is good enough.** Claude Code (primary), Cursor (via `.cursor/rules/` mirror), Codex (config-only adapter), Cline (existing adapter). Four surfaces is the right number for a v0.x daemon. Doubling it without users behind the demand is overreach.

## What would change our mind

For any single harness in this list:

- It crosses ~10k MAU (publicly verifiable) AND a user files a real adapter request with a use case.
- OR one of our existing daemon users moves to it full-time and reports the daemon is unusable without an adapter.
- OR a community contributor ships a working adapter as a PR — at which point we evaluate the maintenance handoff.

## Date

2026-04-30 (Phase 2 import-plan close-out) — re-confirmed 2026-05-19 (Phase 4 Group C)
