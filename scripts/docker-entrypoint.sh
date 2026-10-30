#!/bin/bash
# Single-image entrypoint: run the MCP children (node multi-serve) and the
# nginx gateway side by side in one container (Azure Container Apps friendly).
#
# Env:
#   PORT            public gateway port (default 3000). Must not collide with
#                   the mcps.json child ports (default 3001+).
#   TDEI_MCPS_FILE  multi-server file (default mcps.json).
set -euo pipefail

GATEWAY_PORT="${PORT:-3000}"
MCPS_FILE="${TDEI_MCPS_FILE:-mcps.json}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/default.conf}"
GATEWAY_HTML="${GATEWAY_HTML:-/usr/share/nginx/html/gateway.html}"

# Regenerate the gateway config from the effective mcps.json on every boot so
# a mounted mcps.json stays in sync with nginx routes (single-container
# upstreams on 127.0.0.1 — no Docker-DNS resolver). Set REGENERATE_NGINX=0 to
# keep a hand-mounted nginx conf instead.
if [ "${REGENERATE_NGINX:-1}" = "1" ]; then
  node scripts/generate-nginx-conf.mjs --file "$MCPS_FILE" --out "$NGINX_CONF" \
    --html-out "$GATEWAY_HTML" --direct --listen "$GATEWAY_PORT"
  echo "[entrypoint] nginx listening on ${GATEWAY_PORT}"
fi

nginx -t

# Children bind loopback only — nginx is the single public entrypoint.
node dist/multi-serve.js --file "$MCPS_FILE" --host 127.0.0.1 &
MULTI_PID=$!

shutdown() {
  echo "[entrypoint] shutting down"
  kill -TERM "$MULTI_PID" 2>/dev/null || true
  nginx -s quit 2>/dev/null || true
  wait "$MULTI_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# nginx stays foreground (PID 1 supervisor); multi-serve exiting means the
# container has lost its backends, so tear everything down loudly instead of
# serving 502s forever.
nginx -g "daemon off;" &
NGINX_PID=$!

wait -n "$MULTI_PID" "$NGINX_PID"
STATUS=$?
echo "[entrypoint] a supervised process exited (status=${STATUS}) — stopping container" >&2
kill -TERM "$MULTI_PID" 2>/dev/null || true
nginx -s quit 2>/dev/null || true
exit "$STATUS"
