---
name: methodology-pair-programming
description: Use when the user wants to collaborate interactively on code, think together, co-author implementation, or work through a problem as a pair. Covers driver/navigator dynamics, when to switch roles, how to handle disagreements, and how to keep the session productive.
license: MIT
attribution: Inspired by obra/superpowers methodology skills (MIT license)
metadata:
  author: obra/superpowers (adapted)
  spec: agentskills.io
  version: "1.0"
---

# Pair Programming Methodology

Pair programming is not "one person codes while another watches." It is two minds working the same problem at two different altitudes — one focused on the line being written, the other on where that line fits in the larger design.

This skill covers the discipline of productive pairing, whether the pair is two humans, or a human and an AI agent.

---

## The two roles

### Driver

The driver has the keyboard. They write the code, run the commands, navigate the files. Their attention is on the immediate — syntax, variable names, the current function.

**Driver responsibilities:**
- Think out loud. Narrate what you are doing and why. Silent driving is solo coding with an audience.
- Write the smallest piece that demonstrates intent. Do not write 30 lines before letting the navigator react.
- Ask when stuck. "I'm not sure which data structure to use here" is more productive than struggling silently for 5 minutes.
- Be willing to throw away what you just wrote if the navigator spots a better approach.

### Navigator

The navigator does NOT write code. They watch, think ahead, and catch problems. Their attention is on the big picture — does this approach fit the architecture? Are we heading toward a dead end? Did we forget an edge case?

**Navigator responsibilities:**
- Keep a short mental (or written) list of things to address. "We should add error handling here" noted now, addressed when the driver finishes the current thought.
- Catch bugs in real time. Misspelled variable name, off-by-one error, wrong comparison operator — speak up immediately, before the driver moves on.
- Think one step ahead. While the driver writes the function body, the navigator considers: what will the caller look like? What test will cover this?
- Do NOT dictate code character by character. "You should handle the error case" is navigation. "Type `if err != nil { return fmt.Errorf(...)`" is backseat driving.

---

## When to switch roles

Role switches prevent fatigue and spread knowledge. Switch:

- **On a natural boundary.** Finished a function, completed a test, closed a TODO. "Your turn to drive" at the next logical break.
- **When the driver is stuck.** If the driver has been wrestling with the same 5 lines for several minutes, swap. Fresh hands on the keyboard often unstick the problem.
- **When the navigator has a strong vision.** If the navigator can see exactly how to implement the next piece, let them drive it rather than dictating.
- **On a timer.** If natural switching is not happening, set a 15-25 minute timer. When it rings, switch regardless. This prevents one person from driving the entire session.

**Do NOT switch:**
- Mid-thought. Let the driver finish the current logical unit.
- Because the navigator is bored. If the navigator is bored, they are not navigating — refocus on the big picture, edge cases, or upcoming design decisions.

---

## Starting a pairing session

### 1. Agree on the goal (2 minutes)

Before touching code, both people state what "done" looks like. This prevents the session from wandering. Examples:

- "We are going to implement the `deleteUser` endpoint and its test."
- "We are going to debug why the webhook handler drops events under load."
- "We are going to sketch the data model for the new feature and validate it against the requirements."

If you cannot agree on the goal, the session will be unproductive. Resolve the disagreement first.

### 2. Set up the shared view

Both people must see the same code. For human pairs, this means one screen or a screen-sharing tool. For human-AI pairs, this means the agent has read the relevant files and understands the current state.

### 3. Agree on the approach (5 minutes)

Before writing code, spend 5 minutes talking through the approach. Pseudocode on a whiteboard, a bulleted list in a comment, or a verbal walkthrough. This surfaces disagreements before they become wasted code.

```
// Quick plan before coding:
// 1. Add DELETE /users/:id route
// 2. Soft-delete: set deletedAt, don't remove the row
// 3. Return 204 on success, 404 if user not found
// 4. Test: delete existing user -> 204, delete nonexistent -> 404
```

---

## Handling disagreements

Disagreements are not bugs in the process — they are the point. Two perspectives catch more mistakes than one. But they must be resolved productively.

### When you disagree on approach

