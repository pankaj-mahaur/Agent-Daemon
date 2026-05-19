---
name: methodology-performance-profiling
description: Use when investigating slow pages, high memory usage, CPU-bound operations, or unexplained latency. Covers the profiling workflow from measurement to fix, tool selection by problem type, and the discipline of proving a fix actually helped rather than guessing.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Performance Profiling Methodology

Performance problems have a specific cause. They are not solved by "optimizing" random code — they are solved by measuring, identifying the bottleneck, fixing it, and measuring again. Skipping the measurement step is how developers spend three days optimizing a function that accounts for 0.2% of total latency.

This skill enforces the measurement-first discipline.

---

## The profiling loop

Every performance investigation follows the same loop:

### 1. Define the symptom

Before measuring anything, describe the problem in concrete terms:

- "The /api/users endpoint takes 3.2 seconds (p95) — it should take under 200ms"
- "Memory usage grows from 150MB to 2GB over 4 hours and then OOMs"
- "The build step takes 47 seconds — it used to take 12 seconds"
- "The page takes 8 seconds to become interactive on mobile"

**"It feels slow" is not a symptom.** Get a number. Without a number, you cannot tell if your fix helped.

### 2. Establish a baseline

Measure the current state under controlled conditions.

- **Same environment** every time. Do not compare your laptop to the CI server.
- **Same data.** Performance varies with data size. Use a fixed dataset for profiling.
- **Multiple runs.** Take the median of at least 5 runs. A single measurement can be an outlier.
- **Record the baseline.** Write it down. You will forget it after three hours of debugging.

```
Baseline (2024-01-15):
- Endpoint: GET /api/users?limit=100
- Environment: local, PostgreSQL 15, 10k users in DB
- p50: 280ms, p95: 3200ms, p99: 4100ms
- Measured over 50 requests using `hey -n 50 -c 1`
```

### 3. Profile to find the bottleneck

Do NOT guess. Use a profiler. The tool depends on the problem type (see section below).

The profile will show you where time or memory is actually spent. The result is almost always surprising — the bottleneck is rarely where you expect.

### 4. Form a hypothesis

Based on the profile data, state what you believe the bottleneck is and why.

```
Hypothesis: The p95 latency is caused by an N+1 query in getUsersWithRoles().
The profile shows 101 SQL queries per request (1 for users + 1 per user for roles).
Joining roles in the initial query should reduce this to 1 query.
```

### 5. Fix ONE thing

Make exactly one change. Not three changes that you think might help. One change, so you can attribute the improvement (or lack thereof) to that change.

### 6. Measure again

Re-run the same benchmark from step 2, under the same conditions. Compare to the baseline.

```
After fix:
- p50: 45ms, p95: 120ms, p99: 180ms
- Improvement: p95 dropped from 3200ms to 120ms (96% reduction)
- Root cause confirmed: N+1 query
```

If the fix did not help, revert it and go back to step 3. Do NOT keep the change "just in case" or stack another fix on top.

### 7. Verify there are no regressions

Performance fixes can introduce correctness bugs. Run the full test suite. Verify that the output is the same, not just faster.

---

## Choosing the right tool

### CPU profiling (slow computation)

**Symptom:** High CPU usage, slow function execution, long request times with no I/O wait.

| Runtime | Tool | Command |
|---------|------|---------|
| Node.js | V8 CPU profiler | `node --prof app.js` then `node --prof-process isolate-*.log` |
| Node.js | Chrome DevTools | `node --inspect app.js` -> Chrome DevTools -> Performance tab |
| Node.js | clinic.js | `npx clinic flame -- node app.js` |
| Python | cProfile | `python -m cProfile -s cumulative app.py` |
| Python | py-spy | `py-spy record -o profile.svg -- python app.py` |
| Go | pprof | `import _ "net/http/pprof"` then `go tool pprof http://localhost:6060/debug/pprof/profile` |
| Rust | perf + flamegraph | `cargo flamegraph --bin myapp` |
| Browser | Chrome DevTools | Performance tab -> Record -> Reproduce -> Stop |

**What to look for:** Functions that appear wide in flame graphs. Width = time. A function that is 60% of the flame graph is your bottleneck.

### Memory profiling (leaks, high usage)

**Symptom:** Memory grows over time, OOM kills, garbage collection pauses.

| Runtime | Tool | Command |
|---------|------|---------|
| Node.js | Heap snapshot | `node --inspect` -> Chrome DevTools -> Memory -> Take snapshot |
| Node.js | --max-old-space-size | `node --max-old-space-size=512 app.js` to force earlier OOM for testing |
| Python | tracemalloc | `tracemalloc.start()` then `tracemalloc.get_traced_memory()` |
| Python | objgraph | `objgraph.show_most_common_types()` |
| Go | pprof heap | `go tool pprof http://localhost:6060/debug/pprof/heap` |
| Browser | Chrome DevTools | Memory tab -> Allocation timeline |

