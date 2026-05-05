# Claude Code Toolkit

A collection of reusable [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills, audit playbooks, and configuration examples. Clone this repo and install the skills you need — works with any project, any stack.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/claude-code-toolkit.git

# 2. Install all skills (or pick specific ones)
# Bash:
./setup.sh --all
# PowerShell:
./setup.ps1 -All

# 3. Skills are now available in Claude Code via /skill-name or auto-trigger
```

## Skill Catalog

| Skill | Description | Dependencies | Trigger |
|-------|-------------|--------------|---------|
| [diagnose-fetch-failure](skills/diagnose-fetch-failure/) | Diagnose CORS / network errors in frontend-backend setups | None | Auto: "CORS blocked", "API not working" |
| [graphify](skills/graphify/) | Any input (code, docs, papers, images) to knowledge graph | Python 3.9+, `pip install graphifyy` | `/graphify` |
| [qmd](skills/qmd/) | Search markdown knowledge bases with hybrid BM25 + vector search | Node.js 18+, `npm install -g @tobilu/qmd` | `/qmd` |
| [seed-data](skills/seed-data/) | Generate idempotent database seed scripts with realistic data | None | Auto: "generate seed data" |
| [review-slice](skills/review-slice/) | Deep-review any page/feature using a 9-class bug checklist | None | `/review-slice` or auto |
| [merge-feature-branch](skills/merge-feature-branch/) | Pull a shared branch into a long-lived feature branch safely | None | Auto: merge/rebase requests |
| [security-audit](skills/security-audit/) | Security review with trust boundary mapping | None | `/security-audit` |
| [production-readiness](skills/production-readiness/) | Launch readiness checklist across all layers | None | `/production-readiness` |
| [optimization-audit](skills/optimization-audit/) | Frontend + backend performance review workflow | None | `/optimization-audit` |
| [dead-code-review](skills/dead-code-review/) | Proof-based dead code cleanup | None | `/dead-code-review` |
| [docs-sync-audit](skills/docs-sync-audit/) | Detect and fix documentation drift | None | `/docs-sync-audit` |

## Playbooks

Standalone reference docs — useful even without Claude Code:

- [Bug Class Checklist](playbooks/bug-class-checklist.md) — 9 universal bug patterns with detection and fix strategies
- [Security Checklist](playbooks/security-checklist.md) — Trust boundary + auth checklist for web apps
- [Production Readiness](playbooks/production-readiness.md) — Full launch checklist with checkboxes
- [CI/CD Practices](playbooks/ci-cd-practices.md) — Lint, format, type-check, multi-repo commit patterns
- [CSV Export Safety](playbooks/csv-export-safety.md) — Formula injection, BOM, CRLF, URL lifecycle

## Examples

Copy-paste configuration templates:

- [Global settings](examples/settings-global.json) — `~/.claude/settings.json` with model, plugins, marketplace
- [Project settings](examples/settings-project.json) — `.claude/settings.json` with hooks and permissions
- [Graphify hook](examples/hooks-graphify.json) — PreToolUse hook for graph-aware exploration
- [CLAUDE.md template](examples/CLAUDE.md.example) — Project documentation template
- [AGENTS.md template](examples/AGENTS.md.example) — Multi-repo workspace template

## Installation Options

### Install all skills globally
```bash
./setup.sh --all                          # Linux/macOS
./setup.ps1 -All                          # Windows
```

### Install specific skills
```bash
./setup.sh --skills diagnose-fetch-failure,review-slice,seed-data
./setup.ps1 -Skills diagnose-fetch-failure,review-slice,seed-data
```

### Install as project-local skills
```bash
cd /path/to/your/project
/path/to/setup.sh --skills review-slice --project-local
```

### Manual install
Copy any `skills/<name>/` folder to `~/.claude/skills/<name>/` (global) or `.agents/skills/<name>/` (project-local).

## Docs

- [Skill Anatomy](docs/skill-anatomy.md) — How SKILL.md works, frontmatter fields, trigger system
- [Installation Guide](docs/installation-guide.md) — All 3 install methods with OS-specific instructions
- [Customization Guide](docs/customization-guide.md) — Fork and adapt skills for your project

## License

MIT
