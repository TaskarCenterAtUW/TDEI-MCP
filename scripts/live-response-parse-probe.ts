/**
 * Live GET API probe — calls non-auth TDEI list/read endpoints and checks
 * that recordsFrom / MCP JSON decoding handle the real response shapes.
 *
 * Run from the repo root (do not commit the token):
 *
 *   TDEI_ACCESS_TOKEN='<paste-bearer-here>' \
 *   TDEI_API_URL=https://api-dev.tdei.us \
 *     npm run test:live-parse
 *
 * Or equivalently:
 *
 *   TDEI_ACCESS_TOKEN='<paste-bearer-here>' \
 *   TDEI_API_URL=https://api-dev.tdei.us \
 *     node --import tsx scripts/live-response-parse-probe.ts
 */
import { decodeAwsJson } from "../src/adapters/aws-result-decoder.js";
import { parseTdeiGetResponse } from "../src/adapters/tdei-get-response.js";
import { tryParseTdeiJson } from "../src/adapters/parse-tdei-json.js";
import { TDEI_SSO_CLIENT_ID } from "../src/config.js";

const API = (process.env.TDEI_API_URL ?? "https://api-dev.tdei.us").replace(/\/+$/, "");
const TOKEN = process.env.TDEI_ACCESS_TOKEN?.trim();

if (!TOKEN) {
  console.error("Set TDEI_ACCESS_TOKEN to a Bearer (do not commit it).");
  process.exit(2);
}

// Probe documents that MCP auth uses client_id=tdei-mcp (not portal tdei-gateway).
console.error(`[live-parse] expected SSO client_id=${TDEI_SSO_CLIENT_ID}`);

type Probe = {
  name: string;
  path: string;
  /** Expected parseTdeiGetResponse kind for this GET. */
  expectKind: "records" | "object";
  allowEmpty?: boolean;
  /** Path params filled from earlier list probes. */
  needs?: Array<"projectGroupId" | "serviceId" | "datasetId" | "jobId">;
};

const PROBES: Probe[] = [
  { name: "listApiVersions", path: "/api/v1/api", expectKind: "records", allowEmpty: true },
  { name: "system-capabilities", path: "/api/v1/system/capabilities", expectKind: "object" },
  { name: "system-metrics", path: "/api/v1/system-metrics", expectKind: "object" },
  { name: "data-metrics", path: "/api/v1/data-metrics", expectKind: "object" },
  { name: "listProjectGroups", path: "/api/v1/project-groups?page_no=1&page_size=10", expectKind: "records" },
  { name: "listServices", path: "/api/v1/services?page_no=1&page_size=10", expectKind: "records", allowEmpty: true },
  { name: "listDatasetFiles", path: "/api/v1/datasets?page_no=1&page_size=10", expectKind: "records", allowEmpty: true },
  {
    name: "listJobs",
    path: "/api/v1/jobs?tdei_project_group_id={projectGroupId}&page_no=1&page_size=10",
    needs: ["projectGroupId"],
    expectKind: "records",
    allowEmpty: true,
  },
  { name: "listOswVersions", path: "/api/v1/osw/versions", expectKind: "records", allowEmpty: true },
  { name: "listGtfsFlexVersions", path: "/api/v1/gtfs-flex/versions", expectKind: "records", allowEmpty: true },
  { name: "listGtfsPathwaysVersions", path: "/api/v1/gtfs-pathways/versions", expectKind: "records", allowEmpty: true },
  {
    name: "service-metrics",
    path: "/api/v1/service-metrics/{projectGroupId}",
    needs: ["projectGroupId"],
    // Contains a services[] envelope — classified as records, body still preserved.
    expectKind: "records",
    allowEmpty: true,
  },
  {
    name: "listServicesByGroup",
    path: "/api/v1/services?tdei_project_group_id={projectGroupId}&page_no=1&page_size=10",
    needs: ["projectGroupId"],
    expectKind: "records",
    allowEmpty: true,
  },
  {
    name: "listDatasetsByGroup",
    path: "/api/v1/datasets?tdei_project_group_id={projectGroupId}&page_no=1&page_size=10",
    needs: ["projectGroupId"],
    expectKind: "records",
    allowEmpty: true,
  },
  {
    name: "oswDatasetViewerFeedbacks",
    path: "/api/v1/osw/dataset-viewer/feedbacks?page_no=1&page_size=10",
    expectKind: "records",
    allowEmpty: true,
  },
  {
    name: "oswDatasetViewerFeedbacksMetadata",
    path: "/api/v1/osw/dataset-viewer/feedbacks/metadata",
    expectKind: "object",
  },
];

type Shape =
  | { kind: "array"; length: number; sampleKeys: string[] }
  | { kind: "object"; keys: string[] }
  | { kind: "primitive"; type: string }
  | { kind: "empty" }
  | { kind: "non-json"; contentType: string; bytes: number };

function describe(body: unknown, contentType: string, byteLength: number): Shape {
  if (body === "" || body === undefined) return { kind: "empty" };
  if (typeof body === "string") {
    return { kind: "non-json", contentType, bytes: byteLength };
  }
  if (Array.isArray(body)) {
    const first = body.find((x) => x && typeof x === "object" && !Array.isArray(x)) as
      | Record<string, unknown>
      | undefined;
    return {
      kind: "array",
      length: body.length,
      sampleKeys: first ? Object.keys(first).slice(0, 12) : [],
    };
  }
  if (body && typeof body === "object") {
    return { kind: "object", keys: Object.keys(body as object).slice(0, 24) };
  }
  return { kind: "primitive", type: typeof body };
}

