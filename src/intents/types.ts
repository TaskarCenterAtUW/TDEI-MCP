export type DataType = "osw" | "flex" | "pathways";
export type DatasetStatus = "All" | "Publish" | "Pre-Release";

export interface RequestContext {
  accessToken?: string;
  requestId?: string;
}

export type Dataset = Record<string, unknown>;
export type ProjectGroup = Record<string, unknown>;
export type TdeiService = Record<string, unknown>;

/**
 * Uniform paging info for every list tool, so clients never guess the end
 * of a list by waiting for a short page (which wastes a full request when
 * the total is an exact multiple of the page size).
 * - Single API-page results: `page`/`pageSize` echo the API page and
 *   `hasMore` is exact (a 1-row lookahead settles full pages).
 * - Multi-page scans: `page` is 1, `pageSize` is the display limit,
 *   `returned` is the rows in this response, and `total` is the exact
 *   match count because the tool read every page.
 * `total` is present only when the module knows the exact count — the TDEI
 * core list APIs return bare arrays with no total. `hasMore` is always
 * exact: when true, the next page/window holds at least one more row.
 */
export interface PaginationBlock {
  page: number;
  pageSize: number;
  returned: number;
  total?: number;
  hasMore: boolean;
}

interface MissingInput {
  field: string;
  question: string;
  allowedValues?: string[];
}

export type IntentResult<T> =
  | { status: "complete"; data: T }
  | {
      status: "needs_input";
      missing: MissingInput[];
      accepted: Record<string, unknown>;
    }
  | {
      status: "ambiguous";
      question?: string;
      candidates: Array<Record<string, unknown>>;
      accepted: Record<string, unknown>;
    }
  | {
      status: "unsupported";
      reason: string;
      requiredCapability?: string;
    };

export interface FindDatasetsInput {
  place?: string;
  bbox?: [number, number, number, number];
  dataType?: DataType;
  status?: DatasetStatus;
  projectGroupId?: string;
  serviceId?: string;
  /** Exact TDEI dataset id lookup (maps to API tdei_dataset_id). */
  tdeiDatasetId?: string;
  /** Only keep datasets uploaded after this ISO date-time (client-side; API has no uploaded_after). */
  uploadedAfter?: string;
  /** Shorthand for uploadedAfter = now - N days. */
  uploadedWithinDays?: number;
  /** Exact match on the dataset version (pushed to the API as a server-side filter). */
  version?: string;
  /** Exact match on the data source (pushed to the API as a server-side filter). */
  dataSource?: "3rdParty" | "TDEITools" | "InHouse";
  /** Exact match on the collection method (pushed to the API as a server-side filter). */
  collectionMethod?: "manual" | "transform" | "generated" | "other";
  /** Exact match on the collection agency or person (pushed to the API as a server-side filter). */
  collectedBy?: string;
  /** Only datasets derived from this dataset id (pushed to the API as a server-side filter). */
  derivedFromDatasetId?: string;
  /** Only datasets collected after this date-time (pushed to the API as collection_date). */
  collectionDate?: string;
  /** Minimum confidence level (pushed to the API as confidence_level). */
  confidenceLevel?: number;
  /** Only datasets on this data-type schema version (pushed to the API as a server-side filter). */
  schemaVersion?: string;
  /** Only datasets with a valid-from later than this date-time (pushed to the API as a server-side filter). */
  validFrom?: string;
  /** Only datasets with a valid-to earlier than this date-time (pushed to the API as a server-side filter). */
  validTo?: string;
  /** City-name contains filter (pushed to the API; independent of the place search). */
  city?: string;
  /** County-name contains filter (pushed to the API as a server-side filter). */
  county?: string;
  /** Region-name contains filter (pushed to the API as a server-side filter). */
  region?: string;
  latest?: boolean;
  /**
   * Keep one row per dataset name: the newest version (numeric compare, so
   * 1.10 beats 1.9), newest upload as tie-break, and count the versions it
   * replaced. Defaults to true for projectGroupId/serviceId listings, which
   * read every page; pass false to see each version. This is the single
   * implementation of "latest unique datasets" — dependent tools
   * (tdei_get_dataset_details, tdei_download_dataset, workspace creation)
   * resolve their dataset through this tool, so they inherit it.
   */
  latestPerName?: boolean;
  limit?: number;
}

