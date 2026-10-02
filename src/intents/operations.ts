import type {
  DataType,
  AcceptedJob,
  DatasetAsset,
  DatasetMetadata,
  Dataset,
  DatasetStatus,
  RequestContext,
  TdeiService,
} from "./types.js";

export interface DatasetSearch {
  name?: string;
  city?: string;
  bbox?: [number, number, number, number];
  dataType?: DataType;
  status: DatasetStatus;
  projectGroupId?: string;
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

export interface TdeiOperations {
  searchDatasets(
    input: DatasetSearch,
    context: RequestContext,
  ): Promise<Dataset[]>;
  listServices(
    input: ServiceSearch,
    context: RequestContext,
  ): Promise<TdeiService[]>;
  validateDataset?(
    input: { dataType: DataType; asset: DatasetAsset },
    context: RequestContext,
  ): Promise<AcceptedJob>;
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
