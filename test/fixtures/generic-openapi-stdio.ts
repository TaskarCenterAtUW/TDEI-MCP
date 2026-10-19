import { serveOpenApiStdio } from "../../src/openapi/index.js";

await serveOpenApiStdio({
  name: "pet-api-mcp",
  version: "1.0.0",
  apiUrl: "https://pets.example.test",
  loadSpec: async () => ({
    openapi: "3.0.1",
    paths: {
      "/pets/{pet_id}": {
        get: {
          operationId: "get-pet",
          parameters: [{
            name: "pet_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  }),
  headersProvider: async () => ({ "X-API-Key": "stdio-secret" }),
  fetchImpl: async (input, init) => {
    const request = new Request(input, init);
    return Response.json({
      path: new URL(request.url).pathname,
      apiKey: request.headers.get("X-API-Key"),
    });
  },
});
