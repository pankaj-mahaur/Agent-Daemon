---
name: methodology-writing-plan
description: Use when a non-trivial change needs a plan before code. Covers scoping, dependency ordering, risk identification, and checkpoint design so the implementation does not stall mid-way or produce an unreviewable mega-diff.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Writing an Implementation Plan

A plan is not a design document. It is an ordered list of steps that gets you from the current state to the desired state, with enough detail that each step can be executed without re-thinking the whole problem.

Write a plan when: the change touches more than 2-3 files, spans multiple layers (frontend + backend + migration), or involves a sequence where order matters. Skip it when the change is obvious and self-contained.

---

## Step 1 — Define the target state

Before planning how to get there, describe where "there" is. One to three sentences:

- What does the system do after this change that it does not do now?
- What does the user see or experience differently?
- What constraint or requirement does this satisfy?

Example:
> "After this change, the `/api/reports` endpoint accepts an optional `format=csv` query param and returns a downloadable CSV file. The dashboard 'Export' button calls this endpoint with the current filters applied."

Do NOT describe the implementation in the target state. Describe the outcome.

---

## Step 2 — Inventory what exists

Before writing any new code, map what already exists that is relevant:

1. **Existing code in the change path.** Read the files you will modify. Note their current structure, conventions, imports, and test coverage.
2. **Shared utilities.** Grep for helpers, hooks, services, and middleware that the new code should reuse (see [implement-feature](../implement-feature/SKILL.md) Phase 0-1).
3. **Similar features.** Find a feature that already does something analogous. Its file structure, test patterns, and API shape are your template.
4. **Migration state.** If the change requires a schema change, check the current migration chain. Is the schema stable or mid-migration?

The inventory prevents two failure modes: reinventing utilities that exist, and designing a structure that conflicts with what is already there.

---

## Step 3 — Break into steps

Each step in the plan should be:

- **Independently testable.** After completing the step, you can verify it works without completing the next step.
- **Independently committable.** The codebase is in a valid state after each step. Tests pass, the app runs (possibly with the new feature hidden or incomplete).
- **Ordered by dependency.** If step 3 depends on step 2, step 2 comes first. If steps are independent, order them by risk (hardest/riskiest first).

### Step sizing

A step should produce a diff that a reviewer can understand in one sitting (under 400 lines changed, ideally under 200). If a step is larger, split it.

- **Too big:** "Implement the reports feature" (touches model, migration, API handler, serializer, frontend component, tests)
- **Right size:** "Add `format` field to ReportQuery schema and write unit tests for CSV serialization"

### Step ordering heuristics

1. **Data model first.** Schema changes, migrations, new models/types. Everything else depends on the data shape.
2. **Backend logic second.** Business logic, service functions, validation — the core behavior independent of transport.
3. **API surface third.** Endpoints, serializers, request/response contracts. This is where frontend and backend agree on shape.
4. **Frontend wiring fourth.** API client calls, state management, component integration.
5. **UI polish last.** Styling, animations, loading states, error states.

This order means each step has its dependencies already in place. Reversing it (UI first, then backend) creates throwaway work when the data shape changes.

### Handling the "but I need to see it working end-to-end" urge

The temptation is to spike a thin vertical slice first. This is valid for exploration but not for the plan. If you need a spike:

1. Do the spike as Step 0. Time-box it (1-2 hours max).
2. Throw away the spike code. Its purpose was to inform the plan, not to ship.
3. Write the plan based on what you learned.

---

## Step 4 — Identify risks and unknowns

For each step, ask:

