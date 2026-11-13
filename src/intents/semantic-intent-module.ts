import type { DatasetSearch, TdeiOperations } from "./operations.js";
import { JOB_TYPES, normalizeJobType } from "./job-types.js";
import type { PlaceResolver } from "./place-resolver.js";
import { extractAuthIdentity } from "../auth/auth-manager.js";
import {
  buildClientDownloadCurl,
  defaultClientDownloadsDir,
  joinDownloadPath,
} from "../adapters/binary-tdei-downloads.js";
import { createHash } from "node:crypto";
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
  MyProjectGroupRolesData,
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
  ProjectGroup,
  MyIdentity,
  PublishDatasetInput,
  QualityIntersectionInput,
  QualityTagInput,
  RecoverPasswordInput,
  RegenerateApiKeyInput,
  RequestContext,
  ClientUploadInstruction,
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
  DatasetMatch,
  TcatQaReportRow,
  TcatQaReportsData,
  TcatQaReportsInput,
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
  /**
   * Supplies the SSO token for server-side JSON calls (search, jobs, etc.).
   * Never used for curl commands: those always use $TDEI_TOKEN so multiple
   * users can share one server without leaking tokens. File bytes flow
   * directly from the CLIENT to the TDEI backend; the gateway is not a relay.
   */
  tokenProvider?: () => Promise<string>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** TDEI User Management API origin (project-group roles). Unset means the tool reports it as unsupported. */
  userApiUrl?: string;
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

/** UUID test for download IDs — dataset names are never valid in the download path. */
function isUuidLikeDatasetId(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function readDatasetDataType(dataset: Record<string, unknown>): DataType | undefined {
  const raw = String(dataset.data_type ?? dataset.dataType ?? "").toLowerCase();
  if (raw.includes("flex")) return "flex";
  if (raw.includes("pathway")) return "pathways";
  if (raw === "osw" || raw === "") return raw === "" ? undefined : "osw";
  return "osw";
}

function readDatasetName(dataset: Record<string, unknown>): string | undefined {
  const direct = dataset.name ?? dataset.dataset_name;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  // The live listDatasetFiles shape keeps the name in metadata.dataset_detail.
  return firstText(readDatasetDetail(dataset), ["name"]);
}

function readDatasetId(dataset: Record<string, unknown>): string | undefined {
  const found = dataset.tdei_dataset_id ?? dataset.tdeiDatasetId ?? dataset.id;
  return typeof found === "string" && found.trim() ? found.trim() : undefined;
}

/** Object-only view of an unknown value (arrays and primitives excluded). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First non-empty string/number (or primitive array) among `keys`, trimmed. */
function firstText(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .filter((item) => typeof item === "string" || typeof item === "number")
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  return undefined;
}

/** metadata.dataset_detail block (name, version and custom metadata live here). */
function readDatasetDetail(dataset: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(asRecord(dataset.metadata)?.dataset_detail);
}

function readDatasetCustomMetadata(dataset: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(readDatasetDetail(dataset)?.custom_metadata);
}

function readDatasetVersion(dataset: Record<string, unknown>): string | undefined {
  return firstText(readDatasetDetail(dataset), ["version"]) ?? firstText(dataset, ["version"]);
}

function readDatasetServiceName(dataset: Record<string, unknown>): string | undefined {
  return firstText(dataset, ["service", "service_name"]);
}

/** Natural compare so "1.10" is newer than "1.9" (a plain string sort gets this wrong). */
const VERSION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareDatasetVersions(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return VERSION_COLLATOR.compare(a, b);
}

/** First UUID found anywhere in a string (handles pasted table rows). */
function extractUuidFromText(value: string): string | undefined {
  const match = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(value);
  return match?.[0];
}

function tableCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|");
}

/**
 * Markdown table of dataset matches for the user to pick from: numbered rows
 * with the name, UUID, data type and status. The user replies with a UUID
 * (or a pasted row containing one) or a 1-based row number.
 */
function renderDatasetTable(matches: DatasetMatch[]): string {
  if (matches.length === 0) return "No datasets matched.";
  const header = "| # | name | version | tdei_dataset_id | data_type | status |";
  const divider = "|---|------|---------|-----------------|-----------|--------|";
  const rows = matches.map((match, index) => {
    const dataset = match.dataset;
    const name = readDatasetName(dataset) ?? "";
    const version = match.version ?? readDatasetVersion(dataset) ?? "";
    const id = readDatasetId(dataset) ?? "";
    const rawType = String(dataset.data_type ?? dataset.dataType ?? "");
    const status = String(dataset.status ?? "");
    return `| ${index + 1} | ${tableCell(name)} | ${tableCell(version)} | ${tableCell(id)} | ${tableCell(rawType)} | ${tableCell(status)} |`;
  });
  return [header, divider, ...rows].join("\n");
}

/**
 * QA/QC report table. Report columns show presence (yes/missing) rather than
 * the blob URL: rows[] carries the full URLs, and 300+ long SAS URLs would
 * dominate the reply.
 */
function renderTcatQaReportTable(rows: TcatQaReportRow[]): string {
  if (rows.length === 0) return "No datasets matched the filters.";
  const header =
    "| # | name | version | tdei_dataset_id | uploaded | status | pipeline | tract_no | pdf | html | report_code |";
  const divider =
    "|---|------|---------|-----------------|----------|--------|----------|----------|-----|------|-------------|";
  const lines = rows.map((row, index) => {
    const uploaded = row.uploaded_timestamp ? row.uploaded_timestamp.slice(0, 10) : "";
    const pdf = row.reportUrlPdf ? "yes" : "missing";
    const html = row.reportUrlHtml ? "yes" : "missing";
    return [
      `| ${index + 1}`,
      tableCell(row.name),
      tableCell(row.version ?? ""),
      tableCell(row.tdei_dataset_id ?? ""),
      tableCell(uploaded),
      tableCell(row.status ?? ""),
      tableCell(row.pipelineVersion ?? ""),
      tableCell(row.tractNo ?? ""),
      pdf,
      html,
      `${tableCell(row.reportCode ?? "")} |`,
    ].join(" | ");
  });
  return [header, divider, ...lines].join("\n");
}

/**
 * Client-machine upload path for a dataset asset. Only local_path assets are
 * usable — their path is embedded in the curl command and never read by the
 * server. Returns undefined for missing or non-local assets so callers ask
 * for a client file path instead of sending bytes through MCP.
 */
function clientUploadPath(asset: DatasetAsset | undefined): string | undefined {
  if (!asset || asset.kind !== "local_path") return undefined;
  return asset.path.trim() ? asset.path.trim() : undefined;
}

