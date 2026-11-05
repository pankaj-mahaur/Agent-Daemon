# Held-out corpora (L0, frozen)

Test data for the gates of the MCP + plugin platform plan (parts L4a, L4c, L5, L6, L7b). Plan decision D29: the corpora are written by a different agent than the implementer and frozen before the build, so a part can't grade itself.

## Provenance

- **Written 1 Nov 2026 by four clean-room subagents** (Claude Opus 5.5), one per group below, each from a short brief by the L0 session.
- **What they read:** only the plan sections that state each gate (02 §2–3 and 04 L0, L4a, L4c, L5, L6, L7, L7b). None of them opened implementation code, tests, other corpora or the repo docs. Each folder's README says exactly what its writer read and lists the judgment calls it made.
- **Placeholders:** `{pkg}` stands for the product's command and `{adroot}` for its user-level state folder (today `~/.agent-daemon`). Tests substitute them.
- **Secrets:** any secret is a documented fake (AWS `…EXAMPLE` keys) or a `FAKE` placeholder.

## The corpora

| Folder | Gated file(s) | Items | L0 minimum | Gate (part) |
|---|---|---|---|---|
| `poisoning/` | `poisoning.jsonl` | 107 | 80 | ≥ 95% flagged or quarantined; 0 provisional from non-typed sources (L5) |
| `extractor/` | `extractor.jsonl` | 178 | 150 | precision ≥ 0.85, recall ≥ 0.6 (L4a) |
| `guards/` | `must-block.jsonl`, `must-allow.jsonl` | 184 / 154 | 80 / 80 | 0 misses; ≤ 2% false positives (L4c, L7) |
| `starter-policy/` | `must-block.jsonl`, `must-allow.jsonl` | 143 / 145 | 60 / 100 | 0 misses; ≤ 2% false positives (L7b) |
| `correction-pattern/` | `correction-pattern.jsonl` | 71 | 60 | derivation accuracy ≥ 0.8 (L4c) |
| `prompt-recall/` | `prompts.jsonl` (+ `notes.jsonl`) | 64 prompts, 78 notes | 40 | precision ≥ 0.8 above the threshold (L6) |
| `brief-relevance/` | 8 projects (`context.json`, `notes.jsonl`, `expected.json`) | 8 | 8 | a relevant note in ≥ 7 of 8 briefs; ≤ 20% irrelevant (L6) |

`ambiguous.jsonl` files hold cases the writer couldn't label from the plan's definitions, each with a recommended answer in `why`. They are **not gated**; the plan owner decides them (see 10-PROGRESS).

## Frozen

`MANIFEST.json` records a SHA-256 for every file (LF-normalised), and `runtime/test/corpora-frozen.test.mjs` fails if any file changes, appears or disappears, or if a gated file drops below its minimum. A deliberate new version means a new corpus written the same way, then `node runtime/test/corpora-frozen.test.mjs --write-manifest` and the new hashes in the plan's progress file.
