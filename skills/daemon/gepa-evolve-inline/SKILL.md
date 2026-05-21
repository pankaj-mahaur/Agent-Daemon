---
name: gepa-evolve-inline
description: Use when the user wants to evolve / improve / refine a skill but does NOT have ANTHROPIC_API_KEY or `claude auth login` set up. Triggers on "evolve skill", "improve this skill", "skill ko better banao", "iss skill mein dikkat hai", "regenerate skill X", "skill evolve karo", "is skill ka GEPA chalao". The active Claude Code session itself does the reflection — no headless `claude` spawn, no API key needed.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable-model-invocation: false
---

# GEPA inline — the no-API skill evolution path

The normal `ad evolve <skill>` command spawns a headless `claude` CLI to do reflection + variant generation. That needs auth (`claude auth login` or `ANTHROPIC_API_KEY`). This skill is the no-auth alternative: you (the active Claude Code session) ARE the LLM. You read the traces, reflect, and write the proposal yourself.

The output is the same: a markdown proposal at `.agent-daemon/proposed/<skill>-<timestamp>.md` that the user reviews via `ad review`.

## Phase 1 — Find candidates

Run the CLI flag that lists skills needing evolution (no auth needed):

```bash
ad evolve --list-candidates --json
```

Output is JSON of the form:

```json
{
  "candidates": [
    { "skill_name": "debug-triage", "failure_count": 5 },
    { "skill_name": "deploy-ops",   "failure_count": 3 }
  ]
}
```

If `candidates` is empty → tell the user "no skills currently meet the threshold of ≥3 failures in 30 days. Nothing to evolve." STOP.

If the user named a skill explicitly (e.g. "evolve skill debug-triage"), use that one directly — skip the listing.

## Phase 2 — Export traces

Tell the CLI to dump execution traces for the chosen skill:

```bash
ad evolve <skill-name> --export-traces
```

This writes JSONL to `<cwd>/.agent-daemon/skill-traces/<skill-name>.jsonl`. One line per execution. Each line:

```json
{
  "id": 12,
  "session_id": "abc-123",
  "skill_name": "debug-triage",
  "succeeded": false,
  "failure_reason": "guidance was unclear when the bug was in a third-party dep",
  "trigger_text": "the build is broken on CI but works locally",
  "created_at": "2026-05-15T14:32:00Z"
}
```

If the export reports `no execution traces` → STOP. Tell the user "skill has never been executed (or executions weren't recorded). Run the skill a few times first."

## Phase 3 — Read traces + current SKILL.md

Use `Read` to load:
1. The traces JSONL — every line is a trace
2. The current skill body at `skills/<bucket>/<skill-name>/SKILL.md` (try buckets: `daemon`, `engineering`, `productivity`, then flat)

Group traces by outcome:
- **Failures** — `succeeded: false`. Read each `failure_reason` carefully. What does the skill body NOT explain that the user needed?
- **Successes** — `succeeded: true`. What patterns made these work?

## Phase 4 — Reflect

In your own context (no separate spawn), produce a written analysis. Structure:

```markdown
### Failure modes observed

1. **<mode 1 name>** (N occurrences) — <one sentence: what was the agent missing?>
   Evidence: "<failure_reason quote>" (session abc-123)
2. **<mode 2 name>** (M occurrences) — ...

### Success patterns

- <pattern that consistently worked, with brief example>
- <another pattern>

### Root cause hypothesis

<2-3 sentences: which part of the current SKILL.md body is causing the failures? Is the procedure ambiguous? Are anti-patterns missing? Is the scope wrong?>
```

Keep this honest. If only 3 failures and they're each different root causes — say "insufficient data to propose a confident change."

## Phase 5 — Propose a variant

Based on the reflection, draft a modified SKILL.md. **Only change what the reflection justifies.** Don't refactor for style. Common targeted changes:

- Add a new step to `## Procedure` addressing failure mode #1
- Add a new entry to `## Anti-patterns` for the recurring trap
- Broaden the `description:` line if triggers are missing the failure cases
- Add a `## Examples` block covering the failed scenario

Write the proposal to `.agent-daemon/proposed/<skill>-<ISO-timestamp>.md`:

```bash
mkdir -p .agent-daemon/proposed
TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
PROPOSAL=".agent-daemon/proposed/<skill>-${TIMESTAMP}.md"
```

Proposal file format:

```markdown
# Proposed via inline GEPA (active session)

**Skill:** <skill-name>
**Proposed at:** <ISO timestamp>
**Mode:** inline (no headless claude spawn, no API cost)
**Source traces:** <N>  (failures: <F>, successes: <S>)

## Reflection summary

<paste the reflection from Phase 4>

## Proposed SKILL.md

\`\`\`markdown
<the full revised SKILL.md content, frontmatter + body>
\`\`\`

## Changes from baseline

- <bullet — what changed and why>
- <bullet>

## Review

To accept this proposal:

```bash
ad review
```

The diff will be displayed; accept will replace the existing SKILL.md.
```

## Phase 6 — Surface to user + log

In your final assistant response:

1. **Summary** — "Reflected on N traces (F failures, S successes). Identified <root cause hypothesis>."
2. **Path** — "Proposal written to `.agent-daemon/proposed/<file>`"
3. **Next step** — "Run `ad review` to accept or reject."

Append a log line to `.agent-daemon/gepa-inline-log.jsonl`:

```bash
echo '{"ts":"<ISO>","skill":"<name>","traces":N,"failures":F,"proposal":"<path>","mode":"inline"}' >> .agent-daemon/gepa-inline-log.jsonl
```

## Anti-patterns

- **Skipping export-traces and reading SQLite directly.** Use the CLI flag — it sanitises + caps results. Direct DB access can produce stale or partial data.
- **Proposing a complete rewrite when reflection only justifies one change.** Targeted edits get accepted; full rewrites get rejected for being too risky.
- **Hallucinating failure modes from <5 traces.** If `failure_count < 3`, the heuristic threshold isn't even met. Tell the user the sample is too small.
- **Confidence theater.** If the traces are noisy or contradictory, say so. "No confident proposal — failures appear unrelated to skill body" is a valid outcome.
- **Forgetting the log line.** Log every inline run, even rejections. The pipeline uses the log to detect repeated futile evolutions and skip them next time.

## Examples

### Example 1: clear failure mode

User: *"evolve skill debug-triage"*

Phase 1: `--list-candidates` shows `debug-triage` with 5 failures.
Phase 2: export traces → 5 failures, 12 successes.
Phase 3: read traces. All 5 failures mention "the bug was in a third-party dep, the skill didn't help."
Phase 4: reflect → root cause: skill assumes the bug is in user code; needs a "is it a dependency bug?" phase.
Phase 5: propose adding a new Phase 1.5 "Check if it's a dep" with a 3-step procedure.
Phase 6: surface + log.

### Example 2: insufficient data

User: *"evolve skill seed-data"*

Phase 1: `--list-candidates` doesn't include seed-data.
Phase 2: export traces anyway (user asked) → only 2 failures.
Phase 3: read traces. Both failures are different root causes.
Phase 4: reflect → "2 failures, 2 different root causes — insufficient signal."

Final response: *"Only 2 failures in 30d, both with different root causes. Not enough signal for a confident proposal. Suggest waiting for more data or running the skill in more scenarios."*

Skip Phase 5 entirely.

## Verification

```bash
ls -lt .agent-daemon/proposed/ | head -3        # latest proposal at top
ad status                                        # surface in queued proposals
ad review                                        # user reviews
```

After `ad review` accepts, the change lands in `skills/<bucket>/<name>/SKILL.md` and the next session loads the improved skill.
