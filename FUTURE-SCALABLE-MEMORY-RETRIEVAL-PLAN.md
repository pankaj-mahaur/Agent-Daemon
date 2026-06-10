# Future Plan: Scalable Local Memory Retrieval for Claude

Status: Deferred. Do not implement as part of the current Claude reliability rollout.

## Current Working Baseline

The current Claude-only local workflow is suitable for normal day-to-day use:

- `SessionStart` injects prioritized context under a 9000-byte hook output budget.
- Project memory receives up to 4100 bytes, with `activeContext.md` treated as the current working set.
- Recent SQLite learnings receive up to 1700 bytes.
- `UserPromptSubmit` performs prompt-time retrieval from local learnings.
- `ad doctor` warns when `activeContext.md` is oversized or project memory remains unbootstrapped.
- Deterministic capture and retrieval operate locally without `ANTHROPIC_API_KEY`.

Validated on `mobiux-website` on 2026-05-25:

- `ad doctor` passed all Claude integration checks.
- `activeContext.md` was compacted to 3101 bytes.
- A Claude Code smoke run with `ANTHROPIC_API_KEY` unset returned the expected project-context confirmation.

## Why Further Work Is Needed

The injection limits should not be removed. Loading all accumulated memory into every prompt would increase noise, cost, and contradiction risk. As project history grows, the system should store more durable knowledge while retrieving only task-relevant evidence.

Current long-term limitations:

- Prompt retrieval returns at most three SQLite results under an approximately 2000-byte response budget.
- `activeContext.md` must be manually or agent-compactly maintained as a small working set.
- Large markdown memory stores are not always selected by prompt relevance unless QMD is present and correctly used.
- Duplicate, stale, contradicted, or low-value memories are not yet scored deeply enough.
- Memory health reporting does not yet expose retrieval misses, conflicts, or category growth trends.

## Goals

- Keep normal Claude context concise while allowing local knowledge to grow safely.
- Make retrieval task-aware, ranked, explainable, and confidence-sensitive.
- Preserve no-API-key default behavior for capture, storage, retrieval, and maintenance.
- Improve memory quality over time without silently rewriting trusted project facts.
- Keep user review as the gate for material skill or instruction evolution.

## Non-Goals

- Do not increase the default SessionStart budget simply to hide retrieval problems.
- Do not send full historical memory into each Claude session.
- Do not require hosted embeddings, external vector databases, or API-key-based extraction.
- Do not extend Cursor or Codex behavior as part of this Claude-focused upgrade.

## Proposed Architecture

### 1. Memory Layers

Maintain distinct local layers with clear responsibilities:

| Layer | Purpose | Expected Size |
|---|---|---:|
| `activeContext.md` | Current objective, active risks, verified commands, next steps | 2500-3500 bytes |
| Structured SQLite memory | Decisions, corrections, commands, conventions, incidents, outcomes | Long-lived/unbounded with maintenance |
| Archived context | Prior active working sets retained for audit/recovery | Historical |
| Skill traces | Invocation and correction/failure evidence for GEPA proposals | Historical |

### 2. Structured Durable Memory

Extend durable memory records with fields required for reliable ranking and lifecycle control:

- memory type/category
- project scope and optional subsystem tags
- confidence and evidence source
- created/confirmed/last-retrieved timestamps
- retrieval count and usefulness feedback
- superseded-by or contradicted-by linkage
- freshness/staleness status

Use idempotent SQLite migrations and retain backwards compatibility with existing records.

### 3. Task-Aware Retrieval

Replace fixed recent-only selection with prompt-driven ranking:

- Classify prompt intent such as debugging, architecture, build/test, deployment, or convention lookup.
- Retrieve by project scope, text relevance, category match, confidence, freshness, and prior usefulness.
- Prefer confirmed facts over inferred or single-session observations.
- Include reason metadata internally so diagnostics can show why a memory was retrieved.
- Retain local-only operation using SQLite FTS5 and optional QMD enhancement; do not require embeddings.

### 4. Adaptive Retrieval Budgets

Keep SessionStart compact and allow targeted expansion only when useful:

| Situation | Target Injection |
|---|---:|
| Normal session start | Current existing limits |
| Normal prompt retrieval | Approximately 2 KB |
| Debugging/architecture prompt with strong matches | Configurable 4-6 KB |
| Explicit deep-memory request | Larger targeted retrieval with truncation notice |

