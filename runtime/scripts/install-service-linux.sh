#!/usr/bin/env bash
# Register agent-daemon watch as a systemd user unit on Linux.
# Runs at every login; restarts on crash.
#
# To uninstall:
#   systemctl --user disable --now agent-daemon-watch.service
#   rm ~/.config/systemd/user/agent-daemon-watch.service

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install-service-linux.sh: not running on Linux (uname=$(uname -s))" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "install-service-linux.sh: systemctl not found. This script requires systemd." >&2
  echo "  cron alternative: add the following to your crontab:" >&2
  echo "    @reboot $(command -v node) /full/path/to/cli.mjs watch >> ~/.agent-daemon/logs/watch.log 2>&1" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "install-service-linux.sh: node not on PATH. Install Node.js >= 22 first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_PATH="$(cd "$SCRIPT_DIR/.." && pwd)/src/cli.mjs"

if [[ ! -f "$CLI_PATH" ]]; then
  echo "install-service-linux.sh: cli.mjs not found at $CLI_PATH" >&2
  exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/agent-daemon-watch.service"
LOG_DIR="$HOME/.agent-daemon/logs"

mkdir -p "$UNIT_DIR" "$LOG_DIR"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=agent-daemon watch — self-improving runtime for AI coding agents
After=default.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${CLI_PATH} watch
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_DIR}/watch.stdout.log
StandardError=append:${LOG_DIR}/watch.stderr.log
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now agent-daemon-watch.service

# Enable lingering so the user's services start at boot (not just at login)
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" 2>/dev/null || true
fi

echo "agent-daemon: systemd user unit registered → $UNIT_FILE"
echo "  status:    systemctl --user status agent-daemon-watch"
echo "  logs:      journalctl --user -u agent-daemon-watch -f"
echo "  uninstall: systemctl --user disable --now agent-daemon-watch && rm '$UNIT_FILE'"
