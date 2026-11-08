// Import this first: it points the config at a workspace-style backend before
// any module reads the config singleton (ESM evaluates imports in order).
export const WORKSPACE_SPEC_URL = "https://ws.example.test/openapi.json";
export const WORKSPACE_SPEC = {
  openapi: "3.0.0",
  info: { title: "ws", version: "1" },
  paths: {
    "/api/v1/workspaces/mine": {
      get: {
        operationId: "get_my_workspaces",
        summary: "List my workspaces",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

process.env.TDEI_API_URL = "https://ws.example.test";
process.env.TDEI_SPEC_URL = WORKSPACE_SPEC_URL;
process.env.TDEI_AUTH_API_URL = "https://api-dev.tdei.us";