- **What could go wrong?** (Migration fails, API contract mismatch, performance issue at scale)
- **What am I assuming that I have not verified?** (The existing helper handles edge case X, the library supports feature Y)
- **What external dependency could block me?** (Waiting on another team's API, waiting on a design, waiting on a library release)

Mark risks explicitly in the plan. Example:

```
Step 3: Add CSV serialization to ReportService
  RISK: The existing `csvExport` utility does not handle nested objects.
        Need to verify before starting. If it does not, extend it (adds ~2h).
```

Risks that you identify up front are manageable. Risks you discover mid-implementation cause plan rewrites.

---

## Step 5 — Define checkpoints

A checkpoint is a moment where you pause, verify the plan is still valid, and decide whether to continue, adjust, or stop.

Place checkpoints:

- **After the riskiest step.** If the risk materialized, the plan may need to change.
- **After the data model is in place.** Before building on top of it, confirm the shape is right.
- **At the halfway point.** Is the remaining effort what you expected?
- **Before the point of no return.** If the plan involves a destructive migration, a public API change, or a deploy — checkpoint before that.

At each checkpoint, answer three questions:

1. Is the plan still correct, or has something changed?
2. Is the scope still the same, or has it grown?
3. Should I continue, adjust the plan, or stop and re-plan?

---

## Plan format

Use this template. Adjust section depth to match complexity.

```markdown
## Target state
[1-3 sentences describing the outcome]

## Steps

### Step 1: [short title]
- What: [what this step produces]
- Files: [files created or modified]
- Tests: [what tests are added or updated]
- Depends on: [nothing / Step N]

### Step 2: [short title]
- What: [what this step produces]
- Files: [files created or modified]
- Tests: [what tests are added or updated]
- Depends on: [Step 1]
- RISK: [if any]

### Checkpoint: [after Step N]
- Verify: [what to check]
- Decision: continue / adjust / re-plan

### Step 3: ...

## Out of scope
- [things explicitly deferred]

## Open questions
- [things that need answers before or during execution]
```

---

## Common planning mistakes

### Planning too far ahead

If the change will take more than a week, plan only the first 3-4 days in detail. The rest will change based on what you learn. Write "Steps 5-8: TBD after checkpoint" and move on.

### Planning at the wrong level of detail

- **Too vague:** "Step 2: implement the backend." This is not a step; it is a project.
- **Too detailed:** "Step 2a: create file `src/services/report.ts`. Step 2b: add import for `csv-stringify`. Step 2c: write function signature." This is pseudocode, not a plan.
- **Right level:** "Step 2: Add `ReportService.exportCsv(filters)` that queries the database with the given filters and returns a CSV string. Test with 3 cases: empty result, single row, row with special characters."

### Skipping the inventory

Starting to plan without knowing what exists leads to steps that conflict with the codebase. "Add a date formatting utility" is wasted when `formatDate` already exists in `@/lib/date`.

### No checkpoints

A plan without checkpoints is a waterfall. You discover the plan was wrong only at the end, after doing all the work.

### Scope creep during planning

The plan is for the change you agreed on, not for every improvement you noticed along the way. If you discover something else that should be fixed, note it under "Out of scope" and file a follow-up.

---

## When NOT to write a plan

- **Trivial changes.** Renaming a variable, fixing a typo, updating a dependency version.
- **Well-understood patterns.** Adding a new CRUD endpoint in a project that already has 10 of them. Follow the existing pattern; no plan needed.
- **Exploratory work.** If you do not know enough to plan, do a time-boxed spike first (see Step 3 above).
- **Emergency fixes.** If the site is down, fix it first, plan the proper solution later.

---

## After the plan: execution discipline

- **Follow the plan.** Do not jump ahead to later steps because they seem more interesting.
- **Update the plan when reality diverges.** If a step takes twice as long as expected, adjust the remaining steps. Do not pretend the plan is still accurate.
- **Commit at step boundaries.** Each completed step is a commit. This makes the PR reviewable and the history bisectable.
- **Stop at checkpoints.** Actually pause and assess. Do not skip checkpoints to "save time."

---

## Related

- [methodology-brainstorm](../methodology-brainstorm/SKILL.md) — generating and evaluating options before choosing what to plan
- [implement-feature](../implement-feature/SKILL.md) — executing the plan once it is written
- [methodology-tdd](../methodology-tdd/SKILL.md) — each step in the plan should follow the TDD loop
