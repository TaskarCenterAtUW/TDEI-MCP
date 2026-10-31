import { TdeiHttpError } from "./tdei-http-error.js";
import { DirectMultipartTdeiMutations } from "./direct-multipart-tdei-mutations.js";
import { parseTdeiGetResponse } from "./tdei-get-response.js";
import { tryParseTdeiJson } from "./parse-tdei-json.js";
import type { ApiQuery, DatasetSearch, JobSearch, ServiceSearch, TdeiOperations } from "../intents/operations.js";
import { JOB_OPERATION_PATHS } from "../intents/operations.js";
import type {
  Dataset,
  ClientUploadInstruction,
  DatasetAsset,
  DatasetMetadata,
  DataType,
  JobRecord,
  RequestContext,
  TdeiService,
  ProjectGroup,
  ListProjectGroupsInput,
} from "../intents/types.js";

function appendIfDefined(params: URLSearchParams, name: string, value: string | number | undefined): void {
  if (value !== undefined) params.set(name, String(value));
}

export interface HttpTdeiOperationsOptions {
  tokenProvider?: () => Promise<string>;
}

function queryParams(query?: ApiQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

function toJobRecord(result: unknown): JobRecord {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as JobRecord;
  }
  if (typeof result === "string" && result.length > 0) {
    try {
      const parsed = JSON.parse(result) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JobRecord;
    } catch {
      /* fall through */
    }
    return { job_id: result };
  }
  return {};
}

function dataTypePath(dataType: DataType): string {
  if (dataType === "flex") return "gtfs-flex";
  if (dataType === "pathways") return "gtfs-pathways";
  return "osw";
}

