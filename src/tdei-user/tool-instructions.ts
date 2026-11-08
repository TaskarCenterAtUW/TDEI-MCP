/**
 * LLM-facing guidance for the User Management API tools that core servers expose. Keyed by final tool name
 * (see operation-names.ts). Facts come from the API's OpenAPI document and its source
 * (TDEI-user-management-ts): which routes need the poc role, the request bodies, and how the Portal uses them.
 */

const NEEDS_POC =
  "Needs the poc role in that project group (or tdei_admin). A 403 / permission error means the user lacks it: say so plainly and suggest asking their project group's POC.";
const CONFIRM_WRITE =
  "This changes data: confirm the project group name, the exact target and the change with the user before calling, and report what was done.";
const IDS =
  "Take project group ids from tdei_list_my_project_groups and service ids from tdei_list_services; never guess an id.";

export const TDEI_USER_TOOL_INSTRUCTIONS: Readonly<Record<string, string>> = {
  portal_list_roles: `Lists the roles that can be assigned in a project group (for example poc, member and the data generator roles). Use it to show valid choices before portal_assign_project_group_roles. ${NEEDS_POC}`,
  portal_list_project_group_members: `Lists the members of one project group with their roles (searchText filters by name, page_no and page_size page the list; one call per page). ${IDS} ${NEEDS_POC}`,
  portal_create_service: `Creates a service in a project group. Body: tdei_project_group_id, service_name and service_type (osw, flex or pathways); polygon (GeoJSON boundary) is optional. A service is where datasets of that type are uploaded, so confirm the type matches the data. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_update_service: `Updates a service's name or boundary in a project group. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_set_service_active: `Activates or deactivates a service (status in the path: true to activate, false to deactivate). Deactivating removes it from the active list, so confirm first. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_assign_project_group_roles: `Gives a user roles in a project group. Body: tdei_project_group_id, user_name (the user's registered TDEI email, as entered in the Portal's Assign New User) and roles (valid values from portal_list_roles). The user must already have a TDEI account; if the API says the user is not registered, they must register on the TDEI Portal first (this server cannot take passwords). Check the email and roles twice: assigning poc by mistake lets that person change the project group, members, services and datasets. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_revoke_project_group_roles: `Removes roles from a user in a project group (same body as portal_assign_project_group_roles). ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_list_referral_codes: `Lists the referral (invite) codes of a project group. ${IDS} ${NEEDS_POC}`,
  portal_create_referral_code: `Creates a referral (invite) code for a project group: type 1 is always available, type 2 is limited time (valid_from and valid_to). ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_update_referral_code: `Updates an existing referral code of a project group. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_delete_referral_code: `Deletes (soft deletes) a referral code of a project group. ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
  portal_get_referral_code: "Shows the details of a referral code (public lookup by code).",
  portal_set_project_group_viewer_settings: `Sets the project group's dataset viewer preferences (project-group level; for one dataset use tdei_set_viewer_access). ${IDS} ${NEEDS_POC} ${CONFIRM_WRITE}`,
};

export const TDEI_USER_MY_ROLES_HELP =
  "Lists the caller's own project groups with the roles they hold in each (the Portal's project-group roles). Use it for 'what are my roles in <project group>' and 'which project groups am I in'; optional projectGroupName filters by name. " +
  "Roles are project-group roles (for example poc, member, osw_data_generator); workspace roles are separate and come from the workspace server. Unlike tdei_get_my_identity, this reflects actual project-group membership.";
