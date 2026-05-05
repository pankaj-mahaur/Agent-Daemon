#!/usr/bin/env bash
# Register agent-daemon watch as a launchd user agent on macOS.
# Runs at every user login; restarts on crash.
#
# To uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.agent-daemon.watch.plist
#   rm ~/Library/LaunchAgents/com.agent-daemon.watch.plist

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-service-darwin.sh: not running on macOS (uname=$(uname -s))" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "install-service-darwin.sh: node not on PATH. Install Node.js >= 22 first." >&2
  exit 1
fi

# Resolve the runtime CLI path
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/src/cli.mjs"

if [[ ! -f "$CLI_PATH" ]]; then
  echo "install-service-darwin.sh: cli.mjs not found at $CLI_PATH" >&2
  exit 1
fi

LABEL="com.agent-daemon.watch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.agent-daemon/logs"
mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST")"

# Stop any existing instance (idempotent re-install)
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLI_PATH}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>${LOG_DIR}/watch.stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/watch.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST"

echo "agent-daemon: launchd agent registered → $PLIST"
echo "  status:    launchctl list | grep ${LABEL}"
echo "  logs:      tail -f $LOG_DIR/watch.stderr.log"
echo "  uninstall: launchctl unload '$PLIST' && rm '$PLIST'"
