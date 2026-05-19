# No LLM-tier extraction in the digest pipeline (v0.3)

## What was proposed

Add an LLM tier on top of the regex extractor in the digest pipeline. The agent's `SessionEnd` hook would run the regex extractor first (fast, deterministic), then send the un-matched portions of the transcript to a smaller LLM (e.g. `claude-haiku-4-5`) to catch nuanced learnings the regex can't — implicit corrections, multi-turn confirmations, soft "this approach worked" signals.

## Why we said no (v0.3)

1. **Cost.** Per-session LLM extraction adds a hidden cost on every session close. For users running 20+ sessions a day, that's a multiplier on their daemon usage that they didn't sign up for. Surprise billing is the fastest way to lose trust in a developer tool.

2. **Reliability.** Phase 3's "LLM fallback `write EOF`" bug (in `runtime/src/llm/claude-spawn.mjs`) shows that spawning the Claude CLI from a hook is brittle — stale flags, version drift, env mismatches. We have *one* failing surface today; adding a critical-path LLM call would multiply the failure modes.

3. **Signal quality.** The regex tier captures the high-signal ~60% (explicit corrections, named patterns, decisions). The remaining 40% is genuinely lower-signal — fuzzy "I think we agreed on X" type moments — exactly the kind of thing an LLM will *amplify* into confident memories that are wrong half the time. A confident wrong memory is worse than no memory.

4. **Agent-self-improve covers the gap.** The discipline taught by [`skills/agent-self-improve`](../skills/agent-self-improve/SKILL.md) — "name your corrections, name your confirmations, use the trigger words the extractor is tuned for" — is meant to make the agent emit signals the regex *can* catch. Closing the loop in the agent's authoring, not adding a downstream LLM clean-up.

5. **Phase 3 stops needing the LLM path for the common case.** Continuous capture via `UserPromptSubmit` + the lenient digest parser + the audit-ledger fix together cover what the LLM tier was originally proposed to cover.

## What would change our mind

- The regex extractor's coverage drops below ~60% on real sessions (measure via the audit ledger: `learnings_found / sessions_with_meaningful_work`).
- A **cached local LLM** lands in Claude Code (Haiku or smaller, running on-device or via the user's existing subscription with zero per-call overhead). Removes (1) and partially mitigates (2).
- A user runs the daemon for 3+ months and concretely identifies signal that the regex missed AND that they wanted captured. (Anecdote isn't enough — the audit ledger has to show the gap.)

## Date

2026-05-19 (Phase 4.1 dogfood — after the extractor was tightened with clause-anchoring, regex noise dropped to 0/10 on the 8.8hr replay).
