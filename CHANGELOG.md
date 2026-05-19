# Changelog

All notable changes to agent-daemon. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

## [Unreleased]

### Added — Phase 4 Group A++: 4 generic global skills + dual-write handoff + auto-handoff via CLAUDE.md

Extracted this development session's most reusable lessons as **project-agnostic global skills** — every project that installs agent-daemon gets these, no daemon-specific dependencies. Plus wired the session-close protocol to automatically create handoff docs at both per-project AND global paths.

**4 new generic skills** (any-language, any-project):

- **`skills/llm-output-lenient-parsing/`** — Pattern for parsing LLM-emitted structured blocks when Claude drifts the format (colon for hyphen, YAML for JSON, fenced for bare). Fallback chain: strip fences → strict JSON → tolerant YAML → coerce-then-retry. Hand-rolled YAML parser pattern for fixed schemas. Test fixtures from real transcripts. Distilled from the agent-daemon v0.3 lenient parser fix.
- **`skills/regex-clause-anchored-extractors/`** — Anchor natural-language regex to clause boundaries (`(?:^|[.!?]\s+|\n)`) to stop mid-sentence fragment matches. Concrete before/after for the `we always|never` rule that produced 75% noise. Confidence calibration tiers (auto-apply / queue-for-review / episodic-only / delete) based on real precision data.
- **`skills/audit-every-attempt/`** — Engineering principle: write a one-line audit on every code path — success, failure, skip, no-op. Distinguishes "didn't run" from "ran, did nothing." Schema recommendation, where-to-write tiers by volume, anti-patterns. Cites the agent-daemon v0.2 → v0.3 audit-ledger gap.
- **`skills/repomix-deep-research/`** — Workflow for evaluating remote GitHub repos via repomix pack → grep → read. Beats WebFetch by 60x for multi-file analysis. Pattern guide with real call examples. Adoption-decision template.

**Handoff skill upgraded — now dual-writes:**

`skills/handoff/SKILL.md` now writes to **both** locations on a single invocation:
- **Per-project:** `<cwd>/.agent-daemon/handoffs/handoff-<ISO-ts>.md` (committable, lives with the code)
- **Global:** `~/.agent-daemon/handoffs/<project-slug>/handoff-<ISO-ts>.md` (cross-project personal trail; project-slug is lowercased path)

Identical content, two destinations. Lets you `grep` "what was I doing last week" across every project at once.

**`ad init` scaffolding extended:**

`runtime/src/cli.mjs` now creates **both** handoff directories:
- `<cwd>/.agent-daemon/handoffs/` (per-project, was already there from Phase 4 Group A)
- `~/.agent-daemon/handoffs/<project-slug>/` (NEW — global trail per project)
- `~/.agent-daemon/handoffs/README.md` — top-level README with cross-project grep example

Non-fatal if the global dir can't be created (e.g. permission issue) — per-project still works.

**CLAUDE.md managed section: session-close protocol upgraded from 2 actions to 3:**

Previously the daemon's managed CLAUDE.md section instructed Claude on a 2-action protocol when the user said "end session" / "session khatam" / etc — update session log + emit digest block. Now it's **3 actions** — adds automatic handoff doc creation at both per-project and global paths.

Trigger phrases widened: also fires on `"wrapping up"`, `"I'm done"`. All three actions happen in the same response, no confirmation asked.

Existing projects with the v0.3 managed section will get the upgraded 3-action protocol on next `ad init` (idempotent — replaces the section).

### Added — Phase 4 Group A: Karpathy guidelines + 5 productivity skills

After deep-researching `forrestchang/andrej-karpathy-skills` (~110K stars) and `mattpocock/skills` (MIT, 21 active skills), imported Group A — the high-leverage subset that improves baseline session quality without disrupting existing flow. All additive, zero regression risk.

**`constitution/karpathy-guidelines.md`** — distilled from Andrej Karpathy's 2026-01-26 observations on LLM coding pitfalls. Four behavioral guardrails injected into every SessionStart alongside `core.md`:
1. **Think Before Coding** — state assumptions, present alternatives, push back, stop when confused
2. **Simplicity First** — minimum code, no speculative features, "would a senior engineer call this overcomplicated?"
3. **Surgical Changes** — touch only what you must, match existing style, mention dead code don't delete
4. **Goal-Driven Execution** — verifiable success criteria, "Add validation → write tests for invalid inputs, then make them pass"

Wired in `runtime/src/session-start.mjs` — always-loaded with `core.md`, ~3KB total system-prompt cost.

**5 new skills (vendored from `mattpocock/skills` MIT, all with `source:` frontmatter):**

