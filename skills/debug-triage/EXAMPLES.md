# debug-triage — examples

Concrete ❌ / ✅ pairs. Each example is a real failure shape; the ❌ version is what an undisciplined agent does, the ✅ version is what the triage ladder produces.

---

## Example 1 — "The admin dashboard is showing zero everywhere"

### ❌ Bad

Agent opens `AdminDashboard.tsx`, reads 400 lines of charts and table logic, suspects a `useMemo` dep array, edits it. Tests still pass (because tests have their own fixtures). Dashboard still empty. Agent now suspects backend, opens the serializer, reads more code. 45 minutes in, no fix.

### ✅ Good

Rung 1 — `docker compose ps`: all green. Rung 2 — `python manage.py seed_data --clear --days 30`. Refresh. Numbers appear. **Total time: 90 seconds.**

**Lesson:** the seed window had slid past the current date. Code was fine the whole time. *Always run rungs 1–2 before opening a file.*

---

## Example 2 — "User edits a project, list view still shows old name for 5 minutes"

### ❌ Bad

Agent suspects React state. Adds `key={Date.now()}` to the list, edits the parent `useEffect` to refetch on mount, then on focus, then with a `revalidate` cron. Three commits, no improvement. The list is server-rendered from Redis.

### ✅ Good

Rung 3 — *cache stuck to old data?*

```bash
docker compose exec -T server python manage.py shell -c \
  "from django.core.cache import cache; cache.delete_pattern('project_list_*')"
```

List updates immediately. The mutation handler wasn't invalidating the `project_list_*` family. Two-line fix in the mutation, plus regression test.

**Lesson:** the symptom was "stale UI"; the cause was a missing cache invalidation. The triage ladder named it on rung 3.

---

## Example 3 — "API returns CORS error in browser, works fine in Postman"

### ❌ Bad

Agent widens CORS allowlist to `*`. Browser error goes away. Backend deploys. The browser is now silently accepting cross-origin POSTs from any site, including credential-bearing ones. Security review catches it two weeks later.

### ✅ Good

Triage says "CORS-shaped error → see [diagnose-fetch-failure](../diagnose-fetch-failure/SKILL.md)". That skill says: **most "CORS errors" are 5xx with stripped CORS headers**. Curl the endpoint:

```bash
curl -i -X POST https://api.example.com/users -d @payload.json
```

500 with stack trace. The endpoint is throwing inside middleware, response never gets CORS headers attached, browser shows CORS error. Fix the 500, not the CORS allowlist.

**Lesson:** the browser error message lied. Curl told the truth.

---

## Example 4 — "Bulk save partially succeeds, UI clears everything"

### ❌ Bad

Agent makes bulk save all-or-nothing: any failure aborts the whole batch. User now can't save 50 rows because one row has a validation error. UX regresses.

### ✅ Good

Bug-class catalog entry #7 — *Partial-failure UI desync*. Backend returns `{ savedKeys: [...], failed: [{key, error}] }`. Frontend clears only `savedKeys` from the staging buffer; failed rows stay in place with inline error indicators. Retry only resubmits failed rows.

**Lesson:** catalog patterns exist for a reason. Greppable, namable, fixable.

---

## Example 5 — Hard bug, triage clean: hand off to Phase 4 (disciplined diagnosis)

### ❌ Bad

Triage ladder rungs 1–4 all clean. Bug-class catalog doesn't match. Agent starts editing files, reads logs at random, adds five `console.log`s, removes them, adds three more elsewhere. After two hours, the loop is "edit → npm run dev → click around → maybe see it?" The bug only repros 1-in-20 clicks. No progress.

### ✅ Good

Phase 4 step 1 — **build a feedback loop.** The bug is flaky-1-in-20, so the goal is a *higher reproduction rate*, not a clean repro:

```ts
// scripts/repro-loop.ts
for (let i = 0; i < 200; i++) {
  await page.goto("/dashboard");
  await page.click("button.refresh");
  const ok = await page.evaluate(() => window.__lastResult?.ok);
  if (!ok) { console.log("FAIL on iter", i); break; }
}
```

Rate goes from 1/20 to 6/20 with the loop. Sharpen — pin time with `page.clock.install()`, freeze RNG. Rate goes to 18/20. Now hypothesis-testing is cheap. Three hypotheses ranked, one falsified in 30 seconds via a probe, second one identifies a race between `useEffect` cleanup and a stale closure. Fix in 5 lines.

**Lesson:** the feedback loop is the skill. Everything after it is mechanical.

---

## Anti-patterns to avoid (from the SKILL "What NOT to do")

- **Reading code on rung 1.** Containers restarting invalidates anything you'd conclude from source.
- **Widening CORS / disabling auth / lowering a validator** to make the repro pass. The change will ship.
- **`cache.delete_pattern("*")`** — wipes shared state, often sandbox-blocked.
- **`git add -A`** during the fix commit — express lane to shipping unrelated drift.
- **Trusting subagent / tool summaries** without reading the cited lines yourself.
