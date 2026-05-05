#!/usr/bin/env bash
set -euo pipefail

TOOLKIT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$TOOLKIT_DIR/skills"
GLOBAL_TARGET="$HOME/.claude/skills"
LOCAL_TARGET=".agents/skills"

ALL_SKILLS=(
  diagnose-fetch-failure
  graphify
  qmd
  seed-data
  review-slice
  merge-feature-branch
  security-audit
  production-readiness
  optimization-audit
  dead-code-review
  docs-sync-audit
)

usage() {
  cat <<EOF
Claude Code Toolkit — Skill Installer

Usage:
  ./setup.sh --all                              Install all skills globally
  ./setup.sh --skills name1,name2               Install specific skills globally
  ./setup.sh --skills name1 --project-local     Install to current project (.agents/skills/)
  ./setup.sh --list                             List available skills
  ./setup.sh --dry-run --all                    Show what would be installed

Options:
  --all             Install all skills
  --skills NAME     Comma-separated list of skill names
  --project-local   Install to .agents/skills/ instead of ~/.claude/skills/
  --dry-run         Show what would happen without making changes
  --list            List available skills and exit
  --help            Show this help
EOF
}

list_skills() {
  echo "Available skills:"
  echo ""
  for skill in "${ALL_SKILLS[@]}"; do
    if [ -f "$SKILLS_DIR/$skill/SKILL.md" ]; then
      desc=$(grep "^description:" "$SKILLS_DIR/$skill/SKILL.md" | head -1 | sed 's/^description: //')
      printf "  %-25s %s\n" "$skill" "$desc"
    fi
  done
  echo ""
  echo "Install with: ./setup.sh --skills name1,name2"
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
    echo "  WOULD INSTALL: $name -> $dst"
    return 0
  fi

  mkdir -p "$dst"
  cp -r "$src"/* "$dst/"
  echo "  INSTALLED: $name -> $dst"
}

# Parse arguments
INSTALL_ALL=false
SELECTED_SKILLS=()
PROJECT_LOCAL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      INSTALL_ALL=true
      shift
      ;;
    --skills)
      IFS=',' read -ra SELECTED_SKILLS <<< "$2"
      shift 2
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
      list_skills
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

if [ "$INSTALL_ALL" = false ] && [ ${#SELECTED_SKILLS[@]} -eq 0 ]; then
  usage
  exit 1
fi

# Determine target directory
if [ "$PROJECT_LOCAL" = true ]; then
  TARGET="$LOCAL_TARGET"
  echo "Installing to project-local: $TARGET/"
else
  TARGET="$GLOBAL_TARGET"
  echo "Installing to global: $TARGET/"
fi

# Create target directory
if [ "$DRY_RUN" = false ]; then
  mkdir -p "$TARGET"
fi

# Install skills
if [ "$INSTALL_ALL" = true ]; then
  SELECTED_SKILLS=("${ALL_SKILLS[@]}")
fi

echo ""
SUCCESS=0
FAILED=0

for skill in "${SELECTED_SKILLS[@]}"; do
  if install_skill "$skill" "$TARGET" "$DRY_RUN"; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete. $SUCCESS skill(s) would be installed."
else
  echo "Done. $SUCCESS skill(s) installed."
fi

if [ $FAILED -gt 0 ]; then
  echo "$FAILED skill(s) skipped."
fi
