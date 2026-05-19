# agent-self-improve — examples

How to leave clean signal vs. how to leave noise. Each ✅ is what the daemon's digest pipeline can extract; each ❌ is what gets dropped or, worse, captured as a false memory.

---

## Example 1 — Taking a correction

### ❌ Bad

> **User:** no, use `pnpm` here, we don't use npm in this repo
> **Agent:** Sorry! Let me try again.

The agent silently switches. The extractor sees nothing surprising — just an apology. No memory entry created. Next session repeats the mistake.

### ✅ Good

> **User:** no, use `pnpm` here, we don't use npm in this repo
> **Agent:** Got it — switching to `pnpm`. (Earlier I assumed `npm` because `package-lock.json` was present, but I see `pnpm-lock.yaml` now too.)

The "Earlier I assumed X because Y" clause tells the extractor the false belief AND the misleading evidence. The pipeline tags this as a `correction`-type memory: *"Use `pnpm` for this repo, even though `package-lock.json` is also present."*

---

## Example 2 — Confirming a non-obvious choice

### ❌ Bad

Agent makes a judgment call (bundles 3 commits into 1, picks an unusual library, skips a test). Says nothing. User accepts silently. Extractor has no signal that an *active decision* happened.

### ✅ Good

> **Agent:** I'm bundling these into one commit because they all came from the same root cause (the stale-cache fix touched the mutation handler + the test + the doc).

User accepts silently. Extractor catches the explicit framing and tags it as a `confirmation` memory: *"For root-cause-style fixes in this repo, prefer one commit over N small ones."*

---

## Example 3 — Naming a recurring pattern

### ❌ Bad

> **Agent:** Looks like another cache-stale issue. Fixed.

Generic. The extractor's regex catches "cache-stale" but loses the *which* — which cache, which mutation, which file:line. Memory entry, if any, says only "cache-stale issues happen here" — useless.

### ✅ Good

> **Agent:** This is the third time we've hit a stale-cache issue on the project-list view — `mutations/project.py:84` writes but doesn't invalidate `project_list_*`. Recurring pattern. Worth adding a `cache.delete_pattern` call in the mutation handler, or moving invalidation into a model signal so it can't be forgotten.

The phrase *"recurring pattern"* is the trigger word the extractor is tuned for. The `file:path:line` is the load-bearing detail. The "or moving invalidation into a signal" is the prescriptive part that may auto-propose a new skill.

---

## Example 4 — Flagging a new tool

### ❌ Bad

> **Agent:** Found the cause with grep. Fixed.

Lost: which grep flags, which pattern, why it worked. The extractor can't promote a generic "use grep" into anything useful.

### ✅ Good

> **Agent:** `rg --multiline --multiline-dotall 'struct\s+Order\s*\{[^}]*amount'` found all 6 multi-line struct definitions in one pass — single-line grep would have missed the wrapped ones. Adding to the toolkit.

The backticked command is regex-matchable for the extractor. The "single-line grep would have missed" clause explains *why* it's a discovery. Pipeline tags as `tool` memory.

---

## Example 5 — Emitting the end-of-session digest block

### ❌ Bad

Agent ends with a long prose summary: *"In this session we fixed the cache invalidation, added a regression test, refactored the mutation handler…"*

The pipeline's `SessionEnd` hook reads the transcript but finds no structured block. The extractor falls back to regex-scanning the prose — captures some signal, misses most, mis-categorises some.

### ✅ Good

Agent ends with normal prose summary AND a hidden digest block:

```
<agent-daemon-digest>
{
  "learnings": [
    {
      "type": "pattern",
      "text": "Stale-cache on project-list view — third occurrence. mutations/project.py:84 must invalidate project_list_*.",
      "evidence_quote": "this is the third time we've hit a stale-cache issue on the project-list view",
      "evidence_speaker": "agent",
      "scope": "project",
      "confidence": 0.9,
      "tags": ["cache", "recurring", "mutation-handler"]
    },
    {
      "type": "tool",
      "text": "rg --multiline-dotall finds multi-line struct definitions that single-line grep misses",
      "evidence_quote": "rg --multiline --multiline-dotall 'struct\\s+Order\\s*\\{[^}]*amount'",
      "evidence_speaker": "agent",
      "scope": "global",
      "confidence": 1.0,
      "tags": ["ripgrep", "multiline"]
    }
  ],
  "session_summary": "Fixed recurring stale-cache bug on project-list view; added cache.delete_pattern to mutation handler + regression test."
}
</agent-daemon-digest>
```

The block renders invisible to the user, parses cleanly in the `SessionEnd` hook, populates memory directly.

---

## Example 6 — Promoting a pattern to a SKILL

### ❌ Bad

The same correction has shown up 4 times across unrelated sessions ("don't use `np.float`, it's deprecated → use `float`"). The digest pipeline auto-proposes `proposed/2026-05-19-np-float-deprecation.diff`. The agent, on its next session, sees the proposal, says "looks good, applying" and accepts it.

This violates constitution rule 8 (the agent does NOT accept its own proposals — skill edits are always human-gated).

### ✅ Good

Agent surfaces the proposal to the user:

> **Agent:** The digest pipeline has auto-proposed a new skill: `proposed/2026-05-19-np-float-deprecation.diff`, derived from 4 corrections across 3 different sessions. Want me to show you the diff so you can accept / reject / edit?

User reads, accepts. Diff applies. New skill enters rotation.

**Lesson:** human-gated promotion. The agent surfaces; the user decides.
