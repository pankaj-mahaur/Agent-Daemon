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

## Installation

See the [Installation Guide](../docs/installation-guide.md) for all methods.

Quick:
```bash
# All skills globally
../setup.sh --all

# Specific skills
../setup.sh --skills review-slice,diagnose-fetch-failure
```