export interface DatasetMatch {
  dataset: Dataset;
  matchedBy: "name" | "city" | "bbox" | "project_group" | "service" | "dataset_id";
  evidence: string;
  /** Dataset version from metadata.dataset_detail.version (when present). */
  version?: string;
  /** How many versions share this name (latestPerName scans only). */
  versionsAvailable?: number;
}

export interface FindDatasetsData {
  matches: DatasetMatch[];
  selected?: Dataset;
  effectiveSort: {
    field: "uploaded_timestamp";
    order: "desc";
  };
  /**
   * Uniform paging info. Single-page searches (name/city/bbox/id) report the
   * API page with an exact hasMore (a 1-row lookahead settles full pages, so
   * clients never spend a wasted request on an exact-multiple total).
   * Project-group/service scans report the display window over every match
   * with an exact total. `total` is present only when the module knows the
   * exact count; the core list APIs return bare arrays with no total.
   */
  pagination: PaginationBlock;
  /** Present when the search scanned beyond the first page (latestPerName). */
  scan?: {
    pagesRead: number;
    datasetsScanned: number;
    uniqueDatasetNames: number;
    /** Dataset records hidden because a newer version of the same name was kept. */
    versionsSuperseded: number;
    /** True when the page cap stopped the scan before the last page. */
    truncated: boolean;
    /** True when a date filter stopped paging early (older pages cannot match). */
    stoppedEarly: boolean;
    note: string;
  };
  /** Markdown table of the matches (#, name, version, uuid, type, status, project group, service) for the user to pick from. */
  table: string;
}

export interface ListServicesInput {
  searchText?: string;
  projectGroupId?: string;
  serviceType?: "all" | DataType;
  page?: number;
  pageSize?: number;
}

export interface ListServicesData {
  services: TdeiService[];
  appliedFilters: ListServicesInput;
  apiOperation: "listServices";
  method: "GET";
  path: "/api/v1/services";
  pagination: PaginationBlock;
}

export interface ListProjectGroupsInput {
  searchText?: string;
  page?: number;
  pageSize?: number;
}

export interface ListProjectGroupsData {
  projectGroups: ProjectGroup[];
  appliedFilters: ListProjectGroupsInput;
  accessScope: "authenticated_user";
  scopeExplanation: string;
  apiOperation: "listProjectGroups";
  method: "GET";
  path: "/api/v1/project-groups";
  pagination: PaginationBlock;
}

export interface ListJobsInput {
  jobId?: string;
  projectGroupId?: string;
  /** Resolved against the caller's project groups (case-insensitive). */
  projectGroupName?: string;
  /** Search every accessible project group. Only for an explicit "all" request. */
  allGroups?: boolean;
  includeGroupJobs?: boolean;
  jobType?: string;
  status?: "COMPLETED" | "FAILED" | "IN-PROGRESS" | "ABANDONED";
  /** Only keep jobs created at or after this ISO date-time (client-side; the API has no date param). */
  createdAfter?: string;
  /** Only keep jobs created at or before this ISO date-time (client-side; the API has no date param). */
  createdBefore?: string;
  /** Shorthand for createdAfter = now - N days. */
  createdWithinDays?: number;
  /** Rows returned in the table (1-500). The summary always covers every match. */
  limit?: number;
}

export interface ListJobsRuntimeSummary {
  /** Jobs where a non-negative created_at -> updated_at span could be computed. */
  jobsWithRuntime: number;
  avgRuntimeSeconds?: number;
  minRuntimeSeconds?: number;
  maxRuntimeSeconds?: number;
  stddevRuntimeSeconds?: number;
}

export interface ListJobsData {
  jobs: JobRecord[];
  appliedFilters: ListJobsInput & { searchedProjectGroups: string[] };
  apiOperation: "listJobs";
  method: "GET";
  path: "/api/v1/jobs";
  scopeNote: string;
  /** Aggregate counts over every match (after dedupe and date filtering), so stats never need the full row list. */
  summary: {
    /** Unique jobs matched, across all searched groups. */
    matchingJobs: number;
    /** Same job seen in more than one group (allGroups searches) and counted once. */
    duplicatesRemoved: number;
    /** API pages read across the searched groups. */
    pagesRead: number;
    runtime: ListJobsRuntimeSummary;
  };
  /** Display window over every match: page 1, the display limit, exact total. */
  pagination: PaginationBlock;
  /**
   * The tool pages through the jobs API itself (up to 20 pages of 50 per
   * group) and dedupes by job id, so callers never page manually. The table
   * holds the newest `limit` rows; the summary covers every match.
   */
  truncation: {
    /** Unique jobs matched (after dedupe and date filtering). */
    matching: number;
    shown: number;
    /** True when the per-group page cap stopped the scan before a short page. */
    truncated: boolean;
    mayHaveMore: boolean;
    note: string;
  };
}