const JOB_FANOUT_CONCURRENCY = 5;
const PROJECT_GROUP_CACHE_TTL_MS = 60_000;
/** Data standards and server capabilities change on deploys, not per request. */
const STATIC_REFERENCE_TTL_MS = 5 * 60_000;

/** Runs `fn` over `items` with at most `limit` in flight; result order matches input. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // oxlint-disable-next-line no-await-in-loop -- each worker must finish one item before taking the next, which is what caps concurrency
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The jobs API returns at most this many records per call (page_size 1 to 50). */
const JOBS_API_PAGE_SIZE = 50;

/** Dataset API page size used by the QA/QC report inventory scan. */
const DATASET_SCAN_PAGE_SIZE = 50;
/** Pages fetched in parallel per window (same bound as the jobs fan-out). */
const DATASET_SCAN_CONCURRENCY = 5;
/** Safety stop for a runaway project group (200 pages * 50 = 10,000 datasets). */
const DATASET_SCAN_MAX_PAGES = 200;
/** Follow-up questions reuse the scan instead of re-reading dozens of pages. */
const DATASET_SCAN_CACHE_TTL_MS = 60_000;

interface TcatCandidate {
  dataset: Record<string, unknown>;
  name: string;
  version: string | undefined;
  uploadedMs: number;
  id: string | undefined;
  versionsAvailable: number | undefined;
}