1. **State the tradeoffs, not the preferences.** "I prefer X" is a dead end. "X is simpler but doesn't handle concurrent access; Y handles it but adds complexity" is a discussion.
2. **Time-box the debate.** If you cannot resolve it in 3 minutes of discussion, pick the simpler option and move on. You can revisit after seeing it in code. Most disagreements dissolve when you see the implementation.
3. **Try both, briefly.** If the disagreement is about which approach will be cleaner, the driver spends 5 minutes sketching each. The code usually makes the answer obvious.

### When the navigator spots an issue

The navigator says what the problem is, not how to fix it (unless the fix is obvious). Give the driver a chance to solve it.

```
// Good navigator feedback
"That query doesn't filter by tenant_id — we'll get cross-tenant data."
"The error from fetchUser is being silently ignored on line 12."

// Bad navigator feedback (backseat driving)
"No, delete that line. Now type 'if (!user) throw new NotFoundError()'. No, with a capital N."
```

### When the driver ignores feedback

If the driver dismisses feedback without engaging, the navigator should:
1. State it once more clearly, with the consequence: "If we skip that null check, the function will throw on line 24 when called from the batch processor."
2. If still dismissed, let it go. It will show up in testing or review. Being right is less important than maintaining the collaboration.

---

## AI-specific pairing patterns

When the pair is a human + AI agent, the dynamics shift:

### Human drives, AI navigates

The human writes code and narrates intent. The AI watches for:
- Bugs and edge cases the human may miss
- Consistency with patterns elsewhere in the codebase
- Opportunities to suggest existing utilities instead of reimplementation
- Upcoming complexity that the current approach is heading toward

The AI should speak up only when it has substantive feedback — not on every line. Constant commentary is noise.

### AI drives, human navigates

The AI writes code based on a stated goal. The human watches for:
- Correct understanding of the requirement
- Alignment with unwritten conventions the AI may not know
- Over-engineering or under-engineering for the project's actual needs
- Hallucinated APIs, incorrect assumptions about the codebase

The human should interrupt early if the AI is heading in the wrong direction. Five lines of wrong code is easy to discard; fifty lines creates sunk-cost pressure.

### Ping-pong TDD pairing

One partner writes a failing test, the other makes it pass, then roles swap. This combines pair programming with TDD naturally:

1. Human writes a failing test that specifies the next behavior.
2. AI makes the test pass with the simplest implementation.
3. AI writes the next failing test.
4. Human reviews the test, makes it pass, and refactors.
5. Repeat.

This works well because each partner constrains the other — the test writer defines what, the implementer decides how.

---

## When pairing is NOT the right approach

Pairing is expensive — two people on one task. Use it when the expense is justified:

**Pair when:**
- The problem is ambiguous and benefits from two perspectives
- The code is critical (auth, payments, data migration) and needs real-time review
- One person is learning a new codebase or technology
- You have been stuck solo for more than 30 minutes

**Do NOT pair when:**
- The task is mechanical (rename a variable across 40 files, update dependencies)
- One person clearly knows the answer and the other has nothing to add
- Both people are tired — pairing while fatigued produces worse code than solo work
- The task requires deep focus and flow state (complex algorithm design, hard debugging)

---

## Session hygiene

### Take breaks

Pairing is cognitively intense. Take a 5-minute break every 45-60 minutes. Stand up, look away from the screen, drink water. Returning fresh catches things that tired eyes missed.

### Write down decisions

When the pair makes a non-obvious decision ("we chose a map instead of an array because lookups are O(1) and this is in the hot path"), write a one-line comment in the code or a note in the PR description. The pair's shared context will evaporate after the session.

### End with a summary

In the last 5 minutes, both partners state:
- What was accomplished
- What is left to do
- Any open questions or risks identified

This prevents the "what were we doing?" problem the next morning.

---

## Verification checklist

After a pairing session:

- [ ] The goal stated at the start was achieved (or explicitly descoped with a reason)
- [ ] Both partners can explain the code that was written
- [ ] Decisions made during the session are captured in comments or docs
- [ ] Tests were written for the new or changed behavior
- [ ] The code compiles and tests pass before ending the session

---

## Related

- [methodology-tdd](../methodology-tdd/SKILL.md) — ping-pong TDD is a natural pairing pattern
- [methodology-code-review](../methodology-code-review/SKILL.md) — pairing reduces but does not eliminate the need for review
- [implement-feature](../implement-feature/SKILL.md) — pairing is most valuable during the implementation phase
