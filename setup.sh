#!/usr/bin/env bash
set -euo pipefail

TOOLKIT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$TOOLKIT_DIR/skills"
MCP_DIR="$TOOLKIT_DIR/mcp"
PLUGINS_DIR="$TOOLKIT_DIR/plugins"
TOOLS_DIR="$TOOLKIT_DIR/tools"
ADAPTERS_DIR="$TOOLKIT_DIR/adapters"

GLOBAL_SKILLS="$HOME/.claude/skills"
GLOBAL_PLUGINS="$HOME/.claude/plugins"
LOCAL_SKILLS=".claude/skills"
LOCAL_PLUGINS=".claude/plugins"

ALL_SKILLS=(
  bootstrap-daemon
  diagnose-fetch-failure
  diagnose-intermittent-failure
  graphify
  qmd
  seed-data
  review-slice
  audit-runner
  merge-feature-branch
  security-audit
  production-readiness
  optimization-audit
  dead-code-review
  docs-sync-audit
  implement-feature
  debug-triage
  db-migrations
  llm-app-safety
  multiplatform-parity
  deploy-ops
)

usage() {
  cat <<EOF
agent-daemon — Universal Installer

Usage:
  ./setup.sh --profile <name>                   Install via a named profile (recommended)
  ./setup.sh --profile security --plan          Preview a profile install without applying
  ./setup.sh --all                              Install everything (skills + runtime + hooks) — manual mode
  ./setup.sh --skills name1,name2               Install specific skills (global) — manual mode
  ./setup.sh --skills name1 --project-local     Install skills to current project (.claude/skills/)
  ./setup.sh --mcp name1,name2                  Install MCP server configs (when content lands)
  ./setup.sh --plugins name1,name2              Install Claude Code plugins (when content lands)
  ./setup.sh --tools name1,name2                Install standalone CLI tools (when content lands)
  ./setup.sh --runtime                          Install the agent-daemon CLI to ~/.local/bin/
  ./setup.sh --hooks                            Print hook snippets to merge into ~/.claude/settings.json
  ./setup.sh --service                          Register watch daemon as launchd / systemd unit (start at login)
  ./setup.sh --list                             List everything available
  ./setup.sh --dry-run --all                    Show what would be installed

Profiles (see runtime/profiles/profiles.json):
  minimal      Memory + lifecycle hooks only. No tool guards, no auto-installed skills.
  developer    (default) Adds console.log warning + build/PR-URL log. Installs 7 core skills.
  security     Developer + blocks --no-verify / dev-server-not-tmux, audits every MCP call.

Options:
  --profile NAME    Install profile by name (delegates to: ad init --profile NAME)
  --plan            With --profile, print the install plan without applying
  --all             Install everything across all categories + runtime + hook prompt
  --skills NAME     Comma-separated list of skill names
  --mcp NAME        Comma-separated list of MCP server names
  --plugins NAME    Comma-separated list of plugin names
  --tools NAME      Comma-separated list of tool names
  --runtime         Install the agent-daemon CLI to ~/.local/bin/ (the self-improving runtime)
  --hooks           Print hook configs for SessionStart / SessionEnd / PreCompact
  --service         Register agent-daemon watch as a system service (launchd on macOS, systemd on Linux)
  --project-local   Install skills/plugins to .claude/<kind>/ instead of ~/.claude/<kind>/
  --dry-run         Show what would happen without making changes
  --list            List available items in every category
  --help            Show this help

Categories:
  skills    — Claude Code skills (SKILL.md). Active and well-populated (19 skills).
  mcp       — Model Context Protocol server configs. Scaffolded.
  plugins   — Claude Code plugins (commands + agents + hooks + skills bundles). Scaffolded.
  tools     — Standalone CLI tools agents can invoke. Scaffolded.
  adapters  — Format converters: SKILL.md -> Cursor/AGENTS.md/Copilot. Scaffolded.
  runtime   — The agent-daemon Node CLI that drives the self-improving loop.
  hooks     — Pre-baked Claude Code hook configs that wire the runtime into your sessions.

Quick start (full install):
  ./setup.sh --all      # then follow the printed instructions to merge the hook snippets
EOF
}

