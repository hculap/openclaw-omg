#!/usr/bin/env bash
# ============================================================================
# live-test-enable-plugin.sh — Enable the OMG plugin in openclaw.json.
#
# Usage:
#   ./scripts/live-test-enable-plugin.sh          # Enable
#   ./scripts/live-test-enable-plugin.sh --disable # Disable (rollback)
#
# Modifies: ~/.openclaw/openclaw.json (plugins.entries.omg.enabled)
# Creates a backup at ~/.openclaw/openclaw.json.bak before any change.
# ============================================================================

set -euo pipefail

CONFIG="$HOME/.openclaw/openclaw.json"
BACKUP="$HOME/.openclaw/openclaw.json.bak"

if [[ ! -f "$CONFIG" ]]; then
  echo "[error] Config not found: $CONFIG"
  exit 1
fi

# Create backup
cp "$CONFIG" "$BACKUP"
echo "[backup] Saved to $BACKUP"

if [[ "${1:-}" == "--disable" ]]; then
  # Disable plugin
  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$CONFIG', 'r') as f:
    config = json.load(f)
config['plugins']['entries']['omg']['enabled'] = False
with open('$CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
print('[config] OMG plugin disabled')
"
  else
    # Fallback: sed (less safe but works)
    sed -i.tmp 's/"omg":\s*{[^}]*"enabled":\s*true/"omg": {"enabled": false/g' "$CONFIG"
    rm -f "${CONFIG}.tmp"
    echo "[config] OMG plugin disabled (sed fallback)"
  fi
else
  # Enable plugin
  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$CONFIG', 'r') as f:
    config = json.load(f)
config['plugins']['entries']['omg']['enabled'] = True
with open('$CONFIG', 'w') as f:
    json.dump(config, f, indent=2)
print('[config] OMG plugin enabled')
"
  else
    sed -i.tmp 's/"omg":\s*{[^}]*"enabled":\s*false/"omg": {"enabled": true/g' "$CONFIG"
    rm -f "${CONFIG}.tmp"
    echo "[config] OMG plugin enabled (sed fallback)"
  fi
fi

echo ""
echo "Current OMG plugin status:"
python3 -c "
import json
with open('$CONFIG') as f:
    config = json.load(f)
omg = config.get('plugins', {}).get('entries', {}).get('omg', {})
print(f'  enabled: {omg.get(\"enabled\", \"not found\")}')
print(f'  config: {json.dumps(omg.get(\"config\", {}), indent=4)}')
" 2>/dev/null || echo "  (python3 not available for pretty print)"

echo ""
echo "[next] Restart the gateway for changes to take effect."
