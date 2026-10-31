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
  tdeiDatasetId: z.string().trim().min(1).optional(),
  uploadedAfter: z.string().trim().min(1).optional(),
  uploadedWithinDays: z.number().min(0).optional(),
  latest: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const listJobsSchema = z.object({
  jobId: z.string().trim().min(1).optional(),
  projectGroupId: z.string().trim().min(1).optional(),
  includeGroupJobs: z.boolean().optional(),
  jobType: z.string().trim().min(1).optional(),
  status: z.enum(["COMPLETED", "FAILED", "IN-PROGRESS", "ABANDONED"]).optional(),
  createdAfter: z.string().trim().min(1).optional(),
  createdWithinDays: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const getDatasetDetailsSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1),
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
});

const downloadDatasetSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
  outputDir: z.string().trim().min(1).optional(),
  filename: z.string().trim().min(1).optional(),
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
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Absolute file path on the CLIENT machine running the agent (never on the MCP server); used only to build a client-side curl command.",
      ),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("inline_base64"),
    name: z.string().trim().min(1),
    mediaType: z.string().trim().min(1),
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal("object_ref"),
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }),
]);

const metadataSchema = z
  .object({
    dataset_detail: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
        collected_by: z.string().optional(),
        collection_date: z.string().optional(),
        data_source: z.enum(["3rdParty", "TDEITools", "InHouse"]).optional(),
        schema_version: z.string().optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

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

const publishDatasetSchema = z.object({
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
  tdeiDatasetId: z.string().trim().min(1).optional(),
});

const confirmSchema = z.object({
  confirm: z.boolean().optional(),
});

const deleteDatasetSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  confirm: z.boolean().optional(),
});

const cloneDatasetSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  projectGroupId: z.string().trim().min(1).optional(),
  serviceId: z.string().trim().min(1).optional(),
  metadata: metadataSchema.optional(),
  confirm: z.boolean().optional(),
});

const editMetadataSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  metadata: metadataSchema.optional(),
  confirm: z.boolean().optional(),
});

const confidenceSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  subRegionAsset: assetSchema.optional(),
});

const qualityIntersectionSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  polygonAsset: assetSchema.optional(),
});

const qualityTagSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  tagQualityAsset: assetSchema.optional(),
});

const sanitizeSchema = z.object({
  asset: assetSchema.optional(),
});

const convertOswSchema = z.object({
  asset: assetSchema.optional(),
  sourceFormat: z.enum(["osm", "osw"]).optional(),
  targetFormat: z.enum(["osm", "osw"]).optional(),
});

const convertPathwaysSchema = z.object({
  datasetAsset: assetSchema.optional(),
  arcgisUrl: z.string().trim().min(1).optional(),
  layers: z.string().trim().min(1).optional(),
  crs: z.string().trim().min(1).optional(),
});

const selfMergeSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  proximity: z.number().positive().optional(),
});

const spatialJoinSchema = z.object({
  targetDatasetId: z.string().trim().min(1).optional(),
  targetDimension: z.enum(["edge", "node", "zone"]).optional(),
  sourceDatasetId: z.string().trim().min(1).optional(),
  sourceDimension: z.string().trim().min(1).optional(),
  joinCondition: z.string().trim().min(1).optional(),
});

const unionSchema = z.object({
  tdeiDatasetIdOne: z.string().trim().min(1).optional(),
  tdeiDatasetIdTwo: z.string().trim().min(1).optional(),
  proximity: z.number().positive().optional(),
  confirm: z.boolean().optional(),
});

const cutBboxSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  fileType: z.enum(["osw", "osm"]).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

const tagRoadSchema = z.object({
  sourceDatasetId: z.string().trim().min(1).optional(),
  targetDatasetId: z.string().trim().min(1).optional(),
});

const feedbackListSchema = z.object({
  projectGroupId: z.string().trim().min(1).optional(),
  tdeiDatasetId: z.string().trim().min(1).optional(),
  fromDate: z.string().trim().min(1).optional(),
  toDate: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const feedbackSummarySchema = z.object({
  projectGroupId: z.string().trim().min(1).optional(),
});

const feedbackDownloadSchema = z.object({
  projectGroupId: z.string().trim().min(1).optional(),
  tdeiDatasetId: z.string().trim().min(1).optional(),
  format: z.string().trim().min(1).optional(),
  fromDate: z.string().trim().min(1).optional(),
  toDate: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
});

const feedbackSubmitSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  tdeiDatasetId: z.string().trim().min(1).optional(),
  datasetElementId: z.string().trim().min(1).optional(),
  feedbackText: z.string().trim().min(1).optional(),
  customerEmail: z.string().trim().min(1).optional(),
  locationLatitude: z.number().optional(),
  locationLongitude: z.number().optional(),
});

const feedbackStatusSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  tdeiDatasetId: z.string().trim().min(1).optional(),
  updates: z
    .array(
      z.object({
        id: z.number().int(),
        status: z.enum(["open", "resolved"]),
        resolutionStatus: z.enum(["fixed", "wont_fix", "not_an_issue"]).optional(),
        resolutionDescription: z.string().trim().min(1).optional(),
      }),
    )
    .optional(),
});

const viewerAccessSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  allowViewerAccess: z.boolean().optional(),
});

const metricsSchema = z.object({
  scope: z.enum(["data", "service", "system"]).optional(),
  projectGroupId: z.string().trim().min(1).optional(),
});

const versionsSchema = z.object({
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
});

const emailSchema = z.object({
  email: z.string().trim().min(1).optional(),
});

const regenerateApiKeySchema = z.object({
  confirm: z.boolean().optional(),
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

  register(
    "tdei_get_my_identity",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.getMyIdentity,
      inputSchema: {},
    },
    async () => {
      try {
        return jsonIntentResult(await module.getMyIdentity(contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_list_jobs",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.listJobs,
      inputSchema: listJobsSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.listJobs(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_get_dataset_details",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.getDatasetDetails,
      inputSchema: getDatasetDetailsSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.getDatasetDetails(args as { tdeiDatasetId: string }, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  register(
    "tdei_download_dataset",
    {
      description: SEMANTIC_TOOL_DESCRIPTIONS.downloadDataset,
      inputSchema: downloadDatasetSchema.shape,
    },
    async (args) => {
      try {
        return jsonIntentResult(await module.downloadDataset(args as never, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  const registerIntent = (
    name: string,
    description: string,
    shape: Record<string, z.ZodType>,
    invoke: (args: Record<string, unknown>, ctx: RequestContext) => Promise<unknown>,
  ): void => {
    register(name, { description, inputSchema: shape }, (async (args: Record<string, unknown>) => {
      try {
        return jsonIntentResult(await invoke(args, contextProvider()));
      } catch (error) {
        return formatError(error);
      }
    }) as Parameters<McpServer["registerTool"]>[2]);
  };

  registerIntent(
    "tdei_publish_dataset",
    SEMANTIC_TOOL_DESCRIPTIONS.publishDataset,
    publishDatasetSchema.shape,
    (args, ctx) => module.publishDataset(args as never, ctx),
  );
  registerIntent(
    "tdei_delete_dataset",
    SEMANTIC_TOOL_DESCRIPTIONS.deleteDataset,
    deleteDatasetSchema.shape,
    (args, ctx) => module.deleteDataset(args as never, ctx),
  );
  registerIntent("tdei_clone_dataset", SEMANTIC_TOOL_DESCRIPTIONS.cloneDataset, cloneDatasetSchema.shape, (args, ctx) =>
    module.cloneDataset(args as never, ctx),
  );
  registerIntent("tdei_edit_metadata", SEMANTIC_TOOL_DESCRIPTIONS.editMetadata, editMetadataSchema.shape, (args, ctx) =>
    module.editMetadata(args as never, ctx),
  );
  registerIntent(
    "tdei_calculate_confidence",
    SEMANTIC_TOOL_DESCRIPTIONS.calculateConfidence,
    confidenceSchema.shape,
    (args, ctx) => module.calculateConfidence(args as never, ctx),
  );
  registerIntent(
    "tdei_calculate_quality_intersection",
    SEMANTIC_TOOL_DESCRIPTIONS.calculateQualityIntersection,
    qualityIntersectionSchema.shape,
    (args, ctx) => module.calculateQualityIntersection(args as never, ctx),
  );
  registerIntent(
    "tdei_tag_quality_metric",
    SEMANTIC_TOOL_DESCRIPTIONS.tagQualityMetric,
    qualityTagSchema.shape,
    (args, ctx) => module.tagQualityMetric(args as never, ctx),
  );
  registerIntent(
    "tdei_generate_quality_report",
    SEMANTIC_TOOL_DESCRIPTIONS.generateQualityReport,
    getDatasetDetailsSchema.shape,
    (args, ctx) => module.generateQualityReport(args as never, ctx),
  );
  registerIntent(
    "tdei_sanitize_dataset",
    SEMANTIC_TOOL_DESCRIPTIONS.sanitizeDataset,
    sanitizeSchema.shape,
    (args, ctx) => module.sanitizeDataset(args as never, ctx),
  );
  registerIntent("tdei_convert_osw", SEMANTIC_TOOL_DESCRIPTIONS.convertOsw, convertOswSchema.shape, (args, ctx) =>
    module.convertOsw(args as never, ctx),
  );
  registerIntent(
    "tdei_convert_pathways",
    SEMANTIC_TOOL_DESCRIPTIONS.convertPathways,
    convertPathwaysSchema.shape,
    (args, ctx) => module.convertPathways(args as never, ctx),
  );
  registerIntent("tdei_self_merge", SEMANTIC_TOOL_DESCRIPTIONS.selfMerge, selfMergeSchema.shape, (args, ctx) =>
    module.selfMerge(args as never, ctx),
  );
  registerIntent("tdei_spatial_join", SEMANTIC_TOOL_DESCRIPTIONS.spatialJoin, spatialJoinSchema.shape, (args, ctx) =>
    module.spatialJoin(args as never, ctx),
  );
  registerIntent("tdei_union_datasets", SEMANTIC_TOOL_DESCRIPTIONS.unionDatasets, unionSchema.shape, (args, ctx) =>
    module.unionDatasets(args as never, ctx),
  );
  registerIntent("tdei_cut_dataset_bbox", SEMANTIC_TOOL_DESCRIPTIONS.cutDatasetBbox, cutBboxSchema.shape, (args, ctx) =>
    module.cutDatasetBbox(args as never, ctx),
  );
  registerIntent("tdei_tag_road", SEMANTIC_TOOL_DESCRIPTIONS.tagRoad, tagRoadSchema.shape, (args, ctx) =>
    module.tagRoad(args as never, ctx),
  );
  registerIntent(
    "tdei_tag_incline",
    SEMANTIC_TOOL_DESCRIPTIONS.tagIncline,
    getDatasetDetailsSchema.shape,
    (args, ctx) => module.tagIncline(args as never, ctx),
  );
  registerIntent(
    "tdei_check_dataset_incline",
    SEMANTIC_TOOL_DESCRIPTIONS.checkDatasetIncline,
    getDatasetDetailsSchema.shape,
    (args, ctx) => module.checkDatasetIncline(args as never, ctx),
  );
  registerIntent(
    "tdei_list_feedbacks",
    SEMANTIC_TOOL_DESCRIPTIONS.listFeedbacks,
    feedbackListSchema.shape,
    (args, ctx) => module.listFeedbacks(args as never, ctx),
  );
  registerIntent(
    "tdei_get_feedback_summary",
    SEMANTIC_TOOL_DESCRIPTIONS.getFeedbackSummary,
    feedbackSummarySchema.shape,
    (args, ctx) => module.getFeedbackSummary(args as never, ctx),
  );
  registerIntent(
    "tdei_download_feedbacks",
    SEMANTIC_TOOL_DESCRIPTIONS.downloadFeedbacks,
    feedbackDownloadSchema.shape,
    (args, ctx) => module.downloadFeedbacks(args as never, ctx),
  );
  registerIntent(
    "tdei_submit_feedback",
    SEMANTIC_TOOL_DESCRIPTIONS.submitFeedback,
    feedbackSubmitSchema.shape,
    (args, ctx) => module.submitFeedback(args as never, ctx),
  );
  registerIntent(
    "tdei_update_feedback_status",
    SEMANTIC_TOOL_DESCRIPTIONS.updateFeedbackStatus,
    feedbackStatusSchema.shape,
    (args, ctx) => module.updateFeedbackStatus(args as never, ctx),
  );
  registerIntent(
    "tdei_get_pm_tiles_url",
    SEMANTIC_TOOL_DESCRIPTIONS.getPmTilesUrl,
    getDatasetDetailsSchema.shape,
    (args, ctx) => module.getPmTilesUrl(args as never, ctx),
  );
  registerIntent(
    "tdei_set_viewer_access",
    SEMANTIC_TOOL_DESCRIPTIONS.setViewerAccess,
    viewerAccessSchema.shape,
    (args, ctx) => module.setViewerAccess(args as never, ctx),
  );
  registerIntent("tdei_get_metrics", SEMANTIC_TOOL_DESCRIPTIONS.getMetrics, metricsSchema.shape, (args, ctx) =>
    module.getMetrics(args as never, ctx),
  );
  registerIntent("tdei_list_versions", SEMANTIC_TOOL_DESCRIPTIONS.listVersions, versionsSchema.shape, (args, ctx) =>
    module.listVersions(args as never, ctx),
  );
  registerIntent("tdei_get_system_info", SEMANTIC_TOOL_DESCRIPTIONS.getSystemInfo, confirmSchema.shape, (_args, ctx) =>
    module.getSystemInfo(ctx),
  );
  registerIntent("tdei_verify_email", SEMANTIC_TOOL_DESCRIPTIONS.verifyEmail, emailSchema.shape, (args, ctx) =>
    module.verifyEmail(args as never, ctx),
  );
  registerIntent("tdei_recover_password", SEMANTIC_TOOL_DESCRIPTIONS.recoverPassword, emailSchema.shape, (args, ctx) =>
    module.recoverPassword(args as never, ctx),
  );
  registerIntent(
    "tdei_regenerate_api_key",
    SEMANTIC_TOOL_DESCRIPTIONS.regenerateApiKey,
    regenerateApiKeySchema.shape,
    (args, ctx) => module.regenerateApiKey(args as never, ctx),
  );
}
