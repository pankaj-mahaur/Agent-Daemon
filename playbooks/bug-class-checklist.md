# Bug Class Checklist

9 universal bug patterns that recur across web applications. Use this as a review checklist — grep for each pattern during code review.

---

## 1. Enum/String Mismatch Between Layers

**What:** Backend returns one form of a string (e.g., plural "Managers"), frontend compares against another (singular "Manager"). The comparison is always false.

**Detection:**
```bash
# Find hardcoded role/status/type string comparisons
rg 'role\s*===?\s*["\x27][A-Z]' --type ts --type tsx
rg 'status\s*===?\s*["\x27]' --type ts --type tsx
# Compare against backend enum/choices definitions
rg 'choices\s*=' --type py
rg 'enum\s+' --type ts
```

**Impact:** Silent authorization bypass, broken UI gates, features that "work for no one" without throwing errors.

**Fix:** Define enums/constants in a shared location. Frontend and backend must reference the same values. Add a test that compares frontend constants against backend API response values.

---

## 2. Silent Catch Blocks

**What:** `catch {}` or `catch (e) { /* ignore */ }` blocks that swallow errors with no logging, no user feedback, no re-throw.

**Detection:**
```bash
rg 'catch\s*\([^)]*\)\s*\{[\s]*\}' --type ts --type js
rg 'catch\s*\{[\s]*\}' --type ts --type js
rg 'except.*:\s*pass' --type py
```

**Impact:** Mutations silently fail. User sees stale data. Debugging becomes guesswork because the error is eaten.

**Fix:** At minimum, log the error. For user-facing operations, show an error message. For mutations, consider re-throwing or returning an error state.

---

## 3. Missing Async Cancellation

**What:** Async operations (API calls, timers) in component lifecycle hooks without cancellation on unmount. React `useEffect`, Vue `onMounted`, Angular `ngOnInit` — all need cleanup.

**Detection:**
```bash
# React: useEffect with fetch but no cleanup return
rg 'useEffect.*fetch|useEffect.*await' --type ts --type tsx
# Check if AbortController or cancelled flag exists
rg 'AbortController|let cancelled' --type ts --type tsx
```

**Impact:** `setState` after unmount (React warning), stale data overwrites (user navigates away, response from old page arrives and overwrites new page's state), memory leaks.

**Fix:** Use `AbortController` for fetch calls, or a `let cancelled = false` flag:
```typescript
useEffect(() => {
  let cancelled = false;
  fetchData().then(data => { if (!cancelled) setData(data); });
  return () => { cancelled = true; };
}, []);
```

---

## 4. Debounce Gaps

**What:** Input elements (search boxes, date pickers, filter dropdowns) that trigger API calls on every change event without debouncing.

**Detection:**
```bash
# Find onChange handlers that call fetch/API functions
rg 'onChange.*fetch|onChange.*api|onChange.*query' --type ts --type tsx
# Check if debounce utility is used
rg 'useDebounce|useDebouncedValue|debounce' --type ts --type tsx
```

**Impact:** Hammers the API with requests on every keystroke. Causes flickering UI, wasted bandwidth, and can trigger rate limits. Responses arriving out of order show wrong results.

**Fix:** Check if the project already has a debounce utility. If so, use it. If not, create one and apply to all input-to-fetch paths. Typical debounce: 300-500ms for search, 150-300ms for filters.

---

## 5. N+1 API Calls

**What:** A loop that makes one API call per item instead of a single batch call.

**Detection:**
```bash
# Frontend: fetch inside a loop
rg 'for.*await.*fetch|\.map.*async.*fetch|forEach.*await.*fetch' --type ts --type tsx
# Backend: ORM query inside a loop
rg 'for.*\.objects\.|for.*\.query\.' --type py
rg 'for.*findOne|for.*findById' --type ts --type js
```

**Impact:** 50 items = 50 API calls. Slow, wasteful, and often hits rate limits or connection pool exhaustion.

**Fix:** If a batch endpoint exists, use it. If not, file a follow-up to create one. Don't convert to `Promise.allSettled` without a batch endpoint — it still opens N connections simultaneously.

---

## 6. Cache Invalidation Gaps

**What:** Mutations that update data but don't invalidate the corresponding cache entries. Applies to any cache: React Query, SWR, Redux, Redis, CDN, or custom.

**Detection:**
```bash
# Find mutation endpoints/handlers
rg 'POST|PUT|PATCH|DELETE' --type ts --type py
# Find cache invalidation calls
rg 'invalidateQueries|mutate\(|cache\.delete|cache\.clear' --type ts --type py
# Compare: mutations should have matching invalidations
```

**Impact:** User mutates data, but the list/dashboard still shows stale values until hard refresh. Especially dangerous for admin dashboards.

**Fix:** Every mutation must invalidate all affected cache families. Map out which cache keys are set and which mutations affect them. Consider a naming convention for cache keys that makes invalidation systematic.

---

## 7. Auth Redirect Races

**What:** Using `router.push("/login")` instead of `router.replace("/login")` for auth-required redirects.

**Detection:**
```bash
rg 'router\.push.*login|navigate.*login|redirect.*login' --type ts --type tsx
rg 'window\.location.*login' --type ts --type tsx
```

**Impact:** `push` adds to browser history. After logging in, the user hits "back" and lands on the auth redirect page, which redirects them to login again — infinite loop.

**Fix:** Use `router.replace("/login")` for auth redirects (replaces the current history entry). Keep `router.push` only for intentional navigation like logout.

---

## 8. Partial-Failure State Inconsistency

**What:** Bulk operations where the success callback assumes everything succeeded, but only some items were saved.

**Detection:**
```bash
# Find bulk save/submit handlers
rg 'Promise\.allSettled|Promise\.all|bulkCreate|batch' --type ts --type py
# Check if success handler differentiates partial vs full success
rg 'onSuccess|onSaveSuccess|handleSuccess' --type ts --type tsx
```

**Impact:** User submits 10 items, 3 fail, success callback clears all 10 from the form. The 3 failed items are lost with no way to recover.

**Fix:** Success callbacks must only clear items that were confirmed saved. Return the list of succeeded/failed items from the API. Clear only succeeded items from the UI state.

---

## 9. CSV/Export Pitfalls

**What:** CSV export that's vulnerable to formula injection, encoding issues, or memory leaks.

**Detection:**
```bash
rg 'createObjectURL|text/csv|download.*csv|export.*csv' --type ts --type tsx
rg 'csv.*response|StreamingHttpResponse|FileResponse' --type py
```

**Five rules:**

1. **Formula injection.** Cells starting with `=`, `+`, `-`, `@`, `\t`, `\r` must be prefixed with `'` (single quote). Excel/Sheets interprets them as formulas.

2. **URL lifecycle.** `URL.createObjectURL()` must be paired with `URL.revokeObjectURL()` after the download completes. Otherwise: memory leak.

3. **UTF-8 BOM.** Prepend `﻿` so Excel opens non-ASCII characters correctly. Without BOM, Excel defaults to ANSI and corrupts accented/CJK characters.

4. **CRLF line endings.** Use `\r\n` per RFC 4180. Some CSV parsers break on `\n` only.

5. **Export filtered data.** If the UI has active filters, export only the filtered dataset, not the full raw data. The user expects "download what I see."

**Fix:** Create a single CSV export utility that handles all 5 rules. Reuse it everywhere — don't let individual features implement their own CSV logic.