export class HttpTdeiOperations implements TdeiOperations {
  private readonly baseUrl: string;
  private readonly mutations: DirectMultipartTdeiMutations;
  private readonly tokenProvider?: () => Promise<string>;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    options: HttpTdeiOperationsOptions = {},
  ) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    if (options.tokenProvider !== undefined) this.tokenProvider = options.tokenProvider;
    this.mutations = new DirectMultipartTdeiMutations({
      baseUrl,
      fetchImpl,
      timeoutMs,
      ...(options.tokenProvider !== undefined ? { tokenProvider: options.tokenProvider } : {}),
    });
  }

  private async resolveAccessToken(context: RequestContext): Promise<string> {
    if (context.accessToken) return context.accessToken;
    if (this.tokenProvider) return this.tokenProvider();
    throw new Error("TDEI_SSO_REQUIRED");
  }

  async searchDatasets(input: DatasetSearch, context: RequestContext): Promise<Dataset[]> {
    const params = new URLSearchParams();
    appendIfDefined(params, "name", input.name);
    appendIfDefined(params, "city", input.city);
    if (input.bbox) {
      for (const coordinate of input.bbox) params.append("bbox", String(coordinate));
    }
    appendIfDefined(params, "data_type", input.dataType);
    appendIfDefined(params, "status", input.status);
    appendIfDefined(params, "tdei_project_group_id", input.projectGroupId);
    appendIfDefined(params, "tdei_dataset_id", input.tdeiDatasetId);
    appendIfDefined(params, "collection_date", input.collectionDate);
    appendIfDefined(params, "sort_field", input.sortField);
    appendIfDefined(params, "sort_order", input.sortOrder);
    appendIfDefined(params, "page_no", input.page);
    appendIfDefined(params, "page_size", input.pageSize);
    return this.getRecords("api/v1/datasets", params, context);
  }

  async listJobs(input: JobSearch, context: RequestContext): Promise<JobRecord[]> {
    const params = new URLSearchParams();
    appendIfDefined(params, "job_id", input.jobId);
    appendIfDefined(params, "tdei_project_group_id", input.projectGroupId);
    if (input.includeGroupJobs !== undefined) {
      params.set("show_group_jobs", String(input.includeGroupJobs));
    }
    appendIfDefined(params, "job_type", input.jobType);
    appendIfDefined(params, "status", input.status);
    appendIfDefined(params, "page_no", input.page);
    appendIfDefined(params, "page_size", input.pageSize);
    return this.getRecords("api/v1/jobs", params, context);
  }

  async listServices(input: ServiceSearch, context: RequestContext): Promise<TdeiService[]> {
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
  ): Promise<ClientUploadInstruction> {
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
  ): Promise<ClientUploadInstruction> {
    return this.mutations.uploadDataset(input, context);
  }

  async publishDataset(
    input: { dataType: DataType; tdeiDatasetId: string },
    context: RequestContext,
  ): Promise<JobRecord> {
    const operation =
      input.dataType === "flex"
        ? "publishGtfsFlexFile"
        : input.dataType === "pathways"
          ? "publishGtfsPathwaysFile"
          : "publishOswFile";
    return this.launchJob({ operation, tdeiDatasetId: input.tdeiDatasetId }, context);
  }

  async deleteDataset(input: { tdeiDatasetId: string }, context: RequestContext): Promise<string> {
    return this.deleteText(`api/v1/dataset/${encodeURIComponent(input.tdeiDatasetId)}`, undefined, context);
  }

  async cloneDataset(
    input: {
      tdeiDatasetId: string;
      projectGroupId: string;
      serviceId: string;
      metadata: DatasetMetadata;
    },
    context: RequestContext,
  ): Promise<JobRecord> {
    const result = await this.mutations.postForm(
      `api/v1/dataset/clone/${encodeURIComponent(input.tdeiDatasetId)}/${encodeURIComponent(input.projectGroupId)}/${encodeURIComponent(input.serviceId)}`,
      { file: { json: input.metadata, filename: "metadata.json" } },
      context,
    );
    return toJobRecord(result);
  }

  async editMetadata(
    input: { tdeiDatasetId: string; metadata: DatasetMetadata },
    context: RequestContext,
  ): Promise<unknown> {
    const accessToken = await this.resolveAccessToken(context);
    const url = new URL(`api/v1/metadata/${encodeURIComponent(input.tdeiDatasetId)}`, this.baseUrl);
    const form = new FormData();
    form.set("file", new Blob([JSON.stringify(input.metadata)], { type: "application/json" }), "metadata.json");
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new TdeiHttpError(
        `TDEI request failed with status ${response.status} for editMetadata.`,
        response.status,
        text,
      );
    }
    if (!text) return { updated: true };
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async launchJob(
    input: {
      operation: string;
      tdeiDatasetId?: string;
      query?: ApiQuery;
      body?: Record<string, unknown>;
      assets?: Record<string, DatasetAsset>;
      fields?: Record<string, string>;
    },
    context: RequestContext,
  ): Promise<JobRecord> {
    const template = JOB_OPERATION_PATHS[input.operation];
    if (!template) throw new Error(`Unknown job operation "${input.operation}".`);
    const path = input.tdeiDatasetId
      ? template.replace("{id}", encodeURIComponent(input.tdeiDatasetId))
      : template.replace("/{id}", "");
    const hasFiles = input.assets && Object.keys(input.assets).length > 0;
    if (hasFiles || input.fields) {
      const result = await this.mutations.postForm(
        path,
        { ...input.assets, ...input.fields },
        context,
        queryParams(input.query),
      );
      return toJobRecord(result);
    }
    return toJobRecord(await this.postJson(path, input.query, input.body, context));
  }

  async listFeedbacks(
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
  ): Promise<JobRecord[]> {
    const params = queryParams({
      ...(input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {}),
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...(input.fromDate ? { from_date: input.fromDate } : {}),
      ...(input.toDate ? { to_date: input.toDate } : {}),
      ...(input.status ? { status: input.status } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
    return this.getRecords("api/v1/osw/dataset-viewer/feedbacks", params, context);
  }

  async getFeedbackSummary(input: { projectGroupId?: string }, context: RequestContext): Promise<unknown> {
    return this.getJson(
      "api/v1/osw/dataset-viewer/feedbacks/metadata",
      queryParams(input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {}),
      context,
    );
  }

  async downloadFeedbacks(
    input: {
      projectGroupId: string;
      tdeiDatasetId?: string;
      format?: string;
      fromDate?: string;
      toDate?: string;
      status?: string;
    },
    context: RequestContext,
  ): Promise<{ format?: string; text: string }> {
    const params = queryParams({
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.fromDate ? { from_date: input.fromDate } : {}),
      ...(input.toDate ? { to_date: input.toDate } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
    const text = await this.getText(
      `api/v1/osw/dataset-viewer/feedbacks/download/${encodeURIComponent(input.projectGroupId)}`,
      params,
      context,
    );
    return { ...(input.format ? { format: input.format } : {}), text };
  }

  async submitFeedback(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      feedback: Record<string, unknown>;
    },
    context: RequestContext,
  ): Promise<unknown> {
    return this.postJson(
      `api/v1/osw/dataset-viewer/feedbacks/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.tdeiDatasetId)}`,
      undefined,
      input.feedback,
      context,
    );
  }

  async updateFeedbackStatus(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      updates: Array<Record<string, unknown>>;
    },
    context: RequestContext,
  ): Promise<unknown> {
    const accessToken = await this.resolveAccessToken(context);
    const url = new URL(
      `api/v1/osw/dataset-viewer/feedbacks/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.tdeiDatasetId)}`,
      this.baseUrl,
    );
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(input.updates),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new TdeiHttpError(
        `TDEI request failed with status ${response.status} for updateFeedbackStatus.`,
        response.status,
        text,
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async getPmTilesUrl(input: { tdeiDatasetId: string }, context: RequestContext): Promise<string> {
    const text = await this.getText(
      `api/v1/osw/dataset-viewer/pm-tiles/${encodeURIComponent(input.tdeiDatasetId)}`,
      undefined,
      context,
    );
    return text;
  }

  async setViewerAccess(
    input: { tdeiDatasetId: string; allowViewerAccess: boolean },
    context: RequestContext,
  ): Promise<unknown> {
    return this.postJson(
      `api/v1/osw/dataset-viewer/${encodeURIComponent(input.tdeiDatasetId)}`,
      undefined,
      { allow_viewer_access: input.allowViewerAccess },
      context,
    );
  }

  async getMetrics(
    input: { scope: "data" | "service" | "system"; projectGroupId?: string },
    context: RequestContext,
  ): Promise<unknown> {
    if (input.scope === "service") {
      if (!input.projectGroupId) throw new Error("projectGroupId is required for service metrics.");
      return this.getJson(`api/v1/service-metrics/${encodeURIComponent(input.projectGroupId)}`, undefined, context);
    }
    return this.getJson(input.scope === "system" ? "api/v1/system-metrics" : "api/v1/data-metrics", undefined, context);
  }

  async listVersions(input: { dataType: DataType }, context: RequestContext): Promise<unknown> {
    return this.getJson(`api/v1/${dataTypePath(input.dataType)}/versions`, undefined, context);
  }

  async getCapabilities(context: RequestContext): Promise<unknown> {
    return this.getJson("api/v1/system/capabilities", undefined, context);
  }

  async listApiVersions(context: RequestContext): Promise<unknown> {
    return this.getJson("api/v1/api", undefined, context);
  }

  async verifyEmail(input: { email: string }, context: RequestContext): Promise<unknown> {
    return this.postText("api/v1/verify-email", input.email, context);
  }

  async recoverPassword(input: { email: string }, context: RequestContext): Promise<unknown> {
    return this.postText("api/v1/recover-password", input.email, context);
  }

  async regenerateApiKey(context: RequestContext): Promise<string> {
    const result = await this.postJson("api/v1/regenerate-api-key", undefined, undefined, context);
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  private async requestText(
    method: string,
    path: string,
    params: URLSearchParams | undefined,
    context: RequestContext,
    body?: { text: string; contentType: string },
  ): Promise<{ status: number; text: string }> {
    const accessToken = await this.resolveAccessToken(context);
    const url = new URL(path, this.baseUrl);
    if (params) url.search = params.toString();
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json, text/plain, application/text, text/csv, application/geo+json",
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": body.contentType } : {}),
      },
      ...(body ? { body: body.text } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  }

  private async getJson(path: string, params: URLSearchParams | undefined, context: RequestContext): Promise<unknown> {
    const { status, text } = await this.requestText("GET", path, params, context);
    if (status < 200 || status >= 300) {
      throw new TdeiHttpError(`TDEI request failed with status ${status} for ${path}.`, status, text);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async getText(path: string, params: URLSearchParams | undefined, context: RequestContext): Promise<string> {
    const { status, text } = await this.requestText("GET", path, params, context);
    if (status < 200 || status >= 300) {
      throw new TdeiHttpError(`TDEI request failed with status ${status} for ${path}.`, status, text);
    }
    return text;
  }

  private async postJson(
    path: string,
    query: ApiQuery | undefined,
    body: Record<string, unknown> | undefined,
    context: RequestContext,
  ): Promise<unknown> {
    const { status, text } = await this.requestText(
      "POST",
      path,
      queryParams(query),
      context,
      body === undefined ? undefined : { text: JSON.stringify(body), contentType: "application/json" },
    );
    if (status < 200 || status >= 300) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        /* keep text */
      }
      throw new TdeiHttpError(`TDEI request failed with status ${status} for ${path}.`, status, parsed);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async postText(path: string, textBody: string, context: RequestContext): Promise<unknown> {
    const { status, text } = await this.requestText("POST", path, undefined, context, {
      text: textBody,
      contentType: "text/plain",
    });
    if (status < 200 || status >= 300) {
      throw new TdeiHttpError(`TDEI request failed with status ${status} for ${path}.`, status, text);
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async deleteText(
    path: string,
    params: URLSearchParams | undefined,
    context: RequestContext,
  ): Promise<string> {
    const { status, text } = await this.requestText("DELETE", path, params, context);
    if (status < 200 || status >= 300) {
      throw new TdeiHttpError(`TDEI request failed with status ${status} for ${path}.`, status, text);
    }
    return text;
  }

  private async getRecords(
    path: string,
    params: URLSearchParams,
    context: RequestContext,
  ): Promise<Array<Record<string, unknown>>> {
    const accessToken = await this.resolveAccessToken(context);
    const url = new URL(path, this.baseUrl);
    url.search = params.toString();
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    const body: unknown = text ? tryParseTdeiJson(text) : text;
    if (!response.ok) {
      throw new TdeiHttpError(`TDEI request failed with status ${response.status}.`, response.status, body);
    }
    const parsed = parseTdeiGetResponse(body);
    if (parsed.kind === "text") {
      throw new Error(
        `TDEI upstream returned non-JSON response: ${String(parsed.body).replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
    // List GET callers expect rows. Object GETs (metrics) are not routed here.
    if (parsed.kind === "object") {
      throw new Error(
        `TDEI list endpoint returned an object body without a record array (keys: ${Object.keys(parsed.body as object).join(", ")}).`,
      );
    }
    return parsed.records;
  }
}
