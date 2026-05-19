---
name: methodology-refactoring
description: Use when restructuring code without changing behavior. Provides a safe refactoring loop with verification at each step, common refactoring patterns, and guidance on when to stop — because refactoring without discipline becomes a rewrite.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Safe Refactoring Methodology

Refactoring is changing the structure of code without changing its behavior. The definition matters: if behavior changes, it is not a refactoring — it is a feature change or a bug fix, and needs different treatment (tests, user communication, migration path).

The core risk of refactoring is breaking things while "improving" them. This skill provides the discipline to refactor safely.

---

## The refactoring loop

Every refactoring — no matter how small — follows this loop:

1. **Verify tests pass.** Run the existing test suite. If tests are broken before you start, fix them first or document the failures. You need a green baseline.
2. **Make one structural change.** One rename, one extraction, one inlining, one movement. Not three changes at once.
3. **Run tests.** Do they still pass?
   - **Yes:** Commit. Move to the next change.
   - **No:** Revert the change. The refactoring was not behavior-preserving. Either the change was wrong, or the tests are too tightly coupled to implementation (fix the tests separately, then retry).
4. **Repeat.**

The commit-per-change discipline is not pedantic. It gives you a clean revert point. When step 17 of a refactoring breaks something, you revert to step 16, not to the beginning.

---

## Before you start: pre-flight checks

### 1. Do you have sufficient test coverage?

Refactoring without tests is walking a tightrope without a net. Before starting:

```bash
# Check coverage for the files you plan to touch
# Node
npx jest --coverage --collectCoverageFrom='src/services/report.ts'
# Python
pytest --cov=app.services.report tests/
# Go
go test -cover ./services/report/
```

If coverage is below ~60% for the files you plan to change, write characterization tests first. These tests capture the current behavior (even if that behavior has bugs). They are your safety net.

```ts
// Characterization test — captures current behavior, not desired behavior
test("processOrder returns order with calculated total", () => {
  const result = processOrder({ items: [{ price: 10, qty: 2 }] });
  // I observed this output from the current code. If refactoring changes it,
  // the test will fail and I will know I broke something.
  expect(result.total).toBe(20);
  expect(result.status).toBe("pending");
});
```

### 2. Is this the right time to refactor?

Refactor when:

- You are about to add a feature and the current structure makes it awkward
- You have just fixed a bug and the code around it is fragile
- You are in the TDD refactoring step (green -> refactor -> green)
- A code review identified structural issues

Do NOT refactor when:

- You are on a deadline and the current code works
- You are refactoring "because it's ugly" but it is not in your current change path
- You are in the middle of debugging (refactor after the fix, not during)
- You do not have tests and cannot write them first

### 3. Define the scope boundary

Before starting, state explicitly:

- What files/modules will you touch?
- What will the structure look like when you are done?
- What will you NOT change? (this prevents scope creep)

Write it down. When you are three hours into a refactoring and think "while I'm here, I should also...", check the scope boundary. If it is outside scope, note it for later.

---

## Common refactoring patterns

### Extract function

**When:** A block of code inside a function does one thing that can be named.
**Mechanical steps:**
1. Identify the block.
2. Determine its inputs (variables it reads) and outputs (variables it sets or the value it produces).
3. Create a new function with the inputs as parameters and the output as return value.
4. Replace the block with a call to the new function.
5. Run tests.

**Common mistake:** Extracting a function that takes 8 parameters. If extraction requires that many inputs, the code needs a different decomposition (extract a class/module, or restructure the data flow).

### Inline function

**When:** A function does nothing but delegate to another function, or its name adds no clarity beyond reading the body.
**Mechanical steps:**
1. Verify the function is called from a small number of places.
2. Replace each call site with the function body, substituting parameters.
3. Delete the function.
4. Run tests.

**Common mistake:** Inlining a function that is called from 20 places. That is not simplification; that is duplication.

### Rename

**When:** The current name is misleading, ambiguous, or inconsistent with project conventions.
**Mechanical steps:**
1. Use your editor/IDE's rename refactoring (not find-and-replace, which misses scope).
2. If renaming across files, use a project-wide rename tool or grep carefully.
3. Update documentation, comments, and error messages that reference the old name.
4. Run tests.

**Common mistake:** Renaming a public API symbol without a deprecation period. External callers break silently.

### Move to a new module

**When:** A function/class lives in a module it does not belong to (wrong layer, wrong domain).
**Mechanical steps:**
1. Create the target module (or identify the existing one).
2. Move the code.
3. Update all import paths.
4. Run tests.
5. Check for circular dependencies introduced by the move.

