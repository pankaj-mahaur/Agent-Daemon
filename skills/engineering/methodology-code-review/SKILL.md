---
name: methodology-code-review
description: Use when reviewing PRs, diffs, or code changes for quality and correctness. Provides a structured review order, severity classification, and guidance on distinguishing real bugs from style preferences to produce actionable feedback.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Code Review Methodology

A code review is not a test suite. Tests verify that code does what the programmer intended. A review verifies that what the programmer intended is correct, safe, maintainable, and consistent with the project.

This skill provides the review discipline. It applies whether you are reviewing a PR from a teammate, auditing your own changes before commit, or reviewing AI-generated code.

---

## Review order matters

Do not read the diff top-to-bottom by filename. That order is alphabetical, not logical. Instead:

### Pass 1 — Understand intent (2 minutes)

Read the PR title, description, and linked issue. Answer:

- What user-facing behavior is changing?
- What is the claimed scope? (Feature, bugfix, refactor, test)
- Are there any stated constraints or tradeoffs?

If the PR has no description, ask for one. Reviewing code without knowing its purpose means reviewing syntax, not logic.

### Pass 2 — Architecture and data flow (5 minutes)

Skim the full file list. Identify:

- **Data model changes.** Migrations, schema files, type definitions. Review these first — everything else depends on the data shape.
- **API contract changes.** New or modified endpoints, request/response shapes, serializers. These are the hardest to change later.
- **New dependencies.** Added packages, imported libraries. Each one is a long-term maintenance commitment.

Read these files carefully. A bug in the data model or API contract cascades everywhere.

### Pass 3 — Logic and correctness (the bulk of the review)

Now read the implementation files. For each file, focus on:

1. **Happy path correctness.** Does the normal case produce the right result?
2. **Error paths.** What happens when input is invalid, the database is down, the network call fails? Are errors surfaced to the user or silently swallowed?
3. **Edge cases.** Empty arrays, null values, zero quantities, maximum lengths, concurrent access.
4. **Security.** User input used in queries without sanitization, auth checks missing, secrets in code.

### Pass 4 — Tests (verify coverage of what matters)

Read the tests last, after you understand the implementation. Check:

- Do the tests cover the behavior described in the PR? Not just "do tests exist" but "do they test the right things?"
- Do edge cases identified in Pass 3 have tests?
- Are the tests testing behavior or implementation details? (See [methodology-tdd](../methodology-tdd/SKILL.md))
- Could the tests pass even if the implementation is wrong? (Tests that mock everything test nothing.)

### Pass 5 — Style and conventions (lowest priority)

Naming, formatting, import order, comment quality. These matter but should never block a PR unless they violate project-wide conventions. Linters should catch most of these; if they do not, fix the linter config — do not nag humans about what machines can enforce.

---

## Severity classification for findings

Every review comment should carry an implicit or explicit severity:

### Blocking (must fix before merge)

- Incorrect behavior in the normal path
- Security vulnerability (SQL injection, XSS, auth bypass, exposed secrets)
- Data loss risk (migration that drops data without backup, destructive operation without confirmation)
- Breaking change to public API without versioning
- Missing error handling in critical paths (payment, auth, data persistence)

### Should-fix (fix before merge unless there is a stated reason not to)

- Missing edge case handling that will cause bugs under realistic conditions
- Race condition or concurrency issue
- Missing test for a non-trivial behavior change
- Performance issue that affects real users (N+1 query, unbounded memory allocation)
- Inconsistency with established project patterns

### Suggestion (non-blocking, take it or leave it)

- Alternative approach that is slightly cleaner
- Naming improvement
- Additional test case that would be nice to have
- Comment clarification
- Stylistic preference

### Praise (do this too)

- Particularly clean solution to a hard problem
- Good test coverage
- Well-handled edge case
- Clear documentation

Praise is not filler. It tells the author what to keep doing and builds trust that your critiques are about the code, not the person.

---

## Writing good review comments

### Bad review comments

```
"This is wrong."                    — Wrong how? What should it be?
"Why didn't you use X?"             — Sounds accusatory. Maybe they had a reason.
"Nit: ..."                          — If it's a nit, should you even mention it?
"Can you add tests?"                — Which tests? For what behavior?
"I would have done this differently." — So? Is their way incorrect?
```

