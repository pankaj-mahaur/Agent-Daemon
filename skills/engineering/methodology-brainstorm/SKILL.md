---
name: methodology-brainstorm
description: Use when exploring solution spaces, generating alternatives, or the user asks "what could we do about X?" Provides structured diverge-then-converge brainstorming with explicit evaluation criteria to avoid premature commitment to the first idea.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Structured Brainstorming

The default failure mode when someone asks "how should we solve X?" is to immediately describe the first reasonable approach that comes to mind. This produces adequate solutions but rarely the best one. Structured brainstorming forces you to generate multiple options before evaluating any of them.

The discipline: **diverge first, converge second.** Never evaluate during generation. Never generate during evaluation.

---

## Phase 1 — Frame the problem

Before generating solutions, nail down what you are actually solving. A brainstorm without a clear problem statement produces scattered ideas that do not compose.

### Write a problem statement

One to three sentences covering:

1. **What is happening** (or not happening) that is a problem?
2. **Who is affected?** (User, developer, system, business)
3. **What constraints exist?** (Time, backward compatibility, dependencies, team size)

Example:
> "API response times for the dashboard endpoint exceed 3 seconds under normal load. This affects all users viewing the dashboard. We cannot change the database schema without a migration plan, and the fix needs to ship this sprint."

### Identify non-goals

Explicitly state what this brainstorm is NOT trying to solve. This prevents scope creep during generation.

Example:
> "We are NOT redesigning the dashboard UI. We are NOT adding caching infrastructure that does not already exist."

---

## Phase 2 — Diverge: generate options

### Rules during divergence

1. **No evaluation.** Do not say "but that won't work because..." during this phase. Write it down anyway.
2. **Quantity over quality.** Aim for 5-8 options minimum. Bad ideas often spark good ones.
3. **Vary the dimension.** Force yourself to explore different axes:
   - **Do nothing** — what happens if we accept the status quo?
   - **Minimal fix** — smallest change that addresses the symptom
   - **Structural fix** — address the root cause
   - **Alternative framing** — solve a different problem that makes this one disappear
   - **Opposite approach** — if everyone assumes X, what if we do not-X?
   - **Steal from another domain** — how does a different system/language/framework handle this?

### Generation techniques

**Constraint removal:** "If we had unlimited time, what would we do?" Then work backward to find a version that fits your constraints.

**Inversion:** "What would make this problem worse?" Then invert each answer.

**Decomposition:** Break the problem into sub-problems. Brainstorm solutions for each sub-problem independently. Some combinations will be novel.

**Prior art scan:** Before inventing, check:
- How does the project already handle similar problems?
- How do popular open-source projects in the same ecosystem handle it?
- Is there a well-known pattern (saga, CQRS, circuit breaker, etc.) that fits?

### Output format for options

Number each option. One paragraph max. Include just enough detail to evaluate later — not a full design.

```
Option 1: Add database index on (user_id, created_at) for the dashboard query.
Option 2: Precompute dashboard aggregates in a materialized view, refresh every 5 minutes.
Option 3: Move dashboard data to a read replica with its own optimized schema.
Option 4: Paginate the dashboard — show last 7 days by default, load more on scroll.
Option 5: Cache the API response in Redis with 60-second TTL.
Option 6: Do nothing — document that dashboards with >10k records are slow, add a loading spinner.
Option 7: Stream the response — send partial data immediately, fill in aggregates async.
```

---

## Phase 3 — Define evaluation criteria

Before comparing options, agree on what "better" means. Common criteria:

| Criterion | Question it answers |
|---|---|
| **Effort** | How much work to implement? (hours, days, sprints) |
| **Risk** | What could go wrong? How reversible is it? |
| **Scope of impact** | Does it fix just this case, or a class of problems? |
| **Maintenance burden** | Does it add ongoing complexity? New infrastructure? |
| **User impact** | Does the user experience change? Better or worse? |
| **Backward compatibility** | Does it break existing clients, APIs, or workflows? |
| **Time to value** | How soon does the user see improvement? |

