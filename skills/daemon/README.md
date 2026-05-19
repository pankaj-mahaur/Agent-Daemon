# daemon/

Skills that operate on the daemon itself — bootstrap, orchestrate a team across the daemon's primitives, scaffold project context.

These are **destructive or high-impact** — the bootstrap skill writes files, scaffolds memory, modifies `CLAUDE.md`. They carry `disable-model-invocation: true` where appropriate so they require explicit invocation rather than auto-routing.

| Skill | What it does |
|---|---|
| [bootstrap-daemon](bootstrap-daemon/) | Fully scaffold and populate agent-daemon memory with real project context. Manual-only — `disable-model-invocation: true`. |
| [orchestrate-team](orchestrate-team/) | Deploy 2+ specialist agents in parallel for cross-cutting work. Use when a task spans 2+ domains and >30 min of work. |
