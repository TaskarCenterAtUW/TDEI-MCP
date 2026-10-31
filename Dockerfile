# TDEI-MCP — single image: node multi-serve children + nginx gateway.
# One `docker build` produces the whole stack (Azure Container Apps friendly:
# a single container with a single public port).
#
# Build: docker build -t tdei-mcp .
# Run:   docker run --rm -p 3000:3000 --env-file .env tdei-mcp
#
# Auth model: session SSO is the default — clients call the `tdei_sso_login`
# tool and complete login in a browser. Per-request Bearer tokens are only
# enforced when TDEI_REQUIRE_BEARER_AUTH=true (or --require-bearer-auth).
#
# Runtime env:
#   PORT            public gateway port (default 3000, matching Azure Container
#                   App ingress). Must not collide with the mcps.json child
#                   ports (default 3001+). The entrypoint regenerates the nginx
#                   listen port at boot.
#   TDEI_MCPS_FILE  multi-server file (default mcps.json, baked from repo).
#                   Mount a custom one; the entrypoint regenerates the nginx
#                   routes from it on every boot (REGENERATE_NGINX=0 to skip).

FROM node:22-bookworm-slim AS build
RUN npm i -g pnpm@12.6.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./tsconfig.json
COPY scripts ./scripts
COPY src ./src
COPY mcps.json ./mcps.json
RUN pnpm build \
  && node scripts/generate-nginx-conf.mjs --file mcps.json --out nginx/nginx.conf --direct

FROM node:22-bookworm-slim
RUN npm i -g pnpm@12.6.0 && apt-get update \
  && apt-get install -y --no-install-recommends nginx \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default \
  && ln -sf /dev/stdout /var/log/nginx/access.log \
  && ln -sf /dev/stderr /var/log/nginx/error.log
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/generate-nginx-conf.mjs ./scripts/generate-nginx-conf.mjs
COPY --from=build /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY mcps.json ./mcps.json
COPY --from=build /app/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/nginx/gateway.html /usr/share/nginx/html/gateway.html
RUN chmod +x scripts/docker-entrypoint.sh
# nginx master runs as root (workers drop to www-data); node children bind
# loopback-only child ports — nginx on $PORT is the single public entrypoint.
ENV PORT=3000 TDEI_TRANSPORT=http
ARG GIT_SHA=unknown
ENV TDEI_MCP_BUILD_SHA=$GIT_SHA
EXPOSE 3000
# Gateway landing page proves nginx is up and serving the generated routes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["bash", "scripts/docker-entrypoint.sh"]
