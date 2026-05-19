---
name: methodology-architectural-decision
description: Use when making or documenting significant architectural choices such as technology selection, pattern adoption, service boundary changes, or any decision that will be expensive to reverse. Covers the ADR format, when to write one, and how to evaluate alternatives rigorously.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Architectural Decision Records

Architectural decisions are the choices that are expensive to reverse: which database to use, how services communicate, where the authentication boundary lives, whether to use a monolith or microservices. These decisions outlast the people who made them — and when nobody remembers why a choice was made, the next developer either repeats the evaluation from scratch or makes a worse choice because they lack the original context.

An Architectural Decision Record (ADR) captures the decision, the context, the alternatives considered, and the rationale. It is not a design document — it is a decision log entry.

---

## When to write an ADR

Write an ADR when the decision:

- **Affects multiple teams or components.** Choosing a message queue affects every service that publishes or consumes events.
- **Is expensive to reverse.** Picking PostgreSQL over MongoDB means schema migrations, query patterns, and operational tooling are all built around relational assumptions. Switching later costs months.
- **Constrains future decisions.** Choosing REST over GraphQL means every future API consumer works with REST. Choosing a specific auth library means every endpoint uses its middleware.
- **Was debated.** If reasonable people disagreed, the reasoning needs to be preserved so the debate does not repeat in six months.
- **Surprises newcomers.** If someone joining the project would ask "why is this done this way?", the answer should be in an ADR.

### Do NOT write an ADR for:

- Library version choices (use a comment in package.json)
- Code style decisions (use a linter config)
- Bug fixes (use a commit message)
- Tactical choices that are easy to reverse (which utility function to use)

---

## The ADR format

Store ADRs in `docs/adr/` as numbered files: `001-use-postgresql.md`, `002-event-driven-architecture.md`.

### Template

```markdown
# ADR-NNN: [Title — present tense verb phrase]

## Status

[Proposed | Accepted | Deprecated | Superseded by ADR-NNN]

## Date

YYYY-MM-DD

## Context

[What is the situation? What problem are we solving? What constraints exist?
Be specific — mention team size, scale requirements, existing infrastructure,
deadlines, skill sets. This section should make sense to someone who was not
in the room.]

## Decision

[What we decided to do. One to three clear sentences.
"We will use X for Y because Z."]

## Alternatives Considered

### Alternative A: [name]
- **Pros:** ...
- **Cons:** ...
- **Why rejected:** ...

### Alternative B: [name]
- **Pros:** ...
- **Cons:** ...
- **Why rejected:** ...

## Consequences

### Positive
- [What becomes easier or better]

### Negative
- [What becomes harder or worse — every decision has costs]

### Risks
- [What could go wrong with this decision]

## References

- [Links to relevant docs, benchmarks, blog posts, discussions]
```

---

## Writing each section well

### Context: be honest about constraints

The context section is the most important part. It captures the situation at the time of the decision. Future readers need to understand not just what you decided, but the world you were operating in.

```markdown
// Bad context
"We needed a database."

// Good context
"We are building a multi-tenant SaaS application expecting 500 tenants
within 12 months. Each tenant's data must be isolated for compliance
(SOC 2). The team has 3 backend engineers, all experienced with
PostgreSQL. We deploy to AWS. The data model is relational — tenants
have users, users have roles, roles have permissions. Query patterns
are primarily transactional (CRUD with complex joins), not analytical."
```

The good context makes it obvious why PostgreSQL is a reasonable choice and why MongoDB would be a poor fit — before you even read the decision.

### Alternatives: evaluate honestly

The alternatives section proves you did not pick the first thing that came to mind. It also prevents future developers from proposing alternatives you already considered and rejected.

**Rules for good alternatives:**

1. **Include at least two alternatives.** If you cannot name two alternatives, you have not thought about the problem space enough.
2. **Steel-man each alternative.** Present each option's genuine strengths. If an alternative has no pros, you are biased or it is not a real alternative.
3. **State why each was rejected in concrete terms.** "We rejected MongoDB because our data model is highly relational, and denormalization would require maintaining 7 duplicate data paths" is useful. "We rejected MongoDB because it's not as good" is not.
4. **"Do nothing" is always an alternative.** Sometimes the right decision is to not decide yet — keep the current approach and revisit when you have more information.

### Consequences: include the negative ones

Every decision has costs. If your consequences section only lists positives, you are not being honest. Future developers will discover the costs anyway — it is better to document them up front.

