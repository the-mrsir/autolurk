#!/bin/sh
# Lets the AutoLurk dashboard's Update now reach the updater on this computer.
# Run once per user: sh updater/install-linux.sh
# Moving the AutoLurk folder means running it again.
set -e

HOST_NAME="com.autolurk.updater"
EXTENSION_ID="lofaafmcmpeoaflmfjainbofphpooboa"
HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="$HERE/autolurk-updater.py"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

command -v python3 >/dev/null 2>&1 || { echo "python3 is required."; exit 1; }
chmod +x "$HOST"

for browser in BraveSoftware/Brave-Browser google-chrome chromium; do
  dir="$CONFIG/$browser/NativeMessagingHosts"
  mkdir -p "$dir"
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Updates the AutoLurk Companion folder from GitHub",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
done

echo "AutoLurk updater is set up for $(dirname "$HERE")."
echo "Open the AutoLurk dashboard and click Update now."
