import type { IntentResult } from "./types.js";

export interface IntentRoute {
  intent:
    | "list_my_project_groups"
    | "find_datasets"
    | "list_services"
    | "validate_dataset"
    | "upload_dataset"
    | "get_my_identity"
    | "list_jobs"
    | "get_dataset_details"
    | "publish_dataset"
    | "delete_dataset"
    | "clone_dataset"
    | "edit_metadata"
    | "list_feedbacks"
    | "get_metrics"
    | "list_versions"
    | "get_system_info"
    | "verify_email"
    | "recover_password"
    | "regenerate_api_key";
  tool:
    | "tdei_list_my_project_groups"
    | "tdei_find_datasets"
    | "tdei_list_services"
    | "tdei_validate_dataset"
    | "tdei_upload_dataset"
    | "tdei_get_my_identity"
    | "tdei_list_jobs"
    | "tdei_get_dataset_details"
    | "tdei_publish_dataset"
    | "tdei_delete_dataset"
    | "tdei_clone_dataset"
    | "tdei_edit_metadata"
    | "tdei_list_feedbacks"
    | "tdei_get_metrics"
    | "tdei_list_versions"
    | "tdei_get_system_info"
    | "tdei_verify_email"
    | "tdei_recover_password"
    | "tdei_regenerate_api_key";
  apiOperation:
    | "listProjectGroups"
    | "listDatasetFiles"
    | "listServices"
    | "validateDataset"
    | "uploadDataset"
    | "listJobs"
    | "none"
    | "publishDataset"
    | "deleteDataset"
    | "cloneDataset"
    | "editMetadata"
    | "listFeedbacks"
    | "getMetrics"
    | "listVersions"
    | "systemInfo"
    | "authAction";
  method: "GET" | "POST" | "PUT" | "DELETE";
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
  identity: {
    intent: "get_my_identity",
    tool: "tdei_get_my_identity",
    apiOperation: "none",
    method: "GET",
    path: "SSO JWT claims (no TDEI roles endpoint)",
  },
  jobs: {
    intent: "list_jobs",
    tool: "tdei_list_jobs",
    apiOperation: "listJobs",
    method: "GET",
    path: "/api/v1/jobs",
  },
  datasetDetails: {
    intent: "get_dataset_details",
    tool: "tdei_get_dataset_details",
    apiOperation: "listDatasetFiles",
    method: "GET",
    path: "/api/v1/datasets",
  },
  publish: {
    intent: "publish_dataset",
    tool: "tdei_publish_dataset",
    apiOperation: "publishDataset",
    method: "POST",
    path: "/api/v1/{data-type}/publish/{id}",
  },
  deleteDataset: {
    intent: "delete_dataset",
    tool: "tdei_delete_dataset",
    apiOperation: "deleteDataset",
    method: "DELETE",
    path: "/api/v1/dataset/{id}",
  },
  clone: {
    intent: "clone_dataset",
    tool: "tdei_clone_dataset",
    apiOperation: "cloneDataset",
    method: "POST",
    path: "/api/v1/dataset/clone/{id}/{project-group-id}/{service-id}",
  },
  editMetadata: {
    intent: "edit_metadata",
    tool: "tdei_edit_metadata",
    apiOperation: "editMetadata",
    method: "PUT",
    path: "/api/v1/metadata/{id}",
  },
  feedbacks: {
    intent: "list_feedbacks",
    tool: "tdei_list_feedbacks",
    apiOperation: "listFeedbacks",
    method: "GET",
    path: "/api/v1/osw/dataset-viewer/feedbacks",
  },
  metrics: {
    intent: "get_metrics",
    tool: "tdei_get_metrics",
    apiOperation: "getMetrics",
    method: "GET",
    path: "/api/v1/data-metrics",
  },
  versions: {
    intent: "list_versions",
    tool: "tdei_list_versions",
    apiOperation: "listVersions",
    method: "GET",
    path: "/api/v1/{data-type}/versions",
  },
  systemInfo: {
    intent: "get_system_info",
    tool: "tdei_get_system_info",
    apiOperation: "systemInfo",
    method: "GET",
    path: "/api/v1/system/capabilities",
  },
  verifyEmail: {
    intent: "verify_email",
    tool: "tdei_verify_email",
    apiOperation: "authAction",
    method: "POST",
    path: "/api/v1/verify-email",
  },
  recoverPassword: {
    intent: "recover_password",
    tool: "tdei_recover_password",
    apiOperation: "authAction",
    method: "POST",
    path: "/api/v1/recover-password",
  },
  regenKey: {
    intent: "regenerate_api_key",
    tool: "tdei_regenerate_api_key",
    apiOperation: "authAction",
    method: "POST",
    path: "/api/v1/regenerate-api-key",
  },
} as const satisfies Record<string, IntentRoute>;

// Phrases that ask about jobs or their progress. They mention "upload" or
// "validation" as nouns, so they must not trigger the upload/validate actions.
const JOB_PHRASE_SOURCE =
  "jobs?|job id|recent uploads?|upload history|upload failures?|failed uploads?|upload status|validation status|processing status|" +
  "status\\s+of\\s+(?:my|the|that|this|our)?\\s*(?:\\w+\\s+){0,2}?(?:validation|upload|uploads|validate)\\w*|" +
  "(?:did|has|have|is|was|were|are)\\s+(?:my|the|that|this|our|it)?\\s*(?:\\w+\\s+){0,2}?(?:validation|upload|uploads|validate)\\w*\\s+(?:finish\\w*|complet\\w*|done|succe\\w+|fail\\w*|pass\\w*)";
