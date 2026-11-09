import { resolveTdeiEnvironment, type TdeiEnvironment } from "../tdei-shared/web-ui-handoffs.js";

/**
 * Export of a workspace to TDEI has no backend operation. The Workspaces web app does it in the browser
 * (services/export/tdei.ts, TdeiExporter._exportOswToTdei in TaskarCenterAtUW/workspaces-frontend); this
 * runbook reproduces the same calls with existing operations plus client-side curl, so an MCP client can
 * do it for the user. Keep it in step with that file: each step names the frontend call it mirrors.
 */

/** OSM API host that serves a workspace's map data and changesets (not part of any MCP OpenAPI spec). */
const OSM_HOST: Record<TdeiEnvironment, string> = {
  dev: "https://osm.workspaces-dev.sidewalks.washington.edu",
  stage: "https://osm.workspaces-stage.sidewalks.washington.edu",
  prod: "https://osm.workspaces.sidewalks.washington.edu",
};

/** TDEI core API host (convert, jobs, upload). The core server's tools build the same URLs. */
const CORE_HOST: Record<TdeiEnvironment, string> = {
  dev: "https://api-dev.tdei.us",
  stage: "https://api-stage.tdei.us",
  prod: "https://api.tdei.us",
};

export function osmApiBase(environment: TdeiEnvironment): string {
  return `${OSM_HOST[environment]}/api/0.6`;
}

export function coreApiBase(environment: TdeiEnvironment): string {
  return `${CORE_HOST[environment]}/api/v1`;
}

/**
 * Step-by-step runbook for "export workspace <id> to project group <id>". The user supplies the workspace and
 * the target project group; everything else is read from the workspace or asked for.
 */