- **`skills/caveman/`** — Ultra-compressed output mode. ~75% token reduction by dropping filler / articles / pleasantries while keeping technical accuracy. Persistent once triggered. Triggers: *"caveman mode"*, *"be brief"*, *"less tokens"*.
- **`skills/handoff/`** — Compact current conversation into a durable handoff doc at `<cwd>/.agent-daemon/handoffs/handoff-<ts>.md` for the next agent. Adapted from upstream (`mktemp -t handoff-XXX.md`) to land inside the daemon's audit trail. Solves /compact persistence problem.
- **`skills/grill-me/`** — Pre-implementation interview that walks every branch of the design tree. One question at a time. Stops the "Claude built the wrong thing" failure mode.
- **`skills/grill-with-docs/`** — Same as grill-me, but cross-references `constitution/` + `.agent-daemon/memory/activeContext.md` and **updates them inline** as decisions crystallise. Adapted from upstream `CONTEXT.md` + `docs/adr/` pattern to use our memory layout.
- **`skills/zoom-out/`** — One-line skill to ask for the higher-level architectural picture (callers, dependencies, seam location) instead of line-by-line code.

**`ad init` scaffolds `.agent-daemon/handoffs/`** with a README explaining the directory's purpose. Idempotent — skips if already present.

`skills/README.md` updated with new "Productivity (Phase 4)" section.

Tests: still 74/74 pass — no new code paths required testing.

### Added — Continuous learning capture (Phase 3 — kills the digest-block dependency)

Production use surfaced a hard architectural problem: the v0.2.x daemon relied on Claude emitting a `<agent-daemon-digest>` JSON block at session end + the harness firing `SessionEnd` to trigger the digest pipeline. Both legs broke — the VS Code Claude Code extension misses ~30% of `SessionEnd` events, and Claude drifts the block format (colon for hyphen, YAML for JSON) so even when the hook fires, the parser rejects the payload. Two real multi-hour sessions in `redseer-frontend` produced zero captured learnings.

Phase 3 rebuilds capture on **`UserPromptSubmit`** (95% harness-enforced, works in VS Code extension) + **`SessionStart`** (100% enforced) so Claude doesn't have to remember or format anything correctly.

**`UserPromptSubmit` hook — `ad hook user-prompt-extract`.** Fires before every user turn. Reads the user's prompt + the previous assistant turn (tailing the transcript JSONL), runs ~12 rules-based regex extractors, and appends matches to `<cwd>/.agent-daemon/learning-journal.jsonl`. Zero LLM calls. Zero Claude cooperation. <50 ms typical latency.

Patterns detected:
- Corrections — `"actually we use X"`, `"no it's X"`, `"not X but Y"`
- Notes — `"remember: X"`, `"important: X"`, `"we always X"`, `"never X"`
- Conventions — `"the convention is X"`, `"we standardize on X"`
- Decisions — `"decided X"`, `"we'll go with X"`, `"let's use X"`
- Gotchas — `"the bug was X"`, `"root cause was X"`, `"TIL: X"`, `"X fails because Y"`
- Tools — `"the right command is X"`

Each match carries `evidence_quote` (≤200 chars), `evidence_speaker` (user/agent), `confidence` (0.5–0.75), and auto-tags. Modules: `runtime/src/hooks/user-prompt-extract.mjs`, pure rule registry in `runtime/src/hooks/extractors.mjs`, journal writer in `runtime/src/hooks/journal.mjs`. Smoke replay against an 8.8-hour real session: **14 learnings captured** (12 patterns, 1 gotcha, 1 decision).

**`SessionStart` drain.** Extended `runtime/src/session-start.mjs` to drain the journal at every session open, dedupe + classify + apply via the existing digest pipeline, then archive to `learning-journal.archive.jsonl`. Project-scoped `pattern`/`decision`/`tool` with confidence ≥ 0.5 append to `activeContext.md`. `correction`/`gotcha` go to `.agent-daemon/proposals/` for `ad status` review. Surfaces a one-line note in the session injection telling Claude what was carried over. Module: `runtime/src/hooks/journal-drain.mjs`.

**Profile wiring.** `user-prompt-extract` added to all three profiles (`minimal`/`developer`/`security`) in `runtime/profiles/profiles.json`. Standalone snippet at `hooks/user-prompt-submit-extract.json` for manual installs.

### Changed — Lenient digest-block parser

`runtime/src/digest/extract.mjs` now accepts both tag forms (`<agent-daemon[-:]digest>`) and both payload formats (JSON + a small hand-written YAML parser tuned to the digest schema — no new npm dep). Strips `` ```json `` and `` ```yaml `` Markdown fences. The tag regex is now global so the *last* block in a multi-block assistant turn wins (the intent was always "most-recent block wins" — the previous code took the first match in the turn). `VALID_TYPES` widened to accept the new `gotcha` and `decision` types.

