---
name: methodology-incremental-delivery
description: Use when a large feature needs to ship in small, independently valuable increments. Covers slicing strategies, feature flag discipline, the merge-often cadence, and how to avoid the big-bang integration that breaks everything on the last day.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Incremental Delivery Discipline

Big features fail not because the code is bad, but because they are integrated late. A branch that lives for three weeks accumulates merge conflicts, untested interactions, and assumptions that diverge from the codebase. Incremental delivery is the discipline of shipping small pieces continuously so that integration pain is spread out and caught early.

This is not about moving fast for its own sake. It is about reducing risk.

---

## The core principle

Every increment must be:

1. **Independently deployable.** It can be merged and released without waiting for the next increment. It does not break existing behavior.
2. **Independently valuable.** It delivers something useful — even if that "something" is invisible to end users (a new internal API, a data model, a migration). Infrastructure that enables future work counts as value.
3. **Small enough to review in one sitting.** If a reviewer needs more than 30 minutes to understand the PR, it is too large. Split it.

---

## Slicing strategies

The hard part of incremental delivery is deciding how to slice. Here are the strategies, ordered from most to least common:

### Slice by data layer first

For features that introduce new data, ship the data model and persistence layer before any UI or API surface.

```
Increment 1: Migration + model + seed data + tests
Increment 2: API endpoint (read-only) + tests
Increment 3: API endpoint (write) + validation + tests
Increment 4: UI component (display only, reads from new API)
Increment 5: UI component (form, writes to new API)
```

**Why this works:** Each layer can be reviewed and tested in isolation. The data model — the hardest thing to change later — gets reviewed with full attention, not buried in a 2000-line PR.

### Slice by happy path, then edge cases

Ship the normal-case behavior first. Handle edge cases in follow-up increments.

```
Increment 1: User can create a widget (happy path, valid input)
Increment 2: Validation errors show meaningful messages
Increment 3: Handle duplicate widget names gracefully
Increment 4: Widget creation works with concurrent requests
```

**Why this works:** The happy path delivers visible value immediately. Edge cases are easier to implement when the foundation is solid and reviewed.

### Slice by user operation (CRUD)

For features with multiple operations, ship one operation per increment.

```
Increment 1: List widgets (read)
Increment 2: Create widget (write)
Increment 3: Update widget (write)
Increment 4: Delete widget (write, with soft-delete)
```

### Slice by audience

For features that affect multiple user roles, ship one role at a time.

```
Increment 1: Admin can view the new dashboard
Increment 2: Admin can configure dashboard widgets
Increment 3: Regular users can view their own dashboard (read-only)
Increment 4: Regular users can customize their dashboard
```

### Anti-pattern: slicing by technical layer horizontally

```
// DO NOT DO THIS
Increment 1: All database tables and migrations for the entire feature
Increment 2: All API endpoints for the entire feature
Increment 3: All UI components for the entire feature
```

This is not incremental delivery — it is sequential construction. Nothing is usable until the last increment ships, and each increment is too large to review.

---

## Feature flags

Feature flags allow you to merge incomplete features into the main branch without exposing them to users. They are essential for incremental delivery of user-facing features.

### When to use a feature flag

- The increment changes user-visible behavior that is not ready for all users
- The increment is part of a multi-step feature that only makes sense complete
- You need to test in production with a subset of users

### When NOT to use a feature flag

- The increment is a purely internal change (new utility, data model, internal API)
- The increment is backward compatible and does not change existing behavior
- The increment is a bug fix

### Feature flag discipline

```ts
// Good: simple boolean gate at the boundary
if (featureFlags.isEnabled("new-dashboard")) {
  return <NewDashboard />;
}
return <LegacyDashboard />;

// Bad: flags scattered throughout the codebase
function calculatePrice(item) {
  let price = item.basePrice;
  if (featureFlags.isEnabled("new-pricing")) {
    price = item.basePrice * 1.1; // new margin
  }
  if (featureFlags.isEnabled("new-pricing") && item.category === "premium") {
    price += item.premiumSurcharge; // only in new pricing
  }
  // ... 15 more conditionals
  return price;
}
```