```markdown
### Negative
- PostgreSQL requires schema migrations for every data model change,
  adding friction to rapid iteration during early development.
- Row-level security for tenant isolation adds complexity to every
  query and requires careful testing to prevent data leaks.
- The team will need to learn and maintain PostgreSQL-specific
  operational tooling (pg_dump, pg_restore, VACUUM, replication).
```

---

## The decision-making process

### Step 1 — Frame the decision

Write the Context section first. Clarify:
- What problem are we solving?
- What are the constraints (time, team, infrastructure, budget)?
- What are the requirements (functional, non-functional)?
- What is the scope of impact?

### Step 2 — Generate options

List every option, including ones that seem wrong. Wild options sometimes expose assumptions you did not know you had.

### Step 3 — Evaluate against criteria

Define explicit evaluation criteria before evaluating options. This prevents post-hoc rationalization (picking your favorite and finding criteria that support it).

Example criteria for a database choice:
| Criterion | Weight | PostgreSQL | MongoDB | DynamoDB |
|-----------|--------|-----------|---------|----------|
| Relational query support | High | Excellent | Poor | None |
| Operational complexity | Medium | Moderate | Moderate | Low (managed) |
| Team expertise | High | Strong | None | None |
| Multi-tenant isolation | High | Row-level security | Database-per-tenant | Partition key |
| Cost at expected scale | Medium | Moderate | Moderate | Variable |

### Step 4 — Decide

Make the call. State it clearly. Do not hedge — "We will probably use X" is not a decision. "We will use X" is.

If you cannot decide, identify what information you are missing and how to get it. Prototype, benchmark, or timebox the evaluation. Indecision is more expensive than a wrong decision that you learn from quickly.

### Step 5 — Record and share

Write the ADR, get it reviewed by the stakeholders, and merge it into the repo. An ADR that lives in someone's Google Doc is not discoverable.

---

## Maintaining ADRs over time

### Superseding a decision

When a previous decision is reversed or replaced, do NOT delete the old ADR. Update its status to "Superseded by ADR-NNN" and link to the new one. The old ADR is still valuable — it captures why you thought X was right at the time, which helps future developers understand the evolution.

```markdown
## Status
Superseded by [ADR-015: Migrate to event sourcing](./015-event-sourcing.md)
```

### Deprecating a decision

When a decision is no longer relevant (the feature was removed, the service was decommissioned), mark it as deprecated with a date and reason.

### Reviewing existing ADRs

During major architectural reviews or when onboarding new team members, review existing ADRs:
- Are any ADRs based on assumptions that are no longer true?
- Has the team or scale changed enough to warrant revisiting a decision?
- Are there implicit decisions that should be documented as ADRs?

---

## Common mistakes

### Writing ADRs after the fact

An ADR written months after the decision is better than no ADR, but worse than one written during the decision. You will forget the alternatives you considered, the constraints you faced, and the debates you had. Write it while the context is fresh.

### Making ADRs too long

An ADR is not a design document. It captures a decision and its rationale. If it exceeds 2 pages, you are either documenting implementation details (move those to a design doc) or combining multiple decisions (split into separate ADRs).

### Skipping the alternatives section

"We will use PostgreSQL" without alternatives is an announcement, not a decision record. The alternatives section is what makes an ADR useful — without it, future developers cannot tell if you considered their preferred approach.

### Not updating status

An ADR marked "Accepted" when the decision was reversed 6 months ago misleads everyone. Keep the status current.

### Treating ADRs as immutable specs

ADRs record the decision as made at a point in time. They are not permanent constraints. Circumstances change, and decisions should be revisited when the context shifts significantly.

---

## Verification checklist

Before merging an ADR:

- [ ] Context describes the situation, constraints, and requirements concretely
- [ ] Decision is stated clearly in 1-3 sentences
- [ ] At least 2 alternatives are evaluated with genuine pros and cons
- [ ] Each rejected alternative has a specific reason for rejection
- [ ] Consequences include both positive and negative outcomes
- [ ] Status is set correctly (Proposed or Accepted)
- [ ] Date is included
- [ ] The ADR is numbered and filed in `docs/adr/`
- [ ] Stakeholders have reviewed it

---

## Related

- [methodology-documentation](../methodology-documentation/SKILL.md) — ADRs are a form of documentation aimed at future maintainers
- [methodology-code-review](../methodology-code-review/SKILL.md) — ADRs should be reviewed like code
- [production-readiness](../production-readiness/SKILL.md) — architectural decisions directly affect production readiness