### Changed — Audit ledger writes on every digest attempt

`runtime/src/digest/digest.mjs` now appends to `sessions.jsonl` on **all** exit paths: triage-skip, no-block-found, extract-error, success. Previously only success + triage-skip wrote a line, leaving "the daemon never ran" indistinguishable from "the daemon ran and found nothing." New `extract_source` values: `"no-block-found"`, `"extract-error"`, `"user-prompt-hook"`.

### Tests

Total runs from 33 → 74 (`pass 74 / fail 0`). New files:
- `runtime/test/extractors.test.mjs` — 15 cases over the regex rule registry
- `runtime/test/journal.test.mjs` — 7 cases (append/read/archive/rotation/fail-safe)
- `runtime/test/journal-drain.test.mjs` — 6 cases (routing, dedup, dry-run, audit-ledger write)
- `runtime/test/digest-lenient.test.mjs` — 10 cases (hyphen+JSON, colon+JSON, hyphen+YAML, colon+YAML, fences, no-block, multi-block, new types)
- `runtime/test/user-prompt-extract.test.mjs` — 3 subprocess cases (stdin → journal lands, empty prompt, malformed stdin)

### Earlier in this release

**`ad init` now scaffolds `session-logs/`.** A local-only (gitignored) per-project journal directory with a README documenting the format and the close-session workflow. The managed CLAUDE.md section now instructs Claude to update the log on three triggers — `"log tokens"`, `"close session" / "end session" / "session khatam"`, and `"new session"` — and mandates that closing a session emits BOTH the End-of-session block and the agent-daemon digest block in the same response.

**Bootstrap workflow in init output.** The post-init message and the managed CLAUDE.md section now surface the canonical bootstrap prompt (`"bootstrap the daemon memory using the bootstrap-daemon skill"`) so users know how to populate empty memory templates in their first session.

**Per-project session audit ledger.** Every digest run appends one JSONL line to `<project>/.agent-daemon/sessions.jsonl` capturing duration, turns, tool calls, edits, triage decision, learnings extracted/applied/queued, and extract source. Rotated at 5 MB. Module: `runtime/src/digest/session-log.mjs`. 5 new tests.

**`ad digest-latest` command.** One-shot manual digest for the VS Code Claude Code extension (where `SessionEnd` hooks don't fire reliably). Encodes the current `--cwd` to find the matching transcript folder under `~/.claude/projects/`, picks the newest `.jsonl`, and force-digests. Idempotent — SQLite dedupes already-processed sessions.

**`--force` flag for `ad digest`.** Bypass the triage threshold for short verification sessions or known-valuable transcripts.

**`--fallback-to-llm` flag for `ad digest` and `ad watch`.** Wire the LLM extraction path (was previously env-var-only). Now propagated through the SessionEnd hook command in profiles.

**`--once-on-existing` flag for `ad watch`.** Also digest transcripts that exist when the watcher starts.

### Changed

**Watcher reliability on Windows.** `ad watch` now:
- Forces `chokidar` polling mode on Windows by default (native `fs.watch` misses events deep in directory trees). Tunable via `AGENT_DAEMON_WATCH_POLL=1` elsewhere.
- Reads each transcript's actual `cwd` from inside the JSONL (Claude Code embeds it) instead of using `dirname(transcript)` — memory now lands in the correct project root.
- Logs every `+ add` / `~ change` event when `--verbose` is on.
- Propagates `--force` and `--fallback-to-llm` to each digest run.

**SessionEnd hook** (`hooks/session-end-digest.json` + `runtime/profiles/profiles.json`) now passes `--fallback-to-llm` so sessions without an agent-emitted digest block still get learnings extracted via LLM.

### Documentation

- New `docs/workflow.md` — daily workflow (`watch` vs `digest-latest`), the ending protocol, decision matrix, verification commands.
- New `docs/troubleshooting.md` — 13 documented failure modes with diagnosis + fix steps (Windows watch quirks, LLM fallback EOF, hook misses on VS Code extension, `{{PLACEHOLDER}}` confusion, encoded-path mismatches, etc.).
- New `docs/architecture.md` — three-loops model, components, full data-flow diagram, complete file-system layout, design-decision rationale.
- New `docs/contributing.md` — onboarding for new devs: layout, conventions, how to add commands/hooks/skills/tests, commit + branching rules.
- README reshuffled to surface daily workflow + reorganized Docs section.

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
