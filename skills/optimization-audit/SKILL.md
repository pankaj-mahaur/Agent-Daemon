---
name: optimization-audit
description: Audit web application performance and scalability. Use for performance audit, optimization, slow pages, API waterfall, render churn, bundle review, N+1 queries, pagination, cache review, background job performance, database indexes, or high-volume endpoint concerns.
---

# Optimization Audit

Use this after correctness and security are understood. Prefer measured or obvious bottlenecks over speculative rewrites.

## Workflow

1. **Read existing perf docs** — check for performance budgets, past audit notes, or known bottlenecks.
2. **Identify the workflow** being optimized and its success metric (load time, TTFB, throughput, etc.).
3. **Frontend pass:**
   - Route client/server boundary — what renders on server vs client?
   - Fetch waterfall — are requests sequential when they could be parallel?
   - Debounce and cancellation — inputs triggering API calls on every keystroke?
   - Table/chart/list rendering cost — large datasets without virtualization?
   - Bundle and dependency weight — heavy imports, no tree-shaking, no code splitting?
4. **Backend pass:**
   - Queryset shape and N+1 risk — ORM queries inside loops?
   - Pagination and response size — unbounded list endpoints?
   - Aggregation and index match — slow queries missing indexes on filtered/sorted columns?
   - Cache key families and invalidation — cache exists but mutations don't invalidate?
   - Background job efficiency — batching, retries, idempotency, timeout handling?
5. **Split output** into low-risk fixes and measurement-needed follow-ups.

## Common Hot Spots

These patterns appear in most web applications:

- **Data-heavy dashboards** — date filters that re-fetch everything, no pagination, no server-side aggregation
- **Form save flows** — sequential API calls that could be batched or parallelized
- **List/table views** — loading all records when only a page is needed
- **Admin analytics** — complex aggregations without database indexes or caching
- **Background tasks** — no timeout, no retry limit, no idempotency guard
- **Search/filter inputs** — no debounce, fetching on every keystroke
- **Large imports** — importing entire libraries when only one function is needed

## Guardrails

- **Don't optimize without measuring.** If you can't show the bottleneck, don't rewrite the code.
- **Don't parallelize correctness-sensitive saves** unless the backend supports concurrent writes safely.
- **Don't remove pagination or caching** without understanding the data contract.
- **Don't optimize around stale test data.** Refresh demo/seed data before diagnosing "empty" or "slow" dashboards.
- **Separate quick wins from deep work.** Adding an index is a quick win. Rewriting the query layer is deep work. Present both, prioritize quick wins.

## Output

For each finding:

| Field | Description |
|-------|-------------|
| **Category** | Frontend / Backend / Infrastructure |
| **Impact** | Estimated improvement (e.g., "eliminates N+1 → 1 query instead of 50") |
| **Risk** | Low (additive) / Medium (behavioral change) / High (architectural) |
| **Fix** | Concrete code change with file:LINE reference |
| **Measurement** | How to verify improvement (timing, query count, bundle size) |
