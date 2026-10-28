# TDEI-MCP — Streamable HTTP server (session-SSO by default).
# Serves MCP over Streamable HTTP exclusively (no STDIO in the container).
#
# Build: docker build -t tdei-mcp:http .
# Run:   docker run --rm -p 3000:3000 --env-file .env tdei-mcp:http
#
# Auth model: session SSO is the default — clients call the `tdei_sso_login`
# tool and complete login in a browser. Per-request Bearer tokens are only
# enforced when TDEI_REQUIRE_BEARER_AUTH=true (or --require-bearer-auth).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./tsconfig.json
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Downloads and optional local config resolve under the working directory,
# so it must stay writable by the runtime user.
RUN chown -R node:node /app
USER node
ENV TDEI_TRANSPORT=http TDEI_HTTP_HOST=0.0.0.0 TDEI_HTTP_PORT=3000
EXPOSE 3000
# The setup overview is unauthenticated and exercises the HTTP stack,
# so it doubles as a readiness probe (honours custom port/base-path).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.TDEI_HTTP_PORT || '3000') + (process.env.TDEI_HTTP_BASE_PATH || '/mcp') + '/setup').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