install_runtime() {
  local dry_run="$1"
  local runtime_dir="$TOOLKIT_DIR/runtime"
  local cli_src="$runtime_dir/src/cli.mjs"
  local bin_dir="$HOME/.local/bin"
  local bin_target="$bin_dir/agent-daemon"

  if [ ! -f "$cli_src" ]; then
    echo "  SKIP: runtime (cli.mjs not found at $cli_src)"
    return 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "  SKIP: runtime (node not on PATH — install Node.js >= 22 first)"
    return 1
  fi

  if [ "$dry_run" = "true" ]; then
    echo "  WOULD INSTALL: agent-daemon CLI -> $bin_target (symlink to $cli_src)"
    return 0
  fi

  mkdir -p "$bin_dir"
  ln -sf "$cli_src" "$bin_target"
  chmod +x "$cli_src" "$bin_target"

  echo "  INSTALLED: agent-daemon CLI -> $bin_target"
  echo "             (ensure $bin_dir is on your PATH)"
  return 0
}

install_service() {
  local dry_run="$1"
  local scripts_dir="$TOOLKIT_DIR/runtime/scripts"

  case "$(uname -s)" in
    Darwin)
      local installer="$scripts_dir/install-service-darwin.sh"
      ;;
    Linux)
      local installer="$scripts_dir/install-service-linux.sh"
      ;;
    *)
      echo "  SKIP: --service (unsupported platform $(uname -s); use setup.ps1 -Service on Windows)"
      return 1
      ;;
  esac

  if [ ! -f "$installer" ]; then
    echo "  SKIP: --service (installer script missing: $installer)"
    return 1
  fi

  if [ "$dry_run" = "true" ]; then
    echo "  WOULD RUN: $installer"
    return 0
  fi

  echo ""
  echo "═══ Registering agent-daemon watch as a system service ═══"
  echo ""
  bash "$installer"
  return 0
}

print_hook_snippets() {
  local hooks_dir="$TOOLKIT_DIR/hooks"
  echo ""
  echo "═══ Hook configs for ~/.claude/settings.json ═══"
  echo ""
  echo "Merge each block below into the corresponding section of your settings.json."
  echo "If settings.json doesn't exist, create one with: { \"hooks\": { ... } }"
  echo ""

  for snippet in session-start-load.json session-end-digest.json pre-compact-checkpoint.json; do
    local f="$hooks_dir/$snippet"
    if [ -f "$f" ]; then
      echo "─── $snippet ───"
      cat "$f"
      echo ""
    fi
  done

  echo "After merging, verify with:  agent-daemon doctor"
}

