---
name: big-feature-flow
description: "Use for big multi-part work (new subsystem, rewrite) the user wants researched, planned to perfection and built in parts: \"research karo pehle\", \"dusron ne kaise banaya\", \"plan ko multiple iterate karo\", \"jab tak perfect na lage\", \"iteration for perfection\", \"part by part banao\", \"har part ko loop me review test karo\", \"how did others build this\". Research → plan in parts → review rounds until final → spikes → per-part implement/test/review loop."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
  kind: flow
allowed-tools: Agent, Bash, Read, Write, Edit, Grep, Glob, WebSearch, WebFetch
---

# Big Feature Flow

For work too big for one sitting: learn how others built the same thing, write a plan in parts, attack that plan until it holds, prove the unknowns with spikes, then build one part at a time. No part advances while a test is red or a medium-or-worse review finding is open. For a single feature that fits in a session, use `feature-flow` instead.

## When to use

- A new subsystem or front end, a rewrite, a migration: anything with several parts and real unknowns.
- The user asks for research first, a plan that is "perfect", or a part-by-part build with review loops.

## Procedure

1. **Research in parallel.** Start 3–4 read-only research agents, each with one question set and a word cap. Ask for concrete names and sources, with "unverified" flags.
   - **The upstream:** the source of truth you build on (protocols, APIs, the reference implementation's source).
   - **The engineering domain:** libraries, platform quirks, testing approaches.
   - **Other implementations:** how they're built, what broke for them and why, what users love and hate.
   - **This codebase** (an Explore agent): where the work plugs in, existing duplication, test layout.

   Write each report into `docs/research/<topic>.md` as your own summary, never copied text, and keep a short index. Tell agents not to write files into the repo, and check `git status` after they finish.
2. **Plan v1** in `docs/plans/<feature>.md`:
   - a goal with measurable success criteria;
   - a decisions table where every row says *why*, citing research;
   - an architecture sketch;
   - how the work survives upstream changes;
   - a parts table where each part is small enough for one loop and has a **Done-when**;
   - the per-part loop, the testing pyramid, risks, a "later" list, and a revision log.
3. **Review rounds until final.** Each round uses fresh adversarial reviewers with different lenses: one technical (they verify claims against the code and the spec, not the plan's word), one product/UX. They return findings ranked critical/high/medium/low, with evidence and a concrete fix.
   - Apply every finding, or record why not.
   - Bump the version, and log what changed.
   - Repeat until a verification round finds no critical or high finding. Only then mark the plan **final**.
4. **Spikes and checkpoints.** Prove each unknown with a throwaway spike in a scratch directory before building on it, and write the result into the plan. Put user feedback checkpoints where only the user can decide: look and feel, keys, scope.
5. **Per part, loop:**
   1. Re-read the part and the interfaces. Write tests first for pure modules.
   2. Implement in small steps; run focused tests as you go.
   3. Run the full suite and lint; do a live smoke where the part has a runtime effect.
   4. Review the diff with a fresh-eyes review subagent, then do your own pass.
   5. Fix, and re-review the fix. Stop when no finding of medium severity or above is left.
   6. For guards and security fixes, run a **mutation check**: remove the guard and confirm that a test fails.
   7. Update the plan's status and project memory, commit by file name, then move to the next part.
6. **Push and merge only with the user's OK**, every time. Report test counts and any skipped step plainly.

## Examples

### Example 1: the `ad` terminal UI (agent-daemon, 2026-10-04)

The user asked for a Codex-style TUI with agent-daemon's extras that survives Codex releases.

- **Research:** three agents covered the Codex TUI and app-server, terminal engineering in Node, and other harnesses; an Explore agent mapped the code.
- **Plan rounds:**
  - v1 review: 2 critical, 7 high.
  - v2 (technical + product reviewers): 6 critical, 13 high.
  - v3 verification: 1 high.
  - v4 was marked final.
- **Spikes** proved:
  - a real-engine CI against a mock model;
  - where skills are discovered;
  - checkpoint timing, which moved snapshots off the critical path.
- **Part 0** took two review rounds. The re-review caught a Windows trailing-dot path that bypassed the isolation guard. A mutation check then showed every guard had a test that fails without it.

## Anti-patterns

- **Coding before the plan is final.** The rounds above found two critical design errors that code would have baked in.
- **One reviewer, one lens.** Technical and product reviewers found almost disjoint sets of problems.
- **Trusting claims.** Verify reviewer findings, research claims and your own plan text against code and specs before acting on them.
- **Advancing with open findings or red tests.** A part is done when its Done-when holds, not when the code exists.
- **Tests that check a simpler cousin of the bug.** Produce the exact failing shape, and mutation-check the guard.
- **Research copied verbatim into the repo.** Summarize and link.
- **Editing files with backslashes or `$` through shell heredocs.** Use the Write/Edit tools, and give `replace()` a function.
