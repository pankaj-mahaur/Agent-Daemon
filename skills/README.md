# Skills

Each folder contains a `SKILL.md` that Claude Code can use. Install globally to `~/.claude/skills/` or per-project to `.agents/skills/`.

## Layout

Non-vendored skills are organised into buckets by purpose. Vendored upstream skills (carrying a `source:` frontmatter line) stay flat under `skills/` and follow their original conventions. Skill **names** are unique across the catalog — installers and profile manifests reference skills by bare name, the bucket location is resolved automatically.

```
skills/
├── engineering/       Daily code work — debug, implement, review, methodologies, audits
├── productivity/      Workflow + self-improvement — agent-self-improve, parsing/regex patterns
├── daemon/            Daemon-internal — bootstrap, orchestrate-team
├── domain/            Project-specific (none yet for agent-daemon — populated per consumer)
├── deprecated/        Kept for reference, NOT installed by any profile
├── in-progress/       Drafts not ready for use
└── <flat-vendored>/   181 vendored ECC skills + 5 mattpocock productivity skills (have `source:` frontmatter)
```

## Buckets

| Bucket | Count | Quick reference |
|---|---:|---|
| [engineering/](engineering/README.md) | 31 | `debug-triage`, `implement-feature`, `review-slice`, `methodology-*` (14), `audit-runner`, `seed-data`, `security-audit`, … |
| [productivity/](productivity/README.md) | 7 | `agent-self-improve`, `graphify`, `qmd`, `llm-output-lenient-parsing`, `regex-clause-anchored-extractors`, `audit-every-attempt`, `repomix-deep-research` |
| [daemon/](daemon/README.md) | 2 | `bootstrap-daemon`, `orchestrate-team` |
| domain/ | 0 | (consumers add `<project>-*` skills here) |
| deprecated/ | 0 | empty |
| in-progress/ | 0 | empty |

For per-skill detail, open the bucket's `README.md`.

## Vendored productivity skills (flat, `source:` frontmatter)

These 5 came in via Phase 4 Group A from [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT). Listed here because they're part of our active rotation despite carrying upstream provenance:

| Skill | What it does |
|-------|-------------|
| [caveman](caveman/) | Ultra-compressed output mode (~75% token reduction). Trigger: *"caveman mode"*, *"be brief"*. |
| [handoff](handoff/) | Compact the conversation into a handoff doc at BOTH `.agent-daemon/handoffs/` (per-project) AND `~/.agent-daemon/handoffs/<slug>/` (global). Auto-fires on session close. |
| [grill-me](grill-me/) | Pre-implementation interview that walks every branch of the design tree. Trigger: *"grill me"*, *"stress-test this"*. |
| [grill-with-docs](grill-with-docs/) | Same as grill-me, but cross-references constitution + `.agent-daemon/memory/` and updates them inline. |
| [zoom-out](zoom-out/) | One-line skill to ask for the higher-level architectural picture. |

## Vendored from `everything-claude-code`

181 additional skills were imported from [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) (MIT, pinned commit in [vendored/MANIFEST.md](../vendored/MANIFEST.md)). These cover language stacks (python, golang, rust, kotlin, swift, dart/flutter, springboot, django, laravel, nestjs, etc.), domain ops (healthcare, finance, customs, energy, logistics), agent harness construction, eval harnesses, and many more. They live **flat under `skills/`** rather than in buckets.

Each vendored skill carries a `source:` frontmatter line pointing back to its upstream path. They are exempt from our [lint-skills.mjs](../runtime/scripts/lint-skills.mjs) rules and follow upstream conventions. List them with:

```bash
grep -l "^source:" skills/*/SKILL.md | sort
```

To re-sync from upstream: edit the pin in [vendored/fetch.mjs](../vendored/fetch.mjs), run `node vendored/fetch.mjs --force`, then `node runtime/scripts/skills-diff.mjs --apply`.

## How resolution works

Installers and profile manifests reference skills by bare name (`"audit-runner"`, not `"engineering/audit-runner"`). At install time, `runtime/src/skills-source.mjs:buildSkillIndex` walks both flat and bucketed layouts and produces a `name → absolute-path` map. The destination is always flat (`~/.claude/skills/<name>/SKILL.md`) because that's what Claude Code reads.

This means:

- You can rename a bucket or move a skill between buckets without touching `profiles.json` or any installer.
- Two skills with the same name in different buckets is **undefined behavior** — the bucket walker order wins. Don't do it.
- Vendored skills stay flat because there's no value in bucketing 181 files Claude Code installers will never directly install.

## Installation

See the [Installation Guide](../docs/installation-guide.md) for all methods.

Quick:
```bash
# All skills globally
../setup.sh --all

# Specific skills
../setup.sh --skills review-slice,diagnose-fetch-failure
```
