---
name: dead-code-review
description: Review and safely remove unused or disconnected code. Use for dead code cleanup, unused files, stale shims, unused CSS, unused dependencies, unconnected routes, orphan views/URLs, stale documentation, or runtime artifacts checked into repos.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Dead Code Review

Use this for proof-based cleanup. Deletion requires evidence and verification — never delete on suspicion alone.

## Workflow

1. **Read existing docs** — check for refactor summaries, migration notes, or past cleanup records.
2. **Inventory candidates by area:**
   - Routes and pages (frontend routes with no links, backend URLs with no callers)
   - Components and views (imported nowhere, rendered nowhere)
   - Hooks and utilities (exported but never imported elsewhere)
   - API helpers (fetch functions with zero call sites)
   - CSS classes and stylesheets (selectors matching no markup)
   - Backend views, URLs, serializers (unreachable endpoints)
   - Dependencies (packages in lockfile but not imported in code)
   - Documentation (docs describing removed features)
   - Runtime artifacts (build outputs, logs, temp files in source control)
3. **Prove unused status** with reference searches and framework knowledge:
   - `grep`/`rg` for imports, function calls, class references
   - Check dynamic imports, lazy loading, and string-based references
   - Check framework conventions (auto-discovery of routes, middleware, plugins)
   - Check configuration files that may reference code by string
4. **Separate safe deletes from risky ones:**
   - Safe: zero references, no dynamic access pattern, not a public API
   - Risky: compatibility shims, public API endpoints, framework convention files
5. **Propose deletion batches** grouped by root cause (e.g., "removed feature X" = 5 files).
6. **Verify after each batch** — type-check, lint, build, test suite.
7. **Record** what was removed and why.

## Never Delete Casually

These require extra proof before removal:

- **Migrations** — database migration files must never be deleted, even if the feature is gone
- **Public API endpoints** — external consumers may depend on them
- **Redirect or compatibility routes** — may be serving bookmarks or external links
- **Scheduled task names** — job schedulers reference tasks by string name
- **CSS selectors for third-party libraries** — charting libraries, rich text editors, and generated markup use class names your code doesn't explicitly reference
- **Configuration/convention files** — frameworks auto-discover files by name (e.g., `middleware.ts`, `layout.tsx`, `__init__.py`)
- **Documentation with project decisions** — may look stale but preserves architectural context

## Output

For each candidate:

| Field | Description |
|-------|-------------|
| **File(s)** | Clickable file:LINE references |
| **Evidence** | How you proved it's unused (grep output, zero imports, etc.) |
| **Risk** | None / Low / Medium (explain if medium) |
| **Deletion plan** | What to delete and in what order |
| **Verification** | Command to run after deletion (type-check, build, test) |
| **Rollback** | `git checkout <commit> -- <files>` if needed |