Add configuration with conservative defaults and a hard overall safety cap.

### 5. Compaction And Memory Hygiene

Automate maintenance without destroying evidence:

- Summarize repeated equivalent learnings into one confirmed memory while preserving source references.
- Detect potential contradictions and queue them for review rather than resolving silently.
- Archive stale working context while retaining retrievable durable decisions.
- Down-rank low-confidence or never-reused memories over time.
- Prevent instruction blocks, generated protocol examples, and quoted schemas from entering durable memory.

### 6. Diagnostics

Extend `ad doctor` and add optional diagnostic commands for:

- current memory size by category
- active context budget status
- duplicate/conflict candidates
- stale memory candidates
- retrieval hit/miss and truncation counts
- most frequently retrieved facts
- trace volume and unreviewed skill-failure evidence

Example future commands:

```powershell
ad memory stats --cwd .
ad memory review --conflicts --stale
ad retrieve --prompt "debug checkout failure" --explain --cwd .
```

## Implementation Phases

### Phase 1: Measurement First

- Record retrieval request, selected memories, truncation, and source category locally.
- Add memory statistics and budget diagnostics.
- Add regression fixtures for large-memory and conflicting-memory projects.

Exit criteria:

- Retrieval decisions are inspectable without changing current selection behavior.
- No API key required.
- Existing Claude reliability tests remain green.

### Phase 2: Structured Ranking

- Add schema migration for tags, lifecycle state, evidence, and retrieval counters.
- Implement local FTS5 relevance plus confidence/freshness/category scoring.
- Preserve deterministic output and current hard caps.

Exit criteria:

- Relevant debugging/build/convention fixtures rank correctly.
- Stale or contradicted memories do not outrank confirmed current facts.

### Phase 3: Adaptive Prompt Retrieval

- Add prompt intent classification using deterministic rules first.
- Support configurable expanded retrieval budget for high-value query types.
- Provide explicit deep-memory retrieval mode.

Exit criteria:

- Larger projects can recover relevant old decisions without growing `activeContext.md`.
- Normal prompts retain small payloads.

### Phase 4: Hygiene And Review Workflow

- Add duplicate merge candidates and contradiction review queue.
- Add automatic active-context compaction proposals.
- Connect repeated failed skill outcomes to targeted GEPA proposals, preserving `ad review` acceptance.

Exit criteria:

- Memory growth remains manageable across extended usage.
- No unreviewed rewrite of project decisions or skills.

## Testing Plan

Automated tests:

- SQLite migrations remain idempotent against existing installations.
- Large memory sets do not exceed output caps.
- Active context remains first priority under oversized static guidance.
- Retrieval selects relevant high-confidence project facts over irrelevant recent entries.
- Contradicted/stale entries are down-ranked or flagged.
- Diagnostics report growth, truncation, and conflict candidates accurately.
- Windows path and hook JSON behavior remains valid.

Manual validation:

- Run in a temporary Claude project with synthetic large memory history.
- Validate prompt-time retrieval for debugging, architecture, and command questions.
- Validate with `ANTHROPIC_API_KEY` unset.
- Back up live local DB before running on an established repository.
- Use one real development project for several sessions and inspect retrieval evidence before wider rollout.

## Migration And Rollback

- Back up `~/.agent-daemon/episodic.db` and project `.agent-daemon/` before live migrations.
- Migrations must only add or safely transform fields; no destructive reset of historical memory.
- Keep legacy retrieval available behind a configuration switch until the new ranking is validated.
- Document rollback steps before enabling adaptive retrieval by default.

## Decisions To Make Before Implementation

- Whether QMD is an optional accelerator or the preferred indexed markdown path.
- Which deterministic prompt categories justify expanded retrieval budget.
- Whether retrieval feedback should be inferred from subsequent corrections or explicitly requested from users.
- What retention/down-ranking policy is appropriate for rarely used low-confidence memories.
- Which diagnostics belong in `ad doctor` versus separate memory inspection commands.

## Starting Point For A Future Session

When this work is approved, begin with Phase 1 only:

1. Create a dedicated branch from current `origin/main`.
2. Back up local memory/SQLite state before any live migration.
3. Inspect existing memory schema, retrieval queries, QMD behavior, and hook budgets.
4. Add measurement and diagnostic tests before changing ranking behavior.
5. Validate in a temporary Claude project before applying to a real repository.
