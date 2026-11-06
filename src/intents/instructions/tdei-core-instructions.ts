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
- Do not use workspace-only paths (workspace_id, tasking projects, teams, fixmes) on this server. Those belong to the tdei-workspace server.

${renderToolRoutingGuide()}
`;
