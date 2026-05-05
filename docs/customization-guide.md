# Customization Guide

How to adapt toolkit skills for your specific project.

## Forking a Skill

1. Copy the skill to your project's `.agents/skills/` directory
2. Edit the SKILL.md to add project-specific context
3. The project-local version takes precedence over the global one

```bash
# Copy review-slice for customization
cp -r ~/.claude/skills/review-slice .agents/skills/review-slice
```

## Customizing review-slice

The review-slice skill has four placeholder sections designed for customization:

### 1. Stack Quick Reference

Fill in your project's tech stack:

```markdown
## Stack quick reference

- Frontend: Next.js 15 App Router, TypeScript, Tailwind v4, Shadcn/ui
- Backend: Django 6 + DRF, PostgreSQL 16, Redis 7, Celery 5
- Auth: Google OAuth → JWT → httpOnly cookies via proxy
- Date format: YYYY-MM-DD on wire, DD MMM YYYY for display
```

### 2. Recurring Gotchas

After each review, document patterns that bit you:

```markdown
## Recurring gotchas

- Proxy allowlist must match routes both with and without trailing slash
- Wildcard CSS selectors (`.container *`) override inline styles on children
- Redis `delete_pattern('*')` is blocked in sandbox — always scope to a prefix
- Decimal field validators need `Decimal("0.1")` not float `0.1`
```

### 3. Shared Utilities

List extracted utilities that reviewers should reuse:

```markdown
## Shared utilities

- `formatDate(date)` — `@/lib/date`
- `useDebounce(value, ms)` — `@/hooks/useDebounce`
- `hasAdminAccess(user)` — `@/lib/userHelpers`
- `exportToCSV(data, filename)` — `@/lib/csvExport`
```

### 4. Verification Commands

Fill in your project's specific commands:

```markdown
## Verification commands

# Frontend (MUST pass before each commit)
cd frontend && npx tsc --noEmit

# Backend (MUST pass before each commit)
docker compose exec -T server python manage.py check

# Full test suite
npm run test && pytest
```

## Adding Custom Bug Classes

Add project-specific bug classes to the review-slice checklist:

```markdown
## Bug classes (continued — project-specific)

10. **Timezone mismatch.** Backend stores UTC, frontend displays local time.
    If a component formats dates without timezone conversion, times are wrong
    for non-UTC users. Grep: `new Date()` without timezone handling.

11. **Stale seed data.** Admin dashboards show zeros when demo data has
    drifted past the current month. Run seed script before investigating.
```

## Customizing merge-feature-branch

Fill in the "Known Conflict Surface" table after your first merge:

```markdown
## Known conflict surface

| File | Hunks | Strategy |
|------|-------|----------|
| `src/styles/globals.css` | 1 | Union — both sides add CSS |
| `src/components/Layout.tsx` | 3 | Dev-base + graft |
| `package-lock.json` | N | Regenerate — `npm install` |
| `pyproject.toml` | 1 | Union deps, deduplicate |
```

## Creating Your Own Skills

See [Skill Anatomy](skill-anatomy.md) for the full SKILL.md specification. Key steps:

1. Create a folder under `~/.claude/skills/` or `.agents/skills/`
2. Write a `SKILL.md` with YAML frontmatter
3. Include a clear `description` with trigger phrases
4. Test by asking Claude Code questions that should trigger the skill
5. Iterate on the description until triggering is reliable

## Sharing Custom Skills

If you create a skill that's useful beyond your project:

1. Strip all project-specific references
2. Add placeholder sections for customization
3. Submit a PR to this toolkit repository