export type JobRecord = Record<string, unknown>;

/** Which rows a QA/QC report inventory should keep, based on report-link presence. */
type TcatQaReportFilter = "all" | "with_reports" | "missing_reports";

export interface TcatQaReportsInput {
  projectGroupId?: string;
  /** Resolved against the caller's project groups (case-insensitive). */
  projectGroupName?: string;
  serviceId?: string;
  dataType?: DataType;
  /** Defaults to All so pre-release datasets that carry the newest report are included. */
  status?: DatasetStatus;
  /** Keep one row per dataset name, choosing the newest version. Defaults to true. */
  latestPerName?: boolean;
  uploadedAfter?: string;
  uploadedWithinDays?: number;
  /** Case-insensitive substring filter on the dataset name (narrows large inventories). */
  nameContains?: string;
  reportFilter?: TcatQaReportFilter;
  includeCustomMetadata?: boolean;
  /** Rows returned (1-500). The summary always covers every scanned dataset. */
  limit?: number;
  /** Bypass the short-lived read cache and scan the API again. */
  refresh?: boolean;
}

/**
 * One QA/QC report row. Fields are required-but-possibly-undefined so the
 * builder can assign them directly under exactOptionalPropertyTypes; JSON
 * serialization drops the undefined ones.
 */
export interface TcatQaReportRow {
  name: string;
  version: string | undefined;
  tdei_dataset_id: string | undefined;
  uploaded_timestamp: string | undefined;
  status: string | undefined;
  service: string | undefined;
  serviceId: string | undefined;
  pipelineVersion: string | undefined;
  tractNo: string | undefined;
  area: string | undefined;
  county: string | undefined;
  releaseNotes: string | undefined;
  qaQcReportVersion: string | undefined;
  mapSource: string | undefined;
  reportUrlPdf: string | undefined;
  reportUrlHtml: string | undefined;
  reportCode: string | undefined;
  imageryUsed: Record<string, unknown> | undefined;
  /** How many dataset versions share this name (latestPerName only). */
  versionsAvailable: number | undefined;
  customMetadata: Record<string, unknown> | undefined;
}

export interface TcatQaReportsData {
  appliedFilters: TcatQaReportsInput & { projectGroupId: string; dataType: DataType; status: DatasetStatus };
  projectGroupName?: string;
  scan: {
    pagesRead: number;
    datasetsScanned: number;
    uniqueDatasetNames: number;
    /** True when the server-side page cap stopped the scan before the last page. */
    truncated: boolean;
    note: string;
  };
  summary: {
    matchingRows: number;
    withReportPdf: number;
    withReportHtml: number;
    withReportCode: number;
    missingReport: number;
    /** Rows whose PDF URL is shared with at least one other row. */
    duplicateReportUrls: number;
    /** Dataset rows hidden because a newer version of the same name was kept. */
    versionsSuperseded: number;
  };
  rows: TcatQaReportRow[];
  /** Markdown table of the shown rows (presence flags, not full URLs). */
  table: string;
  /** Display window over every match: page 1, the row limit, exact total. */
  pagination: PaginationBlock;
  truncation: {
    shown: number;
    available: number;
    mayHaveMore: boolean;
    note: string;
  };
  apiOperation: "listDatasetFiles";
  method: "GET";
  path: "/api/v1/datasets";
}

export interface PublishDatasetInput {
  tdeiDatasetId?: string;
  dataType?: DataType;
  confirm?: boolean;
}

export interface DeleteDatasetInput {
  tdeiDatasetId?: string;
  confirm?: boolean;
}

export interface CloneDatasetInput {
  tdeiDatasetId?: string;
  projectGroupId?: string;
  serviceId?: string;
  metadata?: DatasetMetadata;
  confirm?: boolean;
}

export interface EditMetadataInput {
  tdeiDatasetId?: string;
  metadata?: DatasetMetadata;
  confirm?: boolean;
}

export interface ConfidenceInput {
  tdeiDatasetId?: string;
  subRegionAsset?: DatasetAsset;
}

export interface QualityIntersectionInput {
  tdeiDatasetId?: string;
  polygonAsset?: DatasetAsset;
}

export interface QualityTagInput {
  tdeiDatasetId?: string;
  tagQualityAsset?: DatasetAsset;
}