### Good review comments

```
"Bug: `users.filter(u => u.active)` should be `u.role === 'admin' && u.active`
based on the requirement in issue #42. Without the role check, non-admin users
will see the admin dashboard."

"Edge case: what happens when `items` is an empty array here? `items[0].name`
will throw. Consider adding an early return or a guard."

"Suggestion (non-blocking): this could use the existing `formatCurrency()`
helper from `@/lib/format` instead of inline formatting. Not blocking but would
reduce duplication."

"The race condition test on line 47 is excellent — I would not have thought to
test that ordering."
```

The pattern: **what is wrong + why it matters + what to do instead.**

---

## Common review mistakes

### Reviewing style instead of substance

If you spend more time commenting on variable names than on logic correctness, recalibrate. A bug in production costs more than a suboptimal name.

### Reviewing only the diff, not the context

The diff shows what changed, not what the changed code interacts with. Read the surrounding code in the file. A function that looks correct in isolation may be incorrect in context (wrong parameter order, different return type than callers expect, missing a step that neighboring functions include).

```bash
# Read the full file, not just the diff hunks
git show HEAD:path/to/file.ts
# Or read the file directly
```

### Approving because "it looks fine"

If you cannot explain what the PR does after reading it, you have not reviewed it. Do not approve. Ask questions. "I don't understand the purpose of X" is a valid review comment.

### Blocking on preferences

If the code is correct, tested, and consistent with project conventions, do not block it because you would have written it differently. Reserve blocks for correctness and safety issues.

### Reviewing too much at once

A 2000-line PR gets a shallow review because the reviewer is fatigued by line 500. If the PR is too large, request it be split. Review in multiple sessions if splitting is not possible.

---

## Reviewing specific change types

### Migrations / schema changes

- Is the migration reversible? (Does it have a `down` method?)
- Does it handle existing data? (Adding a NOT NULL column without a default breaks existing rows)
- Are indexes added for columns used in WHERE/JOIN/ORDER BY?
- Is there a data migration for existing records, or are they left in an invalid state?

### API changes

- Is the change backward compatible? If not, is versioning in place?
- Are new required fields truly required, or should they have defaults?
- Does the error response shape match the project's convention?
- Is input validation present for all user-controlled fields?

### Security-sensitive code

- User input in SQL queries: parameterized or concatenated?
- HTML rendering: escaped or raw?
- Auth checks: present on every endpoint that needs them, or just the obvious ones?
- Secrets: hardcoded or from environment/config?
- File uploads: validated for type and size?

### Dependency additions

- Is the dependency actively maintained? (Check last commit date, open issues, download stats)
- Does the license permit use in this project?
- Does it overlap with an existing dependency? (Adding `lodash` when `ramda` is already in the project)
- Is it the smallest dependency that solves the need? (Adding a 200KB library for one utility function)

---

## Self-review before requesting others

Before pushing code for review, review it yourself using this checklist:

- [ ] I can explain what each changed file does and why
- [ ] I have run the tests and they pass
- [ ] I have checked for debug code (console.log, TODO, commented-out blocks)
- [ ] I have checked for secrets, credentials, or API keys
- [ ] I have verified the PR description explains the change
- [ ] I have read the diff as if someone else wrote it
- [ ] I have considered what a malicious or careless user could do with the new inputs

The last point catches more security bugs than any automated tool.

---

## Review output format

When presenting review findings, group by severity:

```
## Blocking
1. [file:line] Description of the bug/vulnerability. Suggested fix.

## Should-fix
1. [file:line] Description of the issue. Why it matters. Suggested fix.
2. [file:line] ...

## Suggestions
1. [file:line] Non-blocking improvement. Rationale.

## Praise
1. [file:line] What is good and why.

## Summary
[1-2 sentences: overall assessment and recommendation (approve / request changes)]
```

---

## Related

- [review-slice](../review-slice/SKILL.md) — deep-reviewing a feature area in a running application
- [methodology-tdd](../methodology-tdd/SKILL.md) — evaluating test quality during review
- [security-audit](../security-audit/SKILL.md) — focused security review beyond general code review
- [methodology-refactoring](../methodology-refactoring/SKILL.md) — when a review suggests structural improvements
