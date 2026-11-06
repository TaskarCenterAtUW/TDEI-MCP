#!/usr/bin/env bash
# Localsingle-image gateway lifecycle (no compose file).
# Usage:
#   ./scripts/deploy-docker.sh up    # build image, (re)start detached container
#   ./scripts/deploy-docker.sh down  # stop and remove the container
# Or via pnpm: pnpm deploy:docker / pnpm deploy:docker:down
# Env: PORT (default 3000), TDEI_IMAGE (default tdei-mcp), TDEI_CONTAINER (default tdei-mcp).
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${TDEI_IMAGE:-tdei-mcp}"
CONTAINER="${TDEI_CONTAINER:-tdei-mcp}"
PORT="${PORT:-3000}"

cmd="${1:-up}"

if [ "$cmd" = "down" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "stopped $CONTAINER"
  exit 0
fi

if [ "$cmd" != "up" ]; then
  echo "usage: gateway-local.sh [up|down]" >&2
  exit 1
fi

# The commit sha becomes part of the MCP serverInfo.version (x.y.z+sha), which
# is how clients notice a new deploy.
docker build --build-arg GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)" -t "$IMAGE" .

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# Sign-in codes and the login cookie are protected by TDEI_OAUTH_SECRET. It must
# stay the same across restarts (and across replicas), so generate it once and
# keep it in .env, which is git-ignored and never copied into the image.
if [ -z "${TDEI_OAUTH_SECRET:-}" ] && ! grep -qs '^TDEI_OAUTH_SECRET=' .env; then
  printf '\nTDEI_OAUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
  echo "generated TDEI_OAUTH_SECRET in .env (reused on every restart)"
fi

ENV_FILE_ARGS=()
if [ -f .env ]; then
  ENV_FILE_ARGS+=(--env-file .env)
fi

# Mounted mcps.json is picked up on restart — the entrypoint regenerates the
# nginx routes from it on every boot.
docker run -d --name "$CONTAINER" \
  -p "${PORT}:${PORT}" \
  -e "PORT=${PORT}" \
  ${TDEI_OAUTH_SECRET:+-e TDEI_OAUTH_SECRET} \
  "${ENV_FILE_ARGS[@]}" \
  -v "$PWD/mcps.json:/app/mcps.json:ro" \
  "$IMAGE"

echo "gateway up: http://127.0.0.1:${PORT}/ (logs: docker logs -f $CONTAINER)"
