---
name: skill-installer
description: "Use when the user asks to install, add, remove, or find a skill — \"install this skill\", \"add skill X\", \"install skill from <url>\", \"skill install karo\", \"ye skill add karo\", \"uninstall skill\", \"remove skill\", \"what skills are available\", \"find a skill for X\" — or pastes a git URL of a skill repo to use. Drives the `ad skill` CLI: bundled catalog, local paths, or git repos, lint-validated, provenance recorded, right lane selected."
license: MIT
metadata:
  author: agent-daemon
  spec: agentskills.io
  version: "1.1"
---

# Skill Installer

Install skills through `ad skill` — never by hand-copying folders. The CLI
lint-gates the frontmatter, records provenance (source + commit + sha256) in
`~/.agent-daemon/skill-manifest.json`, and recompiles the route maps so the
routing hook starts recommending the new skill immediately.

## 1. Resolve the source

| User gave you | Do this |
|---|---|
| A bare name ("install debug-triage") | `ad skill search <name>` first; on a bundled hit, install by name |
| A vague need ("a skill for accessibility") | `ad skill search <keyword>`, show the hits, install the chosen one |
| A local path | Verify `<path>/SKILL.md` exists (or it's a folder of skills) before installing |
| A git URL | Pass it through verbatim; multi-skill repos need `--skill <name>` — the CLI lists candidates on ambiguity |

## 2. Decide the lane

- **Default: global** (`~/.claude/skills/`) — available in every project.
- **`--project`** (`<cwd>/.claude/skills/`) when the skill is stack- or
  project-specific, or the user says "for this project" / "sirf is project ke liye".
  Project-local shadows a same-named global skill.

## 3. Install and verify

```sh
ad skill install <spec> [--project] [--skill <name>]
ad skill list                      # confirm it landed, with provenance
```

- **Lint failure**: show the errors. Offer to fix the frontmatter (follow
  skill-author conventions) and retry. `--force` only if the user insists —
  say why the lint failed first.
- **Already installed**: tell the user; `--force` overwrites, `ad init`
  refreshes bundled skills.
- **Git installs**: read the skill's description back to the user before
  confirming — they should know what they just added (supply-chain hygiene).

## 4. Mid-session bridge (important)

Claude Code discovers skills at **session start**. After installing:

1. Tell the user it will auto-trigger from the next session.
2. To use it NOW: Read the installed `SKILL.md` and follow its procedure inline.

## 5. Removal

```sh
ad skill remove <name> [--project] [--force]
```

Never `rm -rf` skill directories by hand — the manifest and route maps must
stay in sync. Unmanaged (hand-authored) skills need `--force` and a heads-up
to the user.

## 6. Other hosts and versions

Skills ad improves (accepted in `ad review`) are versioned in
`~/.agent-daemon/skills/<name>/` and written to the hosts that read skills:

```sh
ad skill history <name>                # every version and where it came from
ad skill publish [<name>] [--host <id>] [--dry-run]   # write accepted skills to the hosts' skills folders
ad skill undo <name>                   # an older version becomes current (asks the user to type it)
```

- ad overwrites only a folder it wrote itself and that nobody changed since;
  otherwise it says so and keeps the folder (`--replace` backs it up first).
  Ask the user before `--replace`.
- `undo` refuses from the agent's own shell: hand the user the command.

## Anti-patterns

- Hand-copying skill folders into `~/.claude/skills/` (no lint, no provenance, stale route map).
- Installing a multi-skill repo wholesale when the user asked for one skill.
- Forcing past lint errors without telling the user what was wrong.
- Writing a new SKILL.md from scratch when the user said "install" — that's `skill-author`'s job, and only for authoring.
