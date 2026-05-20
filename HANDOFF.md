# Handoff — Phase 4 Group B + C2-C5 shipped, C1 bucket reorg deferred

**Project:** agent-daemon
**Time:** 2026-05-19T12:13Z
**Branch:** `main` @ `09c8d07`
**Worktree:** `.claude/worktrees/dazzling-tu-461e13/` (claude/dazzling-tu-461e13 — fully merged to main)

---

## Context

Continued from the prior handoff (`92a555d`). Two phases shipped this session:

- **Phase 4 Group B (quality polish):** 4 commits — merged mattpocock methodology into 3 of our skills + added EXAMPLES.md for top 5 skills with concrete ❌/✅ pairs.
- **Phase 4 Group C2-C5 (architectural discipline, partial):** 3 commits — `.out-of-scope/` deferred-decision graveyard, lint-validate `argument-hint` + `disable-model-invocation`, Cursor constitution mirror script + 6 generated `.mdc` files.

**C1 (bucket reorg) deferred** — explicit user decision, picked up next session.

All work shipped to `origin/main`. 82/82 tests pass, 0 lint errors.

---

## State

### ✅ Done this session

**Group B (commits `006a4f5` → `3599342`):**
- `skills/debug-triage/SKILL.md` — Phase 4 "Disciplined diagnosis loop" (6-step methodology from mattpocock/diagnose)
- `skills/agent-self-improve/SKILL.md` — Writing-a-new-skill template + 3-step process + review checklist
- `skills/methodology-tdd/SKILL.md` — Deep modules / DI / SDK-style mocking section (from mattpocock/tdd sub-docs)
- 5 new EXAMPLES.md files in: debug-triage, agent-self-improve, methodology-tdd, implement-feature, handoff

