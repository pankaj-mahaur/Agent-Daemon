# Plugins

Claude Code plugins — bundled commands, agents, hooks, and skills published as a single installable unit.

A plugin is heavier than a single skill: it can ship a custom subagent, slash commands, hooks (PreToolUse / PostToolUse / UserPromptSubmit), settings overrides, and multiple skills together.

## What goes here

Each plugin lives in its own folder following the Claude Code plugin spec:

```
plugins/<plugin-name>/
├── plugin.json         # manifest (name, version, description, author)
├── README.md           # what it does, install steps
├── commands/           # slash commands
│   └── <name>.md
├── agents/             # subagent definitions
│   └── <name>.md
├── hooks/              # hook scripts
│   └── <name>.sh
├── skills/             # bundled skills
│   └── <name>/SKILL.md
└── settings.json       # optional default settings the plugin sets
```

## Conventions

- **plugin.json is the manifest** — required fields: `name`, `version`, `description`, `author`.
- **README states clearly:**
  - What the plugin does end-to-end (the workflow, not just the components)
  - Which Claude Code features it uses (commands? hooks? subagents?)
  - Any external dependencies (APIs, CLI tools)
  - How to disable it without uninstalling
- **No project-name leaks** — same rule as skills. Generic patterns only.
- **Settings overrides are minimal** — don't ship aggressive permission allowlists that surprise users.

## Status

Scaffolded — content coming in subsequent passes. Initial candidates:

- `pre-commit-guard` — runs lint/format/type-check before any `git commit` and blocks on failure
- `audit-trail` — auto-generates a `<FEATURE>_AUDIT_PROGRESS.md` from `audit-runner` chunk activity
- `claude-md-bootstrap` — interactive `/init` replacement that fills CLAUDE.md from repo introspection

## Install (when content lands)

```bash
# Bash
./setup.sh --plugins pre-commit-guard

# PowerShell
./setup.ps1 -Plugins "pre-commit-guard"
```

Plugins install to `~/.claude/plugins/<name>/` (global) or `.claude/plugins/<name>/` (project-local).
