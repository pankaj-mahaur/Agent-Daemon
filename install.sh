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
# Pin a release (e.g. v1, the Claude Code memory runtime):
#   curl -fsSL .../main/install.sh | AD_VERSION=v1.0.0 bash
# Re-running without AD_VERSION moves a pinned install back to main.
set -euo pipefail

REPO_URL="https://github.com/pankaj-mahaur/Agent-Daemon.git"
INSTALL_DIR="${AGENT_DAEMON_DIR:-$HOME/.agent-daemon-src}"
AD_VERSION="${AD_VERSION:-}"
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

# On Windows (Git Bash/MSYS) the terminal UI reads keys through Node's VT console
# input: 22.17+ or 24.2+. Everything else in ad works on any Node 22.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    NODE_MINOR="$(node -v | sed 's/^v//' | cut -d. -f2)"
    if { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 17 ]; } || [ "$NODE_MAJOR" -eq 23 ] \
      || { [ "$NODE_MAJOR" -eq 24 ] && [ "$NODE_MINOR" -lt 2 ]; }; then
      printf '\033[1;33m!\033[0m Node %s: the ad terminal UI needs 22.17+ or 24.2+ on Windows (everything else works).\n' "$(node -v)"
      if [ "$NODE_MAJOR" -eq 22 ]; then
        printf '  Upgrade within 22.x (same native-module ABI, nothing to rebuild).\n'
      else
        printf '  Upgrade to Node 24.2+, then run: cd "%s/runtime" && npm rebuild\n' "$INSTALL_DIR"
      fi
    fi
    ;;
esac

# 2. Clone or update --------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  if [ -n "$AD_VERSION" ]; then
    say "Switching $INSTALL_DIR to $AD_VERSION"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "+refs/tags/$AD_VERSION:refs/tags/$AD_VERSION"
    git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout -q "$AD_VERSION"
  elif git -C "$INSTALL_DIR" symbolic-ref -q HEAD >/dev/null; then
    say "Updating existing clone at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    say "Moving $INSTALL_DIR from a pinned release back to main"
    # A tag clone's fetch refspec covers only that tag; point it back at main.
    git -C "$INSTALL_DIR" config remote.origin.fetch "+refs/heads/main:refs/remotes/origin/main"
    git -C "$INSTALL_DIR" fetch --depth 1 origin
    git -C "$INSTALL_DIR" checkout -q -B main origin/main
    git -C "$INSTALL_DIR" branch -q --set-upstream-to=origin/main main
  fi
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR exists but is not a git clone. Remove it or set AGENT_DAEMON_DIR."
else
  say "Cloning agent-daemon${AD_VERSION:+ $AD_VERSION} into $INSTALL_DIR"
  git -c advice.detachedHead=false clone --depth 1 ${AD_VERSION:+--branch "$AD_VERSION"} "$REPO_URL" "$INSTALL_DIR"
fi
ok "Source ready at $INSTALL_DIR"

# 3. Install + link ---------------------------------------------------------
say "Installing dependencies + linking the \`ad\` command"
# --omit=dev: test-only packages (terminal emulators for screen tests) stay out of user installs.
( cd "$INSTALL_DIR/runtime" && npm install --omit=dev && npm link --omit=dev )
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
