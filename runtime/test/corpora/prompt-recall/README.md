# Prompt-recall corpus (v1)

A held-out corpus for the L6 prompt-time recall gate. On each prompt, the top 3 notes above a relevance threshold are injected. The gate is precision ≥ 0.8 above the threshold.

## Provenance

- Written by a clean-room agent: Claude Opus 5.5 (model id `claude-opus-5-5`), running as a Claude Code subagent, on 1 Nov 2026, under plan decision D29 (the implementer must not grade itself).
- What it read:
  - the caller's brief;
  - the "L6 Recall core" section of `docs/plans/mcp-platform/04-PARTS.md`, read-only. A list of that file's headings was used to find the section.
- What it did not read:
  - anything under `runtime/src`, `runtime/scripts` or `runtime/test` (except this corpus's own output folders);
  - anything under `hooks/`, `adapters/`, `packages/`, `bench/`, `skills/`, `mcp/`, `plugins/`, or the rest of `docs/`.
  - It did not search the repo or open any other corpus folder.
  - So the labels know nothing about how recall is implemented: the tokenizer, the FTS ranking and the threshold.
- All projects, paths, tickets, hosts and people are invented. Public tools (pnpm, Vitest, uv, Prisma, Stripe test mode and so on) are named the way a developer would name them.

## Files

- `notes.jsonl` contains 78 notes, one JSON object per line: `{"id","project","text","created","kind"}`.
  - `kind` is one of `tooling`, `style`, `workflow`, `testing`, `git`, `paths`, `architecture` or `fact`.
  - The longest text is 157 characters (the cap is 200).
- `prompts.jsonl` contains 64 prompts: `{"id","project","prompt","relevant","acceptable","note"}`.
  - `note` is optional. It tells you why a prompt is in the set; it is not an input.

| Project | Stack | Notes | Prompts | `relevant: []` |
|---|---|---|---|---|
| shopfront | Next.js / TypeScript storefront, pnpm, Prisma, Vitest + Playwright | 27 (n-001 to n-027) | 22 | 6 |
| tidewater | Python 3.12 FastAPI + Celery ingest service, uv, Alembic, pytest | 27 (n-028 to n-054) | 21 | 5 |
| relaygate | Go 1.23 API gateway (HTTP + gRPC), Makefile, buf, sqlc | 24 (n-055 to n-078) | 21 | 5 |

Note kinds: fact 17, workflow 15, testing 14, tooling 8, style 7, paths 6, architecture 6, git 5.

Relevant notes per prompt: none for 16 prompts, 1 for 41, 2 for 6 and 3 for 1. No prompt has more than 3, which matches the top-3 injection cap.

## Labels

- **relevant**: notes that clearly help with this prompt. A recall system should return them. They are not in any order.
- **acceptable**: on-topic notes that would not hurt if injected. They are not counted as false positives, and returning them is not required.
- **Everything else**, including every note from another project, counts against precision if it is returned above the threshold.
- **`relevant: []`**: nothing should be recalled. Any returned note that is not listed as acceptable is a false positive.
  - 16 of the 64 prompts (25%) are like this.
  - Only pr-037 also lists an acceptable note.

How the gate is meant to read these labels: precision is the number of returned notes (above the threshold) that are in `relevant` ∪ `acceptable`, divided by all returned notes above the threshold, summed over all prompts. Returning nothing adds no false positives. The plan doesn't gate recall of `relevant`, but you can measure it from the same labels.

## How items were chosen

**Notes** are short learnings a developer would accept after review: tooling, test commands, conventions, gotchas, paths, deploy and release steps, and domain facts. Each project has near-miss notes that share vocabulary but answer different questions:

- **shopfront:**
  - unit tests (n-002), e2e tests (n-003, n-004) and component tests (n-017);
  - branch naming (n-008) and merge style (n-009);
  - Prisma migrations (n-010) and the local database (n-027).
- **tidewater:**
  - unit tests (n-029) and integration tests (n-030);
  - the beat schedule (n-049) and idempotent tasks (n-035);
  - the upload size limit (n-038) and the partner rate limit (n-043).
- **relaygate:**
  - unit tests (n-056), integration tests (n-057), table and golden tests (n-070) and benchmarks (n-073);
  - releases (n-069) and hotfixes (n-077);
  - the upstream timeout (n-063), the circuit breaker (n-078) and rate limits (n-064).

25 of the 78 notes are relevant to no prompt. They act as distractors.

**Prompts** are typed the way a developer types to an agent: terse, mostly lower case, sometimes with pasted error text. A prompt can belong to more than one of these categories, and its `note` field says which:

- **Vocabulary mismatch (18):** pr-001, 005, 012, 013, 014, 015, 022, 024, 027, 029, 032, 039, 048, 049, 050, 054, 061 and 062.
  - Examples: "package manager" vs pnpm, "VAT" vs tax, port 6379 vs redis, "fix out today" vs hotfix, "toggle" vs feature flags.
- **Hinglish, written in Latin script (10, 15.6%):** pr-004, 011, 016, 026, 033, 040, 046, 055, 061 and 064.
- **Names a file path that a note mentions (6):**
  - In pr-006, 021, 023 and 044, the path points at the relevant note.
  - In pr-018 and 058, the path is shared only with a note that is not relevant.
- **Shares a word with a note but is about something else (13):** pr-009, 010, 017, 018, 020, 034, 037, 042, 050, 052, 056, 058 and 060.
- **Near misses called out in the note (6):** pr-002, 003, 023, 024, 045 and 046.
- **Nothing should be recalled (16):**
  - general knowledge: pr-019, 031, 041, 053 and 064;
  - unrelated chores: pr-008 and 063;
  - shared-word traps: pr-010, 018, 020, 034, 037, 042, 052, 056 and 060.

## Judgment calls

- **Project scope.** Recall is assumed to be scoped to the prompt's project. Labels reference only notes from the same project, and a note from another project counts against precision.
- **A tight `acceptable`.** A note is acceptable only if a reviewer would call it on-topic for the prompt, such as the Node pin (n-012) when adding a dependency. Generic project-wide notes, such as the pre-push check (n-019) or lint autofix (n-022), are not acceptable for unrelated prompts even though they are harmless. A ranker that returns them pays for it.
- **Warnings count as relevant.** A note that warns against what the prompt asks for is relevant:
  - pr-013 (a client cart store) → n-016;
  - pr-028 (add a retry) → n-043;
  - pr-036 (log an email) → n-050;
  - pr-057 (store request bodies) → n-075.
- **pr-004:** the local database note n-027 is relevant, because the e2e seed needs Postgres running.
- **pr-017:** rewriting page copy is relevant to the i18n note n-020, because copy lives in `messages/<locale>.json`. The shared word "image" points at n-021, which is not relevant.
- **pr-037:** no note is needed, but n-036 (timestamps in UTC) is acceptable because it is on-topic for formatting datetimes.
- **pr-040:** n-042 (a push to main deploys to staging) is acceptable rather than relevant. The core answer is the force-push rule, n-054.
- **pr-064** (a regex for an Indian PIN code) has no relevant notes even though shopfront has a checkout. No note is about address validation.
- **No stale notes.** Note dates run from 2026-01-21 to 2026-09-29, and no note in this corpus is stale or superseded, so freshness should not change the outcome here. Staleness is covered by the brief-relevance corpus.

Frozen: do not edit; changes need a new corpus version and a new hash.
