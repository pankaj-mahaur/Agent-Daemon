---
name: implement-feature
description: Implementing a new feature, page, hook, component, or backend endpoint. Use when the user asks to "add", "implement", "build", "create", "wire up", or in Hinglish "ye banao", "feature add karo", "iska page banao", "wire up karo", "naya banao", "is feature ko implement karo". Enforces a "search before you write" pass over existing utilities, matches existing file/layout patterns, applies a frontend/backend correctness checklist, and produces one-commit-per-root-cause output.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Implement a feature without reinventing what's already in the repo

Before you write a single line, find what's already there. Most projects have a half-dozen utilities, hooks, or components that already solve the boring parts of your task — date math, debouncing, role checks, toast/banner UI, API clients. Re-implementing them is the single most common source of inconsistency and regression.

This skill is the discipline you walk through before, during, and after writing the feature.

---

## Phase 0 — Before-you-write checklist

1. **Reuse over reinvent.** Build a 60-second inventory of the project's helper surface:
   - `ls src/lib/` (or `app/lib/`, `utils/`, `helpers/` — whatever the project uses)
   - `ls src/hooks/` (or `composables/`, `services/`)
   - `ls src/components/` and look at the shared/atomic-component folder
   - Backend: `ls <app>/utils/`, `<app>/services/`, `<app>/helpers/`
2. **Match existing patterns.** Open one neighboring file that does something similar and copy its layout, naming, and import order. The wrong place to invent a new convention is in the middle of a feature PR.
3. **Read the project's instructions file** (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursor/rules/`) if it exists. Banned patterns and required helpers are usually listed there.
4. **Check pre-commit / CI gates locally** before each commit. Common gates and how to run them:
   - TypeScript: `npx tsc --noEmit`
   - ESLint: `npx eslint . --max-warnings 0`
   - Python (Django): `python manage.py check`
   - Python (FastAPI/general): `python -c "import app.main"` (smoke import)
   - Ruff: `ruff check .` and `ruff format --check .`
   - Go: `go vet ./... && go build ./...`
   - Rust: `cargo check && cargo clippy -- -D warnings`

If any of these fail before your change, fix or note them — don't ship the failure-noise into your own commit.

---

## Phase 1 — Map the helper surface (project-specific)

Once you've done Phase 0 a few times in a project, fill in the table below in the project's `CLAUDE.md`. Future sessions stop rediscovering it.

| Concern | Helper to use | Lives in |
|---|---|---|
| Role / permission check | _e.g. `hasAdminAccess(user)`_ | _e.g. `@/lib/userHelpers`_ |
| Debounced input value | _e.g. `useDebouncedValue(v, ms)` / `useDebounce` / lodash_ | _e.g. `@/hooks/useDebouncedValue`_ |
| Date parsing & formatting | _e.g. `parseDate`, `formatDate`, `date-fns`, `dayjs`_ | _e.g. `@/lib/date`_ |
| API client (auth, base URL, error mapping) | _e.g. `apiClient`, axios instance, ky_ | _e.g. `@/lib/api`_ |
| CSV / file export | _e.g. `exportToCSV(rows, filename)` returning `{ ok, message? }`_ | _e.g. `@/lib/csvExport`_ |
| Custom select / dropdown | _e.g. `<CustomSelect>` (avoid native `<select>`)_ | _e.g. `@/components/ui/CustomSelect`_ |
| Toast / banner / error surface | _e.g. `setError(...)` state, toast hook_ | _e.g. `@/components/ui/Banner`_ |
| Cache invalidation | _e.g. `queryClient.invalidateQueries`, `mutate(...)`, Redux dispatch_ | _e.g. React Query / SWR / Apollo_ |
| Permission gate (backend) | _e.g. `is_admin_user(user)`, `@requires_role`, DRF permission class, FastAPI `Depends(require_admin)`_ | _e.g. `accounts/permissions.py`_ |

Treat this as the project's reusable-utility catalog. Adding a new helper without checking it first is the path to drift.

---

## Phase 2 — Mandatory frontend patterns (apply in every framework)

