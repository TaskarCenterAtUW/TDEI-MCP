import { decodeOpenApiRecords } from "./openapi-result-decoder.js";
import type { ApiQuery, DatasetSearch, JobSearch, ServiceSearch, TdeiOperations } from "../intents/operations.js";
import type {
  DataType,
  ClientUploadInstruction,
  DatasetAsset,
  DatasetMetadata,
  Dataset,
  JobRecord,
  RequestContext,
  TdeiService,
  ProjectGroup,
  ListProjectGroupsInput,
} from "../intents/types.js";

export type TdeiOpenApiToolCaller = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

export class OpenApiTdeiOperations implements TdeiOperations {
  constructor(
    private readonly callTool: TdeiOpenApiToolCaller,
    private readonly isDenied: (tool: string) => boolean = () => false,
    private readonly mutations?: Required<Pick<TdeiOperations, "validateDataset" | "uploadDataset">>,
  ) {}

  async validateDataset(
    input: { dataType: DataType; asset: DatasetAsset },
    context: RequestContext,
  ): Promise<ClientUploadInstruction> {
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
  ): Promise<ClientUploadInstruction> {
    if (!this.mutations) throw new Error("Dataset upload is not configured.");
    return this.mutations.uploadDataset(input, context);
  }

  async searchDatasets(input: DatasetSearch, _context: RequestContext): Promise<Dataset[]> {
    return this.callRecords("listDatasetFiles", {
      ...(input.name ? { name: input.name } : {}),
      ...(input.city ? { city: input.city } : {}),
      ...(input.bbox ? { bbox: input.bbox } : {}),
      ...(input.dataType ? { data_type: input.dataType } : {}),
      status: input.status,
      ...(input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {}),
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...(input.collectionDate ? { collection_date: input.collectionDate } : {}),
      sort_field: input.sortField,
      sort_order: input.sortOrder,
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  async listJobs(input: JobSearch, _context: RequestContext): Promise<JobRecord[]> {
    return this.callRecords("listJobs", {
      ...(input.jobId ? { job_id: input.jobId } : {}),
      tdei_project_group_id: input.projectGroupId,
      ...(input.includeGroupJobs !== undefined ? { show_group_jobs: input.includeGroupJobs } : {}),
      ...(input.jobType ? { job_type: input.jobType } : {}),
      ...(input.status ? { status: input.status } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  async publishDataset(
    input: { dataType: DataType; tdeiDatasetId: string },
    _context: RequestContext,
  ): Promise<JobRecord> {
    const tool =
      input.dataType === "flex"
        ? "publishGtfsFlexFile"
        : input.dataType === "pathways"
          ? "publishGtfsPathwaysFile"
          : "publishOswFile";
    return this.callObject(tool, { tdei_dataset_id: input.tdeiDatasetId });
  }

  async deleteDataset(input: { tdeiDatasetId: string }, _context: RequestContext): Promise<string> {
    const result = await this.callTool("deleteDataset", { tdei_dataset_id: input.tdeiDatasetId });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  async cloneDataset(
    input: {
      tdeiDatasetId: string;
      projectGroupId: string;
      serviceId: string;
      metadata: DatasetMetadata;
    },
    _context: RequestContext,
  ): Promise<JobRecord> {
    if (!this.mutations) throw new Error("Dataset clone is not configured.");
    return this.callObject("cloneDataset", {
      tdei_dataset_id: input.tdeiDatasetId,
      tdei_project_group_id: input.projectGroupId,
      tdei_service_id: input.serviceId,
      file: JSON.stringify(input.metadata),
    });
  }

  async editMetadata(
    input: { tdeiDatasetId: string; metadata: DatasetMetadata },
    _context: RequestContext,
  ): Promise<unknown> {
    return this.callTool("editMetadata", {
      tdei_dataset_id: input.tdeiDatasetId,
      file: JSON.stringify(input.metadata),
    });
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
    _context: RequestContext,
  ): Promise<JobRecord> {
    if (input.assets && !this.mutations) {
      throw new Error("File-based job inputs need a multipart mutation adapter.");
    }
    return this.callObject(input.operation, {
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...input.query,
      ...input.body,
      ...input.fields,
    });
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
    _context: RequestContext,
  ): Promise<JobRecord[]> {
    return this.callRecords("oswDatasetViewerFeedbacks", {
      ...(input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {}),
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...(input.fromDate ? { from_date: input.fromDate } : {}),
      ...(input.toDate ? { to_date: input.toDate } : {}),
      ...(input.status ? { status: input.status } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  async getFeedbackSummary(input: { projectGroupId?: string }, _context: RequestContext): Promise<unknown> {
    return this.callTool(
      "oswDatasetViewerFeedbacksMetadata",
      input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {},
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
    _context: RequestContext,
  ): Promise<{ format?: string; text: string }> {
    const result = await this.callTool("oswDatasetViewerFeedbacksDownload", {
      tdei_project_group_id: input.projectGroupId,
      ...(input.tdeiDatasetId ? { tdei_dataset_id: input.tdeiDatasetId } : {}),
      ...(input.format ? { format: input.format } : {}),
      ...(input.fromDate ? { from_date: input.fromDate } : {}),
      ...(input.toDate ? { to_date: input.toDate } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { ...(input.format ? { format: input.format } : {}), text };
  }

  async submitFeedback(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      feedback: Record<string, unknown>;
    },
    _context: RequestContext,
  ): Promise<unknown> {
    return this.callTool("oswDatasetViewerFeedback", {
      project_id: input.projectId,
      tdei_dataset_id: input.tdeiDatasetId,
      ...input.feedback,
    });
  }

  async updateFeedbackStatus(
    input: {
      projectId: string;
      tdeiDatasetId: string;
      updates: Array<Record<string, unknown>>;
    },
    _context: RequestContext,
  ): Promise<unknown> {
    return this.callTool("oswDatasetViewerFeedbackStatusUpdate", {
      project_id: input.projectId,
      tdei_dataset_id: input.tdeiDatasetId,
      feedbacks: input.updates,
    });
  }

  async getPmTilesUrl(input: { tdeiDatasetId: string }, _context: RequestContext): Promise<string> {
    const result = await this.callTool("oswDatasetViewerPMTiles", {
      tdei_dataset_id: input.tdeiDatasetId,
    });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  async setViewerAccess(
    input: { tdeiDatasetId: string; allowViewerAccess: boolean },
    _context: RequestContext,
  ): Promise<unknown> {
    return this.callTool("oswDatasetViewer", {
      tdei_dataset_id: input.tdeiDatasetId,
      allow_viewer_access: input.allowViewerAccess,
    });
  }

  async getMetrics(
    input: { scope: "data" | "service" | "system"; projectGroupId?: string },
    _context: RequestContext,
  ): Promise<unknown> {
    if (input.scope === "service") {
      if (!input.projectGroupId) throw new Error("projectGroupId is required for service metrics.");
      return this.callTool("service-metrics", { tdei_project_group_id: input.projectGroupId });
    }
    return this.callTool(input.scope === "system" ? "system-metrics" : "data-metrics", {});
  }

  async listVersions(input: { dataType: DataType }, _context: RequestContext): Promise<unknown> {
    const tool =
      input.dataType === "flex"
        ? "listGtfsFlexVersions"
        : input.dataType === "pathways"
          ? "listGtfsPathwaysVersions"
          : "listOswVersions";
    return this.callTool(tool, {});
  }

  async getCapabilities(_context: RequestContext): Promise<unknown> {
    return this.callTool("system-capabilities", {});
  }

  async listApiVersions(_context: RequestContext): Promise<unknown> {
    return this.callTool("listApiVersions", {});
  }

  async verifyEmail(input: { email: string }, _context: RequestContext): Promise<unknown> {
    return this.callTool("verifyEmail", { email: input.email });
  }

  async recoverPassword(input: { email: string }, _context: RequestContext): Promise<unknown> {
    return this.callTool("recoverPassword", { email: input.email });
  }

  async regenerateApiKey(_context: RequestContext): Promise<string> {
    const result = await this.callTool("regenerateApiKey", {});
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  async listServices(input: ServiceSearch, _context: RequestContext): Promise<TdeiService[]> {
    return this.callRecords("listServices", {
      ...(input.searchText ? { searchText: input.searchText } : {}),
      ...(input.projectGroupId ? { tdei_project_group_id: input.projectGroupId } : {}),
      ...(input.serviceType ? { service_type: input.serviceType } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  async listProjectGroups(
    input: Required<Pick<ListProjectGroupsInput, "page" | "pageSize">> & Pick<ListProjectGroupsInput, "searchText">,
    _context: RequestContext,
  ): Promise<ProjectGroup[]> {
    return this.callRecords("listProjectGroups", {
      ...(input.searchText ? { searchText: input.searchText } : {}),
      page_no: input.page,
      page_size: input.pageSize,
    });
  }

  private async callRecords(tool: string, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    if (this.isDenied(tool)) {
      throw new Error(`TDEI operation "${tool}" is disabled by config.`);
    }
    return decodeOpenApiRecords(await this.callTool(tool, input));
  }

  private async callObject(tool: string, input: Record<string, unknown>): Promise<JobRecord> {
    if (this.isDenied(tool)) {
      throw new Error(`TDEI operation "${tool}" is disabled by config.`);
    }
    const result = await this.callTool(tool, input);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as JobRecord;
    }
    if (typeof result === "string") return { job_id: result };
    return { result };
  }
}
