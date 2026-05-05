# memory-templates/

Six-file scaffold for project memory, modeled on the [Cline memory bank](https://docs.cline.bot/features/memory-bank) pattern. Run `agent-daemon init` in a project to drop these into `.agent-daemon/memory/` and the digest pipeline starts populating them automatically.

## The six files

| File | Owns | Update cadence |
|---|---|---|
| `projectbrief.md` | The 30-second pitch — what is this project, who's the user, what problem | Rarely (only on a major pivot) |
| `productContext.md` | Why this exists, who uses it, what success looks like | Occasionally (major scope changes) |
| `activeContext.md` | What's happening right now — current focus, decisions in flight | Frequently (every session that does meaningful work) |
| `systemPatterns.md` | Architecture, key technical decisions, recurring patterns the project uses | Occasionally (when patterns are deliberately changed) |
| `techContext.md` | Stack, dependencies, dev setup, gotchas specific to this codebase | Occasionally (when stack changes) |
| `progress.md` | What works, what doesn't, what's planned, what's blocked | Frequently (every session) |

## Why six files instead of one

A single big `MEMORY.md` is convenient at 5KB but unmaintainable at 50KB. The six-file split:

- Lets the agent load only the file relevant to the current question (`techContext.md` for setup questions, `activeContext.md` for "where were we?")
- Lets distillation route updates cleanly — a finding about architecture goes into `systemPatterns.md`, not the omnibus dump
- Survives `/compact` better — each file fits in a small chunk

## Naming convention vs your existing memory

Claude Code's auto-memory writes to `~/.claude/projects/<encoded>/memory/` — usually a few small markdown files plus `MEMORY.md` index. `agent-daemon` reuses that location for Claude Code projects. The six-file scaffold lives **inside** that directory:

```
~/.claude/projects/<encoded>/memory/
├── MEMORY.md                       # index (auto-managed)
├── projectbrief.md                 # ← from these templates
├── productContext.md               # ←
├── activeContext.md                # ←
├── systemPatterns.md               # ←
├── techContext.md                  # ←
├── progress.md                     # ←
└── feedback_*.md, project_*.md     # ad-hoc Claude Code memory entries
```

For non-Claude-Code agents, the memory lives at `<project>/.agent-daemon/memory/`.

## Manual edits welcome

These files are plain markdown and human-editable. The digest pipeline produces additions; you can always:

- Tighten a verbose entry
- Move a fact from one file to another
- Delete a stale entry
- Mark something with a `<!-- last verified: 2026-05-05 -->` comment

The agent reads what's there. Curate freely.

## Templates

- [projectbrief.md.template](projectbrief.md.template)
- [productContext.md.template](productContext.md.template)
- [activeContext.md.template](activeContext.md.template)
- [systemPatterns.md.template](systemPatterns.md.template)
- [techContext.md.template](techContext.md.template)
- [progress.md.template](progress.md.template)