**What to look for:** Objects that survive garbage collection and grow over time. Take two snapshots 5 minutes apart and compare — the growing objects are the leak.

### Database query profiling (slow queries)

**Symptom:** High latency correlated with database calls, slow endpoints that do little computation.

**Tools:**
- `EXPLAIN ANALYZE` on the specific query (PostgreSQL, MySQL)
- Slow query log (enable and review)
- Application-level query logging with timing (`DEBUG=knex:query` for Knex, `echo=True` for SQLAlchemy)

**What to look for:**
- Sequential scans on large tables (needs an index)
- N+1 queries (loop that issues one query per iteration)
- Missing WHERE clauses (fetching all rows when only some are needed)
- Unoptimized JOINs (joining on unindexed columns)

```sql
-- Always use EXPLAIN ANALYZE, not just EXPLAIN
-- EXPLAIN shows the plan; EXPLAIN ANALYZE actually runs it and shows real times
EXPLAIN ANALYZE
SELECT u.*, r.name as role_name
FROM users u
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE u.active = true;
```

### Network profiling (latency, bandwidth)

**Symptom:** Slow page loads, high time-to-first-byte, large payload sizes.

**Tools:**
- Browser DevTools Network tab (waterfall, timing breakdown)
- `curl -w "@curl-format.txt" -o /dev/null -s URL` for server-side timing
- Lighthouse for overall web performance scoring

**What to look for:**
- Large uncompressed responses (enable gzip/brotli)
- Too many requests (bundle, batch, or use HTTP/2 multiplexing)
- Slow DNS/TLS handshake (CDN, connection reuse)
- Blocking resources in the critical path (render-blocking CSS/JS)

---

## Common performance problems and fixes

### N+1 queries

**Detection:** Query count scales linearly with result set size.

**Fix:** JOIN or batch query (WHERE id IN (...)), or use an ORM's eager loading.

```ts
// Bad: N+1
const users = await db.query("SELECT * FROM users LIMIT 100");
for (const user of users) {
  user.roles = await db.query("SELECT * FROM roles WHERE user_id = ?", [user.id]);
}
// 101 queries

// Good: eager load
const users = await db.query(`
  SELECT u.*, json_agg(r.*) as roles
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id
  GROUP BY u.id
  LIMIT 100
`);
// 1 query
```

### Unbounded queries

**Detection:** Query returns all rows from a table with no LIMIT.

**Fix:** Always paginate. Default to a reasonable limit.

### Missing indexes

**Detection:** EXPLAIN shows Seq Scan on a table with thousands of rows where a conditional filters by a specific column.

**Fix:** Add an index on the filtered/joined column. Verify with EXPLAIN ANALYZE that the index is used.

### Synchronous blocking in async code

**Detection:** Event loop is blocked — no concurrent requests are processed.

**Fix:** Move CPU-intensive work to a worker thread/process. Use async I/O for all file and network operations.

### Memory leaks from event listeners or caches

**Detection:** Memory grows linearly with time or request count.

**Fix:** Remove event listeners when done. Use bounded caches (LRU) instead of unbounded maps.

---

## What NOT to optimize

### Code that is not in the hot path

If a function runs once during startup and takes 50ms, optimizing it to 5ms saves 45ms once. Focus on code that runs per-request or per-iteration.

### Code that is already fast enough

If the endpoint takes 12ms and the SLA is 200ms, do not optimize it. Spend the time on the endpoint that takes 3200ms.

### Micro-optimizations without measurement

Replacing `for` loops with `while` loops, avoiding object spread, using `Map` instead of plain objects "because it's faster." These changes are invisible at the application level and make the code harder to read. The profiler shows what matters — everything else is noise.

---

## Verification checklist

After a performance fix:

- [ ] Baseline was recorded before the fix
- [ ] Exactly one change was made per measurement cycle
- [ ] The improvement was measured (not assumed) under the same conditions
- [ ] The fix did not introduce correctness regressions (tests pass)
- [ ] The profiling data and results are documented (in the PR, commit message, or ADR)
- [ ] No premature optimizations were introduced for code outside the bottleneck

---

## Related

- [optimization-audit](../optimization-audit/SKILL.md) — systematic audit across the application
- [methodology-systematic-debugging](../methodology-systematic-debugging/SKILL.md) — performance problems are a form of debugging
- [production-readiness](../production-readiness/SKILL.md) — performance SLAs are a production readiness concern