Pick 3-5 criteria that matter most for THIS problem. Weight them if some matter more than others.

---

## Phase 4 — Converge: evaluate options

Now — and only now — apply the criteria to each option.

### Evaluation format

Use a simple matrix. Do not over-engineer the scoring. Coarse grades (Low / Medium / High, or 1-3) are sufficient.

```
                    Effort  Risk  Scope  Maintenance  Time-to-value
Option 1 (index)      Low   Low   Narrow    Low         Fast
Option 2 (matview)    Med   Med   Medium    Med         Medium
Option 3 (replica)    High  High  Broad     High        Slow
Option 4 (paginate)   Low   Low   Narrow    Low         Fast
Option 5 (Redis)      Med   Low   Narrow    Med         Fast
Option 6 (nothing)    None  None  None      None        Immediate
Option 7 (streaming)  High  Med   Broad     Med         Medium
```

### Decision heuristics

- **If one option dominates** (better on every criterion), choose it. This is rare.
- **If two options are close**, prefer the one with lower risk and lower maintenance.
- **If the best option is high-effort**, check if a low-effort option buys time. Ship the quick fix now, plan the structural fix for next sprint.
- **"Do nothing" is a valid choice.** If the problem is not painful enough to justify any option's cost, say so explicitly.

### Common evaluation mistakes

- **Anchoring on the first option.** The first idea generated gets disproportionate weight because you have thought about it longest. The matrix corrects for this.
- **Sunk cost.** "We already started on Option 3" is not a reason to continue if Option 1 is better. The work done is gone either way.
- **Complexity bias.** Engineers tend to prefer the more sophisticated solution. Fight this. The boring solution that ships is better than the elegant solution that takes three sprints.
- **Ignoring "do nothing."** Sometimes the problem is not worth solving right now. Forcing this option into the list makes that discussion explicit.

---

## Phase 5 — Decide and record

### State the decision

One sentence: "We will do Option X because [reason]."

If combining options: "We will do Option 4 (paginate) immediately and Option 2 (materialized view) next sprint."

### Record the reasoning

Future-you (or a teammate) will ask "why didn't we just do Y?" The answer should be findable. Record:

- The options considered (not just the winner)
- The criteria used
- Why the winner won and the runner-up lost

This can go in a PR description, an ADR, a comment in the code, or a decision log — whatever the project uses. The format matters less than the existence.

### Record what was explicitly rejected

"We considered Option 3 (read replica) but rejected it because the maintenance burden exceeds the performance gain for our current scale." This prevents the same discussion from recurring.

---

## When to use this skill vs. just deciding

Use structured brainstorming when:

- The decision is hard to reverse (architecture, API contract, data model)
- Multiple stakeholders have opinions
- You have tried one approach and it failed — you need alternatives
- The user explicitly asks for options
- You feel uncertain and want to think clearly

Just decide when:

- The decision is trivially reversible (variable name, file location)
- There is an obvious standard approach (use the ORM, use the framework's router)
- The cost of deliberation exceeds the cost of being wrong

---

## Anti-patterns

- **Brainstorming without a problem statement.** Generates scattered ideas that do not compose.
- **Evaluating during generation.** Kills ideas before they have a chance to combine with other ideas.
- **Generating during evaluation.** Introduces new options that have not been properly considered.
- **Analysis paralysis.** If you have been evaluating for longer than you have been generating, stop. Pick the leading option and move.
- **Brainstorming when the answer is obvious.** Do not use a cannon to kill a mosquito. If there is one clear approach and no meaningful alternatives, just do it.

---

## Related

- [methodology-writing-plan](../methodology-writing-plan/SKILL.md) — after brainstorming, write an implementation plan for the chosen option
- [methodology-api-design](../methodology-api-design/SKILL.md) — brainstorming API shapes before committing to a contract