const JOB_PHRASES = new RegExp(`\\b(?:${JOB_PHRASE_SOURCE})\\b`);
const JOB_PHRASES_GLOBAL = new RegExp(JOB_PHRASES.source, "g");

function contains(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function resolveUserIntent(request: string): IntentResult<IntentRoute> {
  const normalized = request
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const routes: IntentRoute[] = [];
  const wantsJobs = JOB_PHRASES.test(normalized);
  const actionText = normalized.replace(JOB_PHRASES_GLOBAL, " ").replace(/\s+/g, " ").trim();
  const wantsUpload = contains(actionText, /\b(upload|submit|ingest)\b/);
  const validationAction = contains(actionText, /\b(validate|validation|verify|check)\b/);
  const validationObject = contains(actionText, /\b(dataset|data|file|zip|osw|gtfs|pathways|flex)\b/);
  const wantsValidation = validationAction && validationObject;
  const wantsServices = contains(normalized, /\bservices?\b/);
  const wantsDatasets = contains(normalized, /\b(datasets?|data files?|osw|gtfs|sidewalk data)\b/);
  const wantsProjectGroups = contains(
    normalized,
    /\b(project groups?|projects?|organizations?|organisations?|orgs?|groups?)\b/,
  );
  const wantsIdentity = contains(
    normalized,
    /\b(my roles?|what (are|is) my roles?|who am i|my identity|my email|my username|permissions?)\b/,
  );
  const wantsDatasetDetails = contains(
    normalized,
    /\b(dataset details|dataset status|release status|inclines?|tdei dataset id)\b/,
  );
  const wantsPublish = contains(normalized, /\bpublish(?:ed|es|ing)?\b/);
  const wantsDelete = contains(normalized, /\bdelet(?:e|ed|es|ing)\b/);
  const wantsClone = contains(normalized, /\bclone(?:d|s|ing)?\b/);
  const wantsEditMetadata = contains(normalized, /\bmetadata\b/);
  const wantsFeedback = contains(normalized, /\bfeedbacks?\b/);
  const wantsMetrics = contains(normalized, /\bmetrics\b/);
  const wantsVersions = contains(normalized, /\bversions?\b/);
  const wantsSystemInfo = contains(normalized, /\bcapabilit(?:y|ies)\b|\bsystem info(?:rmation)?\b/);
  const wantsVerifyEmail = contains(
    normalized,
    /\bverif(?:y|ication)\b.{0,20}\bemail\b|\bemail\b.{0,20}\bverif(?:y|ication)\b/,
  );
  const wantsRecover = contains(
    normalized,
    /\b(?:recover|reset|forgot)\b.{0,20}\bpassword\b|\bpassword\b.{0,20}\b(?:recover|reset)\b/,
  );
  const wantsRegenKey = contains(normalized, /\bregenerat\w*\b.{0,20}\bapi key\b|\bapi key\b.{0,20}\bregenerat\w*\b/);
  const explicitlyCombinesIntents = /\b(and|then|also)\b/.test(normalized);
  const explicitlyRetrievesDatasets =
    /\b(find|list|show|get|search|download)(?:\s+\w+){0,3}\s+(datasets?|data files?|osw|gtfs|sidewalk data)\b/.test(
      normalized,
    );

  if (wantsValidation || (explicitlyCombinesIntents && validationAction)) routes.push(ROUTES.validate);
  if (wantsUpload) routes.push(ROUTES.upload);
  if (wantsIdentity && !wantsVerifyEmail && (routes.length === 0 || explicitlyCombinesIntents))
    routes.push(ROUTES.identity);
  if (wantsJobs && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.jobs);
  if (wantsDatasetDetails && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.datasetDetails);
  if (wantsPublish && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.publish);
  if (wantsDelete && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.deleteDataset);
  if (wantsClone && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.clone);
  if (wantsEditMetadata && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.editMetadata);
  if (wantsFeedback && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.feedbacks);
  if (wantsMetrics && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.metrics);
  if (wantsVersions && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.versions);
  if (wantsSystemInfo && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.systemInfo);
  if (wantsVerifyEmail && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.verifyEmail);
  if (wantsRecover && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.recoverPassword);
  if (wantsRegenKey && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.regenKey);
  if (wantsServices && (routes.length === 0 || explicitlyCombinesIntents)) routes.push(ROUTES.services);
  if (
    !wantsDatasetDetails &&
    wantsDatasets &&
    (routes.length === 0 || (explicitlyCombinesIntents && explicitlyRetrievesDatasets))
  ) {
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
    missing: [
      {
        field: "intent",
        question:
          "Are you looking for projects, datasets, dataset details, services, jobs, roles/identity, dataset validation, dataset upload, publish, delete, clone, metadata, feedbacks, metrics, versions, system info, email verification, password recovery, or API key regeneration?",
        allowedValues: [
          "projects/project groups",
          "datasets",
          "dataset details",
          "services",
          "jobs",
          "roles/identity",
          "validate a dataset",
          "upload a dataset",
          "publish a dataset",
          "delete a dataset",
          "clone a dataset",
          "edit metadata",
          "feedbacks",
          "metrics",
          "versions",
          "system info",
          "verify email",
          "recover password",
          "regenerate API key",
        ],
      },
    ],
    accepted: { request },
  };
}
