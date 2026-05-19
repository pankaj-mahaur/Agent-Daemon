# implement-feature — examples

Real before-after pairs for the "search before you write" discipline.

---

## Example 1 — Date formatting

### ❌ Bad

> **User:** add a "last updated" badge to each project card
> **Agent:** *writes a `formatRelativeTime(date)` helper from scratch in `ProjectCard.tsx`* using `Math.floor((Date.now() - d) / 86400000)` and a `switch` for "today / yesterday / N days ago"

Six weeks later, someone else hits the same need and writes a *second* helper in `Dashboard.tsx`, slightly different ("N days ago" vs "Nd ago"). UI is now inconsistent across two views.

### ✅ Good

Phase 0 — `ls src/lib/`. Find `src/lib/date.ts` exporting `formatRelative(date)`. Use it. Card matches the rest of the app.

```ts
import { formatRelative } from "@/lib/date";
<span>{formatRelative(project.updatedAt)}</span>
```

**Lesson:** the inventory pass is 60 seconds. The drift it prevents lasts the life of the project.

---

## Example 2 — Role/permission check

### ❌ Bad

```tsx
{user.role === "admin" && <DeleteButton />}
```

Backend serializes the role as `"Admin"` (capital A) for one customer's SSO mapping; `=== "admin"` is `false`; delete button silently disappears. Catalog entry #1 (boundary string mismatch).

### ✅ Good

Phase 0 finds `@/lib/userHelpers` exporting `hasAdminAccess(user)` (case-insensitive, handles `roles: string[]` and `role: string`, has tests against real API fixtures).

```tsx
import { hasAdminAccess } from "@/lib/userHelpers";
{hasAdminAccess(user) && <DeleteButton />}
```

**Lesson:** boundary helpers exist *because* boundary strings drift. Use them.

---

## Example 3 — Match the neighbor

### ❌ Bad

> **User:** add a `/api/projects/:id/archive` endpoint
> **Agent:** writes a fresh handler with its own auth check, its own error shape `{ error: "..." }`, its own logging format.

Code review: the rest of the API uses `requireAuth` middleware, returns `{ ok: false, message: "..." }`, and logs via `logger.info({ event, userId })`. PR bounces.

### ✅ Good

Phase 0 — `ls src/api/projects/`. Open `delete.ts` (neighboring route). Copy its layout, middleware order, error shape, log line. The new handler reads like every other handler in the file.

**Lesson:** the wrong place to invent a convention is inside a feature PR. Pick the closest neighbor and follow it.

---

## Example 4 — CI gate skipped before commit

### ❌ Bad

Agent writes feature, runs `npm run dev`, sees it work, commits, pushes. CI fails on `tsc --noEmit` because an unused import slipped in. PR sits red for an hour while another check finishes, then needs a fixup commit.

### ✅ Good

Phase 0 step 4 — `npx tsc --noEmit && npx eslint . --max-warnings 0` *before* the commit. Catches the import in 8 seconds. Commit lands green.

**Lesson:** local CI gates are free. Pre-commit failures are expensive.

---

## Example 5 — One commit per root cause

### ❌ Bad

The feature also exposed a stale-cache bug and a misnamed function. Agent fixes all three in one giant commit:

```
feat: add archive endpoint + fix cache + rename helper

- New /api/projects/:id/archive route
- Stale project_list_* cache no longer served after mutation
- Renamed getProjects -> listProjects across 14 files
```

Reverting the rename later requires reverting the feature. Bisecting the cache fix requires reading 200 lines of unrelated diff.

### ✅ Good

Three commits, each with one root cause:

```
fix(projects-cache): invalidate project_list_* on mutation
refactor(projects): rename getProjects -> listProjects
feat(projects): add archive endpoint
```

Each is revertible independently. Bisect lands on the right one. Review is faster because each diff has a single story.

**Lesson:** "while I'm here" cleanup deserves its own commit, not a buried line in someone else's feature.

---

## Example 6 — Adding to the helper-surface table

### ❌ Bad

Agent introduces `useThrottledValue(v, ms)` in `src/hooks/useThrottledValue.ts`. Doesn't update the helper-surface table in `CLAUDE.md`. Next session, another agent re-implements throttling inline because they don't know the hook exists.

### ✅ Good

After landing the new hook, agent adds a row to the CLAUDE.md helper table:

| Concern | Helper to use | Lives in |
|---|---|---|
| Throttled input value | `useThrottledValue(v, ms)` | `@/hooks/useThrottledValue` |

Next session's Phase 0 finds it. Drift prevented.

**Lesson:** the inventory is only useful if it stays current. Update it when you add to it.
