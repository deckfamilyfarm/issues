#!/bin/sh
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PM2_APP_NAME="issues"
PM2_ECOSYSTEM="$ROOT_DIR/ecosystem.config.cjs"

cd "$ROOT_DIR"

pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
pm2 start "$PM2_ECOSYSTEM" --only "$PM2_APP_NAME" --update-env
