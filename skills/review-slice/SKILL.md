---
name: review-slice
description: Use for deep-reviewing a page, feature, or section of any web application. Identifies bugs grouped by root cause using a 9-class bug checklist, presents findings by severity, and implements approved fixes.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# review-slice

Deep-review a page, feature, or section of any web application. Produce actionable findings grouped by severity, then implement approved fixes with one commit per root cause.

---

## Phase 0 — Context lookup

Before touching code, check for existing knowledge:

- Read the project README, CLAUDE.md, CONTRIBUTING.md, or equivalent.
- Look for decision logs, ADRs (Architecture Decision Records), or past review notes.
- Check for a `.cursor/rules`, `.github/copilot-instructions`, or similar AI instruction files.
- Skim any existing test coverage for the target area.

**Skip this phase** only if you are certain no relevant docs exist (e.g., the user explicitly told you so). Otherwise, spend 60 seconds here — it prevents rediscovering decisions that were already made.

---

## Phase 1 — Explore

Use a subagent (Agent tool or equivalent) for exploration when the target area spans more than 1-2 files. Give the subagent the **9 Bug Classes** below as priority filters.

Exploration checklist:
- Map out the component/page tree for the target slice.
- Identify all API calls, state management hooks, and side effects.
- Trace the data flow: backend response shape -> frontend consumption -> display.
- Note any shared utilities, custom hooks, or middleware in the path.
- Flag patterns that match any of the 9 bug classes.

If the slice is small (1-2 files), read directly — no subagent needed.

---

## Phase 2 — Verify

Subagent summaries describe **intent**, not always **reality**. Before presenting findings:

1. Pick the 2-3 most impactful claims from the exploration.
2. Read the actual source lines yourself using the Read tool.
3. Confirm the bug exists as described, or adjust/discard the finding.

Never present a finding you have not personally verified in source.

---

## Phase 3 — Present findings

Group all findings into three severity tiers:

### Critical
Bugs that cause incorrect data, security holes, crashes, or broken user flows. These must be fixed before shipping.

### Cleanup
Logic issues, missing error handling, race conditions, or patterns that will cause bugs under specific conditions. Should be fixed soon.

### Polish
Code quality, readability, minor UX inconsistencies, naming conventions. Nice to fix but not urgent.

**Formatting rules:**
- Every finding must include a clickable `file:LINE` reference (e.g., `src/components/Dashboard.tsx:47`).
- Group related symptoms under their shared root cause.
- Include a one-liner showing the problematic code or pattern.
- Suggest the fix direction in 1-2 sentences.

**After presenting: STOP and wait for user approval.** Do not implement anything until the user confirms which findings to fix.

---

## Phase 4 — Plan

After approval, group approved findings by **root cause**, not by file.

- Three symptoms from one cause = one commit.
- Two unrelated bugs in the same file = two commits.
- Create a numbered plan: each item is one root cause with its list of affected files.
- If a finding requires a new utility or shared function, note it explicitly.

Present the plan. Wait for user confirmation before implementing.

---

## Phase 5 — Implement + commit

For each root-cause group:

1. Implement the fix across all affected files.
2. Run verification commands (type-check, lint, tests — see Verification section below).
3. Fix any verification failures before committing.
4. Stage files explicitly by name. **Never** `git add -A` or `git add .`.
5. Commit with style: `type(scope): short message` (see Commit conventions below).
6. Move to the next root-cause group.

One root-cause = one commit. No batching unrelated fixes together.

---

## 9 Bug Classes

Use these as a checklist during exploration (Phase 1) and verification (Phase 2). They cover the most common and impactful bug patterns in web applications.

### 1. Enum/string mismatch between layers

Backend returns one form (e.g., plural `"Managers"`), frontend compares another (singular `"Manager"`). This applies to any boundary: API responses vs. frontend constants, database enums vs. application code, config values vs. runtime checks.

**Detection:** Grep backend enum/constant definitions and compare against frontend string literals, switch cases, and conditional checks. Look for case sensitivity issues too.

### 2. Silent catch blocks

`catch {}` or `catch (e) {}` with no logging, no user feedback, no re-throw. The error disappears silently. Especially dangerous in:
- Refresh-after-mutation paths (user thinks save succeeded).
- Authentication flows (token refresh fails silently).
- Data fetching (stale data displayed without indication).

**Detection:** Grep for `catch` blocks and check if the body is empty or only contains a comment.

### 3. Missing async cancellation

Async operations in component lifecycle hooks (React `useEffect`, Vue `onMounted`, Svelte `onMount`, Angular `ngOnInit`) without cancellation patterns. Missing:
- `AbortController` for fetch calls.
- `let cancelled = false` guard pattern.
- Cleanup return in `useEffect` / `onUnmounted`.

**Consequences:** State updates after unmount (React warnings), stale data overwrites fresh data, memory leaks.

