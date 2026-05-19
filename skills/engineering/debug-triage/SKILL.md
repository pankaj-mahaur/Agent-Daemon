---
name: debug-triage
description: Use when investigating a bug, unexpected behavior, empty data, blank screen, weird console error, or any "X is broken / not working / showing zero" report. Provides a strict triage order (services -> data -> cache -> request -> code) and a recurring bug-class catalog with greppable patterns.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Debug a runtime issue without jumping to code first

When a bug report lands — "X is broken", "showing zero", "page is blank", "API throws 500" — the temptation is to open the file the user named and start reading. Resist it. Half the time the answer is on rungs 1–4 of the ladder below and you never need to look at code.

This skill is the triage ladder + the recurring bug-class catalog. For specific failure shapes (CORS errors, intermittent flag-gated 503s) there are dedicated `diagnose-*` skills — see "Related" at the bottom.

---

## Phase 1 — Triage ladder (DO NOT skip)

Walk top-down. Stop at the first rung that explains the symptom.

### Rung 1 — Are services up?

Whatever orchestration you use:

```bash
# Docker Compose
docker compose ps
docker compose logs --tail=50 <service>

# PM2
pm2 status
pm2 logs <name> --lines 50

# systemd
systemctl status <unit>
journalctl -u <unit> -n 50

# Foreman / Procfile
# scan the terminal where `foreman start` is running
```

A container/process restarting, OOM-killed, or stuck in a crash loop will produce every downstream symptom you can think of (blank screen, 502, "it just stopped working"). Read the logs before the code.

### Rung 2 — Is the data fresh?

If admin dashboards / leaderboards / charts are zero across the board, the seed or test data is almost certainly stale, not the code. Re-seed:

```bash
# Django
docker compose exec -T server python manage.py seed_data --clear --days 30
# Rails
bin/rails db:seed
# Prisma
npx prisma db seed
# Custom node script
node scripts/seed.ts --reset
```

Default seed ranges drift past the current date over time — a project that "worked yesterday" silently goes empty when the seed window slides off the end of the month. See [seed-data](../seed-data/SKILL.md) for idempotent seed patterns.

### Rung 3 — Did the cache stick to old data?

Mutations frequently invalidate the wrong cache families (or none at all). Symptom: the user edits something, the API returns success, but the list view shows old state for several minutes (TTL).

**Targeted invalidation only — never wildcard.** Examples:

```bash
# Django + django-redis
docker compose exec -T server python manage.py shell -c \
  "from django.core.cache import cache; cache.delete_pattern('project_list_*')"

# Direct Redis
redis-cli --scan --pattern 'project:list:*' | xargs -r redis-cli DEL

# Rails
bin/rails runner "Rails.cache.delete_matched('project/list/*')"
```

A wildcard `cache.delete_pattern('*')` / `redis-cli FLUSHDB` / `Rails.cache.clear` will work locally but is dangerous on shared infra (and is often blocked in sandboxed environments).

If you don't know which cache families a mutation should invalidate, grep for every `cache.set` / `cache.get` call that touches the same data shape — those are the keys you need to invalidate.

### Rung 4 — Did the request even reach the backend?

Run the user's repro while tailing the backend access log:

```bash
docker compose logs --tail=30 -f <server>
# or
pm2 logs <server> --lines 30
# or just watch the foreground terminal
```

If the call **isn't in the access log**, the request never reached the handler. Investigate in this order:

1. **Frontend Network tab** — did `fetch` actually fire? What status?
2. **API proxy / rewrite layer** — Next.js rewrites, Vite proxy, nginx location blocks, Cloudflare workers. Common bug: an allowlist that requires `prefix/...` but rejects the bare `prefix` (or vice versa). Match BOTH:
   ```ts
   const isAllowed = (path: string) =>
     ALLOWED.some(p => path === p || path.startsWith(`${p}/`));
   ```
3. **CORS preflight** — for the symptom "CORS blocked" / `net::ERR_FAILED`, see [diagnose-fetch-failure](../diagnose-fetch-failure/SKILL.md). Most "CORS errors" are actually 5xx in disguise.
4. **Auth middleware short-circuit** — token expired, cookie not sent (SameSite issues), bearer header dropped by proxy.

### Rung 5 — Now read code

Only after rungs 1–4. Open the actual file at the actual cited location — don't trust an error message's line number from a stale build.

---

## Phase 2 — Recurring bug classes (grep these first)

Each entry: **Pattern → Symptom → Fix.** This is the "have I seen this before?" checklist.

For a fuller treatment, see [bug-class-checklist.md](../../playbooks/bug-class-checklist.md).

### 1. Boundary string mismatch (enum / role / status)

- **Grep:** `role\s*===?\s*["']`, `status\s*===?\s*["']`, switch/match cases on string literals
- **Symptom:** `isAdmin` always false; gated UI never appears; status badge always shows the default
- **Why:** Backend serializes plurals ("Managers"), Booleans-as-strings ("true"), or different casing. Frontend constants don't match.
- **Fix:** Centralize to a helper (`hasAdminAccess(user)`, `isCompletedStatus(s)`) that's tested against actual API responses, not assumed shapes.