**Rule:** A feature flag should appear in at most 2-3 places in the code — the entry points where the new path diverges from the old. If it appears in more than 5 places, refactor so the flag-gated code is a separate module or component.

### Cleaning up feature flags

Every feature flag has a removal date. When the feature is fully shipped and stable:

1. Remove the flag check from code
2. Remove the old code path
3. Delete the flag from the flag service
4. Do this within 2 weeks of full rollout — stale flags accumulate into an incomprehensible codebase

---

## The merge cadence

### Merge at least once per day

If you are working on an increment for more than one day, you are either working on too large an increment or not merging intermediate progress. Even "work in progress" code can be merged if it is behind a flag or is internal infrastructure.

### Rebase before merging, not after

Keep your branch up to date with main by rebasing frequently (daily or more). This catches integration conflicts when they are small. A branch that drifts for a week accumulates conflicts that take hours to resolve.

```bash
# Do this daily
git fetch origin
git rebase origin/main

# Not this, once a week
git merge origin/main  # creates a merge commit with a week of conflicts
```

### Each merge must leave main deployable

After your increment merges, the main branch must still pass all tests, build successfully, and be deployable. This is non-negotiable. If your increment breaks something, it was not independently deployable and should have been sliced differently.

---

## Tracking increments

Before starting, write the increment plan. This is not a project plan — it is a slicing plan.

```markdown
## Feature: User Dashboard

### Increment 1: Data model [PR #101] ✅
- Dashboard table, user_dashboard_settings table
- Migration + rollback
- Model tests

### Increment 2: Read API [PR #102] ✅
- GET /api/dashboard/:userId
- Returns empty dashboard for new users
- Integration test

### Increment 3: Dashboard shell UI [PR #105] 🔄
- Empty dashboard layout component
- Fetches from read API
- Behind feature flag `new-dashboard`

### Increment 4: Widget system
- Widget registry + base component
- 3 initial widget types (stats, chart, list)

### Increment 5: Dashboard customization API
- PUT /api/dashboard/:userId/layout
- Validation for widget configuration

### Increment 6: Drag-and-drop UI
- Layout editor using widget system
- Saves to customization API
```

Update the plan as increments merge. Adjust future increments based on what you learn from earlier ones — the plan is a guide, not a contract.

---

## Common mistakes

### "I'll split it up later"

You will not. The longer you work on a single branch, the harder it becomes to extract clean increments. Slice first, implement second.

### Increments that depend on each other in the same PR

If increment 2 only works when increment 1 is also deployed, they are not independent increments — they are one increment that you gave two names.

### Skipping tests because "it's just the first increment"

Each increment ships independently, so each increment needs independent tests. The tests for increment 1 are the safety net for when increment 3 accidentally breaks the code from increment 1.

### Making the first increment too ambitious

The first increment should be almost embarrassingly small. A migration and a model. A single API endpoint. A component that renders static text. The point is to establish the pattern and prove the integration path. Ambition comes in later increments.

### Ignoring the "independently valuable" criterion

An increment that adds a database table nobody queries, an API nobody calls, and a component nobody renders is not independently valuable — it is dead code that will rot. Each increment must be used by something, even if that something is only a test suite.

---

## Verification checklist

For each increment before merging:

- [ ] The increment can be described in one sentence without using the word "and"
- [ ] All tests pass (existing + new)
- [ ] Main branch remains deployable after merge
- [ ] No debug code, TODOs for "the next PR," or half-implemented paths
- [ ] Feature flag is in place if the change is user-visible and incomplete
- [ ] The increment is reviewed independently (not "review this alongside PR #X")
- [ ] The tracking plan is updated with the PR link

---

## Related

- [implement-feature](../implement-feature/SKILL.md) — feature implementation uses incremental delivery as its shipping strategy
- [methodology-code-review](../methodology-code-review/SKILL.md) — small increments make reviews faster and more thorough
- [methodology-tdd](../methodology-tdd/SKILL.md) — TDD naturally produces small, tested increments
