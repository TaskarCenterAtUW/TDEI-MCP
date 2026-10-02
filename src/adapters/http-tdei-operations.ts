import { TdeiHttpError } from "./tdei-http-error.js";
import { DirectMultipartTdeiMutations } from "./direct-multipart-tdei-mutations.js";
import type {
  DatasetSearch,
  ServiceSearch,
  TdeiOperations,
} from "../intents/operations.js";
import type {
  Dataset,
  AcceptedJob,
  DatasetAsset,
  DatasetMetadata,
  DataType,
  RequestContext,
  TdeiService,
  ProjectGroup,
  ListProjectGroupsInput,
} from "../intents/types.js";

function appendIfDefined(
  params: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) params.set(name, String(value));
}

function recordsFrom(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    for (const key of ["data", "datasets", "results", "services", "project_groups", "projectGroups"]) {
      const nested = (value as Record<string, unknown>)[key];
      if (Array.isArray(nested)) return recordsFrom(nested);
    }
  }
  return [];
}

export class HttpTdeiOperations implements TdeiOperations {
  private readonly baseUrl: string;
  private readonly mutations: DirectMultipartTdeiMutations;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.mutations = new DirectMultipartTdeiMutations({
      baseUrl,
      fetchImpl,
      allowedAssetKinds: new Set(["inline_base64"]),
      timeoutMs,
    });
  }

  async searchDatasets(
    input: DatasetSearch,
    context: RequestContext,
  ): Promise<Dataset[]> {
    const params = new URLSearchParams();
    appendIfDefined(params, "name", input.name);
    appendIfDefined(params, "city", input.city);
    if (input.bbox) {
      for (const coordinate of input.bbox) params.append("bbox", String(coordinate));
    }
    appendIfDefined(params, "data_type", input.dataType);
    appendIfDefined(params, "status", input.status);
    appendIfDefined(params, "tdei_project_group_id", input.projectGroupId);
    appendIfDefined(params, "sort_field", input.sortField);
    appendIfDefined(params, "sort_order", input.sortOrder);
    appendIfDefined(params, "page_no", input.page);
    appendIfDefined(params, "page_size", input.pageSize);
    return this.getRecords("api/v1/datasets", params, context);
  }

  async listServices(
    input: ServiceSearch,
    context: RequestContext,
  ): Promise<TdeiService[]> {
    const params = new URLSearchParams();
    appendIfDefined(params, "searchText", input.searchText);
    appendIfDefined(params, "tdei_project_group_id", input.projectGroupId);
    appendIfDefined(params, "service_type", input.serviceType);
    appendIfDefined(params, "page_no", input.page);
    appendIfDefined(params, "page_size", input.pageSize);
    return this.getRecords("api/v1/services", params, context);
  }

  async listProjectGroups(
    input: Required<Pick<ListProjectGroupsInput, "page" | "pageSize">> & Pick<ListProjectGroupsInput, "searchText">,
    context: RequestContext,
  ): Promise<ProjectGroup[]> {
    const params = new URLSearchParams();
    appendIfDefined(params, "searchText", input.searchText);
    appendIfDefined(params, "page_no", input.page);
    appendIfDefined(params, "page_size", input.pageSize);
    return this.getRecords("api/v1/project-groups", params, context);
  }

  async validateDataset(
    input: { dataType: DataType; asset: DatasetAsset },
    context: RequestContext,
  ): Promise<AcceptedJob> {
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
    return this.mutations.uploadDataset(input, context);
  }

  private async getRecords(
    path: string,
    params: URLSearchParams,
    context: RequestContext,
  ): Promise<Array<Record<string, unknown>>> {
    if (!context.accessToken) throw new Error("TDEI_SSO_REQUIRED");
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${context.accessToken}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new TdeiHttpError(
        `TDEI request failed with status ${response.status}.`,
        response.status,
        body,
      );
    }
    return recordsFrom(body);
  }

}
