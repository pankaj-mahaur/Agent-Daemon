# Brief-relevance corpus (v1)

A held-out corpus for the L6 session-brief gate. At session start, a project's notes are ranked against a cached repo context (branch, recent paths, freshness), and the best fit within 1,200 tokens is injected. The gate passes when both of these hold:

- for at least 7 of the 8 projects, the brief contains a relevant note;
- at most 20% of the brief's notes are irrelevant.

## Provenance

- Written by a clean-room agent: Claude Opus 5.5 (model id `claude-opus-5-5`), running as a Claude Code subagent, on 1 Nov 2026, under plan decision D29 (the implementer must not grade itself).
- What it read:
  - the caller's brief;
  - the "L6 Recall core" section of `docs/plans/mcp-platform/04-PARTS.md`, read-only. A list of that file's headings was used to find the section.
- What it did not read:
  - anything under `runtime/src`, `runtime/scripts` or `runtime/test` (except this corpus's own output folders);
  - anything under `hooks/`, `adapters/`, `packages/`, `bench/`, `skills/`, `mcp/`, `plugins/`, or the rest of `docs/`.
  - It did not search the repo or open any other corpus folder.
  - So the labels know nothing about how the brief is ranked or how tokens are counted.
- All projects, paths, tickets, channels, hosts and people are invented. Public tools are named the way a developer would name them.

## Files (one folder per project)

- `context.json` holds what the product's cached repo context would know: `{"name","stack","branch","recent_paths","recent_commits","session_cwd"}`.
  - Each project has 10 to 12 recent paths and 5 commit subjects that tell one coherent story.
- `notes.jsonl` holds 22 to 25 notes per project: `{"id":"<slug>-NN","text","created","kind"}`.
  - The kinds are the same eight as in the prompt-recall corpus.
  - Every note text is 200 characters or less.
- `expected.json` sorts every note into exactly one of `relevant`, `irrelevant` or `neutral`, with a one-line reason per id in `reasons`.

**Reference date:** 2026-11-01. All `created` dates fall between 2025-01-20 and 2026-10-29. Read freshness relative to the reference date. `context.json` deliberately has no "now" field.

## Projects

| Slug | Stack | Branch | Paths | Notes | Relevant | Irrelevant | Neutral | Irrelevant share if every note were included |
|---|---|---|---|---|---|---|---|---|
| brightcart-web | Next.js 15 / TypeScript storefront, Prisma, Stripe | feat/checkout-refunds | 12 | 25 | 10 | 9 | 6 | 36% |
| meterly-api | Python FastAPI metering and billing, SQLAlchemy, Hypothesis, uv | fix/invoice-rounding | 11 | 24 | 9 | 9 | 6 | 38% |
| gitsweep | Rust CLI (clap, git2, insta) | feat/dry-run-json-output | 11 | 23 | 9 | 8 | 6 | 35% |
| parcelroute | Go microservice, Kafka (franz-go), Postgres, Helm | feat/kafka-consumer-retries | 11 | 23 | 10 | 9 | 4 | 39% |
| trailmate-app | React Native / Expo hiking app, MapLibre, expo-sqlite | feat/offline-maps | 10 | 22 | 8 | 8 | 6 | 36% |
| infra-orbit | Terraform AWS infrastructure (RDS, EKS, S3) | chore/rds-postgres-16-upgrade | 10 | 22 | 10 | 9 | 3 | 41% |
| lumen-monorepo | pnpm + Turborepo monorepo (ui, web, api) | feat/ui-date-picker | 11 | 24 | 11 | 8 | 5 | 33% |
| handbook-docs | Docusaurus 3 docs site, MDX, Vale | docs/api-v2-migration-guide | 10 | 22 | 9 | 9 | 4 | 41% |
| **Total** | | | | **185** | **76** | **69** | **40** | |

## Labels

- **relevant**: a good brief for this branch and these paths should include the note. There are two kinds:
  - notes tied to the current work area: the files in `recent_paths`, their subsystem, or the change described by `recent_commits`;
  - the commands needed to run or test that area, such as the unit or e2e command for the module being changed.
- **irrelevant**: the note would be noise in this brief. There are two kinds:
  - notes about other areas of the same repo;
  - stale or superseded notes. Each stale note's reason names the note that replaced it, or says that the branch itself contradicts it.
  - Stale notes are irrelevant even when they match the branch's words, because injecting them would mislead the agent.
- **neutral**: true, project-wide notes that are harmless but not needed for this branch (style, commit and PR conventions, release steps, general setup), plus a few borderline notes. They are neither required nor penalized.

How the gate is meant to read these labels:

- "The brief contains a relevant note" means at least one id from `relevant` is in the brief.
- The irrelevant share is |brief ∩ irrelevant| / |brief|. Neutral notes count only in the denominator.

**What the corpus is built to test:**

- Every project has 33% to 41% irrelevant notes, so a brief that includes every note fails the 20% bar in every project. The ranking has to actually choose.
- Each project's notes are short, so most of them fit inside 1,200 tokens. The token budget alone won't filter out the noise.

## How items were chosen

- **Stacks:** the eight from the brief: a Next.js web app, a Python FastAPI service, a Rust CLI, a Go microservice, a React Native app, a Terraform repo, a pnpm monorepo and a docs site.
- **Notes per project:**
  - work-area notes that share vocabulary with the paths and commits;
  - the project-wide commands for running and testing;
  - notes about unrelated areas of the same repo;
  - exactly 3 stale or superseded notes (24 in total).
  - A note that replaces another is always newer than the note it replaces.
- **Deliberate traps:**
  - Stale notes that share the branch's words, so naive text matching ranks them high:
    - brightcart-web-10: refunds are done by hand;
    - meterly-api-08: totals are floats rounded at the end;
    - gitsweep-19: JSON output isn't planned;
    - parcelroute-15: retries are left to Kafka;
    - parcelroute-23: there is no DLQ;
    - trailmate-app-10: offline mode is out of scope;
    - trailmate-app-22: region metadata lives in AsyncStorage;
    - infra-orbit-09: stay on Postgres 13;
    - infra-orbit-20: use `default.postgres13`;
    - lumen-monorepo-12: dates use moment.js;
    - handbook-docs-11: v2 is internal-only;
    - handbook-docs-22: the old v1 deprecation date.
  - Unrelated or generic notes that share a word or a path with the context:
    - meterly-api-23 is about GDPR exports but mentions invoices;
    - gitsweep-15 is about `prune --remote`, and `prune.rs` is a recent path;
    - trailmate-app-18 is about release steps, and `app.config.ts` is a recent path. It is labeled neutral.
  - Relevant notes that share few words with the context:
    - parcelroute-22: the partition and replica layout;
    - meterly-api-07: finalized invoices are immutable;
    - infra-orbit-05: snapshot and maintenance window;
    - lumen-monorepo-24: the venue timezone on the booking page;
    - trailmate-app-03: the dev client instead of Expo Go.

## Judgment calls

- **Commands.** The test and run commands for the area being changed are relevant, because a good brief tells you how to verify the work. Other project-wide commands (lint, format, release, setup) are neutral.
- **Replacements of stale notes.** The current note that replaced a stale one is neutral when the branch doesn't need the topic:
  - meterly-api-10 (uv);
  - meterly-api-22 (invoice generation task);
  - lumen-monorepo-11 (tsup build);
  - infra-orbit-11 (S3 state).

  It is relevant when the branch works right on top of it:
  - parcelroute-09 (franz-go);
  - lumen-monorepo-21 (CSS Modules).
- **Borderline notes.** Rather than forcing these to one side, they are neutral:
  - brightcart-web-22 (currencies);
  - brightcart-web-23 (Storybook);
  - gitsweep-21 (config `protected_patterns`);
  - trailmate-app-14 (i18n);
  - trailmate-app-18 (release and OTA updates);
  - infra-orbit-17 (version pinning; `versions.tf` is a recent path);
  - parcelroute-19 (migrations);
  - handbook-docs-16 (search skips unlisted pages);
  - handbook-docs-21 (admonitions).
- **trailmate-app-22** is stale because of work on this branch (region metadata moved to SQLite in migration 0007), not because another note replaces it.
- **No status field.** Notes carry no review status (accepted, provisional or forget-requested). Every note here should be read as accepted, so tagging is not part of this corpus.

Frozen: do not edit; changes need a new corpus version and a new hash.
