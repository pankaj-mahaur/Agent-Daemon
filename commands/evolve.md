# /evolve — In-session GEPA skill evolution

Evolve a skill using the GEPA (Genetic-Pareto Prompt Evolution) protocol. This is the transparent, in-session alternative to `agent-daemon evolve <skill>` — everything happens in your context window so you can watch each step.

## Arguments

`$ARGUMENTS` should be the name of a skill to evolve (e.g., `debug-triage`).

## Protocol

Execute these steps in order. Use your built-in tools (Bash for SQLite queries, Read for files, Write for proposals). Do NOT skip steps.

### Step 1: Locate the skill

```bash
ls skills/$ARGUMENTS/SKILL.md
```

If not found, report the error and stop.

### Step 2: Read the current skill

Read `skills/$ARGUMENTS/SKILL.md` in full. This is the **baseline** you're evolving from.

### Step 3: Sample execution history from SQLite

Query the episodic database for recent executions of this skill:

```bash
sqlite3 ~/.agent-daemon/episodic.db "SELECT id, session_id, outcome, duration_ms, created_at FROM skill_executions WHERE skill_name = '$ARGUMENTS' ORDER BY created_at DESC LIMIT 20;"
```

If no executions exist or the database doesn't exist, report that there's insufficient data and stop.

Split results into ~70% train / ~30% holdout. Use the train set for reflection and generation; reserve the holdout for evaluation.

### Step 4: Reflect

Analyze the train set. For each execution, note:
- Was the outcome a success or failure?
- What patterns emerge across failures?
- What do successful executions have in common?

Write a **reflection summary** (3-5 bullet points) identifying the skill's strengths and weaknesses.

### Step 5: Generate K=4 candidate variants

Based on the reflection, generate **4 candidate mutations** of the skill's SKILL.md. Each variant should:
- Keep the same frontmatter structure (name, description, etc.)
- Modify the body to address identified weaknesses
- Preserve what works well (don't fix what isn't broken)
- Make ONE focused change per variant (not a kitchen-sink rewrite)

Label them Variant A, B, C, D.

### Step 6: Evaluate against holdout

For each variant, reason through how it would have performed on the **holdout** executions:
- Would it have caught the failure modes?
- Would it have maintained the successes?
- Score each variant on: correctness improvement, token efficiency, generality.

Use a 1-5 scale for each dimension.

### Step 7: Pareto select

Select the variant(s) on the Pareto frontier — best across the three dimensions without being dominated on any. If multiple variants tie, prefer the one with the smallest diff from the baseline.

### Step 8: Write the proposal

Write the winning variant to the proposals directory:

```bash
mkdir -p .agent-daemon/proposed
```

Write it as `.agent-daemon/proposed/skill-$ARGUMENTS-<timestamp>.md` with:
- The full SKILL.md content of the winning variant
- A `<!-- evolve-metadata -->` comment block at the end containing:
  - Reflection summary
  - Variant scores
  - Why this variant won

Report the proposal path and instruct the user to review with `agent-daemon review`.

## Important notes

- This command uses YOUR session's LLM context — no separate API key needed.
- The quality depends on having enough execution history. 5+ executions is the practical minimum.
- Each run costs tokens in your session. For bulk evolution, use `agent-daemon evolve <skill>` via CLI instead.
