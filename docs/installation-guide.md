# Installation Guide

## Install agent-daemon (recommended)

The one-liner clones the repo to `~/.agent-daemon-src`, installs runtime dependencies (including the pinned `@openai/codex` engine; test-only packages are skipped with `--omit=dev`), registers the global `ad` command and runs `ad doctor`. It needs git and Node.js 22 or later. On Windows it warns on Node 22 before 22.17, 23.x and 24 before 24.2: the `ad` terminal UI (bare `ad`, `ad tui`) needs Node's VT console input, and everything else works without it.

The engine is a separate copy in `~/.agent-daemon-src/runtime`, with its own home in `~/.agent-daemon/engine`. An existing install of the engine and its `~/.codex` are left alone.

```bash
# macOS / Linux / Git-Bash
curl -fsSL https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.ps1 | iex
```

- **Pin a release:** set `AD_VERSION` (e.g. `AD_VERSION=v1.0.0` for the Claude Code–only v1). Re-run without it to move back to `main`.
- **From a clone instead:** `cd runtime && npm install --omit=dev && npm link --omit=dev` (contributors drop `--omit=dev` to get the test tools).
- **Then, per project:** `ad init`. Where Claude Code is installed, it offers (in a terminal) to add ad's memory server to it; in a script it prints the command instead.
- **To let ad run the agent:** type `ad` in a project folder (in your home folder ad asks you to pick a project first). The terminal UI opens and asks you to sign in on the first run (`/login` adds more accounts later). For `ad chat`, `ad run`, `ad loop` and the other harness commands, sign in first with `ad auth login <provider>`: `ad auth login --help` lists the providers, and [accounts.md](accounts.md) has the details. The ChatGPT sign-in opens the vendor's page, which may name the engine: that is what ad runs on. See [harness.md](harness.md) and [tui.md](tui.md).
- **Memory needs SQLite.** The runtime installs `better-sqlite3`. Where that can't load, memory runs on Node's built-in SQLite, which needs Node 22.16 or newer; `ad doctor` shows the driver in use.
- **Memory in other agents** (the hosts are listed in [memory/install.md](memory/install.md)): `ad memory install`, or `npx agent-daemon-memory install` without the `ad` command.
- **Moving to another computer:** install there, then bring your state with `ad state import` ([harness.md](harness.md#moving-ad-to-another-computer)).

## Skills only (no `ad` command)

The methods below copy skills without installing the runtime.

### Method 1: Install Script

#### All Skills

```bash
# Linux/macOS
./setup.sh --all

# Windows (PowerShell)
./setup.ps1 -All
```

#### Specific Skills

```bash
# Linux/macOS
./setup.sh --skills diagnose-fetch-failure,review-slice,seed-data

# Windows (PowerShell)
./setup.ps1 -Skills diagnose-fetch-failure,review-slice,seed-data
```

#### List Available Skills

```bash
./setup.sh --list
./setup.ps1 -List
```

#### Dry Run (See What Would Happen)

```bash
./setup.sh --skills review-slice --dry-run
./setup.ps1 -Skills review-slice -DryRun
```

### Method 2: Manual Copy

Copy any skill folder to your global skills directory:

```bash
# Linux/macOS
cp -r skills/diagnose-fetch-failure ~/.claude/skills/

# Windows (PowerShell)
Copy-Item -Recurse skills/diagnose-fetch-failure $env:USERPROFILE/.claude/skills/

# Windows (cmd)
xcopy /E /I skills\diagnose-fetch-failure %USERPROFILE%\.claude\skills\diagnose-fetch-failure
```

### Method 3: Project-Local Install

Install skills only for a specific project by copying to `.claude/skills/`:

```bash
# From your project directory
cp -r /path/to/Agent-Daemon/skills/review-slice .claude/skills/

# Or using the install script
/path/to/setup.sh --skills review-slice --project-local
```

Project-local skills are only active when Claude Code is running in that project directory.

## Verifying Installation

After installing, open Claude Code in any project and check:

1. **Slash command skills** — Type `/graphify` or `/qmd` and see if autocomplete shows the skill
2. **Auto-trigger skills** — Say "review this page" and see if review-slice activates
3. **List installed skills** — Check `~/.claude/skills/` or `.claude/skills/` directory

## Updating Skills

The install script copies files — it doesn't create symlinks. To update:

1. `git pull` in your clone of this toolkit
2. Re-run the install script (it overwrites existing files)

```bash
cd /path/to/Agent-Daemon
git pull
./setup.sh --all  # or specific skills
```

## Uninstalling

Delete the skill folder:

```bash
# Global
rm -rf ~/.claude/skills/skill-name

# Project-local
rm -rf .claude/skills/skill-name
```

## Dependencies

Some skills require external tools. Check [DEPENDENCIES.md](../DEPENDENCIES.md) for the full matrix.

| Skill | Requires |
|-------|----------|
| graphify | Python 3.9+, `pip install graphifyy` |
| qmd | Node.js 18+, `npm install -g @tobilu/qmd` |
| All others | No external dependencies |
