# Installation Guide

Three ways to install skills from this toolkit.

## Method 1: Install Script (Recommended)

### All Skills

```bash
# Linux/macOS
./setup.sh --all

# Windows (PowerShell)
./setup.ps1 -All
```

### Specific Skills

```bash
# Linux/macOS
./setup.sh --skills diagnose-fetch-failure,review-slice,seed-data

# Windows (PowerShell)
./setup.ps1 -Skills diagnose-fetch-failure,review-slice,seed-data
```

### List Available Skills

```bash
./setup.sh --list
./setup.ps1 -List
```

### Dry Run (See What Would Happen)

```bash
./setup.sh --skills review-slice --dry-run
./setup.ps1 -Skills review-slice -DryRun
```

## Method 2: Manual Copy

Copy any skill folder to your global skills directory:

```bash
# Linux/macOS
cp -r skills/diagnose-fetch-failure ~/.claude/skills/

# Windows (PowerShell)
Copy-Item -Recurse skills/diagnose-fetch-failure $env:USERPROFILE/.claude/skills/

# Windows (cmd)
xcopy /E /I skills\diagnose-fetch-failure %USERPROFILE%\.claude\skills\diagnose-fetch-failure
```

## Method 3: Project-Local Install

Install skills only for a specific project by copying to `.agents/skills/`:

```bash
# From your project directory
cp -r /path/to/claude-code-toolkit/skills/review-slice .agents/skills/

# Or using the install script
/path/to/setup.sh --skills review-slice --project-local
```

Project-local skills are only active when Claude Code is running in that project directory.

## Verifying Installation

After installing, open Claude Code in any project and check:

1. **Slash command skills** — Type `/graphify` or `/qmd` and see if autocomplete shows the skill
2. **Auto-trigger skills** — Say "review this page" and see if review-slice activates
3. **List installed skills** — Check `~/.claude/skills/` or `.agents/skills/` directory

## Updating Skills

The install script copies files — it doesn't create symlinks. To update:

1. `git pull` in your clone of this toolkit
2. Re-run the install script (it overwrites existing files)

```bash
cd /path/to/claude-code-toolkit
git pull
./setup.sh --all  # or specific skills
```

## Uninstalling

Delete the skill folder:

```bash
# Global
rm -rf ~/.claude/skills/skill-name

# Project-local
rm -rf .agents/skills/skill-name
```

## Dependencies

Some skills require external tools. Check [DEPENDENCIES.md](../DEPENDENCIES.md) for the full matrix.

| Skill | Requires |
|-------|----------|
| graphify | Python 3.9+, `pip install graphifyy` |
| qmd | Node.js 18+, `npm install -g @tobilu/qmd` |
| All others | No external dependencies |
