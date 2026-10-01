# Backlog — ideas not yet planned

Ideas and research leads that haven't become a plan yet. When one is picked up, it moves to its own `docs/plans/<name>.md`.

## 1. Put the daemon's instructions into Claude Code's own per-project memory

**Today:** `ad init` writes a managed block into each project's `CLAUDE.md` (plus `AD-INSTRUCTIONS.md`). That works, but it's a bandage. It edits a file the user owns and commits.

**Idea:** Claude Code already keeps a folder per project under `~/.claude/projects/<project-slug>/`, including a file-based auto memory (`memory/MEMORY.md` + one file per memory). Integrate the daemon's operating instructions and key learnings there, so they load without touching the repo's `CLAUDE.md`.

**Open questions:**
- Load order and size limits of Claude Code's auto memory vs `CLAUDE.md`. Does it load every session, and how much of it?
- Ownership: Claude Code writes to that folder too, so we'd need markers or our own files to avoid clobbering.
- Slug format (path with separators replaced) must match Claude Code's exactly; reuse the digest pipeline's transcript-path logic.
- Keep the `CLAUDE.md` block as a fallback for other harnesses (Cursor, Codex AGENTS.md)?

## 2. Research leads (agent loops / continuous workflow)

Review each for ideas worth borrowing into `ad loop`, `ad schedule` or the skill set:

- [coze-dev/coze-loop](https://github.com/coze-dev/coze-loop)
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
- [frankbria/ralph-claude-code](https://github.com/frankbria/ralph-claude-code): `ad loop`'s brakes (dual exit, circuit breaker) follow this Ralph-style pattern.
- [rohitg00/pro-workflow](https://github.com/rohitg00/pro-workflow)
