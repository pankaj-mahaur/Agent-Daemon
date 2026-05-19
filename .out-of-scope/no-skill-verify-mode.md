# No `ad init --verify` or `ad skill verify` modes

## What was proposed

Add a dedicated verification mode for skills — either `ad init --verify` (post-install integrity check) or `ad skill verify <name>` (per-skill validation) — that confirms each installed skill's frontmatter is valid, its referenced sub-files exist, its commands resolve, and its trigger description still matches the agentskills.io spec.

## Why we said no

1. **`ad doctor` is already the verification surface.** `ad doctor` runs as a single command, walks every installed component (hooks, skills, profiles, memory templates, adapter configs), and reports issues with file:line context. Adding a `--verify` mode duplicates that path with a worse name (`verify` is vague — verify *what*?).

2. **`runtime/scripts/lint-skills.mjs` covers authorship-time validation.** Catches frontmatter errors, description-spec violations, missing required fields, kebab-case issues. Runs in CI and via `npm run lint:skills`. The cases a runtime `--verify` would catch are the ones lint already catches at the source.

3. **Per-skill verify is over-granular.** If a single skill is broken, the agent's symptom is "skill didn't trigger" or "skill triggered but referenced a missing file". Both surface immediately on use. A pre-emptive per-skill check is solving a problem nobody's hit.

4. **Adding the mode means maintaining its tests.** Test coverage for `--verify` requires fixture skills that are deliberately broken in N different ways. That's N more tests on every change to the skill schema. The maintenance tax outweighs the rare-edge-case coverage.

5. **The right surface for "did my install work?" is `ad status`.** Which already exists, lists installed components, and flags missing pieces.

## What would change our mind

- A user reports `ad doctor` missed a real skill-level breakage and they want a more granular check.
- Skill loading becomes asynchronous / parallel such that lint-at-author-time can no longer guarantee runtime success.
- The skill schema grows fields whose validity depends on the user's environment (e.g. tool availability), which lint *can't* check ahead of time — only a runtime probe can.

## Date

2026-05-19 (Phase 4 Group C — codifying the doctor-not-verify split)
