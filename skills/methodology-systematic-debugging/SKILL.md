---
name: methodology-systematic-debugging
description: Use when debug-triage identified the area but the root cause is still elusive. Provides systematic hypothesis-test-eliminate loops, binary search strategies for large state spaces, and techniques for bugs that resist printf debugging.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Systematic Debugging Beyond Triage

Triage tells you WHERE to look. This skill tells you HOW to find the root cause once you are in the right area but the bug is not obvious.

Prerequisite: you have already walked the triage ladder (see [debug-triage](../debug-triage/SKILL.md)). Services are up, data is fresh, the request reaches the handler. The code is executing but producing the wrong result.

---

## Core principle: hypothesis-driven debugging

Random reading of code hoping to spot the bug is the slowest debugging method. Instead:

1. **State a hypothesis.** "I believe the bug is caused by X."
2. **Design a test.** "If X is the cause, then when I do Y, I will observe Z."
3. **Run the test.** Actually do Y and observe the result.
4. **Evaluate.** If you observed Z, the hypothesis is supported (not proven — keep testing). If you did not observe Z, the hypothesis is eliminated. Move on.

Write your hypotheses down. Not in your head — in a scratch note, a comment, or the chat. Debugging fails when you lose track of what you have already ruled out.

---

## Technique 1 — Binary search the execution path

When you know the input is correct and the output is wrong, but the path between them is long (10+ function calls, middleware chains, pipeline stages), do not read every function. Binary search.

### How to binary search code

1. Identify the entry point (where correct input enters) and the exit point (where wrong output leaves).
2. Find the midpoint of the execution path.
3. Add a log/breakpoint at the midpoint. Is the data correct or wrong at this point?
4. If correct at midpoint: the bug is in the second half. Repeat with midpoint-to-exit.
5. If wrong at midpoint: the bug is in the first half. Repeat with entry-to-midpoint.
6. Continue until you have narrowed to a single function or transformation.

```
Entry (correct) -> [A] -> [B] -> [C] -> [D] -> [E] -> [F] -> Exit (wrong)

Step 1: Check at [C]. Data is correct.
Step 2: Check at [E]. Data is wrong.
Step 3: Check at [D]. Data is wrong.
=> Bug is in [C] -> [D] transition. Read function D carefully.
```

This takes O(log n) checks instead of O(n). For a 10-step pipeline, that is 3-4 checks instead of 10.

### When binary search does not work

- **Non-linear execution.** Async pipelines, event-driven systems, recursive calls. You need to trace the actual execution path first, then binary search within it.
- **State mutation.** If function C modifies shared state that function F reads, the "midpoint" concept does not apply cleanly. Use Technique 3 (state diffing) instead.
- **Timing-dependent bugs.** Binary search assumes deterministic behavior. For race conditions, use Technique 4.

---

## Technique 2 — Minimal reproduction

If the bug happens in a complex context (large form, many database records, specific user account), strip away context until you find the minimal case that still reproduces.

### Reduction procedure

1. Start with the full reproduction case.
2. Remove half the context (half the form fields, half the database records, half the configuration).
3. Does the bug still reproduce?
   - Yes: remove more. The removed half was irrelevant.
   - No: add back half of what you removed. Something in that half matters.
4. Continue until you cannot remove anything without losing the reproduction.

The minimal reproduction tells you exactly which inputs/conditions trigger the bug. It also makes a perfect test case for the fix (see [methodology-tdd](../methodology-tdd/SKILL.md)).

### Common reductions

- **Database state:** Does it reproduce with a single record? With a specific field value? With a null field?
- **User state:** Does it reproduce logged out? With a different role? With a fresh session?
- **Input data:** Does it reproduce with a single character? With an empty string? With special characters?
- **Timing:** Does it reproduce on first load? Only after navigation? Only after idle timeout?

---

## Technique 3 — State diffing

For bugs where the state is wrong but you cannot see where it changed, capture the state at multiple points and diff.

### Manual state diffing

```ts
// Add temporary logging at each state transition
console.log("BEFORE transform:", JSON.stringify(state, null, 2));
const result = transform(state);
console.log("AFTER transform:", JSON.stringify(result, null, 2));
```

Compare the outputs. The diff between BEFORE and AFTER shows exactly what changed. If the change is unexpected, you have found your bug location.

### Automated state diffing

For complex state (Redux stores, database snapshots):

```ts
// Snapshot before
const before = JSON.parse(JSON.stringify(store.getState()));
// ... operation ...
const after = store.getState();

// Deep diff (use a library or write a quick recursive diff)
const changes = deepDiff(before, after);
console.log("State changes:", changes);
```

### Database state diffing

