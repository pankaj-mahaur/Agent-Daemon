# Hermes Agent interop

`agent-daemon` and [Hermes Agent](https://github.com/nousresearch/hermes-agent) (Nous Research) share much of the same vision: a self-improving AI agent with persistent memory, evolving skills, and a digest pipeline. They're built independently — different stacks, different ergonomics — but **the skill format is identical**, and we deliberately mirror Hermes's data model so skills + memory travel between the two.

This document explains what's shared, what differs, and how to use both side-by-side.

---

## What's shared

### 1. SKILL.md format — agentskills.io standard

Every skill in this repo follows the [agentskills.io specification](https://agentskills.io/specification): YAML frontmatter (`name`, `description`, optional `license` / `compatibility` / `metadata` / `allowed-tools`) followed by markdown body.

This is the same format Hermes uses, plus Claude Code, OpenClaw, OpenCode, VS Code Copilot agent skills, and Microsoft Agent Framework. **Our skills work in any of those tools without conversion.**

```yaml
---
name: debug-triage
description: Investigating a bug, unexpected behavior, empty data...
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
---

# Debug a runtime issue without jumping to code first
...
```

### 2. SQLite + FTS5 schema (mirrored)

Our [runtime/src/memory/sqlite.mjs](../runtime/src/memory/sqlite.mjs) schema mirrors the Hermes pattern:

- `sessions` — one row per agent session
- `messages` — turn-by-turn events
- `tool_calls` — denormalized tool invocations for analytics
- `learnings` — distilled lessons (the actual memory)
- `skill_executions` — trace data for self-improvement
- `user_facts` — Honcho-style cross-project user profile
- `messages_fts` / `learnings_fts` — FTS5 virtual tables for full-text recall
- `skill_variants` — GEPA evolution candidates (our addition)
- `proposals` — queued review items (our addition)

The schema is idempotent (`CREATE TABLE IF NOT EXISTS` everywhere), uses WAL journal mode, has a `schema_version` table for future migrations.

### 3. Self-evolution via GEPA

Both projects use [GEPA — Genetic-Pareto Prompt Evolution](https://arxiv.org/abs/...) (Agrawal et al., ICLR 2026 oral) for skill self-improvement. Our implementation in [runtime/src/digest/gepa/](../runtime/src/digest/gepa/) ports the algorithm to Node + headless `claude` calls, while Hermes's [hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) runs it in Python with DSPy.

The five stages — sample → reflect → generate → evaluate → Pareto-select — are identical. Either implementation can produce candidates against either skill library because the input format (SKILL.md) is the same.

---

## What differs

| Dimension | Hermes Agent | agent-daemon |
|---|---|---|
| **Agent loop** | Owns it (Hermes IS the agent) | Layers on top (works with Claude Code, Cursor, etc.) |
| **Trigger** | Internal task lifecycle | Claude Code hooks (`SessionStart` / `SessionEnd` / `PreCompact`) + cross-agent fswatch (v0.2) |
| **Stack** | Python | Node ESM (zero deps for v0.1) |
| **Distillation engine** | OpenAI-compatible API (Anthropic / Gemini / OpenRouter / TokenMix) | Headless `claude` CLI (your existing Claude Code install) |
| **Constitution** | Personalities (soft, configurable) | Hard cardinal rules (12 in [constitution/core.md](../constitution/core.md)) |
| **Skill content** | Mostly assistant tasks (messaging, search, automation) | Software engineering disciplines (debug-triage, audit-runner, db-migrations, …) |
| **Distribution** | Self-hosted always-on agent | Skills + runtime that piggyback on the user's existing agent |

Different products, complementary use cases. Most users will pick one based on whether they want **a new agent** (Hermes) or **a layer on their existing agent** (agent-daemon).

---

## Using both side-by-side

### Skills travel automatically

Drop our `skills/` directory into Hermes's `~/.hermes/skills/` (or vice versa). Both runtimes read SKILL.md as agentskills.io intends. No conversion script needed.

```bash
# Pull our skills into Hermes
cp -r skills/* ~/.hermes/skills/

# Or run Hermes's skill importer
hermes import-skills ./skills/
```

### Memory does NOT travel automatically

We use the same schema *shape* but the `*.db` files are independent — different column-default bytes, different paths, different evolution. Don't copy `episodic.db` between the two; the FTS5 tokens may differ, the schema_version trail will diverge.

If you want cross-tool memory, in v0.3 we'll provide an export/import via JSONL.

### Hooks vs lifecycle

If you run **both** Hermes (as your background agent) and Claude Code with `agent-daemon` hooks (as your IDE assistant), they coexist cleanly — they read each other's transcripts but write to separate `learnings` rows in their respective DBs. The `agent_type` column distinguishes provenance.

### Constitution: ours, not Hermes's

Hermes's "personalities" are configurable per-user prompts. Our [constitution/core.md](../constitution/core.md) is a **hard floor** — 12 rules treated as immutable, with cardinal rules 5-8 (`--no-verify`, push-without-OK, security-widening, destructive-ops) un-overridable even by project config.

If you want our constitution active in Hermes too, copy the `constitution/` content into a Hermes personality file. The text is portable; the enforcement model differs (Hermes treats it as soft preference; agent-daemon treats it as hard).

---

## When to choose which

**Use Hermes if:**
- You want a 24/7 always-on agent reachable via Telegram / Discord / Slack / Email / CLI
- You're OK with Hermes owning the agent loop end-to-end
- You want OpenAI-compatible model flexibility (mix Claude / GPT / Gemini per task)
- You're writing tasks broader than coding (research, scheduling, comms, automation)

**Use agent-daemon if:**
- You're primarily coding in Claude Code (or Cursor / Cline / Aider once v0.2 ships)
- You want hard guardrails (the constitution)
- You want skills + memory specifically for software engineering disciplines
- You want to keep using your existing agent — agent-daemon is a layer, not a replacement

**Use both if:**
- You want background-agent capability AND IDE-augmentation
- You're willing to maintain two memory stores (they don't sync in v0.1)
- You want to publish your evolved skills to both ecosystems

---

## Sources

- [Hermes Agent — Nous Research](https://github.com/nousresearch/hermes-agent)
- [Hermes self-evolution (GEPA + DSPy)](https://github.com/NousResearch/hermes-agent-self-evolution)
- [agentskills.io specification](https://agentskills.io/specification)
- [GEPA paper (ICLR 2026 oral)](https://www.agensi.io/learn/how-to-use-skill-md-with-hermes-agent)
- [Inside Hermes Agent — architecture deep dive](https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving)
