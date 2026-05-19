# No full Codex multi-agent runtime port

## What was proposed

Port `everything-claude-code`'s Codex integration — including any orchestration / multi-agent runtime hooks — into the daemon, so Codex CLI users get the same memory + skills experience as Claude Code users. The proposal extended beyond config (`adapters/codex/AGENTS.md`, `config.toml` defaults) into actually running a Codex-side equivalent of our `SessionStart` / `SessionEnd` hooks.

## Why we said no

1. **Codex hook surface is unstable.** Unlike Claude Code's documented hook events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`), Codex's hook story keeps shifting between releases. Building against a moving target means our integration breaks on every Codex update.

2. **No paying user has asked for it.** We do have Codex *adapter config* (model defaults, tool allowlists, AGENTS.md scaffold) — and that's been enough for the handful of Codex users testing the daemon. Nobody has hit the limits of config-only and asked for runtime parity.

3. **Maintenance cost is high.** A real port means matching Claude Code's hook semantics (transcript path, session ID, project dir) in Codex's CLI, which doesn't have them in the same shape. We'd be building and maintaining an adapter layer that exists only to bridge two CLI surfaces that should converge over time.

4. **Stage 5 of the ECC plan was explicit: "Codex adapter enrichment" only.** The original import plan committed to copying unique config fragments — model defaults, tool allowlists — into our existing `adapters/codex/` and stopping there. The runtime port was always out of scope.

5. **AGENTS.md is the real cross-harness convergence point.** If Codex / Cursor / Claude Code all settle on `AGENTS.md` as the cross-IDE memory format (which is the direction the ecosystem is moving), our memory layer becomes the durable surface regardless of which CLI is running. A Codex-runtime port today would be obsoleted by an AGENTS.md adapter tomorrow.

## What would change our mind

- Codex CLI publishes a stable, versioned hook spec (analogous to Claude Code's `.claude/hooks.json`).
- We have **5+ users** actively running the daemon against Codex AND at least 2 of them request session-end digest parity.
- AGENTS.md adoption stalls or fragments such that we need per-harness runtime adapters anyway.

## Date

2026-04-30 (Phase 2 — import-plan close-out)
