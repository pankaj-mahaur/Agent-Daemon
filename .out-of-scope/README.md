# Out of scope

A graveyard of deliberate "no"s. Each file here documents a feature request, an upstream pattern, or an architectural idea that we considered and chose not to ship — with the reasoning.

## The rule

**If a feature request gets rejected twice, document it here.**

Once is a judgment call. Twice means the question keeps coming back, and the next person (or the next session of you) needs the reasoning, not just the answer. Without this file, every six months the same proposal lands fresh, and we re-litigate the same trade-offs from scratch.

Each entry is a single `.md` file named `no-<topic>.md`. The frontmatter-free body covers:

- **What** was proposed
- **Why** it was rejected
- **What would change our mind** — the trigger that should reopen the question
- **Date** of the decision (so staleness is auditable)

If a trigger fires, delete the entry — don't soften it. The graveyard is for hard decisions, not maybes.

## Current entries

| File | Rejected | Reopen when |
|---|---|---|
| [no-llm-extraction-v0.3.md](no-llm-extraction-v0.3.md) | LLM-tier extraction in the digest pipeline (v0.3) | Regex coverage drops below ~60% on real sessions, OR a cached local LLM lands in Claude Code |
| [no-codex-runtime.md](no-codex-runtime.md) | Full Codex multi-agent runtime port | Codex CLI matures past adapter-config-only usage AND a paying user requests it |
| [no-agents-md-adapter.md](no-agents-md-adapter.md) | First-class `AGENTS.md` adapter generator | OpenAI Codex / Cursor / a third major harness mandates AGENTS.md AND we have 5+ users on it |
| [no-kiro-trae-codebuddy.md](no-kiro-trae-codebuddy.md) | Adapters for Kiro / Trae / CodeBuddy / OpenCode / Gemini | One of these breaks 10k MAU OR a user files a real adapter request |
| [no-skill-verify-mode.md](no-skill-verify-mode.md) | `ad init --verify` / `ad skill verify` modes | `ad doctor` insufficient for a real regression we hit, OR users report it doesn't catch the breakage |

## How to add an entry

1. Confirm this is the **second** rejection of the same request. If it's the first, just say no in the moment — don't document.
2. Create `.out-of-scope/no-<short-topic>.md`. Keep the filename greppable from the request phrasing.
3. Write the four sections (What / Why / Reopen when / Date). Be specific in "Reopen when" — vague triggers ("when it makes sense") rot.
4. Add a row to the table above.
5. Commit with `docs(out-of-scope): document rejection of <topic>`.

## Modeled on

[`mattpocock/skills/.out-of-scope/`](https://github.com/mattpocock/skills/tree/main/.out-of-scope) — Matt's discipline of capturing the "no"s alongside the "yes"s. Stops the catalog from drifting back to whatever was last asked for.
