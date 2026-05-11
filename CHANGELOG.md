# Changelog

All notable changes to agent-daemon. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

## [0.2.0] — 2026-05-11

### Added

**Cross-harness adapters.** First-class support for Cursor and Codex alongside Claude Code (our primary target).

- `adapters/cursor/hooks.json` — Cursor v1 hook bindings that route to our `ad hook <name>` Node helpers (the same handlers Claude Code uses).
- `adapters/cursor/adapt.mjs` — convert `skills/<name>/SKILL.md` → Cursor `.mdc` rule. Modes: single skill (stdout), `--all`, `--core` (skips vendored).
- `adapters/codex/config.example.toml` — drop-in Codex configuration mirroring our profile matrix.
- `adapters/codex/agents/explorer.toml` + `agents/reviewer.toml` — Codex sub-agent role definitions referenced from the example config.

**Install profiles.** `ad init` now drives skill set + hook injection + feature gating from `runtime/profiles/profiles.json`.

- `minimal` — memory + lifecycle hooks only.
- `developer` (default) — adds `console.log` warn + build/PR-URL log + 7 core skills.
- `security` — extends developer with `git --no-verify` block, dev-server-not-tmux block, MCP audit log, untrusted-server warning + 3 security skills.
- `setup.sh --profile <name>` and `setup.ps1 -Profile <name>` delegate to `ad init --profile`.

**Ported hooks.** Reimplemented four production hooks from [`everything-claude-code`](https://github.com/affaan-m/everything-claude-code) (MIT) as Node helpers under `runtime/src/hooks/`, exposed via `ad hook <name>`:

- `bash-pre` — block `git --no-verify` and dev-server-without-tmux; warn on `git push`.
- `bash-post` — surface `gh pr create` URLs, build completions.
- `edit-post` — warn on `console.log` in JS/TS files just edited.
- `mcp-audit` — append every MCP call to `~/.agent-daemon/audit/mcp.jsonl`; warn on untrusted servers.

**Skill catalog.** 181 net-new skills imported from upstream (each tagged with `source:` provenance frontmatter); `methodology-api-design` and `methodology-tdd` hand-merged with upstream sections.

**Tests.** 27 tests across hooks, profile resolver, skills-diff, and Cursor MDC conversion. `npm test` is wired in CI.

**CI.** GitHub Actions `test.yml` matrix (Ubuntu/macOS/Windows × Node 22) running `npm test`, `lint:skills`, `ad doctor` smoke, profile-plan smoke, and skills-diff shape check. `skills-lint.yml` for fast PR feedback on skill-only changes.

**Docs.** `ATTRIBUTION.md` at repo root credits upstream. `vendored/MANIFEST.md` pins the upstream commit (`841beea4`). `vendored/fetch.mjs` re-hydrates the snapshot. `docs/future-harnesses.md` records deferred work (Kiro/Trae/CodeBuddy/OpenCode/Gemini).

### Changed

- `runtime/scripts/lint-skills.mjs` exempts vendored skills (those carrying `source:` frontmatter) so upstream conventions don't break our linter.
- `runtime/package.json` test script: `node --test test/` → `node --test` (auto-discovery; old form failed with `MODULE_NOT_FOUND` when no fixtures matched).
- `hooks/README.md` documents the four new hook configs plus authoring conventions (`exit 0` on non-critical error, `<200ms` for blocking hooks, `[agent-daemon]` stderr prefix).
- `skills/README.md` explains the vendored-skill catalog and how to re-sync.
- `README.md` adds the install-profile matrix and links to `ATTRIBUTION.md`.

### Removed (from vendored snapshot)

These were stripped during import as out-of-scope for our daemon:

- `ecc2/` — upstream Rust control plane (architecture inspiration only).
- `ecc_dashboard.py` — upstream Tkinter dashboard.
- Multilingual READMEs, marketing files (`SOUL.md`, `EVALUATION.md`, `SPONSORS.md`, etc.).

Kept in the snapshot but not ported this release: `.codebuddy/`, `.kiro/`, `.trae/`, `.gemini/`, `.opencode/` — see `docs/future-harnesses.md`.

## [0.1.0] — 2026-05-10 (baseline)

Initial public state. Self-improving memory + skills runtime for Claude Code with multi-agent orchestration. 36 skills, 6 lifecycle hooks (SessionStart, SessionEnd, PreCompact, UserPromptSubmit, plus QMD-redirect), constitution layer, digest pipeline, GEPA skill evolution, multi-agent team templates, `ad init` / `ad doctor` / `ad team` / `ad spawn` CLI.

[0.2.0]: https://github.com/Pankaj-mobiux/Agent-Daemon/releases/tag/v0.2.0
[0.1.0]: https://github.com/Pankaj-mobiux/Agent-Daemon/releases/tag/v0.1.0
