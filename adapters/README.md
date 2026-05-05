# Adapters

Format converters that transform a single source of truth (a skill or playbook) into the format expected by other AI coding agents.

Most agent platforms have their own way of injecting instructions:

| Agent | Format | Path |
|---|---|---|
| Claude Code | `SKILL.md` with frontmatter | `~/.claude/skills/<name>/SKILL.md` |
| Cursor | `.mdc` rule files | `.cursor/rules/<name>.mdc` |
| Aider | Plain markdown conventions | `CONVENTIONS.md` |
| Continue | Rules in `config.json` | `~/.continue/config.json` rules section |
| GitHub Copilot | Single instructions file | `.github/copilot-instructions.md` |
| OpenAI Custom GPT / Assistants | System prompt string | API-only |
| Generic / multi-agent | `AGENTS.md` (emerging spec) | repo root `AGENTS.md` |

Rather than maintain N copies of the same content, adapters here generate the per-agent file from the canonical SKILL.md / playbook source.

## What goes here

Each adapter is a script + spec:

```
adapters/<target>/
├── README.md          # what it produces, how to invoke, limitations
├── adapt.{sh,ps1,py,ts}  # the converter
└── tests/             # known input/output fixtures
```

## Conventions

- **Source of truth is `skills/<name>/SKILL.md`** (canonical) — adapters READ from there, never write back.
- **Adapters are pure functions:** input = a SKILL.md path; output = a file in the target format. No side effects beyond writing the output file.
- **Lossy conversions are documented.** If the target format can't represent triggers/frontmatter cleanly, the adapter README says what gets dropped.
- **Idempotent.** Running the adapter twice produces byte-identical output.

## Status

Scaffolded — content coming in subsequent passes. Initial candidates:

- `cursor-rules` — SKILL.md → `.cursor/rules/<name>.mdc` with the trigger description as the rule's `globs` / `description`.
- `agents-md` — SKILL.md (multiple) → single concatenated `AGENTS.md` with sections.
- `copilot-instructions` — selected SKILL.md set → `.github/copilot-instructions.md`.
- `system-prompt` — SKILL.md → plain text suitable for pasting into ChatGPT / Claude.ai / a custom GPT.

## Usage (when content lands)

```bash
# Bash
./adapters/cursor-rules/adapt.sh skills/debug-triage  > .cursor/rules/debug-triage.mdc
./adapters/agents-md/adapt.sh skills/implement-feature skills/debug-triage skills/audit-runner > AGENTS.md
```

Or via the universal installer:

```bash
./setup.sh --adapters cursor-rules --skills debug-triage,audit-runner --output .cursor/rules/
```
