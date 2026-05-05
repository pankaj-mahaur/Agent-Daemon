# GEPA — Genetic-Pareto Prompt Evolution

The skill self-improvement engine. Inspired by [Hermes Agent's self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) and the ICLR 2026 paper *"Reflective Prompt Evolution Can Outperform Reinforcement Learning"* (Agrawal et al.).

## When this runs

- **Triggered manually:** `agent-daemon evolve <skill-name>`
- **Triggered automatically:** when the digest pipeline detects ≥3 failures of the same skill across recent sessions, it queues an evolution run for that skill.

GEPA is opt-in per skill. Skills that haven't accumulated meaningful trace data yet are skipped — the algorithm needs failures to learn from.

## The 5 stages

| Stage | Module | What |
|---|---|---|
| 1. Sample | [sample.mjs](sample.mjs) | Pull skill_executions from SQLite. Stratified train/holdout split. |
| 2. Reflect | [reflect.mjs](reflect.mjs) | LLM reads training traces. Outputs failure modes + success patterns. |
| 3. Generate | [generate.mjs](generate.mjs) | LLM produces K candidate variants of the skill body, each addressing failure modes. |
| 4. Evaluate | [evaluate.mjs](evaluate.mjs) | Score each variant on quality (held-out replay) + size + compat + testPass. |
| 5. Select | [select.mjs](select.mjs) | Pareto frontier across the four objectives; tie-break on quality desc then size asc. |

Orchestrated by [evolve.mjs](evolve.mjs).

## v0.1 status

- ✅ Algorithm structure + module skeleton
- ✅ Pareto selection logic (real, tested-able)
- ✅ Hash-based variant deduplication
- ✅ Proposal markdown rendering
- 🚧 Stages 1–4 are stubbed (no LLM call, no SQLite read)

The v0.1 ship lets you read the algorithm in the codebase and reason about it. v0.2 wires the LLM calls and SQLite reads.

## Multi-objective Pareto detail

A variant is on the Pareto frontier if no other variant dominates it across all four objectives:

- `quality` — task success rate on held-out trace replay (higher is better)
- `size` — body char count (smaller is better, all else equal)
- `compat` — frontmatter validity, parses correctly (1 / 0)
- `testPass` — passes lint / banned-phrase / schema checks (1 / 0)

A dominates B iff: A ≥ B on every objective AND A > B on at least one.

After the frontier is computed, we sort by quality desc, then size asc, and pick the top result as the winner. The other frontier members are kept as alternatives in the proposal — sometimes a smaller variant with slightly lower quality is what the user actually wants.

## Why Pareto instead of weighted sum?

Weighted sums require choosing weights ahead of time. We don't know in advance whether the user prefers slightly worse quality at much smaller size, or vice versa. Pareto preserves all trade-offs and lets the human pick from the frontier.

## When evolution runs but no winner emerges

Three reasons the run can return `status: 'no-improvement'`:

1. **No trace data** — skill hasn't been used enough.
2. **Parent dominates** — every variant was either worse, or won on no objective. The skill is already locally optimal for the current trace set.
3. **All variants invalid** — generation produced syntactically broken bodies.

In all three cases the user sees a `agent-daemon: evolution skipped (reason)` line; nothing is queued.

## Borrowed from Hermes, but distinct

- **Hermes** runs evolution as a separate sidecar repo (`hermes-agent-self-evolution`).
- **agent-daemon** runs it inline in the digest pipeline. Same algorithm, different ergonomics.
- Hermes uses Python + DSPy. We use Node + headless `claude` CLI calls.
- Hermes targets its own skill format. We target agentskills.io standard SKILL.md (so the same skill ships everywhere).

If you're already running Hermes and want to use its evolution infrastructure on our skills, the agentskills.io compliance means our `skills/` directory works as input to Hermes's evolver too.
