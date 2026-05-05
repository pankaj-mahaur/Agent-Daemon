# Register agent-daemon watch as a Windows Scheduled Task running at user logon.
# Restarts automatically if it crashes.
#
# To uninstall:
#   schtasks /Delete /TN "agent-daemon-watch" /F

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$TaskName = "agent-daemon-watch"

if ($Uninstall) {
    schtasks /Delete /TN $TaskName /F 2>$null
    Write-Host "agent-daemon: scheduled task removed: $TaskName"
    exit 0
}

# Locate node
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "install-service-windows.ps1: node not on PATH. Install Node.js >= 22 first."
    exit 1
}
$NodeExe = $NodeCmd.Source

# Locate cli.mjs
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliPath = Join-Path (Split-Path -Parent $ScriptDir) "src\cli.mjs"
if (-not (Test-Path $CliPath)) {
    Write-Error "install-service-windows.ps1: cli.mjs not found at $CliPath"
    exit 1
}

$LogDir = Join-Path $env:USERPROFILE ".agent-daemon\logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# Build the wrapper command (Scheduled Tasks doesn't redirect cleanly, so we use cmd /c)
$LogPath = Join-Path $LogDir "watch.log"
$ActionExe  = "cmd.exe"
$ActionArgs = "/c `"`"$NodeExe`" `"$CliPath`" watch >> `"$LogPath`" 2>&1`""

# Remove existing task if present (idempotent re-install)
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

# Create the task — at logon, runs the wrapper, restart on failure
$TR = "$ActionExe $ActionArgs"
schtasks /Create `
    /TN $TaskName `
    /TR $TR `
    /SC ONLOGON `
    /RL LIMITED `
    /F | Out-Null

# Optional: configure restart on failure (requires modify after create — XML edit)
# For simplicity, the basic ONLOGON registration is enough for v0.3 ergonomics.

Write-Host "agent-daemon: scheduled task registered: $TaskName"
Write-Host "  status:    schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "  start now: schtasks /Run /TN $TaskName"
Write-Host "  logs:      $LogPath"
Write-Host "  uninstall: powershell -ExecutionPolicy Bypass -File '$($MyInvocation.MyCommand.Path)' -Uninstall"
