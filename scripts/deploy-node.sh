#!/usr/bin/env bash
# Host-local gateway: node MCP children + local nginx, no Docker.
# One command starts everything declared in mcps.json behind an nginx
# path-based reverse proxy on $PORT.
#
# Usage:
#   npm run deploy:node
#   PORT=4000 npm run deploy:node
#   TDEI_MCPS_FILE=my-mcps.json npm run deploy:node
#
# Requires: nginx binary (brew install nginx / sudo apt install nginx), node 22+.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
FILE="${TDEI_MCPS_FILE:-mcps.json}"
PREFIX="$PWD/.gateway"

command -v nginx >/dev/null 2>&1 || {
  echo "error: nginx not found." >&2
  echo "  macOS:  brew install nginx" >&2
  echo "  Debian/Ubuntu: sudo apt install nginx" >&2
  exit 1
}

if [ ! -f "$FILE" ]; then
  echo "error: $FILE not found. Copy the example first:" >&2
  echo "  cp mcps.example.json mcps.json" >&2
  exit 1
fi

# Build first so dist/ matches src/ (skipped if already built and fresh).
if [ ! -f dist/multi-serve.js ] || [ src/multi-serve.ts -nt dist/multi-serve.js ]; then
  echo "building..."
  npm run build
fi

mkdir -p "$PREFIX/html" "$PREFIX/logs"

node scripts/generate-nginx-conf.mjs --file "$FILE" \
  --out "$PREFIX/nginx.conf" --html-out "$PREFIX/html/gateway.html" \
  --root "$PREFIX/html" --direct --standalone --listen "$PORT"

nginx -p "$PREFIX" -c nginx.conf -t

# Children bind loopback only — nginx on $PORT is the single public entrypoint.
node dist/multi-serve.js --file "$FILE" --host 127.0.0.1 &
MULTI_PID=$!

shutdown() {
  echo "shutting down..."
  kill -TERM "$MULTI_PID" 2>/dev/null || true
  nginx -p "$PREFIX" -c nginx.conf -s quit 2>/dev/null || true
  wait "$MULTI_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

nginx -p "$PREFIX" -c nginx.conf

echo "gateway up: http://127.0.0.1:${PORT}/ (Ctrl+C to stop)"
wait "$MULTI_PID"
STATUS=$?
echo "node children exited (status=${STATUS}) — stopping nginx" >&2
nginx -p "$PREFIX" -c nginx.conf -s quit 2>/dev/null || true
exit "$STATUS"
