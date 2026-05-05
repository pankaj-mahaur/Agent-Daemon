---
name: docs-sync-audit
description: Audit and update project documentation to match current code. Use for docs audit, documentation drift, README updates, API docs sync, configuration docs, keeping project docs aligned with current code, or stale documentation cleanup.
---

# Docs Sync Audit

Use this when project documentation may be stale or inconsistent with the actual codebase.

## Workflow

1. **Inventory documentation sources:**
   - Root README and project docs
   - Per-package or per-service READMEs
   - API documentation (OpenAPI, Swagger, manual docs)
   - Architecture decision records (ADRs)
   - Deployment and operations guides
   - Inline code documentation (CLAUDE.md, AGENTS.md, CONTRIBUTING.md)
   - Audit notes, review records, changelog
2. **Compare docs against current code/config:**
   - Do documented commands still work?
   - Do documented environment variables match what the code reads?
   - Do documented API endpoints match actual routes/views?
   - Do documented architecture descriptions match the actual file structure?
   - Do documented dependencies match what's in package files?
3. **Check common drift categories** (see below).
4. **Update docs** where behavior, commands, routes, environment, or status has changed.
5. **Keep meta-docs concise** — link to detailed docs instead of duplicating content.

## Common Drift Categories

These are the most frequent sources of documentation drift:

- **README reverting to boilerplate** — framework-generated READMEs overwrite project-specific content after upgrades or re-initialization
- **API endpoint docs disagreeing with code** — routes added/removed/renamed but docs not updated
- **Environment variable docs missing new vars** — new config added to code but not documented
- **Command examples that don't work** — package scripts renamed, Docker commands changed, CLI flags deprecated
- **Architecture docs describing removed components** — features deleted but docs still reference them
- **Deployment docs with wrong steps** — infrastructure changed but deploy guide not updated
- **Stale audit/review status** — work marked "pending" that was already completed
- **Version numbers and dependency lists** — outdated version references

## Sync Policy

- **Single source of truth.** Each fact should live in one place. Other docs link to it.
- **Update with changes.** When you change code that has corresponding docs, update the docs in the same commit or immediately after.
- **Don't duplicate.** If a deployment guide exists in `docs/deploy.md`, the README should link to it, not reproduce it.
- **Date your snapshots.** If a doc captures a point-in-time state (e.g., "current architecture"), include the date so readers know when it was last verified.

## Output

For each stale item:

| Field | Description |
|-------|-------------|
| **Doc file** | Path to the stale document |
| **Stale content** | What's wrong (quote or summarize) |
| **Source of truth** | Where the correct information lives (code file, config, etc.) |
| **Update** | What was changed or needs to be changed |
| **Verification** | How to confirm the doc is now accurate |
