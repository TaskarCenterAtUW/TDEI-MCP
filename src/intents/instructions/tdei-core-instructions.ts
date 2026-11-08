import { workspaceCompanionNote } from "../../tdei-shared/companion-servers.js";
import { renderToolRoutingGuide } from "../routing-guide.js";
import { TDEI_SHARED_SERVER_INSTRUCTIONS } from "./tdei-shared-instructions.js";

/** Instructions for tdei-core-dev, tdei-core-staging, and tdei-core-production. */
export const TDEI_CORE_SERVER_INSTRUCTIONS = `${TDEI_SHARED_SERVER_INSTRUCTIONS}

## TDEI core data server
This server talks to the TDEI core API: project groups, services, datasets, jobs, feedbacks, metrics, and data-standard versions. The dev, staging, and production instances share these instructions; only the API host changes.

- Resolve project groups and services first (tdei_list_my_project_groups, tdei_list_services) and cache their IDs for later dataset and upload calls.
- Use tdei_find_datasets for name/city/bbox searches, tdei_get_dataset_details for an exact tdei_dataset_id, and tdei_download_dataset to build the client-side download curl.
- If the User provides a osw file (zip) and asks to validate call the following POST API /api/v1/osw/validate thru CURL and upload the file directly. 
- Dataset upload are client-side: ask for the data type, the absolute ZIP path on the CLIENT machine, and (for uploads) projectGroupId, serviceId, and required metadata. Return the curl hand-off, then poll tdei_list_jobs. Once a job is COMPLETED, fetch its result with job_download (GET /api/v1/job/download/<job_id>).
- When user asks for the latest datasets for a project group - Get the latest unique published datasets. No duplicate items on the list return. 
- For OSW Tag definition, use the osw-tag-definition schema (inclines, surface, width, length,description, name) then use tdei_get_dataset_details to generate the request payload based on the json at https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-osw-datasvc-ts/dev/schema/tag-quality.json.
- For Tags, use the tag-quality schema to generate the request payload.
- Jobs: before tdei_list_jobs, ask the user which project group (by name) unless they named one; list project groups with tdei_list_my_project_groups if they need options. Pass projectGroupName (or projectGroupId). Only when the user says "all" pass allGroups:true. For "running jobs" use status IN-PROGRESS; for one job's status use jobId. Fetching a job's result (job_download) is the last step and only for COMPLETED jobs.
- Project-group services and members are managed through the User Management API tools (portal_create_service, portal_update_service, portal_set_service_active, portal_assign_project_group_roles, portal_revoke_project_group_roles, portal_list_project_group_members, portal_list_roles, and referral-code tools); they need the poc role in that project group, so say plainly when the user lacks it. Some things have no API and are web-only: registering an account (passwords never go through chat) is done on the TDEI Portal, and exporting a workspace is done in Workspaces. When the user asks for one, give them the link for their environment and walk them through the steps in the matching tool description instead of failing or guessing an API.
- Do not use workspace-only paths (workspace_id, tasking projects, teams, fixmes) on this server. Those belong to the tdei-workspace server; mention that only if the user asks for them.

## Dataset lifecycle and API behaviour (core server)
Derived from the TDEI API tester (TaskarCenterAtUW/TDEI-api-tester) and the core OpenAPI spec.
- Async operations (upload, validate, convert, publish, union, spatial join, tag road, bbox, confidence, quality) answer 202 with a numeric job id and a Location header /api/v1/jobs?job_id=<id>. 202 means "accepted, now poll", not "done".
- Polling: tdei_list_jobs with the job id and the project group (show_group_jobs=true covers jobs of other members; admins may pass an empty project group). Statuses are IN-PROGRESS, COMPLETED and FAILED; both COMPLETED and FAILED are final, so stop polling and, on FAILED, report the job message instead of retrying. Poll with a growing delay (about 1s, then up to 10s) and give up after about 10 minutes, then tell the user the job is still running.
- An upload job that is COMPLETED carries the new dataset id in response_props.tdei_dataset_id. Use that id for every later step; never invent one.
- Typical lifecycle: upload (creates a pre-release dataset) -> poll -> edit metadata -> publish -> poll. Publish returns 400 while valid_from or valid_to in the metadata is null: set both through edit metadata (PUT /api/v1/metadata/{tdei_dataset_id}) first. Clone (POST /api/v1/dataset/clone/{dataset}/{project_group}/{service}) copies a dataset into a project group and service using a metadata file.
- Multipart field names for the client-side curl hand-offs: upload needs dataset (zip) and metadata (metadata.json), and optionally changeset; validate needs dataset; convert needs file plus source_format and target_format (osw to osm, or osm to osw); edit metadata, clone, tag-quality metric and (optional) confidence or intersection-quality polygon use a single file part. Keep real file names and extensions (.zip, .json, .geojson) on the parts.
- Metadata file blocks: data_provenance, dataset_detail (name, description, version, collected_by, collection_date, collection_method, data_source, dataset_area as a FeatureCollection with a closed Polygon in [lon, lat] order, valid_from, valid_to, schema_version), dataset_summary, maintenance, methodology. Typical schema_version by data type: flex v2.0, pathways v1.0, osw v0.3; confirm with the user or tdei_list_versions rather than assuming.
- OSW operations on the wrong kind of dataset (a flex or pathways id) return 400; an unknown dataset id returns 404; a missing or expired token returns 401; asking for a quality report that is already running or exists returns 409, so look up the existing job instead of repeating the request.
- Tag road (source_dataset_id, target_dataset_id): the target must be a pre-release dataset; a published target returns 400. Union takes tdei_dataset_id_one and tdei_dataset_id_two. Spatial join needs target_dataset_id, source_dataset_id, target_dimension, source_dimension and join_condition (for example ST_Contains(ST_Buffer(geometry_target, 5), geometry_source)); join_filter_target, join_filter_source and aggregate are optional. Empty or invalid values are rejected with 400, so validate inputs with the user before calling.
- Tag-quality metric is synchronous (200 with a list per entity_type: total_entity_count, overall_quality_metric, metric_details); its file is a JSON list of {entity_type, tags[]}. Confidence and intersection-quality are async (202).
- Authentication: SSO is a browser flow (sso-redirect, then sso-login with code and state returns access and refresh tokens); the redirect_uri must be registered with the auth server. API-key calls (x-api-key) exist for validation but this connector signs in with SSO.

## Understanding the request (core server)
- "project", "projects", "organization": on this server a TDEI PROJECT GROUP (tdei_list_my_project_groups), not a workspace tasking project.
- "latest dataset for <place>": tdei_find_datasets with the place, status Publish unless the user wants pre-release, latest:true; the API sorts by upload time, newest first. A "dataset" is data stored in TDEI; a "workspace" is an editable copy of one (workspace server).
- "my roles / permissions": tdei_get_my_identity (SSO token claims; TDEI has no roles endpoint). It does not list project-group membership or workspace roles.
- "jobs": tdei_list_jobs needs a project group (ask which one). "Show: all" in the portal means the whole group (includeGroupJobs true); omitted means only the user's own jobs. The job result is only fetched once the status is COMPLETED.
- "what changed in a dataset": there is no diff; use lineage (derived_from_dataset_id) and exact versions.
- A dataset NAME is not an id: resolve it to a tdei_dataset_id with tdei_find_datasets and let the user confirm before download, delete, clone or publish.
- Destructive or irreversible (delete, publish, union, regenerate API key): confirm the exact target first.

## Requests that span both servers (workspace tasks)
${workspaceCompanionNote()}
Only when the user wants to create a workspace from a dataset: resolve the dataset here (for "latest dataset for <place>" use tdei_find_datasets with place, osw, Publish, latest and let the user confirm a row), ask the user for the workspace name and the project group (show tdei_list_my_project_groups as a table), then hand tdei_dataset_id, data type, service_id and project group id to the workspace server's create_workspace. Exporting a workspace back to TDEI is done in the Workspaces web UI by a user with the POC or osw_data_generator role (see tdei_get_my_identity); use tdei_list_services to show candidate services.

${renderToolRoutingGuide()}
`;
