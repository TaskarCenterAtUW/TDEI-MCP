export type DataType = "osw" | "flex" | "pathways";
export type DatasetStatus = "All" | "Publish" | "Pre-Release";

export interface RequestContext {
  accessToken?: string;
  requestId?: string;
}

export type Dataset = Record<string, unknown>;
export type ProjectGroup = Record<string, unknown>;
export type TdeiService = Record<string, unknown>;

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
  /** Present when the search scanned beyond the first page (latestPerName). */
  scan?: {
    pagesRead: number;
    datasetsScanned: number;
    uniqueDatasetNames: number;
    /** Dataset records hidden because a newer version of the same name was kept. */
    versionsSuperseded: number;
    /** True when the page cap stopped the scan before the last page. */
    truncated: boolean;
    note: string;
  };
  /** Markdown table of the matches (#, name, version, uuid, type, status) for the user to pick from. */
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
  createdAfter?: string;
  createdWithinDays?: number;
  limit?: number;
}

export interface ListJobsData {
  jobs: JobRecord[];
  appliedFilters: ListJobsInput & { searchedProjectGroups: string[] };
  apiOperation: "listJobs";
  method: "GET";
  path: "/api/v1/jobs";
  scopeNote: string;
  /**
   * The jobs API has no total count and no documented ordering, so the tool makes one call per project
   * group (never loops) and reports whether the list may be incomplete.
   */
  truncation: {
    /** Jobs returned by the API across the searched groups, before date filtering and the display limit. */
    returned: number;
    shown: number;
    /** True when a group returned a full API page (50), so more matching jobs may exist. */
    apiPageFull: boolean;
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
}

export interface CheckInclineData {
  tdeiDatasetId: string;
  dataType: DataType;
  apiOperation: "getOswFile";
  method: "GET";
  path: string;
  curlCommand: string;
  instruction: string;
}

export interface ListFeedbacksInput {
  projectGroupId?: string;
  tdeiDatasetId?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
  limit?: number;
}

export interface ListFeedbacksData {
  feedbacks: JobRecord[];
  appliedFilters: ListFeedbacksInput;
  apiOperation: "oswDatasetViewerFeedbacks";
  method: "GET";
  path: "/api/v1/osw/dataset-viewer/feedbacks";
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
