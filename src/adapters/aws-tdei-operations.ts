import { decodeAwsRecords } from "./aws-result-decoder.js";
import type {
  DatasetSearch,
  ServiceSearch,
  TdeiOperations,
} from "../intents/operations.js";
import type {
  AcceptedJob,
  DataType,
  DatasetAsset,
  DatasetMetadata,
  Dataset,
  RequestContext,
  TdeiService,
} from "../intents/types.js";

export type AwsToolCaller = (
  tool: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

export class AwsTdeiOperations implements TdeiOperations {
  constructor(
    private readonly callTool: AwsToolCaller,
    private readonly isDenied: (tool: string) => boolean = () => false,
    private readonly mutations?: Required<Pick<TdeiOperations, "validateDataset" | "uploadDataset">>,
  ) {}

  async validateDataset(
    input: { dataType: DataType; asset: DatasetAsset },
    context: RequestContext,
  ): Promise<AcceptedJob> {
    if (!this.mutations) throw new Error("Dataset validation is not configured.");
    return this.mutations.validateDataset(input, context);
  }

  async uploadDataset(
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
  ): Promise<AcceptedJob> {
    if (!this.mutations) throw new Error("Dataset upload is not configured.");
    return this.mutations.uploadDataset(input, context);
  }

  async searchDatasets(
    input: DatasetSearch,
    _context: RequestContext,
  ): Promise<Dataset[]> {
    return this.callRecords("listDatasetFiles", {
      ...(input.name ? { name: input.name } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.bbox ? { bbox: input.bbox } : {}),
      ...(input.dataType ? { data_type: input.dataType } : {}),
      status: input.status,
      ...(input.projectGroupId
        ? { tdei_project_group_id: input.projectGroupId }
        : {}),
      sort_field: input.sortField,
      sort_order: input.sortOrder,
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  async listServices(
    input: ServiceSearch,
    _context: RequestContext,
  ): Promise<TdeiService[]> {
    return this.callRecords("listServices", {
      ...(input.searchText ? { searchText: input.searchText } : {}),
      ...(input.projectGroupId
        ? { tdei_project_group_id: input.projectGroupId }
        : {}),
      ...(input.serviceType ? { service_type: input.serviceType } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  private async callRecords(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    if (this.isDenied(tool)) {
      throw new Error(`TDEI operation "${tool}" is disabled by config.`);
    }
    return decodeAwsRecords(await this.callTool(tool, input));
  }
}