/** Newer version wins, then newest upload, then id for deterministic output. */
function compareTcatCandidates(a: TcatCandidate, b: TcatCandidate): number {
  const byVersion = compareDatasetVersions(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  if (a.uploadedMs !== b.uploadedMs) return a.uploadedMs - b.uploadedMs;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/** Normalize one dataset record into a dedupe candidate. */
function toTcatCandidate(dataset: Record<string, unknown>): TcatCandidate {
  return {
    dataset,
    name: readDatasetName(dataset) ?? readDatasetId(dataset) ?? "(unnamed dataset)",
    version: readDatasetVersion(dataset),
    uploadedMs: uploadedTimestampMs(dataset) ?? 0,
    id: readDatasetId(dataset),
    versionsAvailable: undefined,
  };
}

/**
 * Keep the newest version of each dataset name. The key includes the service
 * when no service filter was used, because identical names in two services
 * are different datasets and must not collapse into one row.
 */
function selectLatestPerName(
  datasets: Array<Record<string, unknown>>,
  serviceFilter: string | undefined,
): { selected: TcatCandidate[]; versionsSuperseded: number; uniqueNames: number } {
  const byKey = new Map<string, TcatCandidate>();
  const counts = new Map<string, number>();
  for (const dataset of datasets) {
    const candidate = toTcatCandidate(dataset);
    const groupKey = serviceFilter ?? firstText(dataset, ["tdei_service_id"]) ?? readDatasetServiceName(dataset) ?? "";
    const key = `${groupKey}\u0000${candidate.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const previous = byKey.get(key);
    if (!previous || compareTcatCandidates(candidate, previous) > 0) byKey.set(key, candidate);
  }
  const selected = [...byKey.entries()].map(([key, candidate]) => ({
    ...candidate,
    versionsAvailable: counts.get(key) ?? 1,
  }));
  return {
    selected,
    versionsSuperseded: datasets.length - selected.length,
    uniqueNames: new Set(selected.map((candidate) => candidate.name)).size,
  };
}

export class SemanticIntentModule {
  private readonly readCache = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly dependencies: SemanticIntentDependencies) {}

  private async resolveCurlToken(context: RequestContext = {}): Promise<string | undefined> {
    if (context.accessToken?.trim()) return context.accessToken.trim();
    if (this.dependencies.tokenProvider) {
      try {
        const token = await this.dependencies.tokenProvider();
        if (token?.trim()) return token.trim();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Short-lived, in-flight-deduplicated cache for slow-changing reads (project
   * groups, versions, capabilities). Keyed by access token so one caller never
   * sees another's data, and a failed lookup is never cached.
   */
  private async cached<T>(name: string, ttlMs: number, context: RequestContext, load: () => Promise<T>): Promise<T> {
    const token = await this.resolveCurlToken(context);
    // Without a token there is no caller to key the entry to, so never cache.
    if (!token) return load();
    // Keyed by a hash of the caller's token: one caller's entry can never be read by another.
    const key = `${createHash("sha256").update(token).digest("base64url")}\u0000${name}`;
    const now = Date.now();
    const hit = this.readCache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    for (const [k, v] of this.readCache) if (v.expires <= now) this.readCache.delete(k);
    const value = load();
    this.readCache.set(key, { expires: now + ttlMs, value });
    value.catch(() => {
      if (this.readCache.get(key)?.value === value) this.readCache.delete(key);
    });
    return value;
  }

  /** Project groups visible to the caller (cached briefly; names and ids are what jobs lookups need). */
  private accessibleProjectGroups(context: RequestContext): Promise<ProjectGroup[]> {
    return this.cached("projectGroups", PROJECT_GROUP_CACHE_TTL_MS, context, () =>
      this.dependencies.operations.listProjectGroups({ page: 1, pageSize: 50 }, context),
    );
  }

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
    const projectGroupId = input.projectGroupId?.trim() || undefined;
    const serviceId = input.serviceId?.trim() || undefined;
    // A project-group/service listing means "latest unique datasets" unless the
    // caller explicitly asks for every version. This is the single place the
    // rule lives; dependent tools (details, download, workspace creation)
    // resolve their dataset through this search, so they inherit it.
    const latestPerName = input.latestPerName ?? Boolean(projectGroupId || serviceId);

    const common = {
      ...(input.dataType ? { dataType: input.dataType } : {}),
      ...(serviceId ? { serviceId } : {}),
      status: input.status ?? ("All" as const),
      sortField: "uploaded_timestamp" as const,
      sortOrder: "desc" as const,
      page: 1,
      pageSize,
    };

    const result = (
      rows: Array<{
        dataset: Record<string, unknown>;
        version: string | undefined;
        versionsAvailable: number | undefined;
      }>,
      matchedBy: DatasetMatch["matchedBy"],
      evidence: string,
      scan?: FindDatasetsData["scan"],
    ): IntentResult<FindDatasetsData> => {
      const matches: DatasetMatch[] = rows.map((row) => ({
        dataset: row.dataset,
        matchedBy,
        evidence,
        ...(row.version ? { version: row.version } : {}),
        ...(row.versionsAvailable !== undefined ? { versionsAvailable: row.versionsAvailable } : {}),
      }));
      return {
        status: "complete",
        data: {
          matches,
          ...(input.latest && matches[0] ? { selected: matches[0].dataset } : {}),
          effectiveSort: { field: "uploaded_timestamp", order: "desc" },
          ...(scan ? { scan } : {}),
          table: renderDatasetTable(matches),
        },
      };
    };
    const complete = (
      datasets: Array<Record<string, unknown>>,
      matchedBy: DatasetMatch["matchedBy"],
      evidence: string,
    ): IntentResult<FindDatasetsData> =>
      result(
        datasets.map((dataset) => ({
          dataset,
          version: readDatasetVersion(dataset),
          versionsAvailable: undefined,
        })),
        matchedBy,
        evidence,
      );

    /** Project-group/service listings read every page, then keep the latest per name. */
    const scanAndSelect = async (
      base: Pick<DatasetSearch, "projectGroupId" | "serviceId">,
      matchedBy: DatasetMatch["matchedBy"],
      evidence: string,
    ): Promise<IntentResult<FindDatasetsData>> => {
      const baseQuery = {
        ...base,
        ...(input.dataType ? { dataType: input.dataType } : {}),
        status: input.status ?? "All",
      };
      // Follow-up questions reuse the scan instead of re-reading dozens of pages.
      const scanKey = `findDatasetsScan:${base.projectGroupId ?? ""}:${base.serviceId ?? ""}:${input.dataType ?? "*"}:${baseQuery.status}`;
      const scan = await this.cached(scanKey, DATASET_SCAN_CACHE_TTL_MS, context, () =>
        this.scanDatasetPages(baseQuery, context),
      );
      const filtered = applyCutoff(scan.datasets);
      const latest = selectLatestPerName(filtered, base.serviceId);
      const rows = latestPerName ? latest.selected : filtered.map(toTcatCandidate);
      // Newest upload first across every page scanned (the API only sorts within a page).
      rows.sort((a, b) => (a.uploadedMs !== b.uploadedMs ? b.uploadedMs - a.uploadedMs : a.name.localeCompare(b.name)));
      const shown = rows.slice(0, pageSize);
      const note = scan.truncated
        ? `Scanned ${scan.pagesRead} page(s) (${scan.datasets.length} dataset records) and stopped at the ${DATASET_SCAN_MAX_PAGES}-page cap; some datasets were not read. Narrow with serviceId or uploadedWithinDays.`
        : latestPerName
          ? `Scanned every page: ${scan.pagesRead} page(s), ${scan.datasets.length} dataset record(s); kept the latest version of each of ${latest.uniqueNames} dataset name(s) (${latest.versionsSuperseded} older version record(s) hidden).`
          : `Scanned every page: ${scan.pagesRead} page(s), ${filtered.length} dataset record(s).`;
      return result(shown, matchedBy, evidence, {
        pagesRead: scan.pagesRead,
        datasetsScanned: scan.datasets.length,
        uniqueDatasetNames: latest.uniqueNames,
        versionsSuperseded: latestPerName ? latest.versionsSuperseded : 0,
        truncated: scan.truncated,
        note:
          rows.length > shown.length
            ? `${note} Showing ${shown.length} of ${rows.length}; raise limit (max 50) or narrow with serviceId/uploads.`
            : note,
      });
    };
    const search = async (extra: Partial<DatasetSearch>) =>
      applyCutoff(await this.dependencies.operations.searchDatasets({ ...common, ...extra }, context));

    // Exact id lookup (release-status / incline follow-ups). The API
    // supports tdei_dataset_id directly; date filtering is client-side.
    if (input.tdeiDatasetId?.trim()) {
      const id = input.tdeiDatasetId.trim();
      return complete(await search({ tdeiDatasetId: id }), "dataset_id", `tdei_dataset_id = ${id}`);
    }
    if (input.bbox) {
      return complete(await search({ bbox: input.bbox }), "bbox", `explicit bbox ${input.bbox.join(",")}`);
    }
    if (projectGroupId) {
      return scanAndSelect({ projectGroupId }, "project_group", `project group ${projectGroupId}`);
    }
    if (serviceId) {
      return scanAndSelect({ serviceId }, "service", `service ${serviceId}`);
    }

    if (!input.place) {
      return {
        status: "needs_input",
        missing: [{ field: "place", question: "Which place should I search for?" }],
        accepted: {},
      };
    }

    let datasets = await search({ name: input.place });
    if (datasets.length > 0) return complete(datasets, "name", `name contains ${input.place}`);
    datasets = await search({ city: input.place });
    if (datasets.length > 0) return complete(datasets, "city", `city contains ${input.place}`);

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
      return complete(await search({ bbox: resolved.bbox }), "bbox", `bbox for ${resolved.label}`);
    }
    // Nothing matched by name, city or geocode: report the (empty) name-search outcome.
    return complete(datasets, "city", `city contains ${input.place}`);
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
          "These are all project groups visible to your login (an admin login sees all groups), NOT confirmed membership. TDEI reports only poc contacts per group, not members. For your login email call tdei_get_my_identity. For the project groups you belong to and your role in each call tdei_my_project_group_roles. Use searchText to narrow, do not POC-filter.",
        apiOperation: "listProjectGroups",
        method: "GET",
        path: "/api/v1/project-groups",
      },
    };
  }

  async validateDataset(
    input: ValidateDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<ClientUploadInstruction>> {
    const assetPath = clientUploadPath(input.asset);
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
      ...(!input.asset || !assetPath
        ? [
            {
              field: "asset",
              question:
                "Which dataset ZIP should be validated? Give the absolute path on the CLIENT machine (e.g. /Users/you/data/file.zip).",
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

  async uploadDataset(
    input: UploadDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<ClientUploadInstruction>> {
    const detail = input.metadata?.dataset_detail;
    const assetPath = clientUploadPath(input.asset);
    const changesetPath = input.changeset ? clientUploadPath(input.changeset) : undefined;
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
      ...(!input.asset || !assetPath
        ? [
            {
              field: "asset",
              question:
                "Which dataset ZIP should be uploaded? Give the absolute path on the CLIENT machine (e.g. /Users/you/data/file.zip).",
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
    if (input.changeset && !changesetPath) {
      return {
        status: "needs_input",
        missing: [
          {
            field: "changeset",
            question:
              "The changeset must be a local_path asset with the absolute file path on the CLIENT machine (MCP never takes file bytes). Which changeset file should be uploaded?",
          },
        ],
        accepted: {},
      };
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

  /**
   * The caller's own project groups with the roles they hold in each, from the User Management API
   * (GET /api/v1/project-group-roles/{userId}). The user id is the sign-in token's subject, so the model never
   * has to supply or guess it. One call; reports when the API holds more groups than were returned.
   */
  async myProjectGroupRoles(
    input: { projectGroupName?: string } = {},
    context: RequestContext = {},
  ): Promise<IntentResult<MyProjectGroupRolesData>> {
    const base = this.dependencies.userApiUrl?.replace(/\/+$/, "");
    if (!base) {
      return {
        status: "unsupported",
        reason:
          "The TDEI User Management API is not configured for this server (set TDEI_USER_API_URL), so project-group roles cannot be read here.",
        requiredCapability: "TDEI User Management API",
      };
    }
    const token = context.accessToken ?? (await this.dependencies.tokenProvider?.().catch(() => undefined));
    const subject =
      this.dependencies.identityProvider?.()?.subject ?? (token ? extractAuthIdentity(token)?.subject : undefined);
    if (!token || !subject) {
      return {
        status: "complete",
        data: {
          authenticated: false,
          hint: `Not authenticated or the sign-in token has no user id. ${signInText()} Then retry tdei_my_project_group_roles.`,
        },
      };
    }
    const params = new URLSearchParams({ page_size: "50", page_no: "1", sort_by: "name" });
    if (input.projectGroupName?.trim()) params.set("searchText", input.projectGroupName.trim());
    const response = await (this.dependencies.fetchImpl ?? fetch)(
      `${base}/api/v1/project-group-roles/${encodeURIComponent(subject)}?${params}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      return {
        status: "unsupported",
        reason: `The User Management API answered ${response.status} when reading your project-group roles.`,
        requiredCapability: "TDEI User Management API",
      };
    }
    const body = (await response.json().catch(() => [])) as unknown;
    const items = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
    const projectGroups = items.map((item) => ({
      tdei_project_group_id: String(item.tdei_project_group_id ?? ""),
      project_group_name: String(item.project_group_name ?? ""),
      roles: Array.isArray(item.roles) ? item.roles.map(String) : [],
    }));
    const totalHeader = Number.parseInt(response.headers.get("X-Total-Count") ?? "", 10);
    const total = Number.isFinite(totalHeader) ? totalHeader : undefined;
    const more = total !== undefined && total > projectGroups.length;
    return {
      status: "complete",
      data: {
        authenticated: true,
        projectGroups,
        ...(more ? { total } : {}),
        hint: more
          ? `Showing ${projectGroups.length} of ${total} project groups (one call, no paging). Ask for a project group name to narrow the list.`
          : `${projectGroups.length} project group(s). Roles are TDEI project-group roles.`,
      },
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
   * Jobs for one project group. The API requires tdei_project_group_id, so the
   * group is resolved first: by id, or by name against the (cached) list of
   * groups the caller can see. Without either, the tool asks which group,
   * because most questions ("what is running?", "status of job X") concern one
   * group. Only an explicit `allGroups` fans out across every group.
   * Date filtering is client-side on created_at (the API has no date param).
   */
  async listJobs(input: ListJobsInput = {}, context: RequestContext = {}): Promise<IntentResult<ListJobsData>> {
    const pageSize = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const cutoffMs = resolveCutoffMs(input.createdAfter, input.createdWithinDays);

    // The API only accepts its own job_type values; map portal labels ("Filter Dataset by BBox") and
    // aliases, and ask rather than send a value the API would reject.
    let jobType: string | undefined;
    if (input.jobType?.trim()) {
      jobType = normalizeJobType(input.jobType);
      if (!jobType) {
        return {
          status: "needs_input",
          missing: [
            {
              field: "jobType",
              question: `"${input.jobType}" is not a TDEI job type. Which job type do you mean?`,
              allowedValues: [...JOB_TYPES],
            },
          ],
          accepted: { ...input },
        };
      }
    }

    let groupIds: string[];
    const explicitId = input.projectGroupId?.trim();
    const explicitName = input.projectGroupName?.trim();
    if (explicitId) {
      groupIds = [explicitId];
    } else {
      const groups = await this.accessibleProjectGroups(context);
      const entries = groups.flatMap((group) => {
        const id = group.tdei_project_group_id ?? group.id ?? group.project_group_id;
        const name = group.project_group_name ?? group.name;
        return typeof id === "string" && id.length > 0 ? [{ id, name: typeof name === "string" ? name : id }] : [];
      });
      if (explicitName) {
        const wanted = explicitName.toLowerCase();
        const exact = entries.filter((entry) => entry.name.toLowerCase() === wanted);
        const partial = entries.filter((entry) => entry.name.toLowerCase().includes(wanted));
        const found = exact.length > 0 ? exact : partial;
        if (found.length === 0) {
          return {
            status: "needs_input",
            missing: [
              {
                field: "projectGroupName",
                question: `No project group matches "${explicitName}". Which project group should I list jobs for?`,
                allowedValues: entries.map((entry) => entry.name),
              },
            ],
            accepted: { ...input },
          };
        }
        if (found.length > 1) {
          return {
            status: "needs_input",
            missing: [
              {
                field: "projectGroupName",
                question: `"${explicitName}" matches ${found.length} project groups. Which one?`,
                allowedValues: found.map((entry) => entry.name),
              },
            ],
            accepted: { ...input },
          };
        }
        groupIds = [found[0]!.id];
      } else if (input.allGroups === true) {
        groupIds = entries.map((entry) => entry.id);
      } else {
        return {
          status: "needs_input",
          missing: [
            {
              field: "projectGroupName",
              question:
                'Which project group should I list jobs for? Reply with its name, or say "all" to search every project group (slower).',
              allowedValues: entries.map((entry) => entry.name),
            },
          ],
          accepted: { ...input },
        };
      }
    }
    const searchedProjectGroups = groupIds;
    // Bounded-concurrency fan-out; results keep project-group order so output
    // stays deterministic. One inaccessible group must not fail the whole call.
    const perGroup = await mapWithConcurrency(groupIds, JOB_FANOUT_CONCURRENCY, async (groupId) => {
      try {
        return await this.dependencies.operations.listJobs(
          {
            ...(input.jobId?.trim() ? { jobId: input.jobId.trim() } : {}),
            projectGroupId: groupId,
            ...(input.includeGroupJobs !== undefined ? { includeGroupJobs: input.includeGroupJobs } : {}),
            ...(jobType ? { jobType } : {}),
            ...(input.status ? { status: input.status } : {}),
            page: 1,
            // One call per group at the API maximum; the display limit is applied afterwards.
            pageSize: JOBS_API_PAGE_SIZE,
          },
          context,
        );
      } catch {
        return [] as Array<Record<string, unknown>>;
      }
    });
    const collected: Array<Record<string, unknown>> = perGroup.flat();
    const apiPageFull = perGroup.some((jobs) => jobs.length >= JOBS_API_PAGE_SIZE);
    // Newest first across all groups, so the page holds the most recent jobs
    // rather than whatever the first groups happened to return. Jobs without
    // a timestamp sort last; the sort is stable so ties keep group order.
    const newestFirst = [...collected].sort((a, b) => {
      const ta = createdTimestampMs(a);
      const tb = createdTimestampMs(b);
      if (ta === tb) return 0;
      if (ta === undefined) return 1;
      if (tb === undefined) return -1;
      return tb - ta;
    });
    const matching =
      cutoffMs === undefined
        ? newestFirst
        : newestFirst.filter((job) => {
            const ts = createdTimestampMs(job);
            return ts !== undefined && ts >= cutoffMs;
          });
    const filtered = matching.slice(0, pageSize);
    const mayHaveMore = apiPageFull || matching.length > filtered.length;
    const truncation = {
      returned: collected.length,
      shown: filtered.length,
      apiPageFull,
      mayHaveMore,
      note: mayHaveMore
        ? `Showing ${filtered.length} jobs from one API page (the jobs API returns at most ${JOBS_API_PAGE_SIZE} per project group, has no total count and does not document its ordering; shown newest first by created_at). More matching jobs may exist. Do not call again to page: tell the user the list may be incomplete and ask them to narrow it, for example by status, job type, a specific job id, "submitted by me" versus the whole group, a recent-days filter, or a single project group.`
        : `Complete for the filters used: ${filtered.length} job(s) matched.`,
    };
    return {
      status: "complete",
      data: {
        jobs: filtered,
        appliedFilters: { ...input, searchedProjectGroups },
        apiOperation: "listJobs",
        method: "GET",
        path: "/api/v1/jobs",
        scopeNote:
          groupIds.length === 1
            ? "Jobs for the requested project group."
            : "Jobs searched across all of your accessible project groups, as requested.",
        truncation,
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
   * Resolve one project group from an id or a name. Names are matched against
   * the caller's groups (exact first, then substring), mirroring tdei_list_jobs.
   */
  private async resolveSingleProjectGroup(
    input: { projectGroupId?: string; projectGroupName?: string },
    context: RequestContext,
    question: string,
  ): Promise<
    | { status: "resolved"; id: string; name?: string }
    | { status: "needs_input"; question: string; allowedValues?: string[] }
  > {
    const explicitId = input.projectGroupId?.trim();
    const explicitName = input.projectGroupName?.trim();
    let groups: ProjectGroup[] = [];
    try {
      groups = await this.accessibleProjectGroups(context);
    } catch (error) {
      // The id alone is enough; only a name needs the group list.
      if (!explicitId) throw error;
    }
    const entries = groups.flatMap((group) => {
      const id = group.tdei_project_group_id ?? group.id ?? group.project_group_id;
      const name = group.project_group_name ?? group.name;
      return typeof id === "string" && id.length > 0 ? [{ id, name: typeof name === "string" ? name : id }] : [];
    });
    if (!explicitId && !explicitName) {
      return {
        status: "needs_input",
        question,
        allowedValues: entries.map((entry) => entry.name),
      };
    }
    if (explicitId) {
      const known = entries.find((entry) => entry.id === explicitId);
      return { status: "resolved", id: explicitId, ...(known ? { name: known.name } : {}) };
    }
    const wanted = (explicitName ?? "").toLowerCase();
    const exact = entries.filter((entry) => entry.name.toLowerCase() === wanted);
    const partial = entries.filter((entry) => entry.name.toLowerCase().includes(wanted));
    const found = exact.length > 0 ? exact : partial;
    if (found.length === 0) {
      return {
        status: "needs_input",
        question: `No project group matches "${explicitName}". ${question}`,
        allowedValues: entries.map((entry) => entry.name),
      };
    }
    if (found.length > 1) {
      return {
        status: "needs_input",
        question: `"${explicitName}" matches ${found.length} project groups. Which one?`,
        allowedValues: found.map((entry) => entry.name),
      };
    }
    const only = found[0]!;
    return { status: "resolved", id: only.id, name: only.name };
  }

  /**
   * Read every dataset record of a query (project group, optionally one
   * service) in page windows, stopping at the first short page. Bounded
   * concurrency keeps a ~2,400-record service near 10s instead of ~40s, and
   * the cap reports truncation instead of scanning forever.
   */
  private async scanDatasetPages(
    base: Pick<DatasetSearch, "dataType" | "status" | "projectGroupId" | "serviceId">,
    context: RequestContext,
  ): Promise<{ datasets: Array<Record<string, unknown>>; pagesRead: number; truncated: boolean }> {
    const datasets: Array<Record<string, unknown>> = [];
    let pagesRead = 0;
    let truncated = false;
    for (let windowStart = 1; ; windowStart += DATASET_SCAN_CONCURRENCY) {
      if (windowStart > DATASET_SCAN_MAX_PAGES) {
        truncated = true;
        break;
      }
      const lastPage = Math.min(windowStart + DATASET_SCAN_CONCURRENCY - 1, DATASET_SCAN_MAX_PAGES);
      const pageNumbers = Array.from({ length: lastPage - windowStart + 1 }, (_, index) => windowStart + index);
      // oxlint-disable-next-line no-await-in-loop -- pages are read in windows so the scan can stop as soon as a short page arrives
      const batches = await mapWithConcurrency(pageNumbers, DATASET_SCAN_CONCURRENCY, (page) =>
        this.dependencies.operations.searchDatasets(
          {
            ...base,
            sortField: "uploaded_timestamp",
            sortOrder: "desc",
            page,
            pageSize: DATASET_SCAN_PAGE_SIZE,
          },
          context,
        ),
      );
      let reachedEnd = false;
      for (const batch of batches) {
        pagesRead += 1;
        for (const dataset of batch) datasets.push(dataset);
        if (batch.length < DATASET_SCAN_PAGE_SIZE) {
          reachedEnd = true;
          break;
        }
      }
      if (reachedEnd) break;
      // Every page in the capped window was full: there may be more data.
      if (lastPage >= DATASET_SCAN_MAX_PAGES) {
        truncated = true;
        break;
      }
    }
    return { datasets, pagesRead, truncated };
  }

  /**
   * Read-only QA/QC report inventory for a project group or service: scan all
   * dataset pages, keep the latest version per name, and project the TCAT
   * report fields from metadata.dataset_detail.custom_metadata. This is the
   * read side of tdei_generate_quality_report (which creates one report job).
   */
  async getTcatQaReports(
    input: TcatQaReportsInput = {},
    context: RequestContext = {},
  ): Promise<IntentResult<TcatQaReportsData>> {
    const resolved = await this.resolveSingleProjectGroup(
      input,
      context,
      "Which project group should I read QA/QC reports for?",
    );
    if (resolved.status === "needs_input") {
      return {
        status: "needs_input",
        missing: [
          {
            field: "projectGroupName",
            question: resolved.question,
            ...(resolved.allowedValues ? { allowedValues: resolved.allowedValues } : {}),
          },
        ],
        accepted: { ...input },
      };
    }

    const projectGroupId = resolved.id;
    const dataType = input.dataType ?? "osw";
    const status = input.status ?? "All";
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    const latestPerName = input.latestPerName !== false;
    const serviceId = input.serviceId?.trim() || undefined;

    const scanKey = `tcatQaReports:${projectGroupId}:${serviceId ?? "*"}:${dataType}:${status}`;
    const loadScan = () =>
      this.scanDatasetPages({ projectGroupId, ...(serviceId ? { serviceId } : {}), dataType, status }, context);
    const scan = input.refresh
      ? await loadScan()
      : await this.cached(scanKey, DATASET_SCAN_CACHE_TTL_MS, context, loadScan);

    const latest = selectLatestPerName(scan.datasets, serviceId);
    const selected = latestPerName ? latest.selected : scan.datasets.map(toTcatCandidate);
    const versionsSuperseded = latestPerName ? latest.versionsSuperseded : 0;

    const toRow = (candidate: TcatCandidate): TcatQaReportRow => {
      const custom = readDatasetCustomMetadata(candidate.dataset);
      return {
        name: candidate.name,
        version: candidate.version,
        tdei_dataset_id: candidate.id,
        uploaded_timestamp: firstText(candidate.dataset, ["uploaded_timestamp", "uploaded_on"]),
        status: firstText(candidate.dataset, ["status"]),
        service: readDatasetServiceName(candidate.dataset),
        serviceId: firstText(candidate.dataset, ["tdei_service_id"]),
        pipelineVersion: firstText(custom, ["pipeline_version", "pipeline version"]),
        tractNo: firstText(custom, ["tract_no", "tract_nos"]),
        area: firstText(custom, ["area"]),
        county: firstText(custom, ["county"]),
        releaseNotes: firstText(custom, ["release_notes"]),
        qaQcReportVersion: firstText(custom, ["tcat_qa_qc_report_version"]),
        mapSource: firstText(custom, ["map_source"]),
        reportUrlPdf: firstText(custom, ["tcat_quality_report_url_pdf"]),
        reportUrlHtml: firstText(custom, ["tcat_quality_report_url_html"]),
        reportCode: firstText(custom, ["tcat_quality_report_code"]),
        imageryUsed: asRecord(custom?.imagery_used),
        versionsAvailable: candidate.versionsAvailable,
        customMetadata: input.includeCustomMetadata ? (custom ?? {}) : undefined,
      };
    };

    const cutoffMs = resolveCutoffMs(input.uploadedAfter, input.uploadedWithinDays);
    let rows = selected.map(toRow);
    if (cutoffMs !== undefined) {
      rows = rows.filter((row) => {
        const ms = row.uploaded_timestamp ? Date.parse(row.uploaded_timestamp) : Number.NaN;
        return Number.isFinite(ms) && ms >= cutoffMs;
      });
    }
    const needle = input.nameContains?.trim().toLowerCase();
    if (needle) rows = rows.filter((row) => row.name.toLowerCase().includes(needle));
    const reportFilter = input.reportFilter ?? "all";
    if (reportFilter === "with_reports") rows = rows.filter((row) => Boolean(row.reportUrlPdf || row.reportUrlHtml));
    if (reportFilter === "missing_reports") rows = rows.filter((row) => !row.reportUrlPdf && !row.reportUrlHtml);

    rows.sort((a, b) => {
      const byName = VERSION_COLLATOR.compare(a.name, b.name);
      return byName !== 0 ? byName : compareDatasetVersions(b.version, a.version);
    });

    const urlCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.reportUrlPdf) urlCounts.set(row.reportUrlPdf, (urlCounts.get(row.reportUrlPdf) ?? 0) + 1);
    }
    const summary = {
      matchingRows: rows.length,
      withReportPdf: rows.filter((row) => Boolean(row.reportUrlPdf)).length,
      withReportHtml: rows.filter((row) => Boolean(row.reportUrlHtml)).length,
      withReportCode: rows.filter((row) => Boolean(row.reportCode)).length,
      missingReport: rows.filter((row) => !row.reportUrlPdf && !row.reportUrlHtml).length,
      duplicateReportUrls: rows.filter(
        (row) => Boolean(row.reportUrlPdf) && (urlCounts.get(row.reportUrlPdf as string) ?? 0) > 1,
      ).length,
      versionsSuperseded,
    };
    const uniqueDatasetNames = new Set(selected.map((candidate) => candidate.name)).size;
    const shown = rows.slice(0, limit);
    const mayHaveMore = rows.length > shown.length;
    const scanNote = scan.truncated
      ? `Scanned ${scan.pagesRead} page(s) (${scan.datasets.length} dataset records) and stopped at the ${DATASET_SCAN_MAX_PAGES}-page cap; some datasets were not read. Narrow with serviceId or uploadedWithinDays.`
      : `Scanned every page: ${scan.pagesRead} page(s), ${scan.datasets.length} dataset record(s).`;

    return {
      status: "complete",
      data: {
        appliedFilters: { ...input, projectGroupId, dataType, status },
        ...(resolved.name ? { projectGroupName: resolved.name } : {}),
        scan: {
          pagesRead: scan.pagesRead,
          datasetsScanned: scan.datasets.length,
          uniqueDatasetNames,
          truncated: scan.truncated,
          note: scanNote,
        },
        summary,
        rows: shown,
        table: renderTcatQaReportTable(shown),
        truncation: {
          shown: shown.length,
          available: rows.length,
          mayHaveMore,
          note: mayHaveMore
            ? `Showing ${shown.length} of ${rows.length} matching rows (limit ${limit}); the summary counts cover all ${rows.length}. Narrow with serviceId, nameContains, reportFilter or uploadedWithinDays instead of paging.`
            : `Complete for the filters used: ${rows.length} row(s) matched.`,
        },
        apiOperation: "listDatasetFiles",
        method: "GET",
        path: "/api/v1/datasets",
      },
    };
  }

  /**
   * Build a client-side dataset download command. The MCP server never
   * writes files and never touches dataset bytes: it resolves the dataset
   * id + data type, targets the user-connected client folder (outputDir,
   * defaulting to the machine's standard Downloads folder), and returns a
   * ready-to-run curl command the LLM executes on the CLIENT machine into
   * that folder.
   */
  async downloadDataset(
    input: DownloadDatasetInput,
    context: RequestContext = {},
  ): Promise<IntentResult<DownloadDatasetData>> {
    const rawId = input.tdeiDatasetId?.trim() ?? "";
    if (!rawId) {
      return {
        status: "needs_input",
        missing: [{ field: "tdeiDatasetId", question: "Which TDEI dataset id should be downloaded?" }],
        accepted: {},
      };
    }
    const outputDir = input.outputDir?.trim() || defaultClientDownloadsDir();
    const defaultedDir = !input.outputDir?.trim();
    // The download endpoints require a UUID in the path. Callers often paste
    // the dataset NAME (e.g. Seattle_WSP_TDEI_OSW_0p2_Dataset_bbox) or a whole
    // table row instead — the old code then built /api/v1/osw/<NAME>, which
    // the API rejects with 404/403. A UUID anywhere in the input (pasted row
    // included) downloads immediately; a bare name goes through a consent
    // step with a match table first.
    const embeddedUuid = extractUuidFromText(rawId);
    let id = embeddedUuid ?? rawId;
    let dataType: DataType | undefined = input.dataType;
    let datasetName: string | undefined;
    const isUuidLike = embeddedUuid !== undefined || isUuidLikeDatasetId(rawId);
    if (isUuidLike) {
      // Look the dataset up even when dataType is given, so the default
      // filename can be "<dataset name>-<dataset id>.zip".
      if (!dataType || !input.filename?.trim()) {
        const lookup = await this.findDatasets({ tdeiDatasetId: id, limit: 5 }, context).catch(() => undefined);
        if (lookup?.status === "complete" && lookup.data.matches[0]) {
          const dataset = lookup.data.matches[0].dataset;
          dataType = dataType ?? readDatasetDataType(dataset) ?? "osw";
          datasetName = readDatasetName(dataset);
        } else {
          dataType = dataType ?? "osw";
        }
      }
    } else {
      // Bare row numbers carry no dataset context on their own — the caller
      // must also pass the name (via selection) or paste the UUID/row.
      if (/^\d+$/.test(rawId)) {
        return {
          status: "needs_input",
          missing: [
            {
              field: "selection",
              question: `"${rawId}" looks like a row number without a dataset name. Re-run tdei_download_dataset with tdeiDatasetId set to the dataset name plus selection:${rawId} (1-based row from the match table), or paste the tdei_dataset_id UUID directly.`,
            },
          ],
          accepted: { tdeiDatasetId: rawId },
        };
      }
      // Name path: search by name (place search tries name, then city, then
      // bbox). Never auto-downloads: show the match table and require the
      // user to confirm with a UUID (a pasted row works too) or a row number.
      const lookup = await this.findDatasets(
        { place: rawId, ...(input.dataType ? { dataType: input.dataType } : {}), limit: 10 },
        context,
      );
      if (lookup.status === "ambiguous") {
        return {
          status: "needs_input",
          missing: [
            {
              field: "tdeiDatasetId",
              question: `Multiple places match "${rawId}". Re-run tdei_find_datasets with place="${rawId}" to pick the exact dataset, then pass its tdei_dataset_id to tdei_download_dataset.`,
            },
          ],
          accepted: { tdeiDatasetId: rawId },
        };
      }
      if (lookup.status !== "complete" || !lookup.data.matches[0]) {
        // Caller asserted an explicit dataType with an ID-like token the
        // catalogue does not know (common in unit tests with fake ids):
        // preserve the old pass-through so explicit-type calls never fail
        // on lookup. Without an asserted type, a name that matches nothing
        // must not become /api/v1/osw/<NAME> — ask for a UUID instead.
        if (input.dataType) {
          dataType = input.dataType;
          datasetName = undefined;
        } else {
          return {
            status: "needs_input",
            missing: [
              {
                field: "tdeiDatasetId",
                question: `No dataset found for "${rawId}". It looks like a dataset NAME, not a UUID — run tdei_find_datasets with place="${rawId}" (or the city) to get the exact tdei_dataset_id, then retry tdei_download_dataset with that UUID. Raw names cannot be used in the /api/v1/osw/{id} download path.`,
              },
            ],
            accepted: { tdeiDatasetId: rawId },
          };
        }
      } else {
        const matches = lookup.data.matches;
        const retryAccepted: Record<string, unknown> = {
          tdeiDatasetId: rawId,
          ...(input.dataType ? { dataType: input.dataType } : {}),
          ...(input.outputDir ? { outputDir: input.outputDir } : {}),
          ...(input.filename ? { filename: input.filename } : {}),
        };
        if (input.selection !== undefined) {
          const row = Math.floor(input.selection);
          if (!Number.isInteger(input.selection) || row < 1 || row > matches.length) {
            return {
              status: "needs_input",
              missing: [
                {
                  field: "selection",
                  question: `selection ${String(input.selection)} is out of range (1..${matches.length}) for "${rawId}":\n${lookup.data.table}\nRe-run tdei_download_dataset with tdeiDatasetId="${rawId}" and selection:<row number>, or paste the tdei_dataset_id UUID directly.`,
                },
              ],
              accepted: retryAccepted,
            };
          }
          const chosen = matches[row - 1];
          const resolvedId = chosen ? readDatasetId(chosen.dataset) : undefined;
          if (!chosen || !resolvedId) {
            return {
              status: "needs_input",
              missing: [
                {
                  field: "tdeiDatasetId",
                  question: `Row ${row} for "${rawId}" has no tdei_dataset_id. Re-run tdei_find_datasets to inspect it.`,
                },
              ],
              accepted: retryAccepted,
            };
          }
          id = resolvedId;
          datasetName = readDatasetName(chosen.dataset);
          dataType = input.dataType ?? readDatasetDataType(chosen.dataset) ?? "osw";
        } else if (matches.length === 1) {
          const only = matches[0];
          const resolvedId = only ? readDatasetId(only.dataset) : undefined;
          if (!only || !resolvedId) {
            return {
              status: "needs_input",
              missing: [
                {
                  field: "tdeiDatasetId",
                  question: `Found a dataset matching "${rawId}" but it has no tdei_dataset_id. Re-run tdei_find_datasets to inspect it.`,
                },
              ],
              accepted: retryAccepted,
            };
          }
          if (input.confirm !== true) {
            return {
              status: "needs_input",
              missing: [
                {
                  field: "confirm",
                  question: `Found 1 dataset matching "${rawId}":\n${lookup.data.table}\nTo download it, re-run tdei_download_dataset with tdeiDatasetId="${resolvedId}" (pasting the full row works too), or repeat this call with confirm:true.`,
                },
              ],
              accepted: retryAccepted,
            };
          }
          id = resolvedId;
          datasetName = readDatasetName(only.dataset);
          dataType = input.dataType ?? readDatasetDataType(only.dataset) ?? "osw";
        } else {
          return {
            status: "needs_input",
            missing: [
              {
                field: "tdeiDatasetId",
                question: `Found ${matches.length} datasets matching "${rawId}":\n${lookup.data.table}\nReply with the tdei_dataset_id (UUID) of the one to download — pasting the full row works too — or re-run tdei_download_dataset with tdeiDatasetId="${rawId}" and selection:<row number> (1-based).`,
              },
            ],
            accepted: retryAccepted,
          };
        }
      }
    }
    const resolved = (dataType ?? "osw") as DataType;
    const apiPath = `/api/v1/${resolved === "osw" ? "osw" : resolved === "flex" ? "gtfs-flex" : "gtfs-pathways"}/${id}`;
    const apiOperation =
      resolved === "osw" ? "getOswFile" : resolved === "flex" ? "getGtfsFlexFile" : "getGtfsPathwaysFile";
    // Default name: <dataset name>-<dataset id>.zip (just <id>.zip if the
    // name is unknown).
    const safeName = datasetName?.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) ?? "";
    const safeBase = safeName ? `${safeName}-${id}` : id;
    // Always end the download in .zip: a user-supplied filename may omit the
    // extension or carry a wrong one (e.g. ".err"), which confuses clients.
    const rawName = input.filename?.trim() || `${safeBase}.zip`;
    const noSlashes = rawName.replace(/[/\\]/g, "_");
    const filename = /\.zip$/i.test(noSlashes) ? noSlashes : `${noSlashes}.zip`;
    const filePath = joinDownloadPath(outputDir, filename);
    const apiUrl = (this.dependencies.apiUrl ?? process.env.TDEI_API_URL?.trim() ?? "").replace(/\/+$/, "");
    const bearer = (await this.resolveCurlToken(context)) ?? "$TDEI_TOKEN";
    const curlCommand = buildClientDownloadCurl(`${apiUrl}${apiPath}`, bearer, filePath);
    const dirNote = defaultedDir
      ? ` No folder was specified, so the command targets $HOME/Downloads expanded on the CLIENT machine (your Downloads folder on macOS/Linux, and in PowerShell on Windows); if the client shell is Windows cmd.exe — which does not expand $HOME — substitute the connected folder's absolute path for $HOME/Downloads before running.`
      : "";
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
        instruction:
          `Execute this now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it, do not save it to a script file): ${curlCommand}. ` +
          (bearer === "$TDEI_TOKEN"
            ? `$TDEI_TOKEN must hold the caller's TDEI SSO bearer (sign in first). `
            : `The caller's TDEI bearer is already embedded; no export needed. `) +
          `File bytes flow directly from the TDEI backend to the client; the gateway is not a relay.${dirNote}`,
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
    const rawJobId = job.job_id;
    const jobId = typeof rawJobId === "string" && rawJobId.trim() ? rawJobId.trim() : undefined;
    const resultPath = `/api/v1/job/download/${jobId ?? "<job_id>"}`;
    return {
      ...job,
      followUp:
        `Track progress with tdei_list_jobs${jobId ? ` (jobId: ${jobId})` : ""}. ` +
        `Once status is COMPLETED, get the result with the job_download raw tool: GET ${resultPath} ` +
        `(argument job_id="${jobId ?? "<job_id>"}"). ` +
        `Launched via ${operation}.`,
      ...(jobId
        ? {
            resultDownload: {
              tool: "job_download",
              method: "GET",
              path: resultPath,
              requires: "status COMPLETED",
            },
          }
        : {}),
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
    // The lookup only refines the reported data type; a failed search must not block the runbook.
    const lookup = await this.findDatasets({ tdeiDatasetId: id, limit: 5 }, context).catch(() => undefined);
    let dataType: DataType = "osw";
    if (lookup?.status === "complete" && lookup.data.matches[0]) {
      const raw = (lookup.data.matches[0].dataset.data_type as string | undefined)?.toLowerCase();
      if (raw === "flex" || raw === "pathways" || raw === "osw") dataType = raw;
    }
    const apiPath = `/api/v1/osw/${id}`;
    const apiUrl = (this.dependencies.apiUrl ?? process.env.TDEI_API_URL?.trim() ?? "").replace(/\/+$/, "");
    const bearer = (await this.resolveCurlToken(context)) ?? "$TDEI_TOKEN";
    const curlCommand = buildClientDownloadCurl(`${apiUrl}${apiPath}`, bearer, `${id}.zip`);
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
          `Execute this now with your shell tool on the CLIENT machine (no human step, do not ask the user to run it): 1) run ${curlCommand}${bearer === "$TDEI_TOKEN" ? " with $TDEI_TOKEN set to the SSO bearer (sign in first)" : " (caller bearer already embedded)"}; ` +
          `2) unzip and inspect edges files (edges.geojson) for an incline tag/column; ` +
          `3) if inclines are missing, tag them with tdei_tag_incline. File bytes flow directly from the TDEI backend; the gateway is not a relay.`,
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
    // Call through `operations` so implementations keep their `this`.
    const operations = this.dependencies.operations;
    const results = await Promise.all(
      types.map((dataType) =>
        this.cached(`versions:${dataType}`, STATIC_REFERENCE_TTL_MS, context, () =>
          operations.listVersions!({ dataType }, context),
        ),
      ),
    );
    const versions: Record<string, unknown> = Object.fromEntries(types.map((dataType, i) => [dataType, results[i]]));
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
    const operations = this.dependencies.operations;
    const [capabilities, apiVersions] = await Promise.all([
      this.cached("capabilities", STATIC_REFERENCE_TTL_MS, context, () => operations.getCapabilities!(context)),
      this.cached("apiVersions", STATIC_REFERENCE_TTL_MS, context, () => operations.listApiVersions!(context)),
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
