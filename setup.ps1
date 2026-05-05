param(
    [switch]$All,
    [string]$Skills,
    [switch]$ProjectLocal,
    [switch]$DryRun,
    [switch]$List,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ToolkitDir = $PSScriptRoot
$SkillsDir = Join-Path $ToolkitDir "skills"
$GlobalTarget = Join-Path $env:USERPROFILE ".claude" "skills"
$LocalTarget = Join-Path "." ".agents" "skills"

$AllSkills = @(
    "diagnose-fetch-failure"
    "graphify"
    "qmd"
    "seed-data"
    "review-slice"
    "merge-feature-branch"
    "security-audit"
    "production-readiness"
    "optimization-audit"
    "dead-code-review"
    "docs-sync-audit"
)

function Show-Usage {
    Write-Host @"
Claude Code Toolkit - Skill Installer

Usage:
  .\setup.ps1 -All                              Install all skills globally
  .\setup.ps1 -Skills "name1,name2"             Install specific skills globally
  .\setup.ps1 -Skills "name1" -ProjectLocal     Install to current project
  .\setup.ps1 -List                             List available skills
  .\setup.ps1 -DryRun -All                      Show what would be installed

Options:
  -All             Install all skills
  -Skills          Comma-separated list of skill names
  -ProjectLocal    Install to .agents/skills/ instead of ~/.claude/skills/
  -DryRun          Show what would happen without making changes
  -List            List available skills and exit
  -Help            Show this help
"@
}

function Show-Skills {
    Write-Host "Available skills:"
    Write-Host ""
    foreach ($skill in $AllSkills) {
        $skillFile = Join-Path $SkillsDir $skill "SKILL.md"
        if (Test-Path $skillFile) {
            $desc = (Get-Content $skillFile | Where-Object { $_ -match "^description:" } | Select-Object -First 1) -replace "^description:\s*", ""
            Write-Host ("  {0,-25} {1}" -f $skill, $desc)
        }
    }
    Write-Host ""
    Write-Host 'Install with: .\setup.ps1 -Skills "name1,name2"'
}

function Install-Skill {
    param([string]$Name, [string]$Target, [bool]$IsDryRun)

    $src = Join-Path $SkillsDir $Name
    $dst = Join-Path $Target $Name

    if (-not (Test-Path $src)) {
        Write-Host "  SKIP: $Name (not found in toolkit)"
        return $false
    }

    $skillFile = Join-Path $src "SKILL.md"
    if (-not (Test-Path $skillFile)) {
        Write-Host "  SKIP: $Name (no SKILL.md)"
        return $false
    }

    if ($IsDryRun) {
        Write-Host "  WOULD INSTALL: $Name -> $dst"
        return $true
    }

    if (-not (Test-Path $dst)) {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force
    Write-Host "  INSTALLED: $Name -> $dst"
    return $true
}

# Handle help and list
if ($Help) { Show-Usage; exit 0 }
if ($List) { Show-Skills; exit 0 }

# Validate arguments
if (-not $All -and [string]::IsNullOrEmpty($Skills)) {
    Show-Usage
    exit 1
}

# Determine target
if ($ProjectLocal) {
    $Target = $LocalTarget
    Write-Host "Installing to project-local: $Target\"
} else {
    $Target = $GlobalTarget
    Write-Host "Installing to global: $Target\"
}

# Create target directory
if (-not $DryRun -and -not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
}

# Determine which skills to install
if ($All) {
    $SelectedSkills = $AllSkills
} else {
    $SelectedSkills = $Skills -split ","
}

Write-Host ""
$success = 0
$failed = 0

foreach ($skill in $SelectedSkills) {
    $skill = $skill.Trim()
    if (Install-Skill -Name $skill -Target $Target -IsDryRun $DryRun) {
        $success++
    } else {
        $failed++
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete. $success skill(s) would be installed."
} else {
    Write-Host "Done. $success skill(s) installed."
}

if ($failed -gt 0) {
    Write-Host "$failed skill(s) skipped."
}
