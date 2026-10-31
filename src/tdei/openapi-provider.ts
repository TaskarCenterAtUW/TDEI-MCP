import { authManager } from "../auth/auth-manager.js";
import { getConfig } from "../config.js";
import { OpenApiMcpClient } from "../openapi/openapi-mcp-client.js";

const config = getConfig();

export const openApiMcpClient = new OpenApiMcpClient({
  apiUrl: config.apiUrl,
  specUrl: config.specUrl,
  headersProvider: async () => ({
    Authorization: `Bearer ${await authManager.getAccessToken()}`,
  }),
  allowLocalFileUploads: false,
});