### 2. Silent `catch {}` blocks

- **Grep:** `catch\s*\(\s*\)\s*\{\s*\}`, `catch\s*\{\s*\}`, `except.*pass`, `rescue => nil`
- **Symptom:** Save appears to succeed; no error toast; data is stale
- **Fix:** At minimum log + surface to UI banner. Re-throw if upstream needs to know. Empty catch is acceptable only when the comment explains exactly which exception is being swallowed and why.

### 3. Missing async lifecycle cancellation

- **Grep:** `useEffect\(.*async`, `onMounted\(.*async`, `componentDidMount.*async`
- **Symptom:** "setState on unmounted component" warning; stale data flashes after navigation; rapid filter changes show wrong data
- **Fix:** `let cancelled = false` guard with cleanup return, or `AbortController` passed to fetch.

### 4. N+1 API calls

- **Grep:** `for.*await\s+fetch`, `\.map\s*\(\s*async`, `Promise\.all.*\.map.*fetch`
- **Symptom:** Page is slow; Network tab shows N requests where 1 should suffice
- **Fix:** Push aggregation to backend (`prefetch_related` / `include` / `Preload`). If the backend doesn't support it, file a follow-up — don't paper over with `Promise.allSettled` against single-item endpoints.

### 5. Stale cache after mutation

- **Symptom:** Edit/create/delete succeeds; list view stays old for the cache TTL
- **Fix:** Trace every cache key family the mutation should invalidate — including denormalized lists, summary counts, and per-user variants. See Rung 3 above.

### 6. Auth redirect loop

- **Grep:** `router\.push\("/login"\)`, `navigate\("/login"\)` without `replace: true`
- **Symptom:** Browser Back from any page bounces to /login forever
- **Fix:** Use `replace`-style navigation for auth-required redirects. Logout still uses `push`.

### 7. Partial-failure UI desync (bulk operations)

- **Symptom:** Bulk save → some rows persisted, some failed → UI either clears all (loses failed-row data) or keeps all (creates duplicates on retry)
- **Fix:** Backend response should distinguish persisted vs failed by key. Frontend cleanup uses `result.savedKeys`, never assumes all-or-nothing.

### 8. Native form controls in custom-themed UI

- **Symptom:** Dark-mode select/dropdown shows white-on-white text; date picker doesn't respect theme; native popups appear in the wrong z-index
- **Fix:** Use the project's themed component (`<CustomSelect>`, headlessui combobox, react-aria) — native controls don't honor dark-mode classes consistently across browsers.

### 9. CSS wildcard cascade overriding inline / utility styles

- **Grep:** `.parent-container *`, `.theme-dark *` selectors with `color`, `background`, or other inheritable properties
- **Symptom:** Tailwind text-color classes have no effect on children of the wildcard parent
- **Fix:** Drop the wildcard, or scope it more narrowly. Inline `style={{ color: "..." }}` on a parent gets pulled into `color: inherit` for all children, defeating utility classes.

---

## Phase 3 — Stack-specific gotchas (project memory)

After each non-trivial fix, add the recurring trap to the project's `CLAUDE.md` under a "gotchas" section. Examples that have bitten real projects:

- **Proxy + trailing slash.** Backend route is `/api/projects/`; frontend client strips trailing slashes; proxy allowlist accepts `projects/...` but rejects bare `projects`. Symptom: 403 on the list root, 200 on detail routes.
- **Decimal validators with float arguments.** `MinValueValidator(0.1)` on a `DecimalField` (Django/DRF) emits a deprecation warning and may error on stricter versions. Use `Decimal("0.1")`.
- **Backend list-response envelopes.** `/users/` returns `{ users: [...] }`, not `[...]`. Frontend assumes bare array → `.map is not a function`.
- **Heatmap / chart title binding.** Anything that claims a date range (chart title, axis label, tooltip) must be driven from the same period state, not hardcoded.
- **Stale seed masquerading as a bug.** Empty admin dashboards across the board → re-seed before opening any code (Rung 2).

Document the trap once, move on. Future sessions read the gotchas list during Phase 0 of [implement-feature](../implement-feature/SKILL.md).

---

## Phase 4 — When triage doesn't explain it: disciplined diagnosis loop

If rungs 1–4 came up clean and the bug-class catalog didn't match, the bug is genuinely in the code path — don't start grepping wildly. Run the diagnosis loop. Methodology adapted from [`mattpocock/diagnose`](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnose/SKILL.md) (MIT). Skip phases only when explicitly justified.

### Step 1 — Build a feedback loop (this *is* the skill)

Everything else is mechanical. A fast, deterministic, agent-runnable pass/fail signal turns the bug into a search problem. No loop = staring at code = wasted hours. **Be aggressive. Be creative. Refuse to give up.**

Try, roughly in order:

