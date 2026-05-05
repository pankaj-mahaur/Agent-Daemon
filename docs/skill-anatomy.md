# Skill Anatomy

How Claude Code skills work, and how to create your own.

## What is a Skill?

A skill is a `SKILL.md` file with YAML frontmatter that Claude Code recognizes as an invokable capability. When triggered, Claude reads the SKILL.md and follows its instructions.

## File Structure

```
skill-name/
└── SKILL.md          # Required: the skill definition
└── references/       # Optional: supporting docs the skill can reference
    └── setup.md
```

## Frontmatter Fields

```yaml
---
name: skill-name                    # Required: kebab-case identifier
description: What this skill does.  # Required: used for auto-triggering
  Include trigger phrases here —
  Claude matches user messages against this text.
trigger: /skill-name                # Optional: explicit slash command
license: MIT                        # Optional: license
compatibility: Requires X.         # Optional: dependency note
allowed-tools: Bash, Read, Write   # Optional: restrict which tools the skill can use
argument-hint: [entity] [count]    # Optional: hint for arguments
---
```

### Key Fields

**`name`** — The skill's identifier. Used in logs and for reference.

**`description`** — The most important field. Claude Code uses this to decide when to auto-trigger the skill. Include:
- What the skill does
- When to use it (trigger phrases, use cases)
- When NOT to use it

**`trigger`** — An explicit `/command` the user can type. If set, typing `/skill-name` in Claude Code invokes the skill directly.

**`allowed-tools`** — Restricts which tools the skill can use. Useful for read-only skills that shouldn't modify files.

## Installation Directories

### Global Skills (`~/.claude/skills/`)

Available in all projects. Good for general-purpose skills like `graphify`, `qmd`, `seed-data`.

```
~/.claude/skills/
├── graphify/
│   └── SKILL.md
├── qmd/
│   └── SKILL.md
│   └── references/
│       └── mcp-setup.md
└── seed-data/
    └── SKILL.md
```

### Project-Local Skills (`.agents/skills/`)

Available only in the project where they're installed. Good for project-specific audit skills or review playbooks.

```
your-project/
├── .agents/skills/
│   ├── review-slice/
│   │   └── SKILL.md
│   └── security-audit/
│       └── SKILL.md
├── src/
└── ...
```

## How Triggering Works

Claude Code triggers skills in two ways:

1. **Explicit trigger** — User types `/skill-name` and the skill has a matching `trigger:` field
2. **Auto-trigger** — Claude matches the user's message against the `description:` field. If the message matches trigger phrases in the description, Claude invokes the skill automatically.

### Writing Good Descriptions for Auto-Trigger

```yaml
# Good: specific trigger phrases
description: Generate idempotent database seed scripts with realistic test data.
  Use only when user explicitly requests seed/test data generation with phrases
  like "generate seed data", "create test data script", "populate database".

# Bad: too vague, will trigger on unrelated requests
description: Help with database stuff.
```

## Best Practices

1. **One skill, one purpose.** Don't combine unrelated capabilities.
2. **Be specific in descriptions.** Vague descriptions cause false triggers.
3. **Include "when NOT to use" guidance.** Prevents the skill from activating on similar-but-wrong requests.
4. **Reference supporting docs.** Use `references/` for setup guides, schemas, or examples that the skill needs.
5. **Test the trigger.** After installing, try phrases that should and shouldn't trigger the skill.