export function exportToTdeiRunbook(env: NodeJS.ProcessEnv = process.env, bearer?: string): string {
  const environment = resolveTdeiEnvironment(env);
  const token = bearer?.trim() || "$TDEI_TOKEN";
  const osm = osmApiBase(environment);
  const core = coreApiBase(environment);

  return `Export a workspace to TDEI, advanced API recipe. The recommended way is the Workspaces web UI; use this only because the user explicitly asked you to do the export yourself and you can run commands on their machine. There is no single export operation. It creates a NEW TDEI dataset from the workspace's current data. It is what the Workspaces web UI does (Export > Upload to TDEI), done with existing operations plus client-side curl. Run the steps in order; stop at the first failure and show the error.

Do not interrogate the user. Work out every input yourself, apply the defaults below, and ask only for what you truly cannot determine. The one confirmation is step 6, where you show all the values you chose so the user can correct them.
- workspace_id: from the request; if the user named the workspace, match it in get_my_workspaces (ask only when several match). Never invent an id.
- Project group and service: the workspace's own tdeiProjectGroupId and tdeiServiceId. Ask only if one is missing or the user named a different group.
- Output folder: $HOME/Downloads/tdei-export-<workspace_id>/ (create it). Never ask for a folder.
- Environment: the connected servers' environment; ask only under the environment rule when several are connected.
- SSO bearer: ${bearer?.trim() ? "already embedded in every command below" : "not available to this server, so the commands use $TDEI_TOKEN; run them after the user has exported TDEI_TOKEN in the shell"}. Never ask the user to paste a token from dev tools, and never print it in chat.
- Dataset metadata: use the defaults in "Metadata". Do not ask for name, version, collected_by, collection_date, data_source or schema_version.
Role needed: POC or osw_data_generator in the target project group.

0) Preflight. Call get_workspace and read type, title, tdeiProjectGroupId, tdeiServiceId and tdeiRecordId.
- type must be osw for the steps below. For pathways go to "Pathways workspaces" at the end.
- The project group to upload to defaults to the workspace's own tdeiProjectGroupId. If the user named a different one, say so and confirm: tdeiRecordId (the source dataset) belongs to the workspace's group and may not be visible from another.
- A service is required (the upload URL contains it). Use tdeiServiceId from the workspace; if it is empty, list the group's services with tdei_list_services (core server), let the user choose an OSW service and use that id. If the workspace has no project group at all, stop: it cannot be exported.
- Decide the dataset metadata from the defaults (see "Metadata"); do not ask for it.

1) Workspace bounds. Call get_workspace_bbox (GET /api/v1/workspaces/{workspace_id}/bbox). It returns min_lat, min_lon, max_lat, max_lon, or 204/empty/incomplete values when the workspace has never held a node. In that case STOP and tell the user the workspace holds no data, so there is nothing to export (an empty dataset uploaded to TDEI cannot be undone from here). Do not export empty.

2) Export the workspace data as OSM XML, with curl on the CLIENT machine (the OSM host is not an MCP server):
   curl -sS -G "${osm}/map" --data-urlencode "bbox=<min_lon>,<min_lat>,<max_lon + 0.0000001>,<max_lat + 0.0000001>" -H "Authorization: Bearer ${token}" -H "X-Workspace: <workspace_id>" -H "Accept: application/xml" -o "<dir>/osm.xml"
   Pad max_lon and max_lat by 0.0000001 so nodes on the boundary are not lost; do NOT use a whole-world bbox (it crashes the map endpoint). Save into the default output folder. Check the file is non-empty XML starting with <osm.

3) Convert OSM to OSW. Use tdei_convert_osw on the core server (asset = absolute path of osm.xml, sourceFormat osm, targetFormat osw; it needs the project group), or its endpoint: POST ${core}/osw/convert multipart with source_format=osm, target_format=osw, file=@osm.xml. It returns a job_id. Poll tdei_list_jobs (GET ${core}/jobs?job_id=<id>&tdei_project_group_id=<project group>) about every 4 seconds until the status is completed; if it is failed, stop and show the job message ("Conversion job failed"). Then download the result with job_download (GET ${core}/job/download/<job_id>) to <dir>/osw.zip.

4) Source lineage (derived_from_dataset_id). If the workspace has a tdeiRecordId, check the dataset still exists with tdei_get_dataset_details (GET ${core}/datasets?status=All&tdei_dataset_id=<tdeiRecordId>). If it returns a dataset, upload with derived_from_dataset_id=<tdeiRecordId>; if it was deleted or is not visible, upload WITHOUT it. A workspace with no tdeiRecordId has no lineage.

5) Optional changeset archive (see "Changeset archive"). Skip unless the user wants changesets included or an ADA certification.

6) Confirm, then upload. Before sending, show the user: workspace id and title, target project group, service, dataset name and version, whether it derives from a source dataset, and whether changesets are included. Wait for a yes; this creates a dataset in TDEI.
   Use tdei_upload_dataset on the core server (dataType osw, asset = <dir>/osw.zip, projectGroupId, serviceId, the metadata JSON, derived_from_dataset_id when step 4 applies), or its endpoint: POST ${core}/osw/upload/<projectGroupId>/<serviceId>[?derived_from_dataset_id=<tdeiRecordId>] multipart with dataset=@osw.zip;type=application/x-zip-compressed, metadata=@metadata.json;type=application/json and, if built, changeset=@changeset.zip;type=application/x-zip-compressed. The response is a job id. Poll tdei_list_jobs until it is completed; if TDEI rejects it, show the job message ("TDEI rejected the upload").

7) Report the job id, the final job status and the new dataset id (from the job result or tdei_find_datasets / tdei_get_dataset_details). Export is not publication: only if the user also asks to validate or publish it, that is a further core-server step.

Metadata. The upload body is {"dataset_detail": {...}}. Required in dataset_detail: name, version, collected_by, collection_date (ISO date), data_source (one of 3rdParty, TDEITools, InHouse) and schema_version. Optional: description, custom_metadata, valid_from, valid_to, collection_method (manual, transform, generated, AV, others) and dataset_area. Defaults, used without asking: name = "<workspace title> (export <today, YYYY-MM-DD>)"; version = the source dataset's version with its last number incremented when tdeiRecordId exists (v1.7 becomes 1.8), otherwise "1.0"; collected_by = the signed-in user's name or email from tdei_get_my_identity on the core server; collection_date = today (ISO date); data_source = TDEITools; schema_version = the source dataset's schema_version, or the newest from tdei_list_versions if there is no source; description omitted. The user can change any of them at the confirmation in step 6. If dataset_area is not given, set it from the step 1 bounds as a GeoJSON FeatureCollection holding one Polygon Feature whose ring is [min_lon,min_lat], [min_lon,max_lat], [max_lon,max_lat], [max_lon,min_lat], [min_lon,min_lat] (longitude first). Other metadata sections (data_provenance, dataset_summary, maintenance, methodology) are optional.

Changeset archive (optional; the web UI offers it as "include changesets", and ADA certification adds to it). Build <dir>/changeset.zip with:
- manifest.json: {"workspace": {id, title, description, type, tdeiProjectGroupId, tdeiServiceId, tdeiRecordId, createdAt, createdBy, createdByName} (from get_workspace), "exportedAt": <now, ISO>, "includesRawOsmChange": <bool>, "adaCertification": {"certifiedBy", "certifiedByName", "certifiedAt"} or null, "changesets": [<the list from the next call>]}. Only fill adaCertification when the user states who certifies; never invent it.
- the list: curl -sS "${osm}/changesets.json" -H "Authorization: Bearer ${token}" -H "X-Workspace: <workspace_id>" and read .changesets.
- per changeset id: curl -sS "${osm}/changeset/<id>/download" -H "Authorization: Bearer ${token}" -H "X-Workspace: <workspace_id>" -H "Accept: application/xml". The web UI stores each one as changesets/<id>.json (the osmChange XML parsed to JSON with @osmcha/osmchange-parser) and, only if raw OSC was requested, also changesets/<id>.osc. Without that parser installed, store the raw XML as changesets/<id>.osc and tell the user the archive differs from the web UI's.

Pathways workspaces. The calls are the same up to the OSM export, but the dataset is built client-side from GTFS CSV files: the workspace's elements (GET ${osm}/map.json?bbox=<padded bbox>, Accept application/json, X-Workspace) are turned into stops.txt, pathways.txt and levels.txt (generated stop/pathway/level ids, level outlines merged, merged into the source dataset's GTFS files), and the rest of the feed (agency, routes, trips, stop_times, calendar) comes from the source dataset (tdei_download_dataset for gtfs-pathways, tdeiRecordId) or an agency GTFS feed the user supplies. The result is uploaded with POST ${core}/gtfs-pathways/upload/<projectGroupId>/<serviceId>[?derived_from_dataset_id=<id>] (same multipart fields). That CSV build is not reproducible with curl and the ID and merge rules are not documented here, so do not improvise it: for pathways, hand the user to the Workspaces web UI (Export > Upload to TDEI) instead. If the source dataset no longer exists and the user has no agency feed, the web UI refuses too.

Never print the SSO bearer in chat. Run client-side commands on the user's machine, not the server's.`;
}
