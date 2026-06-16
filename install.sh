#!/usr/bin/env bash
# agent-daemon one-liner bootstrap installer (macOS / Linux / Git-Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/pankaj-mahaur/Agent-Daemon/main/install.sh | bash
#
# What it does (all idempotent — safe to re-run):
#   1. Verifies git, node (>=22) and npm are available.
#   2. Clones the repo to $AGENT_DAEMON_DIR (default: ~/.agent-daemon-src),
#      or `git pull`s if it's already there.
#   3. npm install + npm link inside runtime/ so the `ad` command works globally.
#   4. Runs `ad doctor` and prints the next step.
#
# Override the clone location with:  AGENT_DAEMON_DIR=/path ./install.sh
set -euo pipefail

REPO_URL="https://github.com/pankaj-mahaur/Agent-Daemon.git"
INSTALL_DIR="${AGENT_DAEMON_DIR:-$HOME/.agent-daemon-src}"
MIN_NODE_MAJOR=22

say()  { printf '\033[1;36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Prerequisites ----------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required but not found on PATH."
command -v node >/dev/null 2>&1 || die "Node.js >=${MIN_NODE_MAJOR} is required but not found on PATH."
command -v npm  >/dev/null 2>&1 || die "npm is required but not found on PATH."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] \
  || die "Node.js >=${MIN_NODE_MAJOR} required, found $(node -v)."
ok "Prerequisites OK (node $(node -v))"

# 2. Clone or update --------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing clone at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a git clone. Remove it or set AGENT_DAEMON_DIR."
else
  say "Cloning agent-daemon into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
ok "Source ready at $INSTALL_DIR"

# 3. Install + link ---------------------------------------------------------
say "Installing dependencies + linking the \`ad\` command"
( cd "$INSTALL_DIR/runtime" && npm install && npm link )
ok "\`ad\` command registered globally"

# 4. Verify -----------------------------------------------------------------
say "Verifying install"
ad doctor || true

cat <<EOF

$(ok "agent-daemon installed.")

Next step — initialize it in a project:

  cd /path/to/your/project
  ad init

Docs: https://github.com/pankaj-mahaur/Agent-Daemon
EOF