# List items in a category by reading directories with a marker file
list_category() {
  local title="$1"
  local dir="$2"
  local marker="$3"

  echo "$title"
  echo ""

  if [ ! -d "$dir" ]; then
    echo "  (directory missing — nothing to list)"
    echo ""
    return
  fi

  local found=0
  for entry in "$dir"/*/; do
    [ -d "$entry" ] || continue
    local name
    name=$(basename "$entry")
    if [ -f "$entry/$marker" ]; then
      local desc
      desc=$(grep -m1 "^description:" "$entry/$marker" 2>/dev/null | sed 's/^description: //' || echo "")
      if [ -z "$desc" ]; then
        desc="(no description)"
      fi
      printf "  %-30s %s\n" "$name" "$desc"
      found=$((found + 1))
    fi
  done

  if [ "$found" -eq 0 ]; then
    echo "  (scaffolded — no items yet)"
  fi
  echo ""
}

list_all() {
  list_category "Skills (skills/):" "$SKILLS_DIR" "SKILL.md"
  list_category "MCP servers (mcp/):" "$MCP_DIR" "README.md"
  list_category "Plugins (plugins/):" "$PLUGINS_DIR" "plugin.json"
  list_category "Tools (tools/):" "$TOOLS_DIR" "README.md"
  list_category "Adapters (adapters/):" "$ADAPTERS_DIR" "README.md"
  echo "Install with: ./setup.sh --skills name1,name2  (or --mcp / --plugins / --tools / --all)"
}

install_skill() {
  local name="$1"
  local target="$2"
  local dry_run="$3"

  local src="$SKILLS_DIR/$name"
  local dst="$target/$name"

  if [ ! -d "$src" ]; then
    echo "  SKIP: $name (not found in toolkit)"
    return 1
  fi

  if [ ! -f "$src/SKILL.md" ]; then
    echo "  SKIP: $name (no SKILL.md)"
    return 1
  fi

  if [ "$dry_run" = "true" ]; then
    echo "  WOULD INSTALL: skill $name -> $dst"
    return 0
  fi

  mkdir -p "$dst"
  cp -r "$src"/* "$dst/"
  echo "  INSTALLED: skill $name -> $dst"
}

install_plugin() {
  local name="$1"
  local target="$2"
  local dry_run="$3"

  local src="$PLUGINS_DIR/$name"
  local dst="$target/$name"

  if [ ! -d "$src" ]; then
    echo "  SKIP: $name (plugin not found)"
    return 1
  fi
  if [ ! -f "$src/plugin.json" ]; then
    echo "  SKIP: $name (no plugin.json)"
    return 1
  fi

  if [ "$dry_run" = "true" ]; then
    echo "  WOULD INSTALL: plugin $name -> $dst"
    return 0
  fi

  mkdir -p "$dst"
  cp -r "$src"/* "$dst/"
  echo "  INSTALLED: plugin $name -> $dst"
}

# MCP and tools install paths are user-decision; we print snippets.
print_mcp_install_hint() {
  local name="$1"
  local src="$MCP_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "  SKIP: mcp $name (not found)"
    return 1
  fi

  echo "  MCP $name:"
  echo "    See $src/README.md for install steps."
  if [ -f "$src/claude-code.json" ]; then
    echo "    Claude Code snippet: $src/claude-code.json"
  fi
}

print_tool_install_hint() {
  local name="$1"
  local src="$TOOLS_DIR/$name"

  if [ ! -d "$src" ]; then
    echo "  SKIP: tool $name (not found)"
    return 1
  fi

  echo "  TOOL $name:"
  echo "    See $src/README.md for install steps."
}

# Parse arguments
INSTALL_ALL=false
INSTALL_RUNTIME=false
INSTALL_SERVICE=false
SHOW_HOOKS=false
SELECTED_SKILLS=()
SELECTED_MCP=()
SELECTED_PLUGINS=()
SELECTED_TOOLS=()
PROJECT_LOCAL=false
DRY_RUN=false
PROFILE=""
PROFILE_PLAN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --plan)
      PROFILE_PLAN=true
      shift
      ;;
    --all)
      INSTALL_ALL=true
      shift
      ;;
    --skills)
      IFS=',' read -ra SELECTED_SKILLS <<< "$2"
      shift 2
      ;;
    --mcp)
      IFS=',' read -ra SELECTED_MCP <<< "$2"
      shift 2
      ;;
    --plugins)
      IFS=',' read -ra SELECTED_PLUGINS <<< "$2"
      shift 2
      ;;
    --tools)
      IFS=',' read -ra SELECTED_TOOLS <<< "$2"
      shift 2
      ;;
    --runtime)
      INSTALL_RUNTIME=true
      shift
      ;;
    --hooks)
      SHOW_HOOKS=true
      shift
      ;;
    --service)
      INSTALL_SERVICE=true
      shift
      ;;
    --project-local)
      PROJECT_LOCAL=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --list)
      list_all
      exit 0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [ "$INSTALL_ALL" = false ] \
  && [ "$INSTALL_RUNTIME" = false ] \
  && [ "$INSTALL_SERVICE" = false ] \
  && [ "$SHOW_HOOKS" = false ] \
  && [ -z "$PROFILE" ] \
  && [ ${#SELECTED_SKILLS[@]} -eq 0 ] \
  && [ ${#SELECTED_MCP[@]} -eq 0 ] \
  && [ ${#SELECTED_PLUGINS[@]} -eq 0 ] \
  && [ ${#SELECTED_TOOLS[@]} -eq 0 ]; then
  usage
  exit 1
fi

# Profile mode short-circuits the rest of the script — delegate to the CLI
# which knows the canonical install logic from runtime/profiles/profiles.json.
if [ -n "$PROFILE" ]; then
  cli="$TOOLKIT_DIR/runtime/src/cli.mjs"
  if [ ! -f "$cli" ]; then
    echo "ERROR: --profile requires the runtime CLI at $cli"
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: --profile requires Node.js (>=22) on PATH"
    exit 1
  fi
  args=(init --profile "$PROFILE")
  [ "$PROFILE_PLAN" = true ] && args+=(--plan)
  [ "$DRY_RUN" = true ] && args+=(--dry-run)
  echo "Delegating to: node $cli ${args[*]}"
  exec node "$cli" "${args[@]}"
fi

# Determine target directories
if [ "$PROJECT_LOCAL" = true ]; then
  SKILLS_TARGET="$LOCAL_SKILLS"
  PLUGINS_TARGET="$LOCAL_PLUGINS"
  echo "Installing to project-local: ./.claude/"
else
  SKILLS_TARGET="$GLOBAL_SKILLS"
  PLUGINS_TARGET="$GLOBAL_PLUGINS"
  echo "Installing to global: $HOME/.claude/"
fi

# Expand --all to populate every category that has content
if [ "$INSTALL_ALL" = true ]; then
  if [ ${#SELECTED_SKILLS[@]} -eq 0 ]; then
    SELECTED_SKILLS=("${ALL_SKILLS[@]}")
  fi
  # mcp/plugins/tools auto-discover from filesystem (every dir with the marker)
  if [ ${#SELECTED_MCP[@]} -eq 0 ] && [ -d "$MCP_DIR" ]; then
    for entry in "$MCP_DIR"/*/; do
      [ -d "$entry" ] || continue
      [ -f "$entry/README.md" ] || continue
      # Skip the top-level mcp/README.md (the directory README, not a server)
      SELECTED_MCP+=("$(basename "$entry")")
    done
  fi
  if [ ${#SELECTED_PLUGINS[@]} -eq 0 ] && [ -d "$PLUGINS_DIR" ]; then
    for entry in "$PLUGINS_DIR"/*/; do
      [ -d "$entry" ] || continue
      [ -f "$entry/plugin.json" ] || continue
      SELECTED_PLUGINS+=("$(basename "$entry")")
    done
  fi
  if [ ${#SELECTED_TOOLS[@]} -eq 0 ] && [ -d "$TOOLS_DIR" ]; then
    for entry in "$TOOLS_DIR"/*/; do
      [ -d "$entry" ] || continue
      [ -f "$entry/README.md" ] || continue
      SELECTED_TOOLS+=("$(basename "$entry")")
    done
  fi
fi

# Create target directories
if [ "$DRY_RUN" = false ]; then
  [ ${#SELECTED_SKILLS[@]} -gt 0 ] && mkdir -p "$SKILLS_TARGET"
  [ ${#SELECTED_PLUGINS[@]} -gt 0 ] && mkdir -p "$PLUGINS_TARGET"
fi

echo ""
SUCCESS=0
FAILED=0

# Skills
for skill in "${SELECTED_SKILLS[@]}"; do
  [ -z "$skill" ] && continue
  if install_skill "$skill" "$SKILLS_TARGET" "$DRY_RUN"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

# Plugins
for plugin in "${SELECTED_PLUGINS[@]}"; do
  [ -z "$plugin" ] && continue
  if install_plugin "$plugin" "$PLUGINS_TARGET" "$DRY_RUN"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

# MCP servers (print hints, since install paths are user-decision)
for mcp in "${SELECTED_MCP[@]}"; do
  [ -z "$mcp" ] && continue
  if print_mcp_install_hint "$mcp"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

# Tools (print hints)
for tool in "${SELECTED_TOOLS[@]}"; do
  [ -z "$tool" ] && continue
  if print_tool_install_hint "$tool"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

# Runtime
if [ "$INSTALL_RUNTIME" = true ] || [ "$INSTALL_ALL" = true ]; then
  if install_runtime "$DRY_RUN"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
fi

# Hooks (always informational — we never auto-merge settings.json in v0.1)
if [ "$SHOW_HOOKS" = true ] || [ "$INSTALL_ALL" = true ]; then
  print_hook_snippets
fi

# Service (registers watch daemon at login)
if [ "$INSTALL_SERVICE" = true ]; then
  if install_service "$DRY_RUN"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
fi

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. $SUCCESS item(s) would be installed."
else
  echo "Done. $SUCCESS item(s) installed."
fi

if [ $FAILED -gt 0 ]; then
  echo "$FAILED item(s) skipped."
fi
