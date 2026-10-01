<#
.SYNOPSIS
  agent-daemon one-liner bootstrap installer (Windows PowerShell).

.DESCRIPTION
  Run directly from the web:

      irm https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.ps1 | iex

  What it does (all idempotent — safe to re-run):
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

function Say  ($m) { Write-Host "› $m"  -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "✓ $m"  -ForegroundColor Green }
function Die  ($m) { Write-Host "✗ $m"  -ForegroundColor Red; exit 1 }

# 1. Prerequisites ----------------------------------------------------------
foreach ($cmd in 'git', 'node', 'npm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Die "$cmd is required but not found on PATH."
  }
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $MinNodeMajor) {
  Die "Node.js >=$MinNodeMajor required, found $(node -v)."
}
Ok "Prerequisites OK (node $(node -v))"

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
  npm install
  npm link
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

Next step — initialize it in a project:

  cd C:\path\to\your\project
  ad init

Docs: https://github.com/pankaj-mahaur/Agent-Daemon
'@
