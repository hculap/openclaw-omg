#!/usr/bin/env bash
# ============================================================================
# live-test-clean.sh — Clean up OMG state for live testing.
#
# SAFETY GUARDS (Fix #3):
#   - Requires OPENCLAW_LIVE=1
#   - Requires LIVE_CONFIRM=DELETE
#   - Refuses to delete /, $HOME, or empty paths
#   - Validates workspace paths match expected patterns
#   - set -euo pipefail
#
# Usage:
#   OPENCLAW_LIVE=1 LIVE_CONFIRM=DELETE ./scripts/live-test-clean.sh
#   OPENCLAW_LIVE=1 ./scripts/live-test-clean.sh --dry    # Show what would be deleted
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

# ---- Safety gate: OPENCLAW_LIVE ----
if [[ "${OPENCLAW_LIVE:-}" != "1" ]]; then
  echo "[error] OPENCLAW_LIVE=1 is required."
  echo "  Usage: OPENCLAW_LIVE=1 LIVE_CONFIRM=DELETE $0"
  exit 1
fi

# ---- Dry run mode ----
DRY_RUN=false
if [[ "${1:-}" == "--dry" ]]; then
  DRY_RUN=true
  echo "[dry-run] Would delete:"
fi

# ---- Safety gate: LIVE_CONFIRM ----
if ! $DRY_RUN && [[ "${LIVE_CONFIRM:-}" != "DELETE" ]]; then
  echo "[error] LIVE_CONFIRM=DELETE is required for destructive operations."
  echo "  Usage: OPENCLAW_LIVE=1 LIVE_CONFIRM=DELETE $0"
  echo "  Or preview first: OPENCLAW_LIVE=1 $0 --dry"
  exit 1
fi

# ---- Path safety validation ----
validate_path() {
  local dir="$1"
  local label="$2"

  # Refuse empty paths
  if [[ -z "$dir" ]]; then
    echo "[error] Empty path for $label — aborting"
    exit 1
  fi

  # Refuse root
  if [[ "$dir" == "/" ]]; then
    echo "[error] Refusing to delete / for $label — aborting"
    exit 1
  fi

  # Refuse $HOME directly
  if [[ "$dir" == "$HOME" || "$dir" == "$HOME/" ]]; then
    echo "[error] Refusing to delete \$HOME for $label — aborting"
    exit 1
  fi

  # Must contain /Projects/Personal/ (expected workspace pattern)
  if [[ "$dir" != *"/Projects/Personal/"* && "$dir" != "/tmp/"* ]]; then
    echo "[error] Path does not match safe pattern (/Projects/Personal/ or /tmp/): $dir"
    echo "  This script only cleans known workspace paths."
    exit 1
  fi
}

clean_dir() {
  local dir="$1"
  local label="$2"

  validate_path "$dir" "$label"

  if [[ -d "$dir" ]]; then
    if $DRY_RUN; then
      local file_count
      file_count=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d ' ')
      local dir_size
      dir_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  rm -rf $dir"
      echo "    ${file_count} files, ${dir_size} total"
    else
      echo "[clean] Removing $label: $dir"
      rm -rf "$dir"
      echo "[clean] Done."
    fi
  elif [[ -f "$dir" ]]; then
    if $DRY_RUN; then
      echo "  rm $dir (file)"
    else
      echo "[clean] Removing $label: $dir"
      rm -f "$dir"
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
  echo "  OPENCLAW_LIVE=1 LIVE_CONFIRM=DELETE $0"
else
  echo "=== Cleanup complete ==="
fi
