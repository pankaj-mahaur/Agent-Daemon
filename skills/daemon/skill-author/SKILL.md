---
name: skill-author
description: Use when the user asks to "create a skill", "make this a skill", "is se skill banao", "har baar yaad rakhna", "remember this pattern", "save this learning", "skill bana lo", "isko skill mein convert karo", "add to skills", "promote this to a skill", "skill mein dal do", "save as skill". Decides global-vs-project scope, dedups against existing SKILL.md (≥70% overlap → append, not new), prevents cross-session duplicate skills.
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.0"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
disable-model-invocation: false
---

# Author a skill — global vs project, dedup-first

Don't ever write a new SKILL.md without checking what already exists. The single most common failure mode for skill-creation across sessions is producing 3-4 near-duplicate skills (e.g. `debug-fetch-error`, `cors-blocked-fix`, `network-error-triage`) instead of broadening one. This skill fixes that.

You will:
1. Decide **scope** (global vs project-local).
2. **Search for overlap** in existing skills.
3. Check the **cross-session log** for prior near-misses.
4. **Write or append** — never blindly create a new file.
5. **Log** the action so the next session knows.

## Phase 1 — Classify scope

Read what the user said. Ask yourself one question: **could this skill help a DIFFERENT project, in a different language, with a different stack?**

| Signal | Scope |
|---|---|
| Pattern is language-agnostic (e.g. "always check existing utilities before writing new code") | `~/.claude/skills/` (global) |
| Pattern names a framework / library but applies broadly (e.g. "Next.js SSE route pattern") | `~/.claude/skills/` (global) |
| Pattern mentions THIS project's domain, file paths, internal endpoints, business rules | `<cwd>/.claude/skills/` (project-local) |
| User said "make this global" / "global skill banao" | `~/.claude/skills/` |
| User said "project ke liye" / "is project mein" / "for this project only" | `<cwd>/.claude/skills/` |

If the answer is "could go either way", default to **global**. Easier to scope down later than to fish out of project-local later.

Set a variable in your head: `SCOPE = global` or `SCOPE = project`.

## Phase 2 — Dedup search

Before writing anything, search what already exists. Glob both locations:

```bash
# Global
ls ~/.claude/skills/*/SKILL.md 2>/dev/null

# Project-local
ls .claude/skills/*/SKILL.md 2>/dev/null
```

For each existing SKILL.md, read its frontmatter `description` line and the first 30 lines of body. Compute an **overlap score**:

- **Trigger overlap:** how many of your intended trigger phrases already appear in the existing `description`? (case-insensitive substring)
- **Body keyword overlap:** for the top 5 keywords in your draft body, how many appear in the existing body?

If **≥70% overlap** with an existing skill → **append-mode**: extend the existing skill instead of writing a new one. Examples:
- Adding a new example under `## Examples` of the existing skill
- Broadening the frontmatter `description` triggers (union, deduped)
- Adding an anti-pattern under `## Anti-patterns`

If **<70% overlap** → **new-file mode**. But still surface the closest match to the user before writing:

> *"I'm about to create `debug-network-triage`. Existing skill `debug-triage` overlaps 45% (shares triggers 'broken', 'not working'). Continue with new skill, or merge into `debug-triage`?"*

## Phase 3 — Cross-session log check

Read `.agent-daemon/skill-author-log.jsonl` (per-project) and `~/.agent-daemon/skill-author-log.jsonl` (global). Each line is JSON:

```json
{"ts":"2026-05-21T10:30:00Z","skill_id":"debug-triage","triggers":["broken","not working"],"scope":"global","action":"append"}
```

If any prior entry has `skill_id` matching your intended target or `triggers` overlapping ≥50% — surface it. The user may have already created or extended this skill in a prior session.

If logs are missing, that's fine — first run.

## Phase 4 — Write or append

### New skill (Phase 2 said new-file mode)

Write to:
- Global: `~/.claude/skills/<skill-id>/SKILL.md`
- Project: `<cwd>/.claude/skills/<skill-id>/SKILL.md`

Use this template:

```markdown
---
name: <skill-id>
description: Use when the user <trigger phrases — exhaustive, English + Hinglish if relevant>. <One-sentence what-it-does>.
license: MIT
metadata:
  author: <user or "agent-daemon">
  spec: agentskills.io
  version: "1.0"
allowed-tools: <Bash, Read, Edit, ... — whichever the skill needs>
disable-model-invocation: false
---

# <Title — short, imperative>

<One-paragraph "what + why" — describe the problem this solves.>

## When to use

<Concrete trigger conditions, not synonyms — what is the user actually trying to do?>

## Procedure

1. <Step 1 — imperative>
2. <Step 2>
3. <Step 3>

## Examples

### Example 1: <name>
<concrete scenario with file paths, commands, expected output>

## Anti-patterns

- <thing not to do, with reason>
- <another anti-pattern>
```