```sql
-- Snapshot a table before the operation
CREATE TEMP TABLE users_before AS SELECT * FROM users;
-- Run the operation
-- Compare
SELECT 'modified', a.id, a.name, b.name
FROM users a JOIN users_before b ON a.id = b.id
WHERE a.name != b.name;
```

---

## Technique 4 — Concurrency and timing bugs

These are the hardest category. The bug does not reproduce reliably, or it only appears under load, or it depends on the order of async operations.

### Identifying timing bugs

Signs you are dealing with a timing bug:

- "It works sometimes." Deterministic code does not have this property.
- The bug disappears when you add logging. (The logging changes timing.)
- The bug only appears under load or slow network.
- The bug appears after navigation but not on direct page load.

### Debugging strategy for timing bugs

1. **Identify the shared resource.** What state is being read and written by concurrent operations? (Database row, in-memory variable, cache key, DOM element, file)
2. **Map the access pattern.** Which operations read it? Which write it? In what order SHOULD they execute? In what order MIGHT they execute?
3. **Look for missing synchronization.** Is there a lock, mutex, transaction, or serialization mechanism? Is it actually being used?
4. **Reproduce deterministically.** Add artificial delays to force the problematic ordering:

```ts
// Force operation B to complete before operation A
async function operationA() {
  await sleep(100); // Artificial delay
  const data = await fetch("/api/data");
  setState(data);
}

async function operationB() {
  const data = await fetch("/api/other");
  setState(data); // This now always wins the race
}
```

If the bug reproduces with the artificial delay, you have confirmed the race condition and identified the ordering that causes it.

### Common race condition patterns

- **Read-modify-write without atomicity.** Two requests read the same counter, both increment, both write — one increment is lost.
- **Check-then-act without locking.** "If slot is available, book it" — two concurrent requests both see "available."
- **Stale closure over state.** React `useEffect` captures a stale value because the dependency array is incomplete.
- **Async cleanup not cancelling.** Component unmounts but the fetch callback still runs and calls `setState`.

---

## Technique 5 — Rubber duck with structure

When you are stuck, explain the bug to yourself (or the chat) using this template:

1. **What I expect to happen:** [describe the correct behavior]
2. **What actually happens:** [describe the incorrect behavior]
3. **What I have ruled out so far:** [list eliminated hypotheses]
4. **What I have not checked yet:** [list remaining hypotheses]
5. **The thing I am most reluctant to check:** [this is usually the answer]

Point 5 is key. The hypothesis you are avoiding — "maybe the library has a bug," "maybe the migration did not run," "maybe I am looking at the wrong environment" — is disproportionately likely to be correct, because you have been avoiding it while pursuing more comfortable hypotheses.

---

## Technique 6 — Git bisect for regressions

If the bug was not present before and is present now, use git bisect to find the exact commit that introduced it.

```bash
git bisect start
git bisect bad              # Current commit has the bug
git bisect good abc123      # This older commit did not have the bug
# Git checks out a midpoint. Test it.
git bisect good             # or git bisect bad
# Repeat until git identifies the first bad commit
git bisect reset            # Return to your branch when done
```

For automated bisect (if you have a test that reproduces the bug):

```bash
git bisect start HEAD abc123
git bisect run npm test -- --grep "the failing test"
```

This finds the exact commit in O(log n) steps. For 100 commits between good and bad, that is ~7 tests.

---

## When to stop and ask for help

Systematic debugging has diminishing returns. Recognize when to escalate:

- **You have eliminated all your hypotheses** and have no new ones. You need fresh eyes.
- **The bug requires domain knowledge you do not have.** (Cryptography, database internals, OS-level behavior)
- **Reproducing requires infrastructure you do not have access to.** (Production database, specific hardware, external service)
- **You have spent more than 2 hours** on a single hypothesis without progress. Step back.

When asking for help, provide: the problem statement, what you have tried, what you have ruled out, and your current best hypothesis. This respects the helper's time and gets you better answers.

---

## Debugging checklist

Before declaring "I am stuck":

- [ ] I have stated at least 3 hypotheses and tested each one
- [ ] I have binary-searched the execution path to narrow the location
- [ ] I have checked the actual data at the point of failure (not assumed it)
- [ ] I have verified I am debugging the right environment/branch/build
- [ ] I have checked for the "obvious" causes I was reluctant to consider
- [ ] I have a minimal reproduction case (or know why I cannot create one)

---

## Related

- [debug-triage](../debug-triage/SKILL.md) — the triage ladder that precedes systematic debugging
- [methodology-tdd](../methodology-tdd/SKILL.md) — writing a failing test as the reproduction case
- [diagnose-intermittent-failure](../diagnose-intermittent-failure/SKILL.md) — specialized techniques for flaky/intermittent bugs