export interface SanitizeInput {
  asset?: DatasetAsset;
}

export interface ConvertOswInput {
  asset?: DatasetAsset;
  sourceFormat?: "osm" | "osw";
  targetFormat?: "osm" | "osw";
}

export interface ConvertPathwaysInput {
  datasetAsset?: DatasetAsset;
  arcgisUrl?: string;
  layers?: string;
  crs?: string;
}

export interface SelfMergeInput {
  tdeiDatasetId?: string;
  proximity?: number;
}

export interface SpatialJoinInput {
  targetDatasetId?: string;
  targetDimension?: "edge" | "node" | "zone";
  sourceDatasetId?: string;
  sourceDimension?: string;
  joinCondition?: string;
}

export interface UnionDatasetsInput {
  tdeiDatasetIdOne?: string;
  tdeiDatasetIdTwo?: string;
  proximity?: number;
  confirm?: boolean;
}

export interface CutBboxInput {
  tdeiDatasetId?: string;
  fileType?: "osw" | "osm";
  bbox?: [number, number, number, number];
}

export interface TagRoadInput {
  sourceDatasetId?: string;
  targetDatasetId?: string;
}

export interface TagInclineInput {
  tdeiDatasetId?: string;
  /** Batch mode: check several datasets in one call (parallel, max 5 in flight). */
  tdeiDatasetIds?: string[];
  /** Batch mode: resolve ids via a project-group + recency filter instead of passing ids. */
  projectGroupId?: string;
  projectGroupName?: string;
  uploadedAfter?: string;
  uploadedWithinDays?: number;
  limit?: number;
}

export interface CheckInclineRow {
  tdeiDatasetId: string;
  hasIncline: boolean;
  inclinePercent?: number;
  totalEntityCount?: number;
  overallQualityMetric?: string;
  metric?: unknown;
  error?: string;
}

export interface CheckInclineBatchData {
  apiOperation: "qualityMetricTag";
  method: "POST";
  path: string;
  request: Array<{ entity_type: string; tags: string[] }>;
  results: CheckInclineRow[];
  summary: { total: number; withIncline: number; withoutIncline: number; failed: number };
  followUp: string;
}

export interface CheckInclineData {
  tdeiDatasetId: string;
  apiOperation: "qualityMetricTag";
  method: "POST";
  path: string;
  request: Array<{ entity_type: string; tags: string[] }>;
  metric: unknown;
  hasIncline: boolean;
  inclinePercent?: number;
  totalEntityCount?: number;
  overallQualityMetric?: string;
  followUp: string;
}

export interface ListFeedbacksInput {
  projectGroupId?: string;
  tdeiDatasetId?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
  /** Rows returned in the table (1-500). The summary always covers every match. */
  limit?: number;
}

export interface ListFeedbacksData {
  feedbacks: JobRecord[];
  appliedFilters: ListFeedbacksInput;
  apiOperation: "oswDatasetViewerFeedbacks";
  method: "GET";
  path: "/api/v1/osw/dataset-viewer/feedbacks";
  /** Aggregate counts over every scanned page; the table holds the newest `limit` rows. */
  summary: {
    matchingFeedbacks: number;
    pagesRead: number;
  };
  /** Display window over every match: page 1, the display limit, exact total. */
  pagination: PaginationBlock;
  truncation: {
    matching: number;
    shown: number;
    /** True when the page cap stopped the scan before a short page. */
    truncated: boolean;
    mayHaveMore: boolean;
    note: string;
  };
}

export interface FeedbackSummaryData {
  summary: unknown;
  projectGroupId?: string;
  apiOperation: "oswDatasetViewerFeedbacksMetadata";
  method: "GET";
  path: "/api/v1/osw/dataset-viewer/feedbacks/metadata";
}

export interface DownloadFeedbacksInput {
  projectGroupId?: string;
  tdeiDatasetId?: string;
  format?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
}

export interface DownloadFeedbacksData {
  format?: string;
  contentLength: number;
  preview: string;
  truncated: boolean;
  apiOperation: "oswDatasetViewerFeedbacksDownload";
  method: "GET";
  path: "/api/v1/osw/dataset-viewer/feedbacks/download/{tdei_project_group_id}";
}