These reproduce across React, Vue, Svelte, Solid, Angular. Stack-specific syntax differs; the bug class is the same.

### Async lifecycle hooks need cleanup

React `useEffect`, Vue `onMounted` + `onUnmounted`, Svelte `onMount` returning a cleanup, Angular `ngOnInit` paired with `ngOnDestroy` — async work inside any of these must be cancellable. Without it: state updates on unmounted components, stale data overwriting fresh data, memory leaks.

```tsx
// React
useEffect(() => {
  let cancelled = false;
  (async () => {
    const data = await fetchX();
    if (!cancelled) setX(data);
  })();
  return () => { cancelled = true; };
}, [...deps]);
```

```ts
// Vue 3 composition
import { onMounted, onUnmounted } from 'vue';
let controller: AbortController;
onMounted(() => {
  controller = new AbortController();
  fetch(url, { signal: controller.signal }).then(...);
});
onUnmounted(() => controller?.abort());
```

`AbortController` works wherever native `fetch` is used — prefer it when possible.

### Debounce inputs that drive fetches

Search boxes, date pickers, filter dropdowns, autocompletes — wrap the value with a debounce hook **before** it lands in the effect's dependency list. Without debouncing: race conditions (response for keystroke 3 arrives after keystroke 5), excessive network traffic, server-side rate-limit triggers.

If the project already has a debounce helper (`useDebouncedValue`, `useDebounce`, `lodash.debounce`), reuse it. Don't add a third one.

### Auth-required redirects must `replace`, not `push`

```ts
// React Router
navigate("/login", { replace: true });
// Next.js
router.replace("/login");
// Vue Router
router.replace({ name: "login" });
// Angular
this.router.navigate(["/login"], { replaceUrl: true });
```

`push`-style navigation pollutes the back-stack and produces a redirect loop when the user presses Back. Logout still uses push (the user wants to be able to back into the previous app state from the post-logout screen).

### Boundary value coercion

Backend enums, group names, status strings, and config flags do not always match what the frontend constants expect. Plural vs singular ("Managers" vs "Manager"), case ("admin" vs "ADMIN"), serialization ("true" string vs `true` boolean) — verify by reading the actual backend response, not the frontend constants file. Use a single helper (`hasAdminAccess(user)`, `isAdmin(user)`) instead of inlining `user.role === "..."` everywhere.

### Surface errors — never silent `catch`

```ts
// Bad — error vanishes, UI looks like success
try { await save(...) } catch {}

// Acceptable — at minimum log + surface to UI
try {
  await save(...);
} catch (err) {
  console.error("save failed", err);
  setError("Could not save. Please try again.");
}
```

Empty catch blocks in mutation, refresh, and auth paths are the #1 source of "save said it worked but the data didn't update" reports.

### List endpoint envelopes

Many backends wrap list responses in a payload object: `{ users: [...] }`, `{ items: [...], count, next }`. Frontend code that does `setUsers(data)` instead of `setUsers(data.users || [])` blows up the moment the backend changes shape. Check the actual JSON response (curl or DevTools Network tab) before writing the fetcher.

### CSV / file exports — use a shared helper

If the project has an existing export helper, use it and surface its `{ ok, message? }` result through the same banner the rest of the page uses. If it doesn't exist, see [csv-export-safety.md](../../playbooks/csv-export-safety.md) before writing one — formula injection, BOM, CRLF, and `URL.revokeObjectURL` are easy to forget.

---

## Phase 3 — Mandatory backend patterns (apply in every framework)

### New mutation that touches a list → invalidate every cache key family that reads the same data

This applies to Redis caches, in-memory caches, React Query / SWR client caches, CDN page caches — wherever the data is denormalized.

Worked examples by stack:

```python
# Django + django-redis
from django.core.cache import cache
def invalidate_project_caches(project_id: int) -> None:
    cache.delete(f"project_detail_{project_id}")
    try:
        cache.delete_pattern("project_list_*")
        cache.delete_pattern("active_projects_*")
    except AttributeError:
        pass  # backend without delete_pattern
```

