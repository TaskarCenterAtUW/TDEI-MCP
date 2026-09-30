# TDEI-MCP — Streamable HTTP (stateless) server.
# Serves MCP over Streamable HTTP exclusively (no STDIO in the container).
# Run: docker build -t tdei-mcp:http . && docker run --rm -p 3000:3000 --env-file .env tdei-mcp:http
# Every request must carry `Authorization: Bearer <TDEI access token>`.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV TDEI_TRANSPORT=http TDEI_HTTP_HOST=0.0.0.0 TDEI_HTTP_PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
