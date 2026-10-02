import type { IntentResult } from "./types.js";

export interface IntentRoute {
  intent: "list_my_project_groups" | "find_datasets" | "list_services" | "validate_dataset" | "upload_dataset";
  tool: "tdei_list_my_project_groups" | "tdei_find_datasets" | "tdei_list_services" | "tdei_validate_dataset" | "tdei_upload_dataset";
  apiOperation: "listProjectGroups" | "listDatasetFiles" | "listServices" | "validateDataset" | "uploadDataset";
  method: "GET" | "POST";
  path: string;
}

const ROUTES = {
  projectGroups: {
    intent: "list_my_project_groups",
    tool: "tdei_list_my_project_groups",
    apiOperation: "listProjectGroups",
    method: "GET",
    path: "/api/v1/project-groups",
  },
  datasets: {
    intent: "find_datasets",
    tool: "tdei_find_datasets",
    apiOperation: "listDatasetFiles",
    method: "GET",
    path: "/api/v1/datasets",
  },
  services: {
    intent: "list_services",
    tool: "tdei_list_services",
    apiOperation: "listServices",
    method: "GET",
    path: "/api/v1/services",
  },
  validate: {
    intent: "validate_dataset",
    tool: "tdei_validate_dataset",
    apiOperation: "validateDataset",
    method: "POST",
    path: "/api/v1/{data-type}/validate",
  },
  upload: {
    intent: "upload_dataset",
    tool: "tdei_upload_dataset",
    apiOperation: "uploadDataset",
    method: "POST",
    path: "/api/v1/{data-type}/upload/{project-group-id}/{service-id}",
  },
} as const satisfies Record<string, IntentRoute>;

function contains(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function resolveUserIntent(request: string): IntentResult<IntentRoute> {
  const normalized = request.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
  const routes: IntentRoute[] = [];
  const wantsUpload = contains(normalized, /\b(upload|submit|ingest)\b/);
  const validationAction = contains(normalized, /\b(validate|validation|verify|check)\b/);
  const validationObject = contains(normalized, /\b(dataset|data|file|zip|osw|gtfs|pathways|flex)\b/);
  const wantsValidation = validationAction && validationObject;
  const wantsServices = contains(normalized, /\bservices?\b/);
  const wantsDatasets = contains(normalized, /\b(datasets?|data files?|osw|gtfs|sidewalk data)\b/);
  const wantsProjectGroups = contains(normalized, /\b(project groups?|projects?|organizations?|organisations?|orgs?|groups?)\b/);
  const explicitlyCombinesIntents = /\b(and|then|also)\b/.test(normalized);
  const explicitlyRetrievesDatasets = /\b(find|list|show|get|search|download)(?:\s+\w+){0,3}\s+(datasets?|data files?|osw|gtfs|sidewalk data)\b/.test(normalized);

  if (wantsValidation || (explicitlyCombinesIntents && validationAction)) routes.push(ROUTES.validate);
  if (wantsUpload) routes.push(ROUTES.upload);
  if (wantsServices && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.services);
  if (wantsDatasets && (routes.length === 0 || (explicitlyCombinesIntents && explicitlyRetrievesDatasets))) {
    routes.push(ROUTES.datasets);
  }
  if (wantsProjectGroups && (routes.length === 0 || explicitlyCombinesIntents)) {
    routes.push(ROUTES.projectGroups);
  }

  if (routes.length === 1) return { status: "complete", data: routes[0] as IntentRoute };
  if (routes.length > 1) {
    return {
      status: "ambiguous",
      question: `Should I ${routes.map((route) => route.intent.replaceAll("_", " ")).join(" or ")}?`,
      candidates: routes.map((route) => ({ ...route })),
      accepted: { request },
    };
  }
  return {
    status: "needs_input",
    missing: [{
      field: "intent",
      question: "Are you looking for projects, datasets, services, dataset validation, or dataset upload?",
      allowedValues: [
        "projects/project groups",
        "datasets",
        "services",
        "validate a dataset",
        "upload a dataset",
      ],
    }],
    accepted: { request },
  };
}
