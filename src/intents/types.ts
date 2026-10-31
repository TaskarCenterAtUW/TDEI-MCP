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
  /** Exact TDEI dataset id lookup (maps to API tdei_dataset_id). */
  tdeiDatasetId?: string;
  /** Only keep datasets uploaded after this ISO date-time (client-side; API has no uploaded_after). */
  uploadedAfter?: string;
  /** Shorthand for uploadedAfter = now - N days. */
  uploadedWithinDays?: number;
  latest?: boolean;
  limit?: number;
}

export interface DatasetMatch {
  dataset: Dataset;
  matchedBy: "name" | "city" | "bbox" | "project_group" | "dataset_id";
  evidence: string;
}

export interface FindDatasetsData {
  matches: DatasetMatch[];
  selected?: Dataset;
  effectiveSort: {
    field: "uploaded_timestamp";
    order: "desc";
  };
  /** Markdown table of the matches (#, name, uuid, type, status) for the user to pick from. */
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
}

export type JobRecord = Record<string, unknown>;

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
  /** Ready-to-run client-side upload command with the SSO bearer embedded when available. */
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

export interface AcceptedJob {
  jobId: string;
  location?: string;
}

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
