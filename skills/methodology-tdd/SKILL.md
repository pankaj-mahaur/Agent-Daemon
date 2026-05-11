---
name: methodology-tdd
description: Use when building new features or fixing bugs where test coverage matters. Enforces red-green-refactor discipline, guides test granularity decisions, and prevents common TDD anti-patterns like writing tests after the fact or testing implementation details.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Test-Driven Development Discipline

TDD is not "write tests." It is a specific loop — red, green, refactor — that forces you to define behavior before implementing it. The loop matters more than test coverage numbers.

This skill enforces the discipline. It is not a testing tutorial.

---

## The loop

### Step 1 — Red: write a failing test FIRST

Before touching production code, write exactly one test that describes the next behavior you want. The test must:

- **Fail for the right reason.** A test that fails because of a typo in the test file teaches you nothing. Run it, read the failure message, confirm it says "expected X but got Y" (or "function not found" / "endpoint returns 404"). That failure is your specification.
- **Test behavior, not implementation.** "When I call `createUser({name: 'Alice'})`, the returned object has `id` and `name`" is behavior. "When I call `createUser`, it calls `db.insert` once" is implementation. Implementation tests break on every refactor.
- **Be small.** One assertion per behavior. If you need three assertions, you likely need three tests. Exception: asserting on multiple fields of the same return value is fine as one test.

```ts
// Good: tests behavior
test("createUser returns user with generated id", async () => {
  const user = await createUser({ name: "Alice" });
  expect(user.id).toBeDefined();
  expect(user.name).toBe("Alice");
});

// Bad: tests implementation detail
test("createUser calls db.insert", async () => {
  const spy = jest.spyOn(db, "insert");
  await createUser({ name: "Alice" });
  expect(spy).toHaveBeenCalledTimes(1);
});
```

### Step 2 — Green: make it pass with the simplest code

Write the minimum production code that makes the test pass. Not elegant code. Not generalized code. The dumbest thing that works.

- If the test expects `return 42`, write `return 42`. Seriously.
- If the test expects a user object, return a hardcoded object that matches.
- Resist the urge to "while I'm here" generalize. That comes in Step 3 or the next cycle.

The point: you prove the test is actually testing something, and you avoid writing code that no test exercises.

### Step 3 — Refactor: clean up under green tests

Now — and only now — improve the code. Extract helpers, remove duplication, rename variables, restructure. The tests stay green throughout. If a refactor breaks a test, you either broke behavior (revert the refactor) or the test was testing implementation (fix the test).

**Refactoring under green tests is the payoff.** This is why you wrote the test first — so you can restructure with confidence.

---

## Deciding test granularity

Not everything needs a unit test. Not everything needs an integration test. The decision tree:

### Unit test when:

- Pure function (input -> output, no side effects)
- Complex branching logic (multiple conditions, edge cases)
- Data transformation or validation
- Algorithmic code

### Integration test when:

- Database queries (ORM behavior matters; mocking it defeats the purpose)
- API endpoint handler (test the full request-response cycle)
- Middleware chains (auth -> validation -> handler -> response)
- File I/O, external service calls (with test doubles for the external part)

### End-to-end test when:

- Critical user flows (login, checkout, data export)
- Flows that cross multiple services
- Anything where "it works in isolation but breaks when composed" has bitten you before

### Skip tests when:

- Trivial glue code (a function that calls one other function and returns its result)
- Configuration constants
- Type definitions
- Generated code (test the generator, not the output)

**Common mistake:** Testing trivial getters/setters to hit coverage numbers. This adds maintenance burden with zero bug-prevention value.

---

## Test structure: Arrange-Act-Assert

Every test body follows three sections. Keep them visually distinct.

```ts
test("deactivateUser sets active to false and records timestamp", async () => {
  // Arrange — set up preconditions
  const user = await createUser({ name: "Alice", active: true });

  // Act — perform the operation under test
  const result = await deactivateUser(user.id);

  // Assert — verify the outcome
  expect(result.active).toBe(false);
  expect(result.deactivatedAt).toBeDefined();
});
```

If Arrange is more than 5-6 lines, extract a factory or fixture. If Act is more than one call, you are testing two things.

---

## Naming tests

Test names should read as behavior specifications. Someone who has never seen the code should understand what the system does from test names alone.

```
// Good — reads as a spec
"createUser returns user with generated id"
"createUser throws when name is empty"
"createUser trims whitespace from name"
"listUsers returns only active users by default"
"listUsers includes inactive users when filter is 'all'"

// Bad — describes implementation
"test createUser"
"should work correctly"
"handles the edge case"
```

