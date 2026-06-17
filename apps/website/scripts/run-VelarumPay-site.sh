#!/bin/bash
set -euo pipefail

APP_DIR="/Users/yang/code/VelarumPayCode/apps/website"
ENV_FILE="$APP_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT="${PORT:-8091}"

cd "$APP_DIR"
exec /opt/homebrew/opt/node@24/bin/node server.mjs