**Detection:** Find all `useEffect` / lifecycle hooks containing `await` or `.then()` and check for cleanup functions.

### 4. Debounce gaps

Any user input (search box, date picker, filter dropdown, text field) that triggers an API call on every change event without debouncing. Causes:
- Excessive API calls.
- Race conditions (response for keystroke 3 arrives after response for keystroke 5).
- Poor UX on slow connections.

**Detection:** Find `onChange`/`onInput` handlers that call API functions. Check if the project already has a debounce utility before creating a new one.

### 5. N+1 API calls

Sequential API calls in a loop:
```
for (const x of xs) { await fetch(`/api/item/${x.id}`) }
```
Or parallel but unbounded:
```
await Promise.all(xs.map(x => fetch(`/api/item/${x.id}`)))
```

**Detection:** Grep for `fetch`/API call patterns inside `.map()`, `.forEach()`, or `for` loops. If no backend batch endpoint exists, file a follow-up issue rather than implementing one during the review.

### 6. Cache invalidation gaps

Every mutation (create, update, delete) must invalidate all affected cache keys/families. Common frameworks: React Query (`queryClient.invalidateQueries`), SWR (`mutate`), Redux (dispatch refresh), Apollo (`refetchQueries`).

**Common miss:** Invalidating the direct entity cache but forgetting related list/summary caches. Example: updating a user's role but not invalidating the team members list cache.

**Detection:** Find all mutation calls and trace which cache keys they invalidate. Compare against all query keys that read the same data.

### 7. Auth redirect races

`router.push("/login")` (or equivalent) pollutes the browser back-stack. After login, pressing Back sends the user to `/login` again, creating a redirect loop.

**Fix pattern:** Use `router.replace("/login")` for auth-required redirects so the protected route is removed from history.

**Detection:** Grep for router navigation calls in auth guards, middleware, and interceptors. Check if they use `replace` semantics.

### 8. Partial-failure state inconsistency

Bulk operations (batch save, multi-delete, bulk import) where the success callback runs on partial success. If 3 of 5 items save and the UI clears all 5, the user loses 2 items with no indication.

**Fix pattern:** The success handler must only clear/update items confirmed saved by the response. Show errors for failed items.

**Detection:** Find bulk operation handlers and check if the success path distinguishes between full and partial success.

### 9. CSV/export pitfalls

Common export bugs:
- **Formula injection:** Cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` need a `'` (single quote) prefix to prevent spreadsheet formula execution.
- **Memory leak:** `URL.createObjectURL()` must be paired with `URL.revokeObjectURL()` after download completes.
- **Encoding:** UTF-8 BOM (`﻿`) prefix needed for Excel to detect encoding correctly.
- **Line endings:** CRLF (`\r\n`) per RFC 4180.
- **Data scope:** Export must use the current filtered/sorted data, not the raw unfiltered dataset.

**Detection:** Find all export/download functions and check each of these five items.

---

## Recurring gotchas (fill in for your project)

<!-- After each review, document patterns that are easy to re-introduce: -->
<!-- - Example: "Proxy routes must match both with and without trailing slash" -->
<!-- - Example: "Wildcard CSS selectors override inline styles on child elements" -->
<!-- - Example: "Date serialization loses timezone — always use ISO 8601 with offset" -->

---

## Stack quick reference (fill in for your project)

<!-- - Frontend: ... -->
<!-- - Backend: ... -->
<!-- - Auth: ... -->
<!-- - State management: ... -->
<!-- - Key conventions: ... -->

---

## Shared utilities (fill in for your project)

<!-- List extracted utilities that should be reused, not re-invented -->
<!-- - `formatDate()` — `@/lib/date` -->
<!-- - `useDebounce(value, ms)` — `@/hooks/useDebounce` -->
<!-- - `apiClient` — `@/lib/api` (handles auth headers, base URL, error interception) -->

---

## Commit conventions

- **Style:** `type(scope): short message`
  - Types: `fix`, `feat`, `refactor`, `style`, `perf`, `test`, `docs`, `chore`
  - Scope: the component, module, or feature area (e.g., `auth`, `dashboard`, `export`)
- **Body:** Explain **why**, not **what**. The diff shows the what.
- **Staging:** Always stage files explicitly by name. Never `git add -A` or `git add .`.
- **Never amend.** Create new commits. If a commit needs correction, make a follow-up commit.
- **Never `--no-verify`.** If a pre-commit hook fails, fix the underlying issue.
- **Never force-push** to shared branches.

---

## Verification commands (fill in for your project)

<!-- Frontend: -->
<!-- - npx tsc --noEmit -->
<!-- - npm run lint (or npx eslint .) -->
<!-- - npm run build -->
<!-- - npm test -->

<!-- Backend: -->
<!-- - python manage.py check / cargo check / go vet -->
<!-- - pytest / cargo test / go test ./... -->
<!-- - ruff check / eslint / clippy -->

<!-- Run these after EVERY commit in Phase 5. -->
