export const TDEI_LLM_CACHE_INSTRUCTIONS =
  "Cache and reuse stable TDEI reference data (project group IDs and names, service IDs and types, dataset IDs and metadata, and resolved intent mappings) within the conversation context instead of re-fetching on every turn. Only re-query when the user asks to refresh, changes filter criteria, or after a mutation (such as dataset upload or creation).";

export const SEMANTIC_TOOL_DESCRIPTIONS = {
  resolveIntent:
    "Deterministically map a plain-language TDEI request to a supported semantic tool and underlying API operation. Use first when the request uses broad terms or aliases such as projects, organizations, orgs, or groups, or could match more than one TDEI domain. Returns a structured clarification instead of guessing when multiple intents are explicit. Cache the resolved intent mapping for similar requests in the conversation.",
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Returns ambiguity instead of guessing a place. Cache returned dataset IDs, names, project_group_id, service_id, and metadata in conversation memory to avoid redundant searches across follow-up turns.",
  listMyProjectGroups:
    "List TDEI project groups for the authenticated login via listProjectGroups (GET /api/v1/project-groups). Use this for 'project', 'projects', 'project group', 'project groups', or 'groups I belong to'. This tool is the listProjectGroups call; do not look for a separate membership API. Project group memberships rarely change during a session—cache and reuse the returned project_group_id and name values across the conversation rather than calling this tool repeatedly.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'. Cache returned service IDs, names, project_group_id, and service types in conversation context and reuse them for subsequent dataset queries or uploads instead of re-fetching.",
  validateDataset:
    "Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. If the data type or asset is missing, returns structured questions for the client to ask. Never stores clarification state or uploads incomplete input.",
  uploadDataset:
    "Upload a dataset to TDEI. Checks the target project group, service, asset, and required metadata first. Reuse cached projectGroupId and serviceId from earlier listMyProjectGroups / listServices calls in the session when available. Incomplete input returns all missing questions and performs no upload; resend the complete values in a later call.",
} as const;
