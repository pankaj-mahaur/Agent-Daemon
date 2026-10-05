<!-- agent-daemon:start -->
## agent-daemon

This project uses [agent-daemon](https://github.com/pankaj-mahaur/Agent-Daemon) — a self-improving runtime for AI coding agents with multi-agent orchestration. **This section is managed by `ad init` — re-running refreshes it.**

- **Memory:** `.agent-daemon/memory/` — project context and learnings captured continuously by local hooks; session-close digests add richer summaries
- **Multi-agent:** `ad tc` to create teams, `ad sp` to spawn workers in isolated git worktrees, `ad ts` for status
- **CLI:** All commands use the `ad` shorthand (`ad doctor`, `ad init`, `ad tt`, `ad memory`, `ad review`)
- **Skills:** Auto-triggering skills in `~/.claude/skills/` — code review, debugging, orchestration, etc.
- **Self-improvement:** deterministic local capture and optional session-close digests write SQLite memory; skill outcomes remain review-gated

### 📖 Full operating manual → `AD-INSTRUCTIONS.md`

The complete agent-daemon manual — **task-complexity gate, skill decision tree, daemon workflow, mid-session memory discipline, and the mandatory session-close protocol** — lives in [`AD-INSTRUCTIONS.md`](AD-INSTRUCTIONS.md) at the repo root (kept out of CLAUDE.md to save per-session context).

**Read `AD-INSTRUCTIONS.md` before any substantial or specialized task** — audit, implement, debug, review, migration, security, multi-agent orchestration, or session-close. It encodes which skill to invoke and the ordering/dedup/severity logic that one-shot prompting misses.

Proportionality rule (always on): trivial requests (`hey`, a quick question, a one-line edit) — act normally, do NOT search for skills. Anything substantial — **read `AD-INSTRUCTIONS.md` first**, then pick the narrowest matching skill before freelancing. Routing advice is also injected automatically by the `capability-route-advice` hook (see `ad route show`).

**Session close** ("bye", "session khatam", "done for today", "wrapping up") is a mandatory 3-step protocol — see the Session-close section of `AD-INSTRUCTIONS.md`.
<!-- agent-daemon:end -->
