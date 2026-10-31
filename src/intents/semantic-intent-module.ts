import type { TdeiOperations } from "./operations.js";
import type { PlaceResolver } from "./place-resolver.js";
import { extractAuthIdentity } from "../auth/auth-manager.js";
import { signInText } from "../mcp/errors.js";
import type {
  CheckInclineData,
  CloneDatasetInput,
  ConfidenceInput,
  ConvertOswInput,
  ConvertPathwaysInput,
  CutBboxInput,
  DeleteDatasetInput,
  DownloadDatasetData,
  DownloadDatasetInput,
  DownloadFeedbacksData,
  DownloadFeedbacksInput,
  EditMetadataInput,
  FeedbackSummaryData,
  FindDatasetsData,
  FindDatasetsInput,
  GetMetricsData,
  GetMetricsInput,
  GetMyIdentityData,
  IntentResult,
  ListFeedbacksData,
  ListFeedbacksInput,
  ListJobsData,
  ListJobsInput,
  ListServicesData,
  ListServicesInput,
  ListProjectGroupsData,
  ListProjectGroupsInput,
  ListVersionsData,
  MyIdentity,
  PublishDatasetInput,
  QualityIntersectionInput,
  QualityTagInput,
  RecoverPasswordInput,
  RegenerateApiKeyInput,
  RequestContext,
  AcceptedJob,
  SanitizeInput,
  SelfMergeInput,
  SpatialJoinInput,
  SubmitFeedbackInput,
  SystemInfoData,
  TagInclineInput,
  TagRoadInput,
  UnionDatasetsInput,
  UpdateFeedbackStatusInput,
  UploadDatasetInput,
  ValidateDatasetInput,
  VerifyEmailInput,
  JobRecord,
  DataType,
  DatasetAsset,
} from "./types.js";

export type { TdeiOperations } from "./operations.js";
export type { PlaceResolver } from "./place-resolver.js";

type IdentityProvider = () => MyIdentity | undefined;

export interface SemanticIntentDependencies {
  operations: TdeiOperations;
  places: PlaceResolver;
  identityProvider?: IdentityProvider;
  /**
   * Public TDEI API base URL used to build the client-side curl command
   * (e.g. https://api-dev.tdei.us). Falls back to TDEI_API_URL env.
   */
  apiUrl?: string;
}

