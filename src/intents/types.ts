export type DataType = "osw" | "flex" | "pathways";
export type DatasetStatus = "All" | "Publish" | "Pre-Release";

export interface RequestContext {
  accessToken?: string;
  requestId?: string;
}

export type Dataset = Record<string, unknown>;
export type ProjectGroup = Record<string, unknown>;
export type TdeiService = Record<string, unknown>;

export interface MissingInput {
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
  latest?: boolean;
  limit?: number;
}

export interface DatasetMatch {
  dataset: Dataset;
  matchedBy: "name" | "city" | "bbox" | "project_group";
  evidence: string;
}

export interface FindDatasetsData {
  matches: DatasetMatch[];
  selected?: Dataset;
  effectiveSort: {
    field: "uploaded_timestamp";
    order: "desc";
  };
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
}

export type DatasetAsset =
  | { kind: "local_path"; path: string; name?: string }
  | {
    kind: "inline_base64";
    name: string;
    mediaType: string;
    data: string;
  }
  | { kind: "object_ref"; id: string; name: string };

export interface AcceptedJob {
  jobId: string;
  location?: string;
}

export interface DatasetDetailMetadata {
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
