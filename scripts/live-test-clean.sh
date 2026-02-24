#!/usr/bin/env bash
# ============================================================================
# live-test-clean.sh — Clean up OMG state for live testing.
#
# Usage:
#   ./scripts/live-test-clean.sh          # Clean both workspaces
#   ./scripts/live-test-clean.sh --dry    # Show what would be deleted
#
# Removes:
#   - memory/omg/ from Secretary and TechLead workspaces
#   - .omg-state/ from both workspaces
#   - Temp files from previous test runs
#
# Does NOT remove:
#   - memory/*.md source files
#   - ~/.openclaw/memory/*.sqlite databases
#   - openclaw.json config
# ============================================================================

set -euo pipefail

SECRETARY="/Users/szymonpaluch/Projects/Personal/Secretary"
TECHLEAD="/Users/szymonpaluch/Projects/Personal/TechLead"

DRY_RUN=false
if [[ "${1:-}" == "--dry" ]]; then
  DRY_RUN=true
  echo "[dry-run] Would delete:"
fi

clean_dir() {
  local dir="$1"
  local label="$2"
  if [[ -d "$dir" ]]; then
    if $DRY_RUN; then
      echo "  rm -rf $dir"
      echo "    $(find "$dir" -type f | wc -l | tr -d ' ') files, $(du -sh "$dir" | cut -f1) total"
    else
      echo "[clean] Removing $label: $dir"
      rm -rf "$dir"
      echo "[clean] Done."
    fi
  else
    echo "[skip] $label does not exist: $dir"
  fi
}

echo "=== OMG Live Test Cleanup ==="
echo ""

# Secretary workspace
clean_dir "$SECRETARY/memory/omg" "Secretary memory/omg"
clean_dir "$SECRETARY/.omg-state" "Secretary .omg-state"

# TechLead workspace
clean_dir "$TECHLEAD/memory/omg" "TechLead memory/omg"
clean_dir "$TECHLEAD/.omg-state" "TechLead .omg-state"

# Temp files
clean_dir "/tmp/omg-live-test-baseline.json" "baseline snapshot"

echo ""
if $DRY_RUN; then
  echo "[dry-run] No files were deleted. Re-run without --dry to delete."
else
  echo "=== Cleanup complete ==="
fi
