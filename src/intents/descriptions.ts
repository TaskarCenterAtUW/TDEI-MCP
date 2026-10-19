export const SEMANTIC_TOOL_DESCRIPTIONS = {
  resolveIntent:
    "Deterministically map a plain-language TDEI request to a supported semantic tool and underlying API operation. Use first when the request uses broad terms or aliases such as projects, organizations, orgs, or groups, or could match more than one TDEI domain. Returns a structured clarification instead of guessing when multiple intents are explicit.",
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Returns ambiguity instead of guessing a place.",
  listMyProjectGroups:
    "List TDEI project groups for the authenticated login via listProjectGroups (GET /api/v1/project-groups). Use this for 'project', 'projects', 'project group', 'project groups', or 'groups I belong to'. This tool is the listProjectGroups call; do not look for a separate membership API.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'.",
  validateDataset:
    "Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. If the data type or asset is missing, returns structured questions for the client to ask. Never stores clarification state or uploads incomplete input.",
  uploadDataset:
    "Upload a dataset to TDEI. Checks the target project group, service, asset, and required metadata first. Incomplete input returns all missing questions and performs no upload; resend the complete values in a later call.",
} as const;
