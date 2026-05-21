# Handoff — Phase 4 fully shipped + 4.2 noise pass + dedup + scaffolding committed

**Project:** agent-daemon
**Time:** 2026-05-21
**Branch:** `main` @ `cb61729`
**Status:** Working tree clean. Local == origin/main.

---

## Context

Continued from prior handoff (`09c8d07`). Phase 4 fully shipped end-to-end this stretch (Groups A + B + C + D) plus the Phase 4.2 noise pass, cross-session dedup fix, and today's housekeeping commit.

97/97 tests pass. 0 lint errors (18 warnings — all vendored skills skipped).

---

## State

### ✅ Recent commits (newest first)

- `cb61729` — **chore:** scaffolding commit. Added `AGENTS.md`, `HANDOFF.md`, `session-logs/` (`.gitignore` + README) to the repo. Pure housekeeping.
- `00a9c9d` — Noise pass round 2: clause-anchored 4 more rules (`decision-decided`, `gotcha-the-bug-was`, `convention-the-convention-is`, `tool-the-command-is`) using broader boundary set `[.!?,;:—–-]`. Dropped `to` from `FRAGMENT_LEADERS`.
- `cd59788` — Cross-session dedup: `appendToMemory` now dedupes against existing `activeContext.md` content. Fixes the 2× duplicate issue seen in real dogfood data.
- `65e3f99` — Fixed LLM fallback EOF in `runtime/src/llm/claude-spawn.mjs` (dropped `shell:true`, fixed `--mcp-config` payload to `{"mcpServers":{}}`).
- C1 bucket reorg: 40 non-vendored skills moved into `engineering/` (31), `productivity/` (7), `daemon/` (2). Vendored 186 stay flat. Bucket-aware resolver landed in `runtime/src/skills-source.mjs`.
- C2-C5: `.out-of-scope/` graveyard, arg-hint + disable-model-invocation lint, cursor constitution mirror.
- B1-B4: merged mattpocock methodology into 3 skills + 5 `EXAMPLES.md` files.

### 🟡 In progress

Nothing in flight.

### 🔴 Open items (none blocking)

- **Existing residue in `activeContext.md`** — bad regex captures from pre-fix sessions still on disk. Cosmetic only (won't be re-amplified by dedup). Options: manual edit, or write an `ad memory clean` cleanup script.
- **Dogfood on redseer** — pull `D:\Program Files\Agent-Daemon\` to pick up today's fixes (`65e3f99`, `cd59788`, `00a9c9d`), then run real work for a few days.
- **Phase 5 candidates** documented in `.out-of-scope/` — not committed to.

---

## Verify baseline clean

```bash
node runtime/scripts/lint-skills.mjs     # expect: 0 errors, 18 warnings
cd runtime && npm test                   # expect: 97/97 pass
git status                               # expect: clean
git log origin/main..HEAD                # expect: empty
```

---

## How to start the next session

1. **Read THIS file first.**
2. Read `CHANGELOG.md` `[Unreleased]` section.
3. Verify baseline clean (commands above).
4. Pick from open items, or start a new direction.

---

## Critical files

- `HANDOFF.md` — this file
- `CHANGELOG.md` — `[Unreleased]` section
- `~/.claude/plans/https-github-com-affaan-m-everything-cla-cryptic-karp.md` — source-of-truth plan
- `.out-of-scope/README.md` — deferred-decision graveyard
- `runtime/src/skills-source.mjs` — bucket-aware skill resolver (added during C1)
- `runtime/src/llm/claude-spawn.mjs` — LLM fallback (fixed in `65e3f99`)
- `runtime/src/digest/apply.mjs` — cross-session dedup (fixed in `cd59788`)
- `runtime/src/hooks/extractors.mjs` — clause-anchored regex (tightened in `00a9c9d`)

---

## Related

- **GitHub:** https://github.com/Pankaj-mobiux/Agent-Daemon
- **Latest commit:** `cb61729` (scaffolding housekeeping)
- **Plan:** `~/.claude/plans/https-github-com-affaan-m-everything-cla-cryptic-karp.md`