**Common mistake:** Moving code that has circular dependencies with its old location. The move makes the cycle explicit, which is useful, but you need to break the cycle — not just move one side of it.

### Replace conditional with polymorphism

**When:** A switch/if-else chain on a type discriminator appears in multiple functions.
**Mechanical steps:**
1. Identify the discriminator (e.g., `user.type`, `event.kind`).
2. Create an interface/base class with a method for each behavior.
3. Create implementations for each case.
4. Replace the switch/if-else with a method call on the polymorphic object.
5. Run tests.

**When NOT to apply:** If the switch appears in exactly one place and has 2-3 cases, polymorphism adds indirection without benefit. The pattern pays off at 3+ locations or 5+ cases.

### Consolidate duplicate code

**When:** Two or more blocks of code do nearly the same thing with minor variations.
**Mechanical steps:**
1. Identify the commonality and the variation points.
2. Extract the common code into a function.
3. Parameterize the variation points (arguments, callbacks, configuration).
4. Replace each duplicate with a call to the shared function.
5. Run tests.

**Common mistake:** Over-generalizing. If the "duplicates" share 60% structure and differ in the other 40%, the shared function will accumulate conditionals and become harder to understand than the duplicates. Sometimes duplication is the lesser evil.

---

## Knowing when to stop

Refactoring has no natural stopping point. "The code could always be a little cleaner" is technically true and practically dangerous. Stop when:

- **The original goal is met.** If you started refactoring to make a feature easier to add, stop when the feature is easy to add. Do not keep going.
- **The marginal improvement is small.** The first three changes gave 80% of the benefit. The next five changes give the remaining 20%. Stop at 80%.
- **You are fighting the framework.** If the refactoring leads you to restructure around the framework's conventions, you are probably wrong. Work with the framework, not against it.
- **You are breaking unrelated tests.** This means the refactoring is leaking beyond its scope. Revert the last change and stop.
- **You have been at it for more than 2 hours without a commit.** The changes are too intertwined. Revert to the last commit and decompose the refactoring into smaller steps.

---

## Refactoring vs. rewriting

| Refactoring | Rewriting |
|---|---|
| Changes structure, preserves behavior | Changes both structure and behavior |
| Small, incremental steps | Big-bang replacement |
| Tests stay green throughout | Tests are rewritten or discarded |
| Low risk, reversible at each step | High risk, difficult to revert |
| Can be done alongside feature work | Blocks all other work on the module |

If you find yourself wanting to delete a file and rewrite it from scratch, you are not refactoring. That is a rewrite. Rewrites are sometimes necessary but they need different justification, planning, and risk management (see [methodology-writing-plan](../methodology-writing-plan/SKILL.md)).

---

## Red flags during refactoring

- **"I need to change the tests to make this work."** If the refactoring is behavior-preserving, the tests should not need to change (unless they were testing implementation details). Changing tests during a refactoring means you might be silently changing behavior.
- **"Let me also fix this bug I found."** Separate commit. A refactoring commit should contain zero behavior changes. A bug fix commit should contain the fix and its test. Mixing them makes both unreviewable.
- **"This is taking way longer than I thought."** Stop. Revert to the last green commit. Reassess whether the refactoring is worth the cost, or whether a different approach would be simpler.
- **"I need to touch 30 files."** Consider whether you can refactor incrementally — change 5 files now, ship, change 5 more next week. The strangler pattern works for refactoring too.

---

## Commit discipline during refactoring

- One structural change per commit.
- Commit message format: `refactor(scope): what changed structurally`
- The commit message says what the structure change is, not what the behavior change is (there should be no behavior change).
- Stage explicitly by name. Never `git add -A`.
- Run the full test suite before each commit, not just the tests for the changed file.

```bash
# Good refactoring commits
refactor(auth): extract token validation into dedicated module
refactor(reports): rename exportData to exportCsvReport
refactor(orders): replace type switch with OrderProcessor interface
refactor(users): consolidate duplicate permission checks into canAccess()

# Bad refactoring commits
refactor: cleanup
refactor: improvements
refactor: various changes
```

---

## Related

- [methodology-tdd](../methodology-tdd/SKILL.md) — the refactoring step is part of the TDD loop
- [methodology-code-review](../methodology-code-review/SKILL.md) — reviewing refactoring PRs
- [methodology-writing-plan](../methodology-writing-plan/SKILL.md) — planning large refactorings that span multiple sessions
- [implement-feature](../implement-feature/SKILL.md) — refactoring often precedes feature implementation