Keep skills focused on **one** concern. If you find yourself writing two distinct procedures, that's two skills.

### Append to existing (Phase 2 said append-mode)

Use `Edit` tool to modify the existing SKILL.md:

1. **Broaden triggers** — read the current `description:` line, union your new triggers in (dedup), write back. Keep one line under 500 chars.
2. **Add example** — under `## Examples`, append a new `### Example N: <name>` block with the new scenario.
3. **Add anti-pattern (if relevant)** — under `## Anti-patterns`, append a bullet.

Do NOT touch the existing `## Procedure` steps unless the user explicitly asks. Adding examples is safe; rewriting procedure is risky.

## Phase 5 — Log

Append one JSONL line to **both** logs:

```bash
echo '{"ts":"<ISO timestamp>","skill_id":"<skill-id>","triggers":["t1","t2"],"scope":"<global|project>","action":"<new|append>","source_session":"<session-id-if-known>"}' >> .agent-daemon/skill-author-log.jsonl

echo '{"ts":"<ISO timestamp>","skill_id":"<skill-id>","triggers":["t1","t2"],"scope":"<global|project>","action":"<new|append>","cwd":"<cwd>"}' >> ~/.agent-daemon/skill-author-log.jsonl
```

Create parent directories if missing:

```bash
mkdir -p .agent-daemon
mkdir -p ~/.agent-daemon
```

## Examples

### Example 1: User wants a global skill for a framework pattern

User says: *"har baar Next.js mein SSE route banane mein dikkat hoti hai, isko skill bana lo"*

Decision:
- **Scope:** global (Next.js pattern, language-agnostic enough — applies to any Next.js project)
- **Dedup search:** no existing skill matches >70% (nothing about SSE routes)
- **Write:** new skill at `~/.claude/skills/nextjs-sse-route/SKILL.md`
- **Log:** both JSONL logs get an entry

### Example 2: User wants something already covered

User says: *"create a skill for triaging production bugs"*

Decision:
- **Scope:** global
- **Dedup search:** `debug-triage` exists, 75% overlap (same triggers "broken", "production", "bug")
- **Action:** append-mode — add a `## Example: production bug triage` block to `debug-triage/SKILL.md`, broaden `description` triggers if needed
- **Surface to user before writing:** *"Found `debug-triage` (75% overlap). Appending a production-bug example to it instead of new file. OK?"*

### Example 3: Project-specific pattern

User says: *"DriveYO mein har baar negotiator test karte time GCP creds set karna padta hai, ye remember karwa lo"*

Decision:
- **Scope:** project (mentions DriveYO + negotiator + GCP creds — project-specific)
- **Dedup search:** `test-driveyo-negotiator` exists in `~/.claude/skills/` (user's global) with 60% overlap
- **Action:** Surface to user — "Found global `test-driveyo-negotiator`. The GCP creds detail is project-specific to DriveYO. Append to global, or create new project-local `negotiator-test-creds`?"
- After user picks → write accordingly

## Anti-patterns

- **Writing a new skill without dedup search.** This is the root failure mode. Every new SKILL.md is cheap to write but expensive in cognitive load — 217 skills already, adding noise hurts everyone.
- **Project-local when global would do.** If the pattern applies to any project, it's global. Project-local is for things that genuinely couldn't help in a different codebase.
- **Ignoring the cross-session log.** A user creating "the same skill" twice in different sessions is a sign the FIRST one wasn't discoverable. Append to the first; don't write a second.
- **Touching `## Procedure` in append-mode.** Append-mode is for examples + triggers + anti-patterns. Procedure changes need explicit user confirmation — that's editing behavior, not extending coverage.
- **Forgetting the log.** No log = next session won't know this skill exists/was extended. Always write the JSONL line, even on failure (record what was attempted).

## Verification

After writing, ask the user to confirm by triggering the skill:
> *"Skill written to `~/.claude/skills/<id>/SKILL.md`. To test: in a new Claude Code session, type a phrase matching its triggers — it should auto-load."*

If the new skill's triggers don't fire reliably, the `description` line is probably too narrow. Broaden the trigger phrases (most common fix).
