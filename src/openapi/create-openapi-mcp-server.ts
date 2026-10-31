import { McpServer } from "@modelcontextprotocol/server";

import { defaultOperationName, OpenApiMcpClient, type OpenApiMcpClientOptions } from "./openapi-mcp-client.js";
import {
  registerOpenApiTools,
  type OpenApiToolCall,
  type OpenApiToolRegistrationResult,
  type RegisterOpenApiToolsOptions,
} from "./register-openapi-tools.js";

export interface OpenApiMcpServerContext {
  server: McpServer;
  provider: OpenApiMcpClient;
  registration: OpenApiToolRegistrationResult;
}

export interface OpenApiMcpServerOptions extends Omit<OpenApiMcpClientOptions, "operationName"> {
  name: string;
  version: string;
  toolPrefix?: string;
  hiddenOperations?: ReadonlySet<string>;
  includeOperations?: ReadonlySet<string>;
  excludeOperations?: ReadonlySet<string>;
  executeOperation?: (
    name: string,
    input: Record<string, unknown>,
    next: OpenApiToolCall,
  ) => ReturnType<OpenApiToolCall>;
  mapResult?: RegisterOpenApiToolsOptions["mapResult"];
  mapError?: RegisterOpenApiToolsOptions["mapError"];
  configure?: (context: OpenApiMcpServerContext) => void | Promise<void>;
}

export async function createOpenApiMcpServer(options: OpenApiMcpServerOptions): Promise<OpenApiMcpServerContext> {
  const prefix = options.toolPrefix ? defaultOperationName(options.toolPrefix) : "";
  const provider = new OpenApiMcpClient({
    apiUrl: options.apiUrl,
    ...(options.specUrl ? { specUrl: options.specUrl } : {}),
    ...(options.headersProvider ? { headersProvider: options.headersProvider } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.loadSpec ? { loadSpec: options.loadSpec } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.allowLocalFileUploads !== undefined ? { allowLocalFileUploads: options.allowLocalFileUploads } : {}),
    operationName: (operationId) => `${prefix}${defaultOperationName(operationId)}`,
  });
  const server = new McpServer({ name: options.name, version: options.version });
  const call: OpenApiToolCall = (name, input) => provider.callTool(name, input);
  const onCall: OpenApiToolCall | undefined = options.executeOperation
    ? (name, input) => options.executeOperation!(name, input, call)
    : undefined;
  const registration = await registerOpenApiTools(server, provider, {
    ...(options.hiddenOperations ? { hiddenOperations: options.hiddenOperations } : {}),
    isAllowed: (name) =>
      (!options.includeOperations || options.includeOperations.has(name)) &&
      (!options.excludeOperations || !options.excludeOperations.has(name)),
    ...(onCall ? { onCall } : {}),
    ...(options.mapResult ? { mapResult: options.mapResult } : {}),
    ...(options.mapError ? { mapError: options.mapError } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const context = { server, provider, registration };
  await options.configure?.(context);
  return context;
}