---

## When fixing a bug: write the failing test BEFORE the fix

This is the highest-value TDD practice. When a bug is reported:

1. Write a test that reproduces the bug. Run it. Watch it fail.
2. Fix the bug.
3. Run the test. Watch it pass.
4. The bug can never silently regress.

**If you cannot write a test that fails before your fix, you don't understand the bug yet.** Go back to debugging.

---

## Common TDD anti-patterns

### Writing tests after the code

This is "test-confirmed development," not TDD. The tests are shaped by what the code does, not what it should do. They tend to test implementation details and miss edge cases.

### Testing through mocks all the way down

If your test mocks the database, mocks the HTTP client, mocks the file system, and mocks the logger — what is it testing? The glue between mocks. Prefer integration tests with real (test) databases for data-layer code.

### One giant test per feature

A single test that sets up 15 objects, calls 4 methods, and makes 12 assertions. When it fails, you have no idea which behavior broke. Split it.

### Testing private methods directly

If you need to test a private method, it is either complex enough to extract into its own module (and test the public API of that module), or you can test it indirectly through the public method that calls it.

### Chasing coverage numbers

80% coverage with meaningful tests is better than 100% coverage that includes `expect(true).toBe(true)`. Coverage tools measure which lines executed, not whether assertions caught bugs.

---

## TDD in a legacy codebase (no existing tests)

You cannot TDD a feature inside untested code without some preparation:

1. **Characterization tests first.** Before changing anything, write tests that capture the current behavior — even if that behavior is wrong. These are your safety net.
2. **Seam identification.** Find the boundaries where you can inject test doubles. Constructor injection, function parameters, module boundaries.
3. **Expand the tested surface gradually.** Each bug fix and feature adds tests. Over time the tested area grows outward from the parts you touch most.

Do not attempt a "let's add tests to everything" sprint. It will produce low-value tests and burn out the team.

---

## Verification checklist

Before declaring a TDD cycle complete:

- [ ] Every new behavior has a test that was written before the implementation
- [ ] All tests pass (`npm test` / `pytest` / `cargo test` / `go test ./...`)
- [ ] No test depends on execution order (run with `--randomize` if your runner supports it)
- [ ] No test depends on real time (`setTimeout`, `Date.now()` — use fakes)
- [ ] No test leaks state (database rows, temp files, global variables) to other tests
- [ ] The bug-fix test fails when you revert the fix (verify this mentally or actually)

---

## Git checkpoints per TDD stage

When the repo is under Git, commit at each stage of the loop so reviewers can replay your work. Sourced from [`tdd-workflow`](https://github.com/affaan-m/everything-claude-code/blob/main/skills/tdd-workflow/SKILL.md) (MIT) — see [Sources](#sources).

Compact form (3 commits per cycle, fewer if obvious):

| Commit | Stage | Message form |
|---|---|---|
| 1 | RED — failing test added | `test: add failing test for <behavior>` |
| 2 | GREEN — minimal fix lands | `fix: <behavior> (passes test from prev commit)` |
| 3 | (optional) REFACTOR | `refactor: <small change>, still green` |

Rules:

- Don't squash or rewrite these until the cycle is complete and reviewed.
- Only commits on the **current branch reachable from `HEAD`** count as checkpoints. Don't claim a checkpoint from an older branch.
- A test commit clearly corresponding to RED + a fix commit clearly corresponding to GREEN is enough — you don't need a separate evidence-only commit.

## Coverage targets

80% minimum across the three test layers is a useful floor — not a ceiling, not a target to game:

- **Unit** — pure functions, helpers, isolated component logic.
- **Integration** — API endpoints, DB operations, service-to-service, external API mocks at the boundary.
- **E2E** — critical user flows via Playwright (or equivalent). One per major journey, not per page.

Lines covered ≠ behavior covered. A test that runs a line but doesn't assert anything is dead weight — see "Chasing coverage numbers" above.

## Sources

- Methodology framing (red-green-refactor cadence, test pyramid, anti-patterns): obra/superpowers methodology skills, MIT.
- Git-checkpoint discipline + 80% three-layer coverage target: [affaan-m/everything-claude-code skills/tdd-workflow](https://github.com/affaan-m/everything-claude-code/blob/main/skills/tdd-workflow/SKILL.md), MIT.

## Related

- [implement-feature](../implement-feature/SKILL.md) — uses TDD during the build phase
- [methodology-refactoring](../methodology-refactoring/SKILL.md) — refactoring is Step 3 of the TDD loop
- [debug-triage](../debug-triage/SKILL.md) — identifying the bug before writing the reproduction test
