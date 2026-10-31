import type {
  DataType,
  AcceptedJob,
  DatasetAsset,
  DatasetMetadata,
  Dataset,
  DatasetStatus,
  JobRecord,
  RequestContext,
  TdeiService,
  ProjectGroup,
  ListProjectGroupsInput,
} from "./types.js";

export interface DatasetSearch {
  name?: string;
  city?: string;
  bbox?: [number, number, number, number];
  dataType?: DataType;
  status: DatasetStatus;
  projectGroupId?: string;
  tdeiDatasetId?: string;
  collectionDate?: string;
  sortField: "uploaded_timestamp";
  sortOrder: "desc";
  page: number;
  pageSize: number;
}

export interface ServiceSearch {
  searchText?: string;
  projectGroupId?: string;
  serviceType?: "all" | DataType;
  page: number;
  pageSize: number;
}

export interface JobSearch {
  jobId?: string;
  projectGroupId: string;
  includeGroupJobs?: boolean;
  jobType?: string;
  status?: "COMPLETED" | "FAILED" | "IN-PROGRESS" | "ABANDONED";
  page: number;
  pageSize: number;
}

export interface ApiQuery {
  [key: string]: string | number | boolean | Array<string | number> | undefined;
}

/** OperationId -> POST path template for async job launchers. */
export const JOB_OPERATION_PATHS: Record<string, string> = {
  publishOswFile: "api/v1/osw/publish/{id}",
  publishGtfsFlexFile: "api/v1/gtfs-flex/publish/{id}",
  publishGtfsPathwaysFile: "api/v1/gtfs-pathways/publish/{id}",
  oswConfidenceCalculate: "api/v1/osw/confidence/{id}",
  oswQualityCalculate: "api/v1/osw/quality-metric/ixn/{id}",
  qualityMetricTag: "api/v1/osw/quality-metric/tag/{id}",
  oswQualityReportGenerate: "api/v1/osw/quality-report/{id}",
  sanitizeOswFile: "api/v1/osw/sanitize",
  oswOnDemandFormat: "api/v1/osw/convert",
  "osw-self-merge": "api/v1/osw/self-merge",
  "osw-spatial-join": "api/v1/osw/spatial-join",
  "osw-union": "api/v1/osw/union",
  datasetBbox: "api/v1/osw/dataset-bbox",
  datasetTagRoad: "api/v1/osw/dataset-tag-road",
  datasetTagIncline: "api/v1/osw/dataset-inclination/{id}",
  convertGtfsPathways: "api/v1/gtfs-pathways/convert",
};

export interface TdeiOperations {
  searchDatasets(input: DatasetSearch, context: RequestContext): Promise<Dataset[]>;
  listServices(input: ServiceSearch, context: RequestContext): Promise<TdeiService[]>;
  listProjectGroups(
    input: Required<Pick<ListProjectGroupsInput, "page" | "pageSize">> & Pick<ListProjectGroupsInput, "searchText">,
    context: RequestContext,
  ): Promise<ProjectGroup[]>;
  listJobs(input: JobSearch, context: RequestContext): Promise<JobRecord[]>;
  publishDataset?(input: { dataType: DataType; tdeiDatasetId: string }, context: RequestContext): Promise<JobRecord>;
  deleteDataset?(input: { tdeiDatasetId: string }, context: RequestContext): Promise<string>;
  cloneDataset?(
    input: {
      tdeiDatasetId: string;
      projectGroupId: string;
      serviceId: string;
      metadata: DatasetMetadata;
    },
    context: RequestContext,
  ): Promise<JobRecord>;
  editMetadata?(input: { tdeiDatasetId: string; metadata: DatasetMetadata }, context: RequestContext): Promise<unknown>;
  /** Launch one async OSW/Pathways job op by operation name (per-op wrappers validate inputs). */
  launchJob?(
    input: {
      operation: string;
      tdeiDatasetId?: string;
      query?: ApiQuery;
      body?: Record<string, unknown>;
      assets?: Record<string, DatasetAsset>;
      fields?: Record<string, string>;
    },
    context: RequestContext,
  ): Promise<JobRecord>;
  listFeedbacks?(
    input: {
      projectGroupId?: string;
      tdeiDatasetId?: string;
      fromDate?: string;
      toDate?: string;
      status?: string;
      page: number;
      pageSize: number;
    },
    context: RequestContext,
  ): Promise<JobRecord[]>;
  getFeedbackSummary?(input: { projectGroupId?: string }, context: RequestContext): Promise<unknown>;
  downloadFeedbacks?(
    input: {
      projectGroupId: string;
      tdeiDatasetId?: string;
      format?: string;
      fromDate?: string;
      toDate?: string;
      status?: string;
    },
    context: RequestContext,
  ): Promise<{ format?: string; text: string }>;
  submitFeedback?(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      feedback: Record<string, unknown>;
    },
    context: RequestContext,
  ): Promise<unknown>;
  updateFeedbackStatus?(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      updates: Array<Record<string, unknown>>;
    },
    context: RequestContext,
  ): Promise<unknown>;
  getPmTilesUrl?(input: { tdeiDatasetId: string }, context: RequestContext): Promise<string>;
  setViewerAccess?(
    input: { tdeiDatasetId: string; allowViewerAccess: boolean },
    context: RequestContext,
  ): Promise<unknown>;
  getMetrics?(
    input: { scope: "data" | "service" | "system"; projectGroupId?: string },
    context: RequestContext,
  ): Promise<unknown>;
  listVersions?(input: { dataType: DataType }, context: RequestContext): Promise<unknown>;
  getCapabilities?(context: RequestContext): Promise<unknown>;
  listApiVersions?(context: RequestContext): Promise<unknown>;
  verifyEmail?(input: { email: string }, context: RequestContext): Promise<unknown>;
  recoverPassword?(input: { email: string }, context: RequestContext): Promise<unknown>;
  regenerateApiKey?(context: RequestContext): Promise<string>;
  validateDataset?(input: { dataType: DataType; asset: DatasetAsset }, context: RequestContext): Promise<AcceptedJob>;
  uploadDataset?(
    input: {
      dataType: DataType;
      asset: DatasetAsset;
      projectGroupId: string;
      serviceId: string;
      metadata: DatasetMetadata;
      derivedFromDatasetId?: string;
      changeset?: DatasetAsset;
    },
    context: RequestContext,
  ): Promise<AcceptedJob>;
}
