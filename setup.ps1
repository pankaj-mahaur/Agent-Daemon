param(
    [string]$Profile,
    [switch]$Plan,
    [switch]$All,
    [string]$Skills,
    [string]$Mcp,
    [string]$Plugins,
    [string]$Tools,
    [switch]$Runtime,
    [switch]$Hooks,
    [switch]$Service,
    [switch]$ProjectLocal,
    [switch]$DryRun,
    [switch]$List,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ToolkitDir = $PSScriptRoot
$SkillsDir   = Join-Path $ToolkitDir "skills"
$McpDir      = Join-Path $ToolkitDir "mcp"
$PluginsDir  = Join-Path $ToolkitDir "plugins"
$ToolsDir    = Join-Path $ToolkitDir "tools"
$AdaptersDir = Join-Path $ToolkitDir "adapters"

$GlobalSkills  = Join-Path $env:USERPROFILE ".claude" "skills"
$GlobalPlugins = Join-Path $env:USERPROFILE ".claude" "plugins"
$LocalSkills   = Join-Path "." ".claude" "skills"
$LocalPlugins  = Join-Path "." ".claude" "plugins"

$AllSkills = @(
    "diagnose-fetch-failure"
    "diagnose-intermittent-failure"
    "graphify"
    "qmd"
    "seed-data"
    "review-slice"
    "audit-runner"
    "merge-feature-branch"
    "security-audit"
    "production-readiness"
    "optimization-audit"
    "dead-code-review"
    "docs-sync-audit"
    "implement-feature"
    "debug-triage"
    "db-migrations"
    "llm-app-safety"
    "multiplatform-parity"
    "deploy-ops"
)

function Show-Usage {
    Write-Host @"
agent-daemon - Universal Installer

Usage:
  .\setup.ps1 -Profile <name>                   Install via a named profile (recommended)
  .\setup.ps1 -Profile security -Plan           Preview a profile install without applying
  .\setup.ps1 -All                              Install everything (skills + runtime + hooks) - manual mode
  .\setup.ps1 -Skills "name1,name2"             Install specific skills (global)
  .\setup.ps1 -Skills "name1" -ProjectLocal     Install skills to current project
  .\setup.ps1 -Mcp "name1,name2"                Install MCP server configs (when content lands)
  .\setup.ps1 -Plugins "name1,name2"            Install Claude Code plugins (when content lands)
  .\setup.ps1 -Tools "name1,name2"              Install standalone CLI tools (when content lands)
  .\setup.ps1 -Runtime                          Install the agent-daemon CLI (Node 22+ required)
  .\setup.ps1 -Hooks                            Print hook configs to merge into ~/.claude/settings.json
  .\setup.ps1 -List                             List everything available
  .\setup.ps1 -DryRun -All                      Show what would be installed

Profiles (see runtime/profiles/profiles.json):
  minimal      Memory + lifecycle hooks only. No tool guards, no auto-installed skills.
  developer    (default) Adds console.log warning + build/PR-URL log. Installs 7 core skills.
  security     Developer + blocks --no-verify / dev-server-not-tmux, audits every MCP call.

Options:
  -Profile NAME    Install profile by name (delegates to: ad init --profile NAME)
  -Plan            With -Profile, print the install plan without applying
  -All             Install everything across all categories + runtime + hook prompt
  -Skills          Comma-separated list of skill names
  -Mcp             Comma-separated list of MCP server names
  -Plugins         Comma-separated list of plugin names
  -Tools           Comma-separated list of tool names
  -Runtime         Install the agent-daemon Node CLI (the self-improving runtime)
  -Hooks           Print hook configs for SessionStart / SessionEnd / PreCompact
  -ProjectLocal    Install skills/plugins to .claude/<kind>/ instead of ~/.claude/<kind>/
  -DryRun          Show what would happen without making changes
  -List            List available items in every category
  -Help            Show this help

Categories:
  skills    - Claude Code skills (SKILL.md). Active and well-populated (19 skills).
  mcp       - Model Context Protocol server configs. Scaffolded.
  plugins   - Claude Code plugins (commands + agents + hooks + skills bundles). Scaffolded.
  tools     - Standalone CLI tools agents can invoke. Scaffolded.
  adapters  - Format converters: SKILL.md -> Cursor/AGENTS.md/Copilot. Scaffolded.
  runtime   - The agent-daemon Node CLI that drives the self-improving loop.
  hooks     - Pre-baked Claude Code hook configs that wire the runtime into sessions.

Quick start (full install):
  .\setup.ps1 -All       # then follow the printed instructions to merge the hook snippets
"@
}

function Install-Runtime {
    param([bool]$IsDryRun)

    $runtimeDir = Join-Path $ToolkitDir "runtime"
    $cliSrc = Join-Path $runtimeDir "src" "cli.mjs"
    $binDir = Join-Path $env:USERPROFILE "AppData" "Local" "agent-daemon" "bin"
    $binCmd = Join-Path $binDir "agent-daemon.cmd"

    if (-not (Test-Path $cliSrc)) {
        Write-Host "  SKIP: runtime (cli.mjs not found at $cliSrc)"
        return $false
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "  SKIP: runtime (node not on PATH - install Node.js >= 22 first)"
        return $false
    }

    if ($IsDryRun) {
        Write-Host "  WOULD INSTALL: agent-daemon CLI -> $binCmd (wrapper to $cliSrc)"
        return $true
    }

    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    }

    # Write a .cmd wrapper that forwards args to node + cli.mjs
    $wrapper = "@node `"$cliSrc`" %*`r`n"
    Set-Content -Path $binCmd -Value $wrapper -Encoding ASCII

    Write-Host "  INSTALLED: agent-daemon CLI -> $binCmd"
    Write-Host "             (ensure $binDir is on your PATH; user PATH not auto-modified)"
    return $true
}

function Install-Service {
    param([bool]$IsDryRun)

    $installer = Join-Path $ToolkitDir "runtime" "scripts" "install-service-windows.ps1"
    if (-not (Test-Path $installer)) {
        Write-Host "  SKIP: --service (installer not found: $installer)"
        return $false
    }

    if ($IsDryRun) {
        Write-Host "  WOULD RUN: $installer"
        return $true
    }

    Write-Host ""
    Write-Host "==== Registering agent-daemon watch as a Windows scheduled task ===="
    Write-Host ""
    & powershell -ExecutionPolicy Bypass -File $installer
    return $true
}

function Show-HookSnippets {
    $hooksDir = Join-Path $ToolkitDir "hooks"
    Write-Host ""
    Write-Host "==== Hook configs for ~/.claude/settings.json ===="
    Write-Host ""
    Write-Host "Merge each block below into the corresponding section of your settings.json."
    Write-Host "If settings.json doesn't exist, create one with: { ""hooks"": { ... } }"
    Write-Host ""

    foreach ($snippet in @("session-start-load.json", "session-end-digest.json", "pre-compact-checkpoint.json")) {
        $f = Join-Path $hooksDir $snippet
        if (Test-Path $f) {
            Write-Host "--- $snippet ---"
            Get-Content $f | ForEach-Object { Write-Host $_ }
            Write-Host ""
        }
    }

    Write-Host "After merging, verify with:  agent-daemon doctor"
}

function List-Category {
    param([string]$Title, [string]$Dir, [string]$Marker)

    Write-Host $Title
    Write-Host ""

    if (-not (Test-Path $Dir)) {
        Write-Host "  (directory missing - nothing to list)"
        Write-Host ""
        return
    }

    $found = 0
    Get-ChildItem -Path $Dir -Directory | ForEach-Object {
        $markerFile = Join-Path $_.FullName $Marker
        if (Test-Path $markerFile) {
            $desc = (Get-Content $markerFile | Where-Object { $_ -match "^description:" } | Select-Object -First 1) -replace "^description:\s*", ""
            if ([string]::IsNullOrWhiteSpace($desc)) { $desc = "(no description)" }
            Write-Host ("  {0,-30} {1}" -f $_.Name, $desc)
            $found++
        }
    }

    if ($found -eq 0) {
        Write-Host "  (scaffolded - no items yet)"
    }
    Write-Host ""
}

function List-All {
    List-Category -Title "Skills (skills/):"      -Dir $SkillsDir   -Marker "SKILL.md"
    List-Category -Title "MCP servers (mcp/):"     -Dir $McpDir      -Marker "README.md"
    List-Category -Title "Plugins (plugins/):"     -Dir $PluginsDir  -Marker "plugin.json"
    List-Category -Title "Tools (tools/):"         -Dir $ToolsDir    -Marker "README.md"
    List-Category -Title "Adapters (adapters/):"   -Dir $AdaptersDir -Marker "README.md"
    Write-Host 'Install with: .\setup.ps1 -Skills "name1,name2"  (or -Mcp / -Plugins / -Tools / -All)'
}

function Install-Skill {
    param([string]$Name, [string]$Target, [bool]$IsDryRun)

    $src = Join-Path $SkillsDir $Name
    $dst = Join-Path $Target $Name

    if (-not (Test-Path $src)) { Write-Host "  SKIP: $Name (not found in toolkit)"; return $false }
    $skillFile = Join-Path $src "SKILL.md"
    if (-not (Test-Path $skillFile)) { Write-Host "  SKIP: $Name (no SKILL.md)"; return $false }

    if ($IsDryRun) { Write-Host "  WOULD INSTALL: skill $Name -> $dst"; return $true }

    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    Write-Host "  INSTALLED: skill $Name -> $dst"
    return $true
}

function Install-Plugin {
    param([string]$Name, [string]$Target, [bool]$IsDryRun)

    $src = Join-Path $PluginsDir $Name
    $dst = Join-Path $Target $Name

    if (-not (Test-Path $src)) { Write-Host "  SKIP: $Name (plugin not found)"; return $false }
    $manifest = Join-Path $src "plugin.json"
    if (-not (Test-Path $manifest)) { Write-Host "  SKIP: $Name (no plugin.json)"; return $false }

    if ($IsDryRun) { Write-Host "  WOULD INSTALL: plugin $Name -> $dst"; return $true }

    if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    Write-Host "  INSTALLED: plugin $Name -> $dst"
    return $true
}

function Print-McpHint {
    param([string]$Name)

    $src = Join-Path $McpDir $Name
    if (-not (Test-Path $src)) { Write-Host "  SKIP: mcp $Name (not found)"; return $false }

    Write-Host "  MCP $($Name):"
    Write-Host "    See $src\README.md for install steps."
    $snippet = Join-Path $src "claude-code.json"
    if (Test-Path $snippet) { Write-Host "    Claude Code snippet: $snippet" }
    return $true
}

function Print-ToolHint {
    param([string]$Name)

    $src = Join-Path $ToolsDir $Name
    if (-not (Test-Path $src)) { Write-Host "  SKIP: tool $Name (not found)"; return $false }

    Write-Host "  TOOL $($Name):"
    Write-Host "    See $src\README.md for install steps."
    return $true
}

# Handle help and list
if ($Help) { Show-Usage; exit 0 }
if ($List) { List-All; exit 0 }

# Profile mode short-circuits the rest of the script — delegate to the CLI
# which knows the canonical install logic from runtime/profiles/profiles.json.
if (-not [string]::IsNullOrEmpty($Profile)) {
    $cli = Join-Path $ToolkitDir "runtime" "src" "cli.mjs"
    if (-not (Test-Path $cli)) {
        Write-Error "--Profile requires the runtime CLI at $cli"
        exit 1
    }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Error "--Profile requires Node.js (>=22) on PATH"
        exit 1
    }
    $cliArgs = @("init", "--profile", $Profile)
    if ($Plan)    { $cliArgs += "--plan" }
    if ($DryRun)  { $cliArgs += "--dry-run" }
    Write-Host "Delegating to: node $cli $($cliArgs -join ' ')"
    & node $cli @cliArgs
    exit $LASTEXITCODE
}

# Validate arguments
if (-not $All -and -not $Runtime -and -not $Hooks -and -not $Service -and `
    [string]::IsNullOrEmpty($Skills) -and `
    [string]::IsNullOrEmpty($Mcp) -and `
    [string]::IsNullOrEmpty($Plugins) -and `
    [string]::IsNullOrEmpty($Tools)) {
    Show-Usage
    exit 1
}

# Determine targets
if ($ProjectLocal) {
    $SkillsTarget  = $LocalSkills
    $PluginsTarget = $LocalPlugins
    Write-Host "Installing to project-local: .\.claude\"
} else {
    $SkillsTarget  = $GlobalSkills
    $PluginsTarget = $GlobalPlugins
    Write-Host "Installing to global: $env:USERPROFILE\.claude\"
}

# Build selection lists
$SelectedSkills  = @()
$SelectedMcp     = @()
$SelectedPlugins = @()
$SelectedTools   = @()

if (-not [string]::IsNullOrEmpty($Skills))  { $SelectedSkills  = $Skills  -split "," | ForEach-Object { $_.Trim() } }
if (-not [string]::IsNullOrEmpty($Mcp))     { $SelectedMcp     = $Mcp     -split "," | ForEach-Object { $_.Trim() } }
if (-not [string]::IsNullOrEmpty($Plugins)) { $SelectedPlugins = $Plugins -split "," | ForEach-Object { $_.Trim() } }
if (-not [string]::IsNullOrEmpty($Tools))   { $SelectedTools   = $Tools   -split "," | ForEach-Object { $_.Trim() } }

if ($All) {
    if ($SelectedSkills.Count -eq 0) { $SelectedSkills = $AllSkills }
    if ($SelectedMcp.Count -eq 0 -and (Test-Path $McpDir)) {
        Get-ChildItem -Path $McpDir -Directory | ForEach-Object {
            if (Test-Path (Join-Path $_.FullName "README.md")) { $SelectedMcp += $_.Name }
        }
    }
    if ($SelectedPlugins.Count -eq 0 -and (Test-Path $PluginsDir)) {
        Get-ChildItem -Path $PluginsDir -Directory | ForEach-Object {
            if (Test-Path (Join-Path $_.FullName "plugin.json")) { $SelectedPlugins += $_.Name }
        }
    }
    if ($SelectedTools.Count -eq 0 -and (Test-Path $ToolsDir)) {
        Get-ChildItem -Path $ToolsDir -Directory | ForEach-Object {
            if (Test-Path (Join-Path $_.FullName "README.md")) { $SelectedTools += $_.Name }
        }
    }
}

# Create target directories (only if we have something to install in them)
if (-not $DryRun) {
    if ($SelectedSkills.Count -gt 0  -and -not (Test-Path $SkillsTarget))  { New-Item -ItemType Directory -Path $SkillsTarget  -Force | Out-Null }
    if ($SelectedPlugins.Count -gt 0 -and -not (Test-Path $PluginsTarget)) { New-Item -ItemType Directory -Path $PluginsTarget -Force | Out-Null }
}

Write-Host ""
$success = 0
$failed = 0

foreach ($skill in $SelectedSkills) {
    if ([string]::IsNullOrWhiteSpace($skill)) { continue }
    if (Install-Skill -Name $skill -Target $SkillsTarget -IsDryRun $DryRun) { $success++ } else { $failed++ }
}

foreach ($plugin in $SelectedPlugins) {
    if ([string]::IsNullOrWhiteSpace($plugin)) { continue }
    if (Install-Plugin -Name $plugin -Target $PluginsTarget -IsDryRun $DryRun) { $success++ } else { $failed++ }
}

foreach ($mcp in $SelectedMcp) {
    if ([string]::IsNullOrWhiteSpace($mcp)) { continue }
    if (Print-McpHint -Name $mcp) { $success++ } else { $failed++ }
}

foreach ($tool in $SelectedTools) {
    if ([string]::IsNullOrWhiteSpace($tool)) { continue }
    if (Print-ToolHint -Name $tool) { $success++ } else { $failed++ }
}

# Runtime
if ($Runtime -or $All) {
    if (Install-Runtime -IsDryRun $DryRun) { $success++ } else { $failed++ }
}

# Hooks (always informational - never auto-merge settings.json in v0.1)
if ($Hooks -or $All) {
    Show-HookSnippets
}

# Service registration
if ($Service) {
    if (Install-Service -IsDryRun $DryRun) { $success++ } else { $failed++ }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete. $success item(s) would be installed."
} else {
    Write-Host "Done. $success item(s) installed."
}

if ($failed -gt 0) { Write-Host "$failed item(s) skipped." }
