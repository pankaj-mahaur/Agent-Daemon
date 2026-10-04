<#
.SYNOPSIS
  agent-daemon one-liner bootstrap installer (Windows PowerShell).

.DESCRIPTION
  Run directly from the web:

      irm https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.ps1 | iex

  What it does (all idempotent - safe to re-run):
    1. Verifies git, node (>=22) and npm are available.
    2. Clones the repo to $env:AGENT_DAEMON_DIR (default: ~\.agent-daemon-src),
       or `git pull`s if it's already there.
    3. npm install + npm link inside runtime\ so the `ad` command works globally.
    4. Runs `ad doctor` and prints the next step.

  Override the clone location with:  $env:AGENT_DAEMON_DIR = 'D:\path'; irm ... | iex
  Pin a release (e.g. v1, the Claude Code memory runtime):
      $env:AD_VERSION = 'v1.0.0'; irm ... | iex
  Re-running without AD_VERSION moves a pinned install back to main.
#>

$ErrorActionPreference = 'Stop'

$RepoUrl     = 'https://github.com/pankaj-mahaur/Agent-Daemon.git'
$InstallDir  = if ($env:AGENT_DAEMON_DIR) { $env:AGENT_DAEMON_DIR } else { Join-Path $HOME '.agent-daemon-src' }
$Version     = $env:AD_VERSION
$MinNodeMajor = 22

function Say  ($m) { Write-Host "> $m"  -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "+ $m"  -ForegroundColor Green }
# throw, not exit: under `irm | iex` an exit would close the user's PowerShell window.
function Die  ($m) { Write-Host "x $m"  -ForegroundColor Red; throw "agent-daemon install stopped: $m" }

# 1. Prerequisites ----------------------------------------------------------
foreach ($cmd in 'git', 'node', 'npm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Die "$cmd is required but not found on PATH."
  }
}

# Parse `node -v` here: Windows PowerShell 5.1 strips the inner quotes of
# `node -p '...split(".")...'`, so asking node to split always failed there.
$nodeVersion = [version]((node -v).Trim().TrimStart('v'))
if ($nodeVersion.Major -lt $MinNodeMajor) {
  Die "Node.js >=$MinNodeMajor required, found v$nodeVersion."
}
Ok "Prerequisites OK (node v$nodeVersion)"

# The terminal UI reads keys through Node's VT console input on Windows: 22.17+ or 24.2+.
# Everything else in ad works on any Node 22.
$tuiNode = ($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 17) -or ($nodeVersion.Major -eq 24 -and $nodeVersion.Minor -ge 2) -or ($nodeVersion.Major -ge 25)
if (-not $tuiNode) {
  Write-Host "! Node v$nodeVersion: the ad terminal UI needs 22.17+ or 24.2+ (everything else works)." -ForegroundColor Yellow
  if ($nodeVersion.Major -eq 22) {
    Write-Host "  Upgrade within 22.x (same native-module ABI, nothing to rebuild): winget install --id OpenJS.NodeJS.22 -e" -ForegroundColor Yellow
  } else {
    Write-Host "  Upgrade to Node 24.2+ (winget install --id OpenJS.NodeJS.LTS -e), then run: cd `"$InstallDir\runtime`"; npm rebuild" -ForegroundColor Yellow
  }
}

# 2. Clone or update --------------------------------------------------------
# Native commands don't throw on failure, so check each git exit code.
function Invoke-Git { git @args; if ($LASTEXITCODE -ne 0) { Die "git $($args -join ' ') failed." } }

if (Test-Path (Join-Path $InstallDir '.git')) {
  if ($Version) {
    Say "Switching $InstallDir to $Version"
    Invoke-Git -C $InstallDir fetch --depth 1 origin "+refs/tags/${Version}:refs/tags/${Version}"
    Invoke-Git -C $InstallDir -c advice.detachedHead=false checkout -q $Version
  } else {
    git -C $InstallDir symbolic-ref -q HEAD *> $null
    if ($LASTEXITCODE -eq 0) {
      Say "Updating existing clone at $InstallDir"
      Invoke-Git -C $InstallDir pull --ff-only
    } else {
      Say "Moving $InstallDir from a pinned release back to main"
      # A tag clone's fetch refspec covers only that tag; point it back at main.
      Invoke-Git -C $InstallDir config remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
      Invoke-Git -C $InstallDir fetch --depth 1 origin
      Invoke-Git -C $InstallDir checkout -q -B main origin/main
      Invoke-Git -C $InstallDir branch -q --set-upstream-to=origin/main main
    }
  }
} elseif (Test-Path $InstallDir) {
  Die "$InstallDir exists but is not a git clone. Remove it or set `$env:AGENT_DAEMON_DIR."
} elseif ($Version) {
  Say "Cloning agent-daemon $Version into $InstallDir"
  Invoke-Git -c advice.detachedHead=false clone --depth 1 --branch $Version $RepoUrl $InstallDir
} else {
  Say "Cloning agent-daemon into $InstallDir"
  Invoke-Git clone --depth 1 $RepoUrl $InstallDir
}
Ok "Source ready at $InstallDir"

# 3. Install + link ---------------------------------------------------------
Say 'Installing dependencies + linking the `ad` command'
Push-Location (Join-Path $InstallDir 'runtime')
try {
  # --omit=dev: test-only packages (terminal emulators for screen tests) stay out of user installs.
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
  npm link --omit=dev
  if ($LASTEXITCODE -ne 0) { Die 'npm link failed.' }
} finally {
  Pop-Location
}
Ok '`ad` command registered globally'

# 4. Verify -----------------------------------------------------------------
Say 'Verifying install'
try { ad doctor } catch { }

Write-Host ''
Ok 'agent-daemon installed.'
Write-Host @'

Next step - initialize it in a project:

  cd C:\path\to\your\project
  ad init

Docs: https://github.com/pankaj-mahaur/Agent-Daemon
'@
