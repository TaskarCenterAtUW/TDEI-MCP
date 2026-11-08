import type { ResolvedConfig } from "../config.js";
import { OpenApiMcpClient } from "../openapi/openapi-mcp-client.js";
import type { TdeiServerProfile } from "../intents/server-instructions.js";
import { CompositeOpenApiClient, type OpenApiClientLike } from "./composite-client.js";
import { userOperationName } from "./operation-names.js";

interface ClientInputs {
  config: Pick<ResolvedConfig, "apiUrl" | "specUrl" | "userApiUrl" | "userSpecUrl">;
  profile: TdeiServerProfile;
  headersProvider: () => Promise<HeadersInit>;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * The OpenAPI client for a server: the backend's own spec, plus (core profile only) the User Management API
 * when configured. Workspace servers never load it.
 */
export function createOpenApiClient({ config, profile, headersProvider, fetchImpl }: ClientInputs): OpenApiClientLike {
  const primary = new OpenApiMcpClient({
    apiUrl: config.apiUrl,
    specUrl: config.specUrl,
    headersProvider,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (profile !== "core" || !config.userApiUrl || !config.userSpecUrl) return primary;
  const user = new OpenApiMcpClient({
    apiUrl: config.userApiUrl,
    specUrl: config.userSpecUrl,
    headersProvider,
    operationName: userOperationName,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return new CompositeOpenApiClient(primary, user);
}
