# Recall dev set (L6 tuning only)

The ranking of the session brief and prompt-time recall (plan L6) is tuned on this set. The gates are measured on the held-out corpora in `../../corpora/brief-relevance` and `../../corpora/prompt-recall`, which tuning never reads item by item.

- **Written 8 Nov 2026** by a clean-room agent (Claude Opus 5.5) from a short brief: the held-out schema and the kinds of traps, other stacks (Django + Celery, Kotlin Android, Elixir Phoenix, Rails, C++/CMake, SvelteKit; Spring Boot batch, Flutter, Laravel). It read no repo code and no held-out file.
- **`brief/<project>/`:** `context.json` (`name`, `stack`, `branch`, `recent_paths`, `recent_commits`, `session_cwd`), `notes.jsonl` (24 notes: `id`, `text`, `created`, `kind`), `expected.json` (`relevant`, `irrelevant`, `neutral`, `reasons`). Each project has exactly 3 stale notes, each older than the note that replaces it. Reference date 2026-11-01.
- **`prompt/`:** `notes.jsonl` (72 notes, 3 projects) and `prompts.jsonl` (60 prompts: `relevant`, `acceptable`, `note`); 15 prompts should recall nothing.
- Everything is invented. It is not frozen: a fix to a label is fine, with a line in the plan's L6 design log.
