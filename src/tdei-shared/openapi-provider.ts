import { authManager } from "../auth/auth-manager.js";
import { getConfig } from "../config.js";
import { resolveTdeiServerProfile } from "../intents/server-instructions.js";
import { createOpenApiClient } from "../tdei-user/client.js";

const config = getConfig();

/**
 * The server's OpenAPI client: its backend spec, plus the User Management API for core servers
 * (see createOpenApiClient).
 */
export const openApiMcpClient = createOpenApiClient({
  config,
  profile: resolveTdeiServerProfile({
    name: process.env.TDEI_MCP_NAME,
    explicit: process.env.TDEI_MCP_PROFILE,
    apiUrl: config.apiUrl,
  }),
  headersProvider: async () => ({
    Authorization: `Bearer ${await authManager.getAccessToken()}`,
  }),
});