```ts
// Express + ioredis
async function invalidateProjectCaches(projectId: number) {
  await redis.del(`project:detail:${projectId}`);
  const stream = redis.scanStream({ match: 'project:list:*' });
  for await (const keys of stream) if (keys.length) await redis.del(...keys);
}
```

```ruby
# Rails
def invalidate_project_caches(project_id)
  Rails.cache.delete("project/detail/#{project_id}")
  Rails.cache.delete_matched("project/list/*")
end
```

**Never** wildcard the entire cache (`cache.delete_pattern("*")`, `redis-cli FLUSHDB`, `Rails.cache.clear`) on a hot path — this nukes shared state and triggers a thundering-herd refill.

### List endpoints — eager-load relations

The N+1 query pattern hits every ORM:

```python
# Django
projects = Project.objects.prefetch_related("assigned_users").select_related("owner")
```

```ts
// Prisma
const projects = await prisma.project.findMany({
  include: { assignedUsers: true, owner: true },
});
// TypeORM
const projects = await repo.find({ relations: ["assignedUsers", "owner"] });
```

```ruby
# Rails
Project.includes(:assigned_users, :owner)
```

```go
// GORM
db.Preload("AssignedUsers").Preload("Owner").Find(&projects)
```

If you can't push the aggregation to the backend, don't paper over it on the frontend with `Promise.all(items.map(fetchOne))` — it multiplies open connections and hides the real cost.

### Permission gates

Use the project's existing helper or framework convention:

```python
# Django (helper) or DRF permission class
if not is_admin_user(request.user):
    raise PermissionDenied()
# DRF
permission_classes = [IsAdminUser]
```

```ts
// FastAPI
@router.get("/admin/users")
def list_users(user: User = Depends(require_admin)): ...
// Express
router.get("/admin/users", requireAdmin, handler);
```

Match the existing pattern — don't introduce a parallel auth path until the user agrees to a refactor.

### Numeric / decimal validators

Use the type the field uses. `MinValueValidator(0.1)` on a `DecimalField` warns or errors on stricter ORM versions; use `Decimal("0.1")`. Currency math uses `Decimal` / `BigDecimal` / `MoneyKit`, never `float`.

---

## Phase 4 — Commit shape

- **One commit per root cause.** Three changes from the same reason → one commit. Two unrelated bug fixes in the same file → two commits.
- **Stage explicitly by name.** Never `git add -A` / `git add .`. Both pull in stray whitespace drift, debug prints, scratch files.
- **Conventional Commits style** works in any language:
  ```
  fix(projects): invalidate active-projects caches on assignment edit
  feat(reports): add weekly summary export
  refactor(auth): extract requireAdmin permission gate
  ```
  Scope = the module/feature area, not the file path.
- **Body explains why.** The diff shows what; the body explains the user pain or constraint that drove the change.
- **Multi-repo workspace?** Frontend and backend commit separately, in their own repos. The parent directory is usually NOT a git repo — verify with `git rev-parse --show-toplevel` from each subdirectory.

---

## What NOT to do

- **Don't write a new `formatDate` / `useDebounce` / `apiClient`** without grepping for an existing one.
- **Don't introduce a new file layout** ("components-v2/", "hooks-new/") in the middle of a feature.
- **Don't bypass pre-commit hooks** (`--no-verify`). If a hook fails, fix the underlying issue and create a new commit.
- **Don't `git add -A`** to "save time". Stray files in commits are the cause of most "why is X in this PR" review comments.
- **Don't ship silent error swallowing.** At minimum log + surface to UI.
- **Don't widen permissions / loosen validators / disable CSP / add a CORS wildcard** to make a feature work locally. The change will ship.

---

## See also

- [bug-class-checklist.md](../../playbooks/bug-class-checklist.md) — patterns to avoid while writing the feature
- [debug-triage](../debug-triage/SKILL.md) — when something the feature touches breaks at runtime
- [review-slice](../review-slice/SKILL.md) — review the feature once it's complete
- [ci-cd-practices.md](../../playbooks/ci-cd-practices.md) — pre-commit / CI gate setup