async function fetchJson(path: string): Promise<{
  status: number;
  contentType: string;
  body: unknown;
  text: string;
}> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/json, */*",
      Authorization: `Bearer ${TOKEN}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const body: unknown = text ? tryParseTdeiJson(text) : text;
  return { status: response.status, contentType, body, text };
}

function fillPath(
  template: string,
  ids: Partial<Record<"projectGroupId" | "serviceId" | "datasetId" | "jobId", string>>,
): string | undefined {
  let path = template;
  for (const key of ["projectGroupId", "serviceId", "datasetId", "jobId"] as const) {
    if (path.includes(`{${key}}`)) {
      const value = ids[key];
      if (!value) return undefined;
      path = path.replaceAll(`{${key}}`, encodeURIComponent(value));
    }
  }
  return path;
}

type Row = {
  name: string;
  path: string;
  status: number;
  shape: Shape;
  expectKind: "records" | "object";
  parsedKind?: string;
  parsedCount: number;
  bodyMatches: boolean;
  ok: boolean;
  note?: string;
};

const ids: Partial<Record<"projectGroupId" | "serviceId" | "datasetId" | "jobId", string>> = {};
const rows: Row[] = [];
const failures: string[] = [];

for (const probe of PROBES) {
  const path = fillPath(probe.path, ids);
  if (!path) {
    rows.push({
      name: probe.name,
      path: probe.path,
      status: 0,
      shape: { kind: "empty" },
      expectKind: probe.expectKind,
      parsedCount: 0,
      bodyMatches: true,
      ok: true,
      note: `skipped — missing ${probe.needs?.join(",")}`,
    });
    continue;
  }

  try {
    const { status, contentType, body, text } = await fetchJson(path);
    const shape = describe(body, contentType, text.length);
    const parsed = parseTdeiGetResponse(body);
    const mcpDecoded = decodeAwsJson({
      content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
    });

    if (status === 200 && parsed.kind === "records") {
      const first = parsed.records[0];
      if (first) {
        const pg = first.tdei_project_group_id;
        const svc = first.tdei_service_id;
        const ds = first.tdei_dataset_id;
        const job = first.job_id ?? first.tdei_job_id;
        if (typeof pg === "string" && !ids.projectGroupId) ids.projectGroupId = pg;
        if (typeof svc === "string" && !ids.serviceId) ids.serviceId = svc;
        if (typeof ds === "string" && !ids.datasetId) ids.datasetId = ds;
        if (typeof job === "string" && !ids.jobId) ids.jobId = job;
      }
    }

    let ok = status === 200 || status === 204 || status === 404;
    let note: string | undefined;
    const bodyMatches = JSON.stringify(parsed.body) === JSON.stringify(body)
      && JSON.stringify(mcpDecoded.body) === JSON.stringify(body);

    if (status === 401 || status === 403) {
      ok = false;
      note = "auth rejected — token may be expired";
    } else if (status === 200) {
      if (parsed.kind !== probe.expectKind) {
        ok = false;
        note = `expected kind=${probe.expectKind}, got ${parsed.kind}`;
      } else if (!bodyMatches) {
        ok = false;
        note = "parsed/MCP body drifted from API JSON";
      } else if (
        probe.expectKind === "records" &&
        parsed.records.length === 0 &&
        !probe.allowEmpty
      ) {
        ok = false;
        note = `records empty but data required; shape=${JSON.stringify(shape)}`;
      } else if (
        probe.expectKind === "records" &&
        parsed.records.length > 0 &&
        Array.isArray(body) &&
        JSON.stringify(parsed.records[0]) !== JSON.stringify(body[0])
      ) {
        ok = false;
        note = "first record does not match API row fields";
      } else if (mcpDecoded.kind !== parsed.kind || mcpDecoded.records.length !== parsed.records.length) {
        ok = false;
        note = "MCP decode classification mismatch";
      }
    }

    if (!ok) failures.push(`${probe.name}: ${note ?? `HTTP ${status}`}`);
    rows.push({
      name: probe.name,
      path,
      status,
      shape,
      expectKind: probe.expectKind,
      parsedKind: parsed.kind,
      parsedCount: parsed.records.length,
      bodyMatches,
      ok,
      note,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${probe.name}: ${message}`);
    rows.push({
      name: probe.name,
      path,
      status: 0,
      shape: { kind: "empty" },
      expectKind: probe.expectKind,
      parsedCount: 0,
      bodyMatches: false,
      ok: false,
      note: message,
    });
  }
}

console.log(JSON.stringify({
  api: API,
  capturedIds: {
    projectGroupId: ids.projectGroupId ?? null,
    serviceId: ids.serviceId ?? null,
    datasetId: ids.datasetId ?? null,
    jobId: ids.jobId ?? null,
  },
  summary: {
    total: rows.length,
    ok: rows.filter((r) => r.ok).length,
    failed: failures.length,
  },
  failures,
  rows,
}, null, 2));

if (failures.length > 0) process.exit(1);
