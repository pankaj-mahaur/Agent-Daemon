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
#>

$ErrorActionPreference = 'Stop'

$RepoUrl     = 'https://github.com/pankaj-mahaur/Agent-Daemon.git'
$InstallDir  = if ($env:AGENT_DAEMON_DIR) { $env:AGENT_DAEMON_DIR } else { Join-Path $HOME '.agent-daemon-src' }
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
if (Test-Path (Join-Path $InstallDir '.git')) {
  Say "Updating existing clone at $InstallDir"
  git -C $InstallDir pull --ff-only
} elseif (Test-Path $InstallDir) {
  Die "$InstallDir exists but is not a git clone. Remove it or set `$env:AGENT_DAEMON_DIR."
} else {
  Say "Cloning agent-daemon into $InstallDir"
  git clone --depth 1 $RepoUrl $InstallDir
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
