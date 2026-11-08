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
- Some things have no API and are web-only: registering an account, creating or editing a service, and adding project-group members or changing their roles are done in the TDEI Portal (poc role for services and members); exporting a workspace is done in Workspaces. When the user asks for one, give them the link for their environment and walk them through the steps in the matching tool description instead of failing or guessing an API.
- Do not use workspace-only paths (workspace_id, tasking projects, teams, fixmes) on this server. Those belong to the tdei-workspace server; mention that only if the user asks for them.

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