**Group C2-C5 (commits `1e470b4` → `09c8d07`):**
- `.out-of-scope/` directory with README + 5 entries documenting deferred decisions (no-llm-extraction-v0.3, no-codex-runtime, no-agents-md-adapter, no-kiro-trae-codebuddy, no-skill-verify-mode)
- `runtime/scripts/lint-skills.mjs` — validates `argument-hint` (string ≤200 chars) and `disable-model-invocation` (literal true/false)
- `skills/bootstrap-daemon/SKILL.md` — gated with `disable-model-invocation: true` (it's destructive — explicit invocation only)
- `runtime/scripts/sync-constitution-to-cursor.mjs` + `npm run sync:constitution` — idempotent generator, converts `constitution/*.md` → `adapters/cursor/.cursor/rules/*.mdc` with `alwaysApply: true` frontmatter
- 6 `.mdc` files first-generated and committed: agent-daemon-core, agent-daemon-safety, agent-daemon-verification, agent-daemon-communication, agent-daemon-ending-protocol, karpathy-guidelines

### 🟡 In progress

Nothing in flight.

### 🔴 Deferred (next-session candidates)

- **C1 (bucket reorg, ~90 min):** Reorganize 40 non-vendored skills into `skills/engineering/`, `skills/productivity/`, `skills/daemon/`, `skills/domain/`, `skills/deprecated/`, `skills/in-progress/`. Touches:
  - `~40 git mv` operations (vendored ~186 skills probably stay flat)
  - `runtime/scripts/lint-skills.mjs` — needs recursive walk + bucket validation
  - `runtime/src/cli.mjs` — skill-resolution logic (currently `path.join(skillsSrc, skill)`; needs to walk buckets or maintain a flat-name map)
  - `runtime/profiles/profiles.json` — references skills by bare name; may still work depending on resolution strategy
  - `skills/README.md` — restructure to mirror new layout + link bucket-level READMEs
- **Option D (LLM fallback EOF bug, ~30-45 min):** `runtime/src/llm/claude-spawn.mjs` has stale `claude` CLI flags. Investigate current `claude --help`, strip invalid ones. Workaround: rules-based extractor covers the common case.
- **Option A (dogfood on redseer):** Apply daemon updates to real work. Existing redseer install needs `ad init` re-run to pick up upgrades since `4cfc1ba`.

---

## Next action (pick one)

### Option C1 — Finish Group C (bucket reorg)

The structural change Group C started. ~90 min, higher risk than the rest. Suggested approach:

1. **Plan-mode first.** Read `runtime/src/cli.mjs:225-310` (skill-install routine) and decide: walk buckets, or maintain a flat-name → bucketed-path map?
2. **Lint walker rewrite.** `runtime/scripts/lint-skills.mjs` currently does `fs.readdir(skillsDir)` and expects each entry to be a skill dir. Rewrite to recurse one level into bucket dirs.
3. **One bucket at a time.** Don't `git mv` all 40 at once. Start with `productivity/` (smallest, lowest-risk: caveman, handoff, grill-me, grill-with-docs, zoom-out, agent-self-improve) and verify lint + tests pass before moving to the next bucket.
4. **Vendored skills:** leave flat under `skills/` for this iteration. They're not in any profile. The bucket discipline is for our own skills.

### Option D — Fix the LLM fallback EOF bug

`runtime/src/llm/claude-spawn.mjs` — check current `claude --help` output, identify which flags are now invalid, strip them. ~30-45 min.

### Option A — Dogfood on redseer

```powershell
cd "D:\Program Files\Agent-Daemon"
git pull   # latest main 09c8d07

cd "D:\Program Files\Mobiux\redseer-frontend"
ad init    # idempotent — picks up Group B + C2-C5 upgrades
```

Then do real redseer work. Check after ~5 sessions:

```powershell
Get-Content .agent-daemon\sessions.jsonl | Measure-Object -Line
Get-Content .agent-daemon\memory\activeContext.md | Select-Object -Last 30
ls ~/.agent-daemon/handoffs/
```

---

## Open questions

1. **C1 bucket strategy:** Walk-time bucket resolution vs. flat-name → path map cached at install? Walking is simpler but slows `ad init`. Map is faster but adds a build step. Defer the decision to whoever picks up C1.
2. **Vendored skills in buckets?** Currently 186 vendored skills sit flat under `skills/`. Group C plan didn't explicitly bucket them. Recommendation: leave flat; they're not in profiles and bucketing them adds 186 more `git mv`s for zero user-visible win.
3. **Constitution mirror — when CI?** The cursor mirror script runs manually today. Should we add a CI check that `npm run sync:constitution` produces no diff (i.e. enforce mirror-is-current)? Open question, not blocking.

---

## Suggested skills (next session)

- **`agent-self-improve`** — open the project, ask what changed since last time, leave breadcrumbs
- **`handoff`** — auto-fires when ending the next session (3-action close protocol)
- **`audit-runner`** — if picking C1 (chunk-by-chunk bucket reorg with per-bucket verification)
- **`methodology-tdd`** — if writing tests for the lint walker rewrite (use the deep-modules / DI section we just added)

---

## Critical files (for next-session priming)

### Project root
- `C:\Users\panka\Documents\Claude\Projects\Agent Daemon\` — main checkout (on `main` branch)
- `CHANGELOG.md` — read the `[Unreleased]` section for what shipped this session
- `HANDOFF.md` — THIS FILE
- `.out-of-scope/README.md` — NEW: deferred-decision graveyard

### Plan (the source of truth)
- `C:\Users\panka\.claude\plans\https-github-com-affaan-m-everything-cla-cryptic-karp.md`
- Phase 4 Group C section at lines 544–630
- C1 specifically at lines 548–568

### Core daemon source (unchanged this session)
- `runtime/src/cli.mjs` — main CLI dispatcher. `cmdInit` skill-copy routine at lines 290–308 is what C1 will touch.
- `runtime/scripts/lint-skills.mjs` — added arg-hint + disable-model-invocation validators. C1 will need a recursive walker added here.
- `runtime/scripts/sync-constitution-to-cursor.mjs` — NEW, regenerate cursor rules

### Constitution
- `constitution/` — unchanged this session; mirrored to `adapters/cursor/.cursor/rules/`

### Skills index
- `skills/README.md` — full catalog. C1 will restructure this.
- `skills/handoff/SKILL.md` — already has `argument-hint:` frontmatter (Group A)
- `skills/bootstrap-daemon/SKILL.md` — NEW: `disable-model-invocation: true`

### Tests
- `runtime/test/extractors.test.mjs` — 82 tests, includes the 6 regression cases for real garbage
- All tests: `cd runtime && npm test`
- Lint: `node runtime/scripts/lint-skills.mjs` (0 errors, 18 warnings — all vendored skipped)

---

## How to start the next session

1. **Read THIS file** first.
2. **Read** `CHANGELOG.md` `[Unreleased]` section.
3. **Verify** baseline clean: `node runtime/scripts/lint-skills.mjs && cd runtime && npm test` (should show 0 errors + 82/82).
4. **Pick** C1 / D / A above.
5. **For C1:** start with plan-mode. The script changes are higher-risk than the `git mv`s.

---

## Related

- **Plan:** `~/.claude/plans/https-github-com-affaan-m-everything-cla-cryptic-karp.md`
- **GitHub:** https://github.com/Pankaj-mobiux/Agent-Daemon
- **Latest commit:** `09c8d07` (cursor constitution mirror)
- **CHANGELOG section:** `[Unreleased]` covers Phase 3, 4, 4.1, and now Phase 4 Group B + C2-C5

---

*Generated by the `handoff` skill (dual-write). Also written to `~/.agent-daemon/handoffs/agent-daemon/handoff-2026-05-19T12-13-17Z.md` for the global cross-project trail.*
