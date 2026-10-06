import type { TdeiOperations } from "./operations.js";
import type { PlaceResolver } from "./place-resolver.js";
import type {
  FindDatasetsData,
  FindDatasetsInput,
  IntentResult,
  ListServicesData,
  ListServicesInput,
  ListProjectGroupsData,
  ListProjectGroupsInput,
  RequestContext,
  AcceptedJob,
  UploadDatasetInput,
  ValidateDatasetInput,
} from "./types.js";

export type { TdeiOperations } from "./operations.js";
export type { PlaceResolver } from "./place-resolver.js";

export interface SemanticIntentDependencies {
  operations: TdeiOperations;
  places: PlaceResolver;
}

export class SemanticIntentModule {
  constructor(private readonly dependencies: SemanticIntentDependencies) {}

  async findDatasets(
    input: FindDatasetsInput,
    context: RequestContext = {},
  ): Promise<IntentResult<FindDatasetsData>> {
    const pageSize = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const common = {
      ...(input.dataType ? { dataType: input.dataType } : {}),
      status: input.status ?? "All" as const,
      sortField: "uploaded_timestamp" as const,
      sortOrder: "desc" as const,
      page: 1,
      pageSize,
    };

    if (input.bbox) {
      const datasets = await this.dependencies.operations.searchDatasets(
        { ...common, bbox: input.bbox },
        context,
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
      const datasets = await this.dependencies.operations.searchDatasets(
        { ...common, projectGroupId: input.projectGroupId },
        context,
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

    let datasets = await this.dependencies.operations.searchDatasets(
      { ...common, name: input.place },
      context,
    );
    let matchedBy: "name" | "city" | "bbox" = "name";
    let evidence = `name contains ${input.place}`;
    if (datasets.length === 0) {
      datasets = await this.dependencies.operations.searchDatasets(
        { ...common, city: input.place },
        context,
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
            ...(candidate.confidence !== undefined
              ? { confidence: candidate.confidence }
              : {}),
            ...(candidate.providerId !== undefined
              ? { providerId: candidate.providerId }
              : {}),
          })),
          accepted: { ...input },
        };
      }
      const resolved = placeCandidates[0];
      if (resolved) {
        datasets = await this.dependencies.operations.searchDatasets(
          { ...common, bbox: resolved.bbox },
          context,
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
    const services = await this.dependencies.operations.listServices(
      appliedFilters,
      context,
    );
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
        scopeExplanation: "These are all project groups available to your authenticated TDEI login.",
        apiOperation: "listProjectGroups",
        method: "GET",
        path: "/api/v1/project-groups",
      },
    };
  }

  async validateDataset(
    input: ValidateDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<AcceptedJob>> {
    const missing = [
      ...(!input.dataType
        ? [{ field: "dataType", question: "Is this dataset OSW, GTFS Flex, or GTFS Pathways?", allowedValues: ["osw", "flex", "pathways"] }]
        : []),
      ...(!input.asset
        ? [{ field: "asset", question: "Which dataset ZIP should be validated?" }]
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
      data: await this.dependencies.operations.validateDataset({
        dataType: input.dataType as NonNullable<typeof input.dataType>,
        asset: input.asset as NonNullable<typeof input.asset>,
      }, context),
    };
  }

  async uploadDataset(
    input: UploadDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<AcceptedJob>> {
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
        ? [{ field: "dataType", question: "Is this dataset OSW, GTFS Flex, or GTFS Pathways?", allowedValues: ["osw", "flex", "pathways"] }]
        : []),
      ...(!input.asset
        ? [{ field: "asset", question: "Which dataset ZIP should be uploaded?" }]
        : []),
      ...(!input.projectGroupId
        ? [{ field: "projectGroupId", question: "Which project group should receive the dataset?" }]
        : []),
      ...(!input.serviceId
        ? [{ field: "serviceId", question: "Which TDEI service should receive the dataset?" }]
        : []),
      ...requiredMetadata.flatMap(([field, question]) =>
        detail?.[field]
          ? []
          : [{
            field: `metadata.dataset_detail.${String(field)}`,
            question,
            ...(field === "data_source"
              ? { allowedValues: ["3rdParty", "TDEITools", "InHouse"] }
              : {}),
          }]
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
      data: await this.dependencies.operations.uploadDataset({
        dataType: input.dataType as NonNullable<typeof input.dataType>,
        asset: input.asset as NonNullable<typeof input.asset>,
        projectGroupId: input.projectGroupId as string,
        serviceId: input.serviceId as string,
        metadata: input.metadata as NonNullable<typeof input.metadata>,
        ...(input.derivedFromDatasetId
          ? { derivedFromDatasetId: input.derivedFromDatasetId }
          : {}),
        ...(input.changeset ? { changeset: input.changeset } : {}),
      }, context),
    };
  }
}