1. **Failing test** at whatever seam reaches the bug (unit / integration / e2e).
2. **`curl` against a running dev server** with the exact request payload.
3. **CLI invocation** with a fixture input, diffed against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) — drives the UI, asserts on DOM / console / network.
5. **Replay a captured trace** — save the real network request / payload / event log, replay through the code path in isolation.
6. **Throwaway harness** — minimal subset of the system (one service, mocked deps) that exercises the bug code path with one function call.
7. **Property / fuzz loop** — 1000 random inputs if the bug is "sometimes wrong output".
8. **Bisection harness** — automate "boot at state X, check, repeat" so `git bisect run` works.
9. **Differential loop** — same input through old-version vs new-version, diff outputs.
10. **HITL bash script** — last resort. If a human must click, drive *them* with a structured loop so captured output feeds back.

Iterate on the loop itself: can I make it faster? sharper? more deterministic? A 30-second flaky loop is barely better than no loop; a 2-second deterministic loop is a debugging superpower.

**Non-deterministic bugs:** the goal isn't a clean repro — it's a *higher reproduction rate*. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. 50%-flake is debuggable; 1% is not.

**When you genuinely cannot build a loop:** stop and say so explicitly. List what you tried. Ask the user for (a) access to a reproducing environment, (b) a captured artifact (HAR / log dump / screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do *not* hypothesise without a loop.

### Step 2 — Reproduce

Run the loop. Watch the bug appear. Confirm:

- The loop produces the failure mode the **user** described — not a different failure that happens to be nearby. Wrong bug = wrong fix.
- Reproducible across runs (or, for non-det bugs, at high-enough rate to debug against).
- You've captured the exact symptom (error message / wrong output / slow timing) so later phases can verify the fix.

### Step 3 — Hypothesise (3–5 ranked, falsifiable)

Generate **3–5 ranked hypotheses before testing any.** Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**:

> "If `<X>` is the cause, then `<changing Y>` will make the bug disappear / `<changing Z>` will make it worse."

If you can't state the prediction, it's a vibe — discard or sharpen. **Show the ranked list to the user before testing** — they often re-rank instantly ("we just deployed a change to #3") or have ruled some out. Cheap checkpoint, big time saver. Proceed with your ranking if user is AFK.

### Step 4 — Instrument (one variable at a time)

Each probe maps to a specific Phase-3 prediction. Tool preference:

1. **Debugger / REPL inspection** if env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Establish baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

### Step 5 — Fix + regression test

Write the regression test **before the fix** — but only if there is a **correct seam** for it. A correct seam exercises the *real bug pattern* as it occurs at the call site. A shallow seam (single-caller test when the bug needs multiple callers) gives false confidence.

**If no correct seam exists, that is itself the finding.** Note it — the architecture is preventing the bug from being locked down. Flag for the cleanup phase.

If a seam exists: turn the minimised repro into a failing test → watch it fail → apply the fix → watch it pass → re-run the original (un-minimised) Phase 1 loop.

### Step 6 — Cleanup + post-mortem

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted or moved to a clearly-marked debug location
- [ ] The hypothesis that turned out correct is stated in the commit / PR message — so the next debugger learns

Then ask: **what would have prevented this bug?** If the answer involves architectural change (no good test seam, tangled callers, hidden coupling), capture it as a follow-up. Make the recommendation **after** the fix is in — you have more information now than when you started.

---

## Verification before declaring fixed

1. **Re-run the failing flow** end-to-end — the original repro the user reported, not a synthetic test.
2. **Run the project's pre-commit / CI gates** — type-check, lint, smoke tests. See [ci-cd-practices.md](../../playbooks/ci-cd-practices.md) for stack-specific commands.
3. **If the fix touched cache or migrations**, also clear the affected cache family and verify against fresh data.
4. **Watch the access log** during one repro to confirm the request now reaches the handler and returns the expected status.

---

## What NOT to do

- **Don't read code on Rung 1.** Container restarting / process crash-looping invalidates anything you'd conclude from the source.
- **Don't widen CORS / disable auth / lower a validator** to make the repro pass. The change will ship.
- **Don't `cache.delete_pattern("*")`** — wipes shared state, may be sandbox-blocked.
- **Don't `git add -A`** during the fix commit — it's the express lane to shipping unrelated whitespace drift and debug prints.
- **Don't trust subagent / tool summaries** without reading the actual cited lines yourself. See Phase 2 of [review-slice](../review-slice/SKILL.md).

---

## Related

- [diagnose-fetch-failure](../diagnose-fetch-failure/SKILL.md) — CORS-shaped errors, `net::ERR_FAILED`, 5xx-with-stripped-CORS-headers
- [diagnose-intermittent-failure](../diagnose-intermittent-failure/SKILL.md) — "sometimes works, sometimes doesn't" against a local backend
- [bug-class-checklist.md](../../playbooks/bug-class-checklist.md) — fuller catalog of the 9 bug classes
- [implement-feature](../implement-feature/SKILL.md) — patterns to use while writing the fix so you don't reintroduce the bug
