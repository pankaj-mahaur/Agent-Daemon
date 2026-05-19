# Skills

Each folder contains a `SKILL.md` that Claude Code can use. Install globally to `~/.claude/skills/` or per-project to `.agents/skills/`.

## Catalog

### Development Tools
| Skill | What it does |
|-------|-------------|
| [diagnose-fetch-failure](diagnose-fetch-failure/) | Diagnose CORS / network errors — usually a backend 500, not actually CORS |
| [graphify](graphify/) | Build knowledge graphs from code, docs, papers, images |
| [qmd](qmd/) | Search markdown knowledge bases with BM25 + vector hybrid search |
| [seed-data](seed-data/) | Generate idempotent database seed scripts with realistic test data |
| [merge-feature-branch](merge-feature-branch/) | Safely merge a shared branch into a long-lived feature branch |

### Review & Audit
| Skill | What it does |
|-------|-------------|
| [review-slice](review-slice/) | Deep-review a page/feature using a 9-class bug checklist |
| [security-audit](security-audit/) | Security review with trust boundary mapping |
| [production-readiness](production-readiness/) | Launch readiness checklist across all layers |
| [optimization-audit](optimization-audit/) | Frontend + backend performance review |
| [dead-code-review](dead-code-review/) | Proof-based dead code cleanup |
| [docs-sync-audit](docs-sync-audit/) | Detect and fix documentation drift |

### Productivity (Phase 4 — vendored from `mattpocock/skills`, MIT)

Workflow tools that pair with the daemon's continuous capture loop.

| Skill | What it does |
|-------|-------------|
| [caveman](caveman/) | Ultra-compressed output mode (~75% token reduction). Trigger: *"caveman mode"*, *"be brief"*, *"less tokens"*. |
| [handoff](handoff/) | Compact the current conversation into a handoff doc at `.agent-daemon/handoffs/handoff-<ts>.md` for the next agent. Solves /compact. |
| [grill-me](grill-me/) | Pre-implementation interview that walks every branch of the design tree. Trigger: *"grill me"*, *"stress-test this"*. |
| [grill-with-docs](grill-with-docs/) | Same as grill-me, but cross-references constitution + `.agent-daemon/memory/` and updates them inline. |
| [zoom-out](zoom-out/) | One-line skill to ask for the higher-level architectural picture. |

## Vendored from `everything-claude-code`

181 additional skills were imported from [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) (MIT, pinned commit in [vendored/MANIFEST.md](../vendored/MANIFEST.md)). These cover language stacks (python, golang, rust, kotlin, swift, dart/flutter, springboot, django, laravel, nestjs, etc.), domain ops (healthcare, finance, customs, energy, logistics), agent harness construction, eval harnesses, and many more.

Each vendored skill carries a `source:` frontmatter line pointing back to its upstream path. They are exempt from our [lint-skills.mjs](../runtime/scripts/lint-skills.mjs) rules and follow upstream conventions. List them with:

```bash
grep -l "^source:" skills/*/SKILL.md | sort
```

To re-sync from upstream: edit the pin in [vendored/fetch.mjs](../vendored/fetch.mjs), run `node vendored/fetch.mjs --force`, then `node runtime/scripts/skills-diff.mjs --apply`.

## Installation

See the [Installation Guide](../docs/installation-guide.md) for all methods.

Quick:
```bash
# All skills globally
../setup.sh --all

# Specific skills
../setup.sh --skills review-slice,diagnose-fetch-failure
```
