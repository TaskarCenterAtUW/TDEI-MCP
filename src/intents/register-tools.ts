import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { formatError, truncateText } from "../mcp/errors.js";
import { SEMANTIC_TOOL_DESCRIPTIONS } from "./descriptions.js";
import { resolveUserIntent } from "./intent-resolver.js";
import type { SemanticIntentModule } from "./semantic-intent-module.js";
import type { RequestContext } from "./types.js";

export type RequestContextProvider = () => RequestContext;

const registeredToolsByServer = new WeakMap<McpServer, Set<string>>();

const findDatasetsSchema = z.object({
  place: z.string().trim().min(1).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
  status: z.enum(["All", "Publish", "Pre-Release"]).optional(),
  projectGroupId: z.string().trim().min(1).optional(),
  latest: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const resolveIntentSchema = z.object({
  request: z.string().trim().min(1),
});

const listServicesSchema = z.object({
  searchText: z.string().trim().min(1).optional(),
  projectGroupId: z.string().trim().min(1).optional(),
  serviceType: z.enum(["all", "osw", "flex", "pathways"]).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
});

const listProjectGroupsSchema = z.object({
  searchText: z.string().trim().min(1).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
});

const assetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local_path"),
    path: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("inline_base64"),
    name: z.string().trim().min(1),
    mediaType: z.string().trim().min(1),
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal("object_ref"),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }),
]);

const metadataSchema = z.object({
  dataset_detail: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    collected_by: z.string().optional(),
    collection_date: z.string().optional(),
    data_source: z.enum(["3rdParty", "TDEITools", "InHouse"]).optional(),
    schema_version: z.string().optional(),
  }).catchall(z.unknown()).optional(),
}).catchall(z.unknown());

const validateDatasetSchema = z.object({
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
  asset: assetSchema.optional(),
});

const uploadDatasetSchema = z.object({
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
  asset: assetSchema.optional(),
  projectGroupId: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional(),
  derivedFromDatasetId: z.string().trim().min(1).optional(),
  changeset: assetSchema.optional(),
  metadata: metadataSchema.optional(),
});

function jsonIntentResult(data: unknown) {
  const { text } = truncateText(JSON.stringify(data, null, 2));
  return { content: [{ type: "text" as const, text }] };
}

export function registerSemanticTools(
  server: McpServer,
  module: SemanticIntentModule,
  contextProvider: RequestContextProvider = () => ({}),
): void {
  let registered = registeredToolsByServer.get(server);
  if (!registered) {
    registered = new Set<string>();
    registeredToolsByServer.set(server, registered);
  }

  const register = (
    name: string,
    definition: Parameters<McpServer["registerTool"]>[1],
    handler: Parameters<McpServer["registerTool"]>[2],
  ) => {
    if (registered.has(name)) return;
    server.registerTool(name, definition, handler);
    registered.add(name);
  };

  register(
    "tdei_resolve_intent",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.resolveIntent,
      inputSchema: resolveIntentSchema.shape,
    },
    async (args) => jsonIntentResult(resolveUserIntent(String(args.request))),
  );

  register(
    "tdei_find_datasets",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.findDatasets,
      inputSchema: findDatasetsSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.findDatasets(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_list_my_project_groups",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.listMyProjectGroups,
      inputSchema: listProjectGroupsSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.listMyProjectGroups(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_list_services",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.listServices,
      inputSchema: listServicesSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.listServices(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_validate_dataset",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.validateDataset,
      inputSchema: validateDatasetSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.validateDataset(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_upload_dataset",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.uploadDataset,
      inputSchema: uploadDatasetSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.uploadDataset(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );
}
