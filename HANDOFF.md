# Handoff — Phase 5 shipped (WS-1..WS-8): deeper Claude integration + self-improving polish

**Project:** agent-daemon
**Time:** 2026-05-21
**Branch:** `main` @ `2a73cb5` (PR #2 merged)
**Status:** Working tree clean. Local == origin/main.

---

## Context

Continued from prior handoff (`c7e9be1`). Eight-workstream pass shipped end-to-end via `feat/claude-deep-integration` branch (10 commits, merged via PR #2 as `2a73cb5`). The goal: make agent-daemon feel native to Claude Code, broader-triggered, fully self-improving **without API keys**, and tighter on multi-agent internals.

**141/141 tests pass** (97 → 141, +44 new). **0 lint errors** (18 vendored-only warnings).

---

## State

### ✅ Recent commits (newest first, all on `main`)

- `2a73cb5` — **merge:** PR #2 from `feat/claude-deep-integration` into `main`. 10-commit feature branch, all WS-1..WS-8 work.
- `d2d785f` — **WS-8:** `activeContext.md` weekly rotation (size + age compound trigger; size > 32KB AND mtime > 7 days). Archives oldest 50% to `.agent-daemon/archive/activeContext-<YYYY-MM-DD>.md`.
- `37f9cfb` — **WS-7d:** Template schema versioning + v1→v2 auto-migration. `CURRENT_SCHEMA_VERSION = 2` in `templates.mjs`. All 4 shipped templates updated with `schema_version: 2`. v1 user templates migrate in memory + one-shot stderr warning.
- `f29d0e9` — **WS-7c:** File-conflict pre-detection. New `runtime/src/orchestration/conflict-detect.mjs` scans task descriptions for overlapping file paths between unordered task pairs. Hooked into `cmdSpawn`: TTY prompt, non-TTY warn-and-proceed.
- `f023a58` — **WS-7b:** Task retry/rollback semantics. New fields `attempts`, `max_retries`, `last_error`, `next_retry_at`. New `markTaskFailed()` + `retryTask()` + `ad team retry --team <id> --task <task-id>` CLI (alias `ad tr`). Exponential backoff `2^attempts × 30s`.
- `991c10e` — **WS-7a:** Inbox `acked/` purge. New `purgeAckedOlderThan()` deletes >7-day-old acked messages. Non-blocking + 6-hour throttle marker.
- `b489d53` — **WS-6:** Broaden triggers. 7 new Hinglish regex rules in `extractors.mjs` at confidence 0.45 (clause-anchored). 4 skills updated with Hinglish trigger phrases (debug-triage, implement-feature, review-slice, security-audit).
- `4f5c3b3` — **WS-5:** Inline GEPA mode (no API key). New `ad evolve --list-candidates [--json]` and `--export-traces` flags. New skill `skills/daemon/gepa-evolve-inline/`. New module `runtime/src/digest/gepa/export-traces.mjs`. Auth-fallback messaging in `evolve.mjs`.
- `8a7f0dd` — **WS-4:** `session-close` skill. Auto-triggers on Hinglish + English session-end phrases. 7-phase no-API protocol: read CLAUDE.md → idempotency check → update session-log → emit digest block → invoke handoff → GEPA queue → touch flag.
- `2aa69bf` — **WS-2:** `skill-author` meta-skill. Dedup-first authoring (≥70% overlap → append-mode). Cross-session log at `.agent-daemon/skill-author-log.jsonl` + global mirror. Global-vs-project scope decision encoded.
- `db76752` — **WS-1 + WS-3:** Stack-detection-driven smart skill install. New `ad init --skills-mode <smart|all|minimal|manual>` (default `smart`). New `stack-detect.mjs` + `stack-skill-map.json`. Project-local install lane (`<cwd>/.claude/skills/`). mtime-based idempotency. Deeper `~/.claude/` integration: global `CLAUDE.md` managed block + `~/.claude/commands/` copy.

### 🟡 In progress

Nothing in flight.

### 🔴 Open items (none blocking)

- **Two `session-close` skills now exist** — the new `skills/daemon/session-close/` (7-phase, with GEPA queue + idempotency flag) and the legacy `skills/session-close-dual/` (2-phase, simpler). They don't conflict but the catalog has dual entries. Consider: deprecate the older one or keep both for backwards compatibility.
- **Hinglish regex confidence at 0.45** — may need tuning after real-world dogfood. Drain step boosts duplicates so worst case degrades gracefully. Watch the journal for false-positive rates.
- **Inline GEPA quality drift** — `.agent-daemon/proposed/<skill>-<ts>.md` files now include a `# Proposed via inline GEPA (active session)` disclaimer header. The `ad review` gate is mandatory — proposals from inline mode are higher-variance than the headless-claude path.
- **Memory rotation thresholds (32KB / 7d compound)** — chosen conservatively. May need tuning if real projects don't rotate often enough. Archive is recoverable.

---

## Verify baseline clean

```bash
cd runtime && npm test           # expect: 141/141 pass
node runtime/scripts/lint-skills.mjs   # expect: 0 errors, 18 warnings (vendored)
git status                       # expect: clean
git log origin/main..HEAD        # expect: empty
```

---

## How to start the next session

1. **Read THIS file first.**
2. Read `CHANGELOG.md` `[Unreleased]` section — Phase 5 entry has the full story.
3. Verify baseline clean (commands above).
4. Pick from open items, or start a new direction.

---

## Critical files

### New in Phase 5

- `runtime/src/stack-detect.mjs` — project stack detection
- `runtime/profiles/stack-skill-map.json` — stack → skill mapping
- `runtime/src/orchestration/conflict-detect.mjs` — file-overlap detection
- `runtime/src/digest/gepa/export-traces.mjs` — JSONL trace export for inline GEPA
- `skills/daemon/skill-author/SKILL.md` — dedup-first skill authoring
- `skills/daemon/session-close/SKILL.md` — no-API session-end macro
- `skills/daemon/gepa-evolve-inline/SKILL.md` — no-API GEPA via active session
- `commands/skill-author.md` — slash command wrapper

### Heavily modified in Phase 5

- `runtime/src/cli.mjs` — `cmdInit` (smart mode + project-local install + global `~/.claude/` integration), `cmdEvolve` (`--list-candidates`, `--export-traces`, auth-fallback messaging), `cmdTeam` retry case
- `runtime/src/hooks/extractors.mjs` — 7 Hinglish rules added
- `runtime/src/orchestration/inbox.mjs` — `purgeAckedOlderThan` + `readInbox` non-blocking purge call
- `runtime/src/orchestration/team.mjs` — `markTaskFailed`, `retryTask`, new task fields
- `runtime/src/orchestration/templates.mjs` — `CURRENT_SCHEMA_VERSION`, `migrateV1ToV2`
- `runtime/src/orchestration/spawn.mjs` — already imports conflict-detect via cmdSpawn (no in-file change)
- `runtime/src/session-start.mjs` — `rotateActiveContextIfNeeded` + pre-drain call
- `teams/templates/*.json` — all 4 templates marked `schema_version: 2`

### From prior phases (unchanged but referenced)

- `runtime/src/skills-source.mjs` — bucket-aware skill resolver
- `runtime/src/digest/apply.mjs` — cross-session dedup
- `runtime/src/digest/gepa/evolve.mjs` — full GEPA pipeline (now with auth-fallback messaging)

---

## Try it (Mobiux project already has all of this installed)

In `D:\Program Files\Mobiux\mobiux-website\`:

| Bolo (Claude Code) | Kya hota hai |
|---|---|
| *"har baar yaad rakhna pnpm use karna"* | `skill-author` skill auto-triggers — dedup search, write or append |
| *"bye, aaj ka kaam ho gaya"* | `session-close` skill auto-triggers — 7-phase no-API protocol |
| *"kuch toot gaya site mein"* | `debug-triage` skill (now with Hinglish trigger) |
| *"evolve skill debug-triage"* | `gepa-evolve-inline` skill — inline reflection, no API key |
| `ad init --plan --skills-mode smart` | Smart mode plan for current cwd (stack detection visible) |
| `ad evolve --list-candidates --json` | List skills needing evolution (no auth) |
| `ad tr --team <id> --task <task-id>` | Retry a failed task |

---

## Related

- **GitHub:** https://github.com/Pankaj-mobiux/Agent-Daemon
- **PR #2 (merged):** Phase 5 work
- **Latest commit:** `2a73cb5` (merge into main)
- **Plan:** `~/.claude/plans/c-users-panka-claude-skills-humne-jab-da-binary-llama.md`
- **Prior handoff:** Phase 4 — `c7e9be1`
