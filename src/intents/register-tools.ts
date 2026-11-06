import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { formatError, truncateText } from "../mcp/errors.js";
import { SEMANTIC_TOOL_DESCRIPTIONS } from "./descriptions.js";
import { TOOL_SPEC_FIELDS } from "./generated/tool-fields.generated.js";
import { summarizeFields } from "../mcp/field-summary.js";
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
  projectGroupName: z.string().trim().min(1).optional(),
  allGroups: z.boolean().optional(),
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
  confirm: z.boolean().optional(),
  selection: z.number().int().min(1).optional(),
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

// Optional on purpose: a missing id must reach the module so it can ask
// "Which TDEI dataset id should get a quality report?" instead of failing
// protocol validation before the tool can respond.
const qualityReportSchema = z.object({
  tdeiDatasetId: z.string().trim().min(1).optional(),
  dataType: z.enum(["osw", "flex", "pathways"]).optional(),
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
  // Compact JSON: indentation only costs the model tokens.
  const { text } = truncateText(JSON.stringify(data));
  return { content: [{ type: "text" as const, text }] };
}

type ToolHandler = Parameters<McpServer["registerTool"]>[2];

/**
 * Description plus a spec-derived "Fields" line. Mandatory fields come from the
 * OpenAPI spec (see scripts/generate-tool-fields.ts); everything else the tool
 * accepts is listed as optional. Our Zod schemas keep fields optional on purpose
 * so a missing value gets a helpful needs_input reply, which hides required-ness
 * from the model; this line puts it back.
 */
export function describeWithFields(name: string, description: string, shapeKeys: readonly string[]): string {
  const spec = TOOL_SPEC_FIELDS[name];
  if (!spec) return description;
  const required = shapeKeys.filter((key) => spec.required.includes(key));
  const optional = shapeKeys.filter((key) => !spec.required.includes(key) && !spec.oneOf?.includes(key));
  const line = summarizeFields({ required, optional, oneOf: spec.oneOf });
  return line ? `${description}\n${line}` : description;
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

  /** Registers one intent tool; the try/catch + JSON wrapping lives here once. */
  const tool = <S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    // Zod's inferred optionals (`T | undefined`) clash with the module's
    // exactOptionalPropertyTypes inputs; the schema already validated `args`.
    // oxlint-disable-next-line typescript/no-explicit-any
    invoke: (args: any, ctx: RequestContext) => unknown,
  ): void => {
    if (registered.has(name)) return;
    server.registerTool(
      name,
      { description: describeWithFields(name, description, Object.keys(schema.shape)), inputSchema: schema.shape },
      (async (args: unknown) => {
        try {
          return jsonIntentResult(await invoke(args, contextProvider()));
        } catch (error) {
          return formatError(error);
        }
      }) as unknown as ToolHandler,
    );
    registered.add(name);
  };
  const D = SEMANTIC_TOOL_DESCRIPTIONS;
  const noArgs = z.object({});

  tool("tdei_find_datasets", D.findDatasets, findDatasetsSchema, (a, c) => module.findDatasets(a, c));
  tool("tdei_list_my_project_groups", D.listMyProjectGroups, listProjectGroupsSchema, (a, c) =>
    module.listMyProjectGroups(a, c),
  );
  tool("tdei_list_services", D.listServices, listServicesSchema, (a, c) => module.listServices(a, c));
  tool("tdei_validate_dataset", D.validateDataset, validateDatasetSchema, (a, c) => module.validateDataset(a, c));
  tool("tdei_upload_dataset", D.uploadDataset, uploadDatasetSchema, (a, c) => module.uploadDataset(a, c));
  tool("tdei_get_my_identity", D.getMyIdentity, noArgs, (_a, c) => module.getMyIdentity(c));
  tool("tdei_list_jobs", D.listJobs, listJobsSchema, (a, c) => module.listJobs(a, c));
  tool("tdei_get_dataset_details", D.getDatasetDetails, getDatasetDetailsSchema, (a, c) =>
    module.getDatasetDetails(a, c),
  );
  tool("tdei_download_dataset", D.downloadDataset, downloadDatasetSchema, (a, c) => module.downloadDataset(a, c));
  tool("tdei_publish_dataset", D.publishDataset, publishDatasetSchema, (a, c) => module.publishDataset(a, c));
  tool("tdei_delete_dataset", D.deleteDataset, deleteDatasetSchema, (a, c) => module.deleteDataset(a, c));
  tool("tdei_clone_dataset", D.cloneDataset, cloneDatasetSchema, (a, c) => module.cloneDataset(a, c));
  tool("tdei_edit_metadata", D.editMetadata, editMetadataSchema, (a, c) => module.editMetadata(a, c));
  tool("tdei_calculate_confidence", D.calculateConfidence, confidenceSchema, (a, c) =>
    module.calculateConfidence(a, c),
  );
  tool("tdei_calculate_quality_intersection", D.calculateQualityIntersection, qualityIntersectionSchema, (a, c) =>
    module.calculateQualityIntersection(a, c),
  );
  tool("tdei_tag_quality_metric", D.tagQualityMetric, qualityTagSchema, (a, c) => module.tagQualityMetric(a, c));
  tool("tdei_generate_quality_report", D.generateQualityReport, qualityReportSchema, (a, c) =>
    module.generateQualityReport(a, c),
  );
  tool("tdei_sanitize_dataset", D.sanitizeDataset, sanitizeSchema, (a, c) => module.sanitizeDataset(a, c));
  tool("tdei_convert_osw", D.convertOsw, convertOswSchema, (a, c) => module.convertOsw(a, c));
  tool("tdei_convert_pathways", D.convertPathways, convertPathwaysSchema, (a, c) => module.convertPathways(a, c));
  tool("tdei_self_merge", D.selfMerge, selfMergeSchema, (a, c) => module.selfMerge(a, c));
  tool("tdei_spatial_join", D.spatialJoin, spatialJoinSchema, (a, c) => module.spatialJoin(a, c));
  tool("tdei_union_datasets", D.unionDatasets, unionSchema, (a, c) => module.unionDatasets(a, c));
  tool("tdei_cut_dataset_bbox", D.cutDatasetBbox, cutBboxSchema, (a, c) => module.cutDatasetBbox(a, c));
  tool("tdei_tag_road", D.tagRoad, tagRoadSchema, (a, c) => module.tagRoad(a, c));
  tool("tdei_tag_incline", D.tagIncline, getDatasetDetailsSchema, (a, c) => module.tagIncline(a, c));
  tool("tdei_check_dataset_incline", D.checkDatasetIncline, getDatasetDetailsSchema, (a, c) =>
    module.checkDatasetIncline(a, c),
  );
  tool("tdei_list_feedbacks", D.listFeedbacks, feedbackListSchema, (a, c) => module.listFeedbacks(a, c));
  tool("tdei_get_feedback_summary", D.getFeedbackSummary, feedbackSummarySchema, (a, c) =>
    module.getFeedbackSummary(a, c),
  );
  tool("tdei_download_feedbacks", D.downloadFeedbacks, feedbackDownloadSchema, (a, c) =>
    module.downloadFeedbacks(a, c),
  );
  tool("tdei_submit_feedback", D.submitFeedback, feedbackSubmitSchema, (a, c) => module.submitFeedback(a, c));
  tool("tdei_update_feedback_status", D.updateFeedbackStatus, feedbackStatusSchema, (a, c) =>
    module.updateFeedbackStatus(a, c),
  );
  tool("tdei_get_pm_tiles_url", D.getPmTilesUrl, getDatasetDetailsSchema, (a, c) => module.getPmTilesUrl(a, c));
  tool("tdei_set_viewer_access", D.setViewerAccess, viewerAccessSchema, (a, c) => module.setViewerAccess(a, c));
  tool("tdei_get_metrics", D.getMetrics, metricsSchema, (a, c) => module.getMetrics(a, c));
  tool("tdei_list_versions", D.listVersions, versionsSchema, (a, c) => module.listVersions(a, c));
  tool("tdei_get_system_info", D.getSystemInfo, confirmSchema, (_a, c) => module.getSystemInfo(c));
  tool("tdei_verify_email", D.verifyEmail, emailSchema, (a, c) => module.verifyEmail(a, c));
  tool("tdei_recover_password", D.recoverPassword, emailSchema, (a, c) => module.recoverPassword(a, c));
  tool("tdei_regenerate_api_key", D.regenerateApiKey, regenerateApiKeySchema, (a, c) => module.regenerateApiKey(a, c));
}