export interface DownloadDatasetInput {
  tdeiDatasetId?: string;
  dataType?: DataType;
  /**
   * Absolute folder on the CLIENT machine the ZIP is saved to
   * (the user-connected folder). The MCP server never writes files.
   */
  outputDir?: string;
  /** Optional ZIP filename override (defaults to <dataset-name-or-id>.zip). */
  filename?: string;
  /**
   * Consent flag for name-based downloads. A UUID in tdeiDatasetId downloads
   * immediately; a dataset NAME first returns the match table and requires
   * a follow-up call with confirm:true (single match) or a UUID/selection.
   */
  confirm?: boolean;
  /** 1-based row number into the match table of a previous name search. */
  selection?: number;
}

export interface DownloadDatasetData {
  tdeiDatasetId: string;
  dataType: DataType;
  datasetName?: string;
  /** Client-local destination path (joined, not written server-side). */
  filePath: string;
  apiOperation: "getOswFile" | "getGtfsFlexFile" | "getGtfsPathwaysFile";
  method: "GET";
  path: string;
  /** Ready-to-run client-side download command (client mode only). */
  curlCommand?: string;
  /** Server mode only: absolute path the MCP server wrote the ZIP to. */
  savedTo?: string;
  bytes?: number;
  httpStatus?: number;
  instruction: string;
}

export interface ClientUploadInstruction {
  dataType: DataType;
  /** Absolute dataset path on the CLIENT machine; curl reads it, the MCP server never touches bytes. */
  datasetPath: string;
  apiOperation: "validateDataset" | "uploadDataset";
  method: "POST";
  path: string;
  /** Hands-free client-side upload command using $TDEI_TOKEN (never an embedded bearer). */
  curlCommand: string;
  instruction: string;
}

export interface SubmitFeedbackInput {
  projectId?: string;
  tdeiDatasetId?: string;
  datasetElementId?: string;
  feedbackText?: string;
  customerEmail?: string;
  locationLatitude?: number;
  locationLongitude?: number;
}

export interface UpdateFeedbackStatusInput {
  projectId?: string;
  tdeiDatasetId?: string;
  updates?: Array<{
    id: number;
    status: "open" | "resolved";
    resolutionStatus?: "fixed" | "wont_fix" | "not_an_issue";
    resolutionDescription?: string;
  }>;
}

export interface GetMetricsInput {
  scope?: "data" | "service" | "system";
  projectGroupId?: string;
}

export interface GetMetricsData {
  scope: "data" | "service" | "system";
  metrics: unknown;
  apiOperation: "data-metrics" | "service-metrics" | "system-metrics";
  method: "GET";
  path: string;
}

export interface ListVersionsData {
  versions: Record<string, unknown>;
  apiOperation: "listOswVersions" | "listGtfsFlexVersions" | "listGtfsPathwaysVersions";
  method: "GET";
  path: string;
}

export interface SystemInfoData {
  capabilities: unknown;
  apiVersions: unknown;
}

export interface VerifyEmailInput {
  email?: string;
}

export interface RecoverPasswordInput {
  email?: string;
}

export interface RegenerateApiKeyInput {
  confirm?: boolean;
}

export interface MyIdentity {
  subject?: string;
  username?: string;
  email?: string;
  name?: string;
  roles: string[];
  groups: string[];
}

export interface MyProjectGroupRolesData {
  authenticated: boolean;
  projectGroups?: Array<{ tdei_project_group_id: string; project_group_name: string; roles: string[] }>;
  /** Total reported by the API (X-Total-Count) when it exceeds what was returned. */
  total?: number;
  hint: string;
}

export interface GetMyIdentityData {
  authenticated: boolean;
  identity?: MyIdentity;
  hint: string;
}

export type DatasetAsset =
  | { kind: "local_path"; path: string; name?: string }
  | {
      kind: "inline_base64";
      name: string;
      mediaType: string;
      data: string;
    }
  | { kind: "url"; url: string; name?: string }
  | { kind: "object_ref"; id: string; name: string };

interface DatasetDetailMetadata {
  name?: string;
  version?: string;
  collected_by?: string;
  collection_date?: string;
  data_source?: "3rdParty" | "TDEITools" | "InHouse";
  schema_version?: string;
  [key: string]: unknown;
}

export interface DatasetMetadata {
  dataset_detail?: DatasetDetailMetadata;
  [key: string]: unknown;
}

export interface ValidateDatasetInput {
  dataType?: DataType;
  asset?: DatasetAsset;
}

export interface UploadDatasetInput {
  dataType?: DataType;
  asset?: DatasetAsset;
  projectGroupId?: string;
  serviceId?: string;
  derivedFromDatasetId?: string;
  changeset?: DatasetAsset;
  metadata?: DatasetMetadata;
}
