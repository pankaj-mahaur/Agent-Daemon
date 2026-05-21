# /skill-author — Author or extend a skill (dedup-first)

Invoke the `skill-author` skill to author a new Claude Code skill OR extend an existing one. Decides global-vs-project scope and dedupes against existing skills.

## Arguments

`$ARGUMENTS` is the **intent description** — what should the skill do? Examples:

- `/skill-author skill for triaging Next.js SSE route bugs`
- `/skill-author project-local: how to test the negotiator with GCP creds`
- `/skill-author har baar yaad rakhna: pnpm use karna, npm nahi`

## Protocol

The `skill-author` skill in `~/.claude/skills/skill-author/SKILL.md` runs five phases:

1. **Classify scope** — global (`~/.claude/skills/`) vs project-local (`<cwd>/.claude/skills/`)
2. **Dedup search** — Glob existing SKILL.md, compute overlap. ≥70% → append-mode
3. **Cross-session log check** — read `.agent-daemon/skill-author-log.jsonl` for prior attempts
4. **Write or append** — new file with the standard template, OR add example/trigger to existing
5. **Log** — append JSONL entry to both per-project and global logs

Always surface near-misses (≥50% overlap) to the user before writing.

## When the skill auto-triggers

Without `/skill-author`, the skill also auto-fires on these phrases (in any Claude Code session):

- "create a skill" / "make this a skill" / "add to skills"
- "is se skill banao" / "skill bana lo" / "isko skill mein convert karo"
- "har baar yaad rakhna" / "isko hamesha yaad rakhna"
- "remember this pattern" / "save this learning" / "promote this to a skill"

## Output

The skill writes to one of:
- `~/.claude/skills/<id>/SKILL.md` (global)
- `<cwd>/.claude/skills/<id>/SKILL.md` (project-local)

Plus a JSONL log line in:
- `<cwd>/.agent-daemon/skill-author-log.jsonl`
- `~/.agent-daemon/skill-author-log.jsonl`
