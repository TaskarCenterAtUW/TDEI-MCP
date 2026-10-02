export const SEMANTIC_TOOL_DESCRIPTIONS = {
  findDatasets:
    "Find TDEI datasets from a natural-language place or bounding box. Use for requests such as 'get me the latest dataset for Seattle'. Searches dataset name first, then city, then forward-geocodes the place for a bbox search. Returns ambiguity instead of guessing a place.",
  listMyProjectGroups:
    "List the TDEI project groups the authenticated user belongs to. The current published TDEI API lacks a complete membership operation, so this tool reports the required capability instead of returning all groups or an incomplete inference.",
  listServices:
    "List TDEI services, optionally filtered by name, project group, or data type (OSW, GTFS Flex, or GTFS Pathways). Use for requests such as 'get me the list of services'.",
  validateDataset:
    "Validate an OSW, GTFS Flex, or GTFS Pathways dataset ZIP. If the data type or asset is missing, returns structured questions for the client to ask. Never stores clarification state or uploads incomplete input.",
  uploadDataset:
    "Upload a dataset to TDEI. Checks the target project group, service, asset, and required metadata first. Incomplete input returns all missing questions and performs no upload; resend the complete values in a later call.",
} as const;