function uploadedTimestampMs(dataset: Record<string, unknown>): number | undefined {
  const raw = dataset.uploaded_timestamp ?? dataset.uploaded_on ?? dataset.created_at;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function createdTimestampMs(job: Record<string, unknown>): number | undefined {
  const raw = job.created_at ?? job.updated_at;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function resolveCutoffMs(after?: string, withinDays?: number): number | undefined {
  if (after?.trim()) {
    const ms = Date.parse(after.trim());
    if (Number.isFinite(ms)) return ms;
  }
  if (withinDays !== undefined && Number.isFinite(withinDays) && withinDays >= 0) {
    return Date.now() - withinDays * 86_400_000;
  }
  return undefined;
}

export class SemanticIntentModule {
  constructor(private readonly dependencies: SemanticIntentDependencies) {}

  async findDatasets(input: FindDatasetsInput, context: RequestContext = {}): Promise<IntentResult<FindDatasetsData>> {
    const pageSize = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const cutoffMs = resolveCutoffMs(input.uploadedAfter, input.uploadedWithinDays);
    const applyCutoff = <T extends Record<string, unknown>>(items: T[]): T[] =>
      cutoffMs === undefined
        ? items
        : items.filter((item) => {
            const ts = uploadedTimestampMs(item);
            return ts !== undefined && ts >= cutoffMs;
          });
    const common = {
      ...(input.dataType ? { dataType: input.dataType } : {}),
      status: input.status ?? ("All" as const),
      sortField: "uploaded_timestamp" as const,
      sortOrder: "desc" as const,
      page: 1,
      pageSize,
    };

    // Exact id lookup (release-status / incline follow-ups). The API
    // supports tdei_dataset_id directly; date filtering is client-side.
    if (input.tdeiDatasetId?.trim()) {
      const datasets = applyCutoff(
        await this.dependencies.operations.searchDatasets(
          { ...common, tdeiDatasetId: input.tdeiDatasetId.trim() },
          context,
        ),
      );
      return {
        status: "complete",
        data: {
          matches: datasets.map((dataset) => ({
            dataset,
            matchedBy: "dataset_id" as const,
            evidence: `tdei_dataset_id = ${input.tdeiDatasetId?.trim()}`,
          })),
          ...(input.latest && datasets[0] ? { selected: datasets[0] } : {}),
          effectiveSort: { field: "uploaded_timestamp", order: "desc" },
        },
      };
    }

    if (input.bbox) {
      const datasets = applyCutoff(
        await this.dependencies.operations.searchDatasets({ ...common, bbox: input.bbox }, context),
      );
      return {
        status: "complete",
        data: {
          matches: datasets.map((dataset) => ({
            dataset,
            matchedBy: "bbox" as const,
            evidence: `explicit bbox ${input.bbox?.join(",")}`,
          })),
          ...(input.latest && datasets[0] ? { selected: datasets[0] } : {}),
          effectiveSort: { field: "uploaded_timestamp", order: "desc" },
        },
      };
    }

    if (input.projectGroupId) {
      const datasets = applyCutoff(
        await this.dependencies.operations.searchDatasets({ ...common, projectGroupId: input.projectGroupId }, context),
      );
      return {
        status: "complete",
        data: {
          matches: datasets.map((dataset) => ({
            dataset,
            matchedBy: "project_group" as const,
            evidence: `project group ${input.projectGroupId}`,
          })),
          ...(input.latest && datasets[0] ? { selected: datasets[0] } : {}),
          effectiveSort: { field: "uploaded_timestamp", order: "desc" },
        },
      };
    }

    if (!input.place) {
      return {
        status: "needs_input",
        missing: [{ field: "place", question: "Which place should I search for?" }],
        accepted: {},
      };
    }

    let datasets = applyCutoff(
      await this.dependencies.operations.searchDatasets({ ...common, name: input.place }, context),
    );
    let matchedBy: "name" | "city" | "bbox" = "name";
    let evidence = `name contains ${input.place}`;
    if (datasets.length === 0) {
      datasets = applyCutoff(
        await this.dependencies.operations.searchDatasets({ ...common, city: input.place }, context),
      );
      matchedBy = "city";
      evidence = `city contains ${input.place}`;
    }
    if (datasets.length === 0) {
      const placeCandidates = await this.dependencies.places.forwardGeocode(input.place);
      if (placeCandidates.length > 1) {
        return {
          status: "ambiguous",
          candidates: placeCandidates.map((candidate) => ({
            label: candidate.label,
            bbox: candidate.bbox,
            ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
            ...(candidate.providerId !== undefined ? { providerId: candidate.providerId } : {}),
          })),
          accepted: { ...input },
        };
      }
      const resolved = placeCandidates[0];
      if (resolved) {
        datasets = applyCutoff(
          await this.dependencies.operations.searchDatasets({ ...common, bbox: resolved.bbox }, context),
        );
        matchedBy = "bbox";
        evidence = `bbox for ${resolved.label}`;
      }
    }
    const matches = datasets.map((dataset) => ({
      dataset,
      matchedBy,
      evidence,
    }));

    return {
      status: "complete",
      data: {
        matches,
        ...(input.latest && datasets[0] ? { selected: datasets[0] } : {}),
        effectiveSort: { field: "uploaded_timestamp", order: "desc" },
      },
    };
  }

  async listServices(
    input: ListServicesInput = {},
    context: RequestContext = {},
  ): Promise<IntentResult<ListServicesData>> {
    const appliedFilters: ListServicesInput & { page: number; pageSize: number } = {
      ...(input.searchText ? { searchText: input.searchText } : {}),
      ...(input.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
      ...(input.serviceType ? { serviceType: input.serviceType } : {}),
      page: Math.max(input.page ?? 1, 1),
      pageSize: Math.min(Math.max(input.pageSize ?? 10, 1), 50),
    };
    const services = await this.dependencies.operations.listServices(appliedFilters, context);
    return {
      status: "complete",
      data: {
        services,
        appliedFilters,
        apiOperation: "listServices",
        method: "GET",
        path: "/api/v1/services",
      },
    };
  }

  async listMyProjectGroups(
    input: ListProjectGroupsInput = {},
    context: RequestContext = {},
  ): Promise<IntentResult<ListProjectGroupsData>> {
    const appliedFilters = {
      ...(input.searchText ? { searchText: input.searchText } : {}),
      page: Math.max(input.page ?? 1, 1),
      pageSize: Math.min(Math.max(input.pageSize ?? 50, 1), 50),
    };
    return {
      status: "complete",
      data: {
        projectGroups: await this.dependencies.operations.listProjectGroups(appliedFilters, context),
        appliedFilters,
        accessScope: "authenticated_user",
        scopeExplanation:
          "These are all project groups visible to your login (an admin login sees all groups), NOT confirmed membership. TDEI reports only poc contacts per group, not members. For your login email call tdei_get_my_identity. For full membership check the TDEI portal user/role screen. Use searchText to narrow, do not POC-filter.",
        apiOperation: "listProjectGroups",
        method: "GET",
        path: "/api/v1/project-groups",
      },
    };
  }

  async validateDataset(input: ValidateDatasetInput, context: RequestContext = {}): Promise<IntentResult<AcceptedJob>> {
    const missing = [
      ...(!input.dataType
        ? [
            {
              field: "dataType",
              question: "Is this dataset OSW, GTFS Flex, or GTFS Pathways?",
              allowedValues: ["osw", "flex", "pathways"],
            },
          ]
        : []),
      ...(!input.asset
        ? [
            {
              field: "asset",
              question:
                'Which dataset ZIP should be validated? MCP never takes file bytes — run curl from your machine: curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/validate" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip", then poll with tdei_list_jobs.',
            },
          ]
        : []),
    ];
    if (missing.length > 0) {
      return {
        status: "needs_input",
        missing,
        accepted: input.dataType ? { dataType: input.dataType } : {},
      };
    }
    if (!this.dependencies.operations.validateDataset) {
      return {
        status: "unsupported",
        reason: "Dataset validation is not supported by this deployment adapter.",
      };
    }
    return {
      status: "complete",
      data: await this.dependencies.operations.validateDataset(
        {
          dataType: input.dataType as NonNullable<typeof input.dataType>,
          asset: input.asset as NonNullable<typeof input.asset>,
        },
        context,
      ),
    };
  }

  async uploadDataset(input: UploadDatasetInput, context: RequestContext = {}): Promise<IntentResult<AcceptedJob>> {
    const detail = input.metadata?.dataset_detail;
    const requiredMetadata: Array<[keyof NonNullable<typeof detail>, string]> = [
      ["name", "What is the dataset name?"],
      ["version", "What is the dataset version?"],
      ["collected_by", "Who collected the dataset?"],
      ["collection_date", "When was the dataset collected?"],
      ["data_source", "What is the data source?"],
      ["schema_version", "Which schema version does the dataset use?"],
    ];
    const missing = [
      ...(!input.dataType
        ? [
            {
              field: "dataType",
              question: "Is this dataset OSW, GTFS Flex, or GTFS Pathways?",
              allowedValues: ["osw", "flex", "pathways"],
            },
          ]
        : []),
      ...(!input.asset
        ? [
            {
              field: "asset",
              question:
                'Which dataset ZIP should be uploaded? MCP never takes file bytes — run curl from your machine: curl -X POST "<apiUrl>/api/v1/{osw|gtfs-flex|gtfs-pathways}/upload/{projectGroupId}/{serviceId}" -H "Authorization: Bearer $TDEI_TOKEN" -F "dataset=@/path/to/file.zip" -F "metadata=@metadata.json", then poll with tdei_list_jobs.',
            },
          ]
        : []),
      ...(!input.projectGroupId
        ? [{ field: "projectGroupId", question: "Which project group should receive the dataset?" }]
        : []),
      ...(!input.serviceId ? [{ field: "serviceId", question: "Which TDEI service should receive the dataset?" }] : []),
      ...requiredMetadata.flatMap(([field, question]) =>
        detail?.[field]
          ? []
          : [
              {
                field: `metadata.dataset_detail.${String(field)}`,
                question,
                ...(field === "data_source" ? { allowedValues: ["3rdParty", "TDEITools", "InHouse"] } : {}),
              },
            ],
      ),
    ];
    if (missing.length > 0) {
      const accepted: Record<string, unknown> = {
        ...(input.dataType ? { dataType: input.dataType } : {}),
        ...(input.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      return { status: "needs_input", missing, accepted };
    }
    if (!this.dependencies.operations.uploadDataset) {
      return {
        status: "unsupported",
        reason: "Dataset upload is not supported by this deployment adapter.",
      };
    }
    return {
      status: "complete",
      data: await this.dependencies.operations.uploadDataset(
        {
          dataType: input.dataType as NonNullable<typeof input.dataType>,
          asset: input.asset as NonNullable<typeof input.asset>,
          projectGroupId: input.projectGroupId as string,
          serviceId: input.serviceId as string,
          metadata: input.metadata as NonNullable<typeof input.metadata>,
          ...(input.derivedFromDatasetId ? { derivedFromDatasetId: input.derivedFromDatasetId } : {}),
          ...(input.changeset ? { changeset: input.changeset } : {}),
        },
        context,
      ),
    };
  }

  /** Identity/roles from the SSO JWT (no roles endpoint exists in the TDEI API). */
  async getMyIdentity(context: RequestContext = {}): Promise<IntentResult<GetMyIdentityData>> {
    const fromProvider = this.dependencies.identityProvider?.();
    if (fromProvider) {
      return {
        status: "complete",
        data: {
          authenticated: true,
          identity: fromProvider,
          hint: "Roles come from SSO JWT claims (realm_access/resource_access); TDEI has no roles endpoint.",
        },
      };
    }
    const fromToken = context.accessToken ? extractAuthIdentity(context.accessToken) : undefined;
    if (fromToken) {
      return {
        status: "complete",
        data: {
          authenticated: true,
          identity: fromToken,
          hint: "Roles come from SSO JWT claims (realm_access/resource_access); TDEI has no roles endpoint.",
        },
      };
    }
    return {
      status: "complete",
      data: {
        authenticated: false,
        hint: `Not authenticated. ${signInText()} Then retry tdei_get_my_identity.`,
      },
    };
  }

  /**
   * Jobs across project groups. The API requires tdei_project_group_id, so
   * without one this fans out across the caller's groups. Date filtering is
   * client-side on created_at (the API has no date param).
   */
  async listJobs(input: ListJobsInput = {}, context: RequestContext = {}): Promise<IntentResult<ListJobsData>> {
    const pageSize = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const cutoffMs = resolveCutoffMs(input.createdAfter, input.createdWithinDays);
    let groupIds: string[] = [];
    if (input.projectGroupId?.trim()) {
      groupIds = [input.projectGroupId.trim()];
    } else {
      const groups = await this.dependencies.operations.listProjectGroups({ page: 1, pageSize: 50 }, context);
      groupIds = groups
        .map((group) => group.tdei_project_group_id ?? group.id ?? group.project_group_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    }
    const searchedProjectGroups = groupIds;
    const collected: Array<Record<string, unknown>> = [];
    for (const groupId of groupIds) {
      try {
        const jobs = await this.dependencies.operations.listJobs(
          {
            ...(input.jobId?.trim() ? { jobId: input.jobId.trim() } : {}),
            projectGroupId: groupId,
            ...(input.includeGroupJobs !== undefined ? { includeGroupJobs: input.includeGroupJobs } : {}),
            ...(input.jobType ? { jobType: input.jobType } : {}),
            ...(input.status ? { status: input.status } : {}),
            page: 1,
            pageSize,
          },
          context,
        );
        collected.push(...jobs);
      } catch {
        // One inaccessible group must not fail the whole fan-out.
      }
      if (collected.length >= pageSize * Math.max(groupIds.length, 1)) break;
    }
    const filtered = (
      cutoffMs === undefined
        ? collected
        : collected.filter((job) => {
            const ts = createdTimestampMs(job);
            return ts !== undefined && ts >= cutoffMs;
          })
    ).slice(0, pageSize);
    return {
      status: "complete",
      data: {
        jobs: filtered,
        appliedFilters: { ...input, searchedProjectGroups },
        apiOperation: "listJobs",
        method: "GET",
        path: "/api/v1/jobs",
        scopeNote: input.projectGroupId
          ? "Jobs for the requested project group."
          : "The jobs API requires a project group, so this fanned out across your accessible groups.",
      },
    };
  }

  /**
   * Dataset details by id (status/release + metadata). For incline
   * presence there is no metadata flag: download the OSW ZIP via the
   * getOswFile raw tool and inspect edges for an incline tag; use
   * datasetTagIncline to add it.
   */
  async getDatasetDetails(
    input: { tdeiDatasetId: string; dataType?: FindDatasetsInput["dataType"] },
    context: RequestContext = {},
  ): Promise<IntentResult<FindDatasetsData & { inclineNote: string }>> {
    const id = input.tdeiDatasetId.trim();
    if (!id) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should I look up?" }],
        accepted: {},
      };
    }
    const result = await this.findDatasets(
      {
        tdeiDatasetId: id,
        ...(input.dataType ? { dataType: input.dataType } : {}),
        limit: 5,
      },
      context,
    );
    if (result.status !== "complete") return result as IntentResult<FindDatasetsData & { inclineNote: string }>;
    return {
      status: "complete",
      data: {
        ...result.data,
        inclineNote:
          "Incline presence is not in dataset metadata. Use tdei_check_dataset_incline for an automatic verdict, or download the dataset ZIP with tdei_download_dataset and inspect edges files; to tag it, call tdei_tag_incline.",
      },
    };
  }

  /**
   * Build a client-side dataset download command. The MCP server never
   * writes files and never touches dataset bytes: it resolves the dataset
   * id + data type, requires the user-connected client folder
   * (outputDir, via needs_input when missing), and returns a ready-to-run
   * curl command the LLM executes on the CLIENT machine into that folder.
   */
  async downloadDataset(
    input: DownloadDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<DownloadDatasetData>> {
    const id = input.tdeiDatasetId?.trim() ?? "";
    if (!id) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be downloaded?" }],
        accepted: {},
      };
    }
    const outputDir = input.outputDir?.trim() ?? "";
    if (!outputDir) {
      return {
        status: "needs_input",
        missing: [
          {
            field: "outputDir",
            question:
              "Which absolute folder on your machine should the dataset ZIP be saved to? Connect a folder (e.g. /Users/you/downlaods) and reply with its absolute path.",
          },
        ],
        accepted: { tdeiDatasetId: id },
      };
    }
    let dataType: DataType | undefined = input.dataType;
    let datasetName: string | undefined;
    if (!dataType) {
      const lookup = await this.findDatasets({ tdeiDatasetId: id, limit: 5 }, context);
      if (lookup.status === "complete" && lookup.data.matches[0]) {
        const raw = String(
          lookup.data.matches[0].dataset.data_type ?? lookup.data.matches[0].dataset.dataType ?? "",
        ).toLowerCase();
        if (raw.includes("flex")) dataType = "flex";
        else if (raw.includes("pathway")) dataType = "pathways";
        else dataType = "osw";
        const name = lookup.data.matches[0].dataset.name ?? lookup.data.matches[0].dataset.dataset_name;
        if (typeof name === "string" && name.trim()) datasetName = name.trim();
      } else {
        dataType = "osw";
      }
    }
    const resolved = (dataType ?? "osw") as DataType;
    const apiPath = `/api/v1/${resolved === "osw" ? "osw" : resolved === "flex" ? "gtfs-flex" : "gtfs-pathways"}/${id}`;
    const apiOperation =
      resolved === "osw" ? "getOswFile" : resolved === "flex" ? "getGtfsFlexFile" : "getGtfsPathwaysFile";
    const safeBase = (datasetName ?? id).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || id;
    const filename = (input.filename?.trim() || `${safeBase}.zip`).replace(/[/\\]/g, "_");
    const base = outputDir.replace(/[/\\]+$/, "");
    const filePath = `${base}/${filename}`;
    const apiUrl = (this.dependencies.apiUrl ?? process.env.TDEI_API_URL?.trim() ?? "").replace(/\/+$/, "");
    const curlCommand = `curl -L -H "Authorization: Bearer $TDEI_TOKEN" "${apiUrl}${apiPath}" -o "${filePath}"`;
    return {
      status: "complete",
      data: {
        tdeiDatasetId: id,
        dataType: resolved,
        ...(datasetName ? { datasetName } : {}),
        filePath,
        apiOperation,
        method: "GET",
        path: apiPath,
        curlCommand,
        instruction: `Run this curl on the CLIENT machine (not the MCP server) so the ZIP lands in the connected folder: ${curlCommand}. $TDEI_TOKEN must hold the caller's SSO bearer token.`,
      },
    };
  }

  private unsupported(op: string): IntentResult<never> {
    return {
      status: "unsupported",
      reason: `The ${op} operation is not supported by this deployment adapter.`,
    };
  }

  private confirmGuard(
    confirmed: boolean | undefined,
    action: string,
    detail: string,
  ): IntentResult<never> | undefined {
    if (confirmed === true) return undefined;
    return {
      status: "needs_input",
      missing: [
        {
          field: "confirm",
          question: `This will ${action}: ${detail} Reply with confirm:true to proceed, or abandon this turn to cancel.`,
        },
      ],
      accepted: {},
    };
  }

  private jobFollowUp(operation: string, job: JobRecord): JobRecord {
    return {
      ...job,
      followUp: `Track progress with tdei_list_jobs, then download outputs with the job-download raw tool. Launched via ${operation}.`,
    };
  }

  async publishDataset(input: PublishDatasetInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.dataType
        ? [
            {
              field: "dataType",
              question: "Which data type is the dataset (osw, flex, pathways)?",
              allowedValues: ["osw", "flex", "pathways"],
            },
          ]
        : []),
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be published?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    if (!this.dependencies.operations.publishDataset) return this.unsupported("publishDataset");
    const job = await this.dependencies.operations.publishDataset(
      { dataType: input.dataType as DataType, tdeiDatasetId: input.tdeiDatasetId as string },
      context,
    );
    return { status: "complete", data: this.jobFollowUp("publish", job) };
  }

  async deleteDataset(input: DeleteDatasetInput, context: RequestContext = {}): Promise<IntentResult<string>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [
          { field: "tdeiDatasetId", question: "Which TDEI dataset id should be deleted? This cannot be undone." },
        ],
        accepted: {},
      };
    }
    const guard = this.confirmGuard(
      input.confirm,
      "permanently delete a dataset",
      `dataset ${input.tdeiDatasetId} will be removed from TDEI and cannot be recovered`,
    );
    if (guard) return guard;
    if (!this.dependencies.operations.deleteDataset) return this.unsupported("deleteDataset");
    const result = await this.dependencies.operations.deleteDataset(
      { tdeiDatasetId: input.tdeiDatasetId as string },
      context,
    );
    return { status: "complete", data: result };
  }

  async cloneDataset(input: CloneDatasetInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be cloned?" }]
        : []),
      ...(!input.projectGroupId?.trim()
        ? [{ field: "projectGroupId", question: "Which project group should receive the clone?" }]
        : []),
      ...(!input.serviceId?.trim()
        ? [{ field: "serviceId", question: "Which TDEI service should receive the clone?" }]
        : []),
      ...(!input.metadata
        ? [
            {
              field: "metadata",
              question:
                "What metadata (name, version, collected_by, collection_date, data_source, schema_version) should the clone carry?",
            },
          ]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    const guard = this.confirmGuard(
      input.confirm,
      "clone a dataset",
      `dataset ${input.tdeiDatasetId} will be cloned into project group ${input.projectGroupId}`,
    );
    if (guard) return guard;
    if (!this.dependencies.operations.cloneDataset) return this.unsupported("cloneDataset");
    const job = await this.dependencies.operations.cloneDataset(
      {
        tdeiDatasetId: input.tdeiDatasetId as string,
        projectGroupId: input.projectGroupId as string,
        serviceId: input.serviceId as string,
        metadata: input.metadata as NonNullable<typeof input.metadata>,
      },
      context,
    );
    return { status: "complete", data: this.jobFollowUp("cloneDataset", job) };
  }

  async editMetadata(input: EditMetadataInput, context: RequestContext = {}): Promise<IntentResult<unknown>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id needs a metadata update?" }],
        accepted: {},
      };
    }
    if (!input.metadata) {
      return {
        status: "needs_input",
        missing: [{ field: "metadata", question: "What is the replacement metadata document?" }],
        accepted: { tdeiDatasetId: input.tdeiDatasetId },
      };
    }
    const guard = this.confirmGuard(
      input.confirm,
      "overwrite dataset metadata",
      `metadata of dataset ${input.tdeiDatasetId} will be replaced`,
    );
    if (guard) return guard;
    if (!this.dependencies.operations.editMetadata) return this.unsupported("editMetadata");
    return {
      status: "complete",
      data: await this.dependencies.operations.editMetadata(
        { tdeiDatasetId: input.tdeiDatasetId as string, metadata: input.metadata },
        context,
      ),
    };
  }

  private static readonly ID_LESS_OPERATIONS = new Set([
    "sanitizeOswFile",
    "oswOnDemandFormat",
    "osw-self-merge",
    "osw-spatial-join",
    "osw-union",
    "datasetTagRoad",
    "convertGtfsPathways",
  ]);

  private async launchValidatedJob(
    operation: string,
    tdeiDatasetId: string | undefined,
    params: Record<string, unknown>,
    context: RequestContext,
    asset?: { value: DatasetAsset; name: string },
  ): Promise<IntentResult<JobRecord>> {
    const id = tdeiDatasetId?.trim() ?? "";
    if (!id && !SemanticIntentModule.ID_LESS_OPERATIONS.has(operation)) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should this job run on?" }],
        accepted: {},
      };
    }
    if (!this.dependencies.operations.launchJob) return this.unsupported("launchJob");
    const job = await this.dependencies.operations.launchJob(
      {
        operation,
        ...(id ? { tdeiDatasetId: id } : {}),
        ...this.jobParams(operation, params, asset),
      },
      context,
    );
    return { status: "complete", data: this.jobFollowUp(operation, job) };
  }

  private jobParams(
    operation: string,
    params: Record<string, unknown>,
    asset?: { value: DatasetAsset; name: string },
  ): {
    query?: Record<string, string | number | boolean | Array<string | number>>;
    body?: Record<string, unknown>;
    assets?: Record<string, DatasetAsset>;
    fields?: Record<string, string>;
  } {
    const stringFields: Record<string, string> = {};
    const assets: Record<string, DatasetAsset> = {};
    if (asset) assets[asset.name] = asset.value;
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        stringFields[key] = String(value);
      }
    }
    switch (operation) {
      case "datasetBbox":
        return {
          query: {
            ...(typeof params.tdeiDatasetId === "string" ? { tdei_dataset_id: params.tdeiDatasetId } : {}),
            ...(typeof params.fileType === "string" ? { file_type: params.fileType } : {}),
            ...(Array.isArray(params.bbox) ? { bbox: params.bbox as Array<string | number> } : {}),
          },
        };
      case "datasetTagRoad":
        return {
          query: {
            ...(typeof params.sourceDatasetId === "string" ? { source_dataset_id: params.sourceDatasetId } : {}),
            ...(typeof params.targetDatasetId === "string" ? { target_dataset_id: params.targetDatasetId } : {}),
          },
        };
      case "osw-self-merge":
      case "osw-spatial-join":
      case "osw-union":
        return { body: params };
      default:
        break;
    }
    const out: { assets?: Record<string, DatasetAsset>; fields?: Record<string, string> } = {};
    if (Object.keys(assets).length > 0) out.assets = assets;
    if (Object.keys(stringFields).length > 0) out.fields = stringFields;
    return out;
  }

  async calculateConfidence(input: ConfidenceInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = !input.tdeiDatasetId?.trim()
      ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should confidence be calculated for?" }]
      : [];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "oswConfidenceCalculate",
      input.tdeiDatasetId,
      {},
      context,
      input.subRegionAsset ? { value: input.subRegionAsset, name: "file" } : undefined,
    );
  }

  async calculateQualityIntersection(
    input: QualityIntersectionInput,
    context: RequestContext = {},
  ): Promise<IntentResult<JobRecord>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [
          {
            field: "tdeiDatasetId",
            question: "Which TDEI dataset id should the intersection quality be calculated for?",
          },
        ],
        accepted: {},
      };
    }
    return this.launchValidatedJob(
      "oswQualityCalculate",
      input.tdeiDatasetId,
      {},
      context,
      input.polygonAsset ? { value: input.polygonAsset, name: "file" } : undefined,
    );
  }

  async tagQualityMetric(input: QualityTagInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be quality-tagged?" }]
        : []),
      ...(!input.tagQualityAsset
        ? [{ field: "tagQualityAsset", question: "Which tag-quality JSON file defines the element tags?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "qualityMetricTag",
      input.tdeiDatasetId,
      {},
      context,
      input.tagQualityAsset ? { value: input.tagQualityAsset, name: "file" } : undefined,
    );
  }

  async generateQualityReport(input: TagInclineInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should get a quality report?" }],
        accepted: {},
      };
    }
    return this.launchValidatedJob("oswQualityReportGenerate", input.tdeiDatasetId, {}, context);
  }

  async sanitizeDataset(input: SanitizeInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    if (!input.asset) {
      return {
        status: "needs_input",
        missing: [{ field: "asset", question: "Which OSW ZIP should be sanitized?" }],
        accepted: {},
      };
    }
    return this.launchValidatedJob(
      "sanitizeOswFile",
      undefined,
      {},
      context,
      input.asset ? { value: input.asset, name: "dataset" } : undefined,
    );
  }

  async convertOsw(input: ConvertOswInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.asset ? [{ field: "asset", question: "Which OSW/OSM file should be converted?" }] : []),
      ...(!input.sourceFormat
        ? [{ field: "sourceFormat", question: "What is the source format?", allowedValues: ["osm", "osw"] }]
        : []),
      ...(!input.targetFormat
        ? [{ field: "targetFormat", question: "What is the target format?", allowedValues: ["osm", "osw"] }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "oswOnDemandFormat",
      undefined,
      {
        source_format: input.sourceFormat,
        target_format: input.targetFormat,
      },
      context,
      input.asset ? { value: input.asset, name: "file" } : undefined,
    );
  }

  async convertPathways(input: ConvertPathwaysInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    if (!input.datasetAsset && !input.arcgisUrl?.trim()) {
      return {
        status: "needs_input",
        missing: [
          {
            field: "datasetAsset",
            question:
              "Provide a DXF ZIP asset or an ArcGIS MapServer/FeatureServer URL to convert to a Pathways draft.",
          },
        ],
        accepted: {},
      };
    }
    return this.launchValidatedJob(
      "convertGtfsPathways",
      undefined,
      {
        ...(input.arcgisUrl?.trim() ? { arcgis_url: input.arcgisUrl.trim() } : {}),
        ...(input.layers?.trim() ? { layers: input.layers.trim() } : {}),
        ...(input.crs?.trim() ? { crs: input.crs.trim() } : {}),
      },
      context,
      input.datasetAsset ? { value: input.datasetAsset, name: "dataset" } : undefined,
    );
  }

  async selfMerge(input: SelfMergeInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be self-merged?" }],
        accepted: {},
      };
    }
    return this.launchValidatedJob(
      "osw-self-merge",
      input.tdeiDatasetId,
      {
        tdei_dataset_id: input.tdeiDatasetId,
        ...(input.proximity !== undefined ? { proximity: input.proximity } : {}),
      },
      context,
    );
  }

  async spatialJoin(input: SpatialJoinInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.targetDatasetId?.trim()
        ? [{ field: "targetDatasetId", question: "Which dataset is the join target?" }]
        : []),
      ...(!input.targetDimension
        ? [
            {
              field: "targetDimension",
              question: "Which target dimension (edge, node, zone)?",
              allowedValues: ["edge", "node", "zone"],
            },
          ]
        : []),
      ...(!input.sourceDatasetId?.trim()
        ? [{ field: "sourceDatasetId", question: "Which dataset is the join source?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "osw-spatial-join",
      undefined,
      {
        target_dataset_id: input.targetDatasetId,
        target_dimension: input.targetDimension,
        source_dataset_id: input.sourceDatasetId,
        ...(input.sourceDimension?.trim() ? { source_dimension: input.sourceDimension.trim() } : {}),
        ...(input.joinCondition?.trim() ? { join_condition: input.joinCondition.trim() } : {}),
      },
      context,
    );
  }

  async unionDatasets(input: UnionDatasetsInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.tdeiDatasetIdOne?.trim()
        ? [{ field: "tdeiDatasetIdOne", question: "Which dataset is DS1 (the authoritative base)?" }]
        : []),
      ...(!input.tdeiDatasetIdTwo?.trim()
        ? [{ field: "tdeiDatasetIdTwo", question: "Which dataset is DS2 (merged into DS1)?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    const guard = this.confirmGuard(
      input.confirm,
      "union two datasets",
      `DS2 ${input.tdeiDatasetIdTwo} will be merged into DS1 ${input.tdeiDatasetIdOne}`,
    );
    if (guard) return guard;
    return this.launchValidatedJob(
      "osw-union",
      undefined,
      {
        tdei_dataset_id_one: input.tdeiDatasetIdOne,
        tdei_dataset_id_two: input.tdeiDatasetIdTwo,
        ...(input.proximity !== undefined ? { proximity: input.proximity } : {}),
      },
      context,
    );
  }

  async cutDatasetBbox(input: CutBboxInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be cut to a bbox?" }]
        : []),
      ...(!input.fileType
        ? [{ field: "fileType", question: "Which output file type?", allowedValues: ["osw", "osm"] }]
        : []),
      ...(!input.bbox
        ? [{ field: "bbox", question: "What is the [minLon, minLat, maxLon, maxLat] bounding box?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "datasetBbox",
      input.tdeiDatasetId,
      {
        tdeiDatasetId: input.tdeiDatasetId,
        fileType: input.fileType,
        bbox: input.bbox,
      },
      context,
    );
  }

  async tagRoad(input: TagRoadInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    const missing = [
      ...(!input.sourceDatasetId?.trim()
        ? [{ field: "sourceDatasetId", question: "Which dataset provides the road network (source)?" }]
        : []),
      ...(!input.targetDatasetId?.trim()
        ? [{ field: "targetDatasetId", question: "Which dataset gets road tags (target)?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    return this.launchValidatedJob(
      "datasetTagRoad",
      undefined,
      {
        sourceDatasetId: input.sourceDatasetId,
        targetDatasetId: input.targetDatasetId,
      },
      context,
    );
  }

  async tagIncline(input: TagInclineInput, context: RequestContext = {}): Promise<IntentResult<JobRecord>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be incline-tagged?" }],
        accepted: {},
      };
    }
    return this.launchValidatedJob("datasetTagIncline", input.tdeiDatasetId, {}, context);
  }

  /**
   * Client-side incline inspection runbook. The MCP server never downloads
   * dataset bytes: it resolves the dataset id + data type from metadata and
   * returns a ready-to-run curl command plus inspection steps the LLM
   * executes on the CLIENT machine.
   */
  async checkDatasetIncline(
    input: TagInclineInput,
    context: RequestContext = {},
  ): Promise<IntentResult<CheckInclineData>> {
    const id = input.tdeiDatasetId?.trim() ?? "";
    if (!id) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be checked for inclines?" }],
        accepted: {},
      };
    }
    const lookup = await this.findDatasets({ tdeiDatasetId: id, limit: 5 }, context);
    let dataType: DataType = "osw";
    if (lookup.status === "complete" && lookup.data.matches[0]) {
      const raw = (lookup.data.matches[0].dataset.data_type as string | undefined)?.toLowerCase();
      if (raw === "flex" || raw === "pathways" || raw === "osw") dataType = raw;
    }
    const apiPath = `/api/v1/osw/${id}`;
    const apiUrl = (this.dependencies.apiUrl ?? process.env.TDEI_API_URL?.trim() ?? "").replace(/\/+$/, "");
    const curlCommand = `curl -L -H "Authorization: Bearer $TDEI_TOKEN" "${apiUrl}${apiPath}" -o "${id}.zip"`;
    return {
      status: "complete",
      data: {
        tdeiDatasetId: id,
        dataType,
        apiOperation: "getOswFile",
        method: "GET",
        path: apiPath,
        curlCommand,
        instruction:
          `MCP server never downloads files. On the CLIENT machine: 1) run ${curlCommand} with $TDEI_TOKEN set to the SSO bearer; ` +
          `2) unzip and inspect edges files (edges.geojson) for an incline tag/column; ` +
          `3) if inclines are missing, tag them with tdei_tag_incline.`,
      },
    };
  }

  async listFeedbacks(
    input: ListFeedbacksInput = {},
    context: RequestContext = {},
  ): Promise<IntentResult<ListFeedbacksData>> {
    if (!this.dependencies.operations.listFeedbacks) return this.unsupported("listFeedbacks");
    const pageSize = Math.min(Math.max(input.limit ?? 10, 1), 50);
    return {
      status: "complete",
      data: {
        feedbacks: await this.dependencies.operations.listFeedbacks(
          {
            ...(input.projectGroupId?.trim() ? { projectGroupId: input.projectGroupId.trim() } : {}),
            ...(input.tdeiDatasetId?.trim() ? { tdeiDatasetId: input.tdeiDatasetId.trim() } : {}),
            ...(input.fromDate ? { fromDate: input.fromDate } : {}),
            ...(input.toDate ? { toDate: input.toDate } : {}),
            ...(input.status ? { status: input.status } : {}),
            page: 1,
            pageSize,
          },
          context,
        ),
        appliedFilters: input,
        apiOperation: "oswDatasetViewerFeedbacks",
        method: "GET",
        path: "/api/v1/osw/dataset-viewer/feedbacks",
      },
    };
  }

  async getFeedbackSummary(
    input: { projectGroupId?: string } = {},
    context: RequestContext = {},
  ): Promise<IntentResult<FeedbackSummaryData>> {
    if (!this.dependencies.operations.getFeedbackSummary) return this.unsupported("getFeedbackSummary");
    return {
      status: "complete",
      data: {
        summary: await this.dependencies.operations.getFeedbackSummary(
          input.projectGroupId?.trim() ? { projectGroupId: input.projectGroupId.trim() } : {},
          context,
        ),
        ...(input.projectGroupId?.trim() ? { projectGroupId: input.projectGroupId.trim() } : {}),
        apiOperation: "oswDatasetViewerFeedbacksMetadata",
        method: "GET",
        path: "/api/v1/osw/dataset-viewer/feedbacks/metadata",
      },
    };
  }

  async downloadFeedbacks(
    input: DownloadFeedbacksInput,
    context: RequestContext = {},
  ): Promise<IntentResult<DownloadFeedbacksData>> {
    if (!input.projectGroupId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "projectGroupId", question: "Which project group should feedbacks be downloaded for?" }],
        accepted: {},
      };
    }
    if (!this.dependencies.operations.downloadFeedbacks) return this.unsupported("downloadFeedbacks");
    const { text, format } = await this.dependencies.operations.downloadFeedbacks(
      {
        projectGroupId: input.projectGroupId.trim(),
        ...(input.tdeiDatasetId?.trim() ? { tdeiDatasetId: input.tdeiDatasetId.trim() } : {}),
        ...(input.format?.trim() ? { format: input.format.trim() } : {}),
        ...(input.fromDate ? { fromDate: input.fromDate } : {}),
        ...(input.toDate ? { toDate: input.toDate } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      context,
    );
    const preview = text.slice(0, 4000);
    return {
      status: "complete",
      data: {
        ...(format ? { format } : {}),
        contentLength: text.length,
        preview,
        truncated: text.length > preview.length,
        apiOperation: "oswDatasetViewerFeedbacksDownload",
        method: "GET",
        path: "/api/v1/osw/dataset-viewer/feedbacks/download/{tdei_project_group_id}",
      },
    };
  }

  async submitFeedback(input: SubmitFeedbackInput, context: RequestContext = {}): Promise<IntentResult<unknown>> {
    const missing = [
      ...(!input.projectId?.trim()
        ? [{ field: "projectId", question: "Which project (group) id does the feedback belong to?" }]
        : []),
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id does the feedback belong to?" }]
        : []),
      ...(!input.feedbackText?.trim() ? [{ field: "feedbackText", question: "What is the feedback text?" }] : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    if (!this.dependencies.operations.submitFeedback) return this.unsupported("submitFeedback");
    const { projectId, tdeiDatasetId, ...feedback } = input;
    return {
      status: "complete",
      data: await this.dependencies.operations.submitFeedback(
        {
          projectId: (projectId as string).trim(),
          tdeiDatasetId: (tdeiDatasetId as string).trim(),
          feedback: Object.fromEntries(Object.entries(feedback).filter(([, value]) => value !== undefined)),
        },
        context,
      ),
    };
  }

  async updateFeedbackStatus(
    input: UpdateFeedbackStatusInput,
    context: RequestContext = {},
  ): Promise<IntentResult<unknown>> {
    const missing = [
      ...(!input.projectId?.trim()
        ? [{ field: "projectId", question: "Which project (group) id do the feedbacks belong to?" }]
        : []),
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id do the feedbacks belong to?" }]
        : []),
      ...(!input.updates || input.updates.length === 0
        ? [{ field: "updates", question: "Which feedback ids should change, and to what status?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    if (!this.dependencies.operations.updateFeedbackStatus) return this.unsupported("updateFeedbackStatus");
    return {
      status: "complete",
      data: await this.dependencies.operations.updateFeedbackStatus(
        {
          projectId: (input.projectId as string).trim(),
          tdeiDatasetId: (input.tdeiDatasetId as string).trim(),
          updates: (input.updates as Array<Record<string, unknown>>).map((update) => ({ ...update })),
        },
        context,
      ),
    };
  }

  async getPmTilesUrl(
    input: TagInclineInput,
    context: RequestContext = {},
  ): Promise<IntentResult<{ tdeiDatasetId: string; pmTilesUrl: string }>> {
    if (!input.tdeiDatasetId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id needs its PMTiles URL?" }],
        accepted: {},
      };
    }
    if (!this.dependencies.operations.getPmTilesUrl) return this.unsupported("getPmTilesUrl");
    return {
      status: "complete",
      data: {
        tdeiDatasetId: input.tdeiDatasetId.trim(),
        pmTilesUrl: await this.dependencies.operations.getPmTilesUrl(
          { tdeiDatasetId: input.tdeiDatasetId.trim() },
          context,
        ),
      },
    };
  }

  async setViewerAccess(
    input: { tdeiDatasetId?: string; allowViewerAccess?: boolean },
    context: RequestContext = {},
  ): Promise<IntentResult<unknown>> {
    const missing = [
      ...(!input.tdeiDatasetId?.trim()
        ? [{ field: "tdeiDatasetId", question: "Which TDEI dataset id needs viewer preference changes?" }]
        : []),
      ...(input.allowViewerAccess === undefined
        ? [{ field: "allowViewerAccess", question: "Should viewer access be allowed (true/false)?" }]
        : []),
    ];
    if (missing.length > 0) return { status: "needs_input", missing, accepted: {} };
    if (!this.dependencies.operations.setViewerAccess) return this.unsupported("setViewerAccess");
    return {
      status: "complete",
      data: await this.dependencies.operations.setViewerAccess(
        {
          tdeiDatasetId: (input.tdeiDatasetId as string).trim(),
          allowViewerAccess: input.allowViewerAccess as boolean,
        },
        context,
      ),
    };
  }

  async getMetrics(input: GetMetricsInput = {}, context: RequestContext = {}): Promise<IntentResult<GetMetricsData>> {
    const scope = input.scope ?? "data";
    if (scope === "service" && !input.projectGroupId?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "projectGroupId", question: "Which project group should service metrics cover?" }],
        accepted: { scope },
      };
    }
    if (!this.dependencies.operations.getMetrics) return this.unsupported("getMetrics");
    const apiOperation =
      scope === "system" ? "system-metrics" : scope === "service" ? "service-metrics" : "data-metrics";
    const path =
      scope === "system"
        ? "/api/v1/system-metrics"
        : scope === "service"
          ? "/api/v1/service-metrics/{tdei_project_group_id}"
          : "/api/v1/data-metrics";
    return {
      status: "complete",
      data: {
        scope,
        metrics: await this.dependencies.operations.getMetrics(
          {
            scope,
            ...(input.projectGroupId?.trim() ? { projectGroupId: input.projectGroupId.trim() } : {}),
          },
          context,
        ),
        apiOperation,
        method: "GET",
        path,
      },
    };
  }

  async listVersions(
    input: { dataType?: DataType } = {},
    context: RequestContext = {},
  ): Promise<IntentResult<ListVersionsData>> {
    if (!this.dependencies.operations.listVersions) return this.unsupported("listVersions");
    const types: DataType[] = input.dataType ? [input.dataType] : ["osw", "flex", "pathways"];
    const versions: Record<string, unknown> = {};
    for (const dataType of types) {
      versions[dataType] = await this.dependencies.operations.listVersions({ dataType }, context);
    }
    return {
      status: "complete",
      data: {
        versions,
        apiOperation: "listOswVersions",
        method: "GET",
        path: "/api/v1/{data-type}/versions",
      },
    };
  }

  async getSystemInfo(context: RequestContext = {}): Promise<IntentResult<SystemInfoData>> {
    if (!this.dependencies.operations.getCapabilities || !this.dependencies.operations.listApiVersions) {
      return this.unsupported("getSystemInfo");
    }
    const [capabilities, apiVersions] = await Promise.all([
      this.dependencies.operations.getCapabilities(context),
      this.dependencies.operations.listApiVersions(context),
    ]);
    return { status: "complete", data: { capabilities, apiVersions } };
  }

  async verifyEmail(input: VerifyEmailInput, context: RequestContext = {}): Promise<IntentResult<unknown>> {
    if (!input.email?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "email", question: "Which email address should receive the verification link?" }],
        accepted: {},
      };
    }
    if (!this.dependencies.operations.verifyEmail) return this.unsupported("verifyEmail");
    return {
      status: "complete",
      data: await this.dependencies.operations.verifyEmail({ email: input.email.trim() }, context),
    };
  }

  async recoverPassword(input: RecoverPasswordInput, context: RequestContext = {}): Promise<IntentResult<unknown>> {
    if (!input.email?.trim()) {
      return {
        status: "needs_input",
        missing: [{ field: "email", question: "Which email address should receive the password-recovery link?" }],
        accepted: {},
      };
    }
    if (!this.dependencies.operations.recoverPassword) return this.unsupported("recoverPassword");
    return {
      status: "complete",
      data: await this.dependencies.operations.recoverPassword({ email: input.email.trim() }, context),
    };
  }

  async regenerateApiKey(input: RegenerateApiKeyInput, context: RequestContext = {}): Promise<IntentResult<string>> {
    const guard = this.confirmGuard(
      input.confirm,
      "regenerate the TDEI API key",
      "the old API key will be invalidated immediately; update stored credentials afterwards",
    );
    if (guard) return guard;
    if (!this.dependencies.operations.regenerateApiKey) return this.unsupported("regenerateApiKey");
    return {
      status: "complete",
      data: await this.dependencies.operations.regenerateApiKey(context),
    };
  }
}
