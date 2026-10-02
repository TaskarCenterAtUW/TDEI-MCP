import { McpServer } from "@modelcontextprotocol/server";

import { HttpTdeiOperations } from "./adapters/http-tdei-operations.js";
import { registerSemanticTools } from "./intents/register-tools.js";
import { SemanticIntentModule } from "./intents/semantic-intent-module.js";
import type { PlaceResolver } from "./intents/place-resolver.js";

export interface HttpSemanticServerOptions {
  accessToken: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
  places?: PlaceResolver;
}

export function createHttpSemanticServer(
  options: HttpSemanticServerOptions,
): McpServer {
  const server = new McpServer({
    name: "tdei-mcp",
    version: "0.1.0",
  });
  const module = new SemanticIntentModule({
    operations: new HttpTdeiOperations(options.apiUrl, options.fetchImpl),
    places: options.places ?? {
      async forwardGeocode() { return []; },
    },
  });
  registerSemanticTools(
    server,
    module,
    () => ({ accessToken: options.accessToken }),
  );
  return server;
}
