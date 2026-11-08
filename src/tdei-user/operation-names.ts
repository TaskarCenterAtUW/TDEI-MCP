import { defaultOperationName } from "../openapi/openapi-mcp-client.js";

/**
 * TDEI User Management API ("portal API": https://portal-api-{dev,stage}.tdei.us and https://portal-api.tdei.us).
 * Its operationIds are terse ("permission", "roles"), so the operations users need get explicit portal_* names. The prefix is portal_, not tdei_: tdei_* names are built-ins that bypass the operator's endpoints.allow/deny filter, and these write tools must stay deniable.
 * Everything else keeps its default name and is hidden unless explicitly allow-listed.
 */
export const USER_API_TOOL_NAMES: Readonly<Record<string, string>> = {
  roles: "portal_list_roles",
  getProjectGroupUsers: "portal_list_project_group_members",
  createService: "portal_create_service",
  updateService: "portal_update_service",
  deleteService: "portal_set_service_active",
  permission: "portal_assign_project_group_roles",
  revokePermission: "portal_revoke_project_group_roles",
  getProjectGroupReferralCodes: "portal_list_referral_codes",
  createProjectGroupReferralCode: "portal_create_referral_code",
  updateProjectGroupReferralCode: "portal_update_referral_code",
  deleteProjectGroupReferralCode: "portal_delete_referral_code",
  getReferralCodeDetails: "portal_get_referral_code",
  updateDataViewer: "portal_set_project_group_viewer_settings",
};

/** Final MCP tool name for a User API operationId. */
export function userOperationName(operationId: string): string {
  return USER_API_TOOL_NAMES[operationId] ?? defaultOperationName(operationId);
}

/**
 * User API operations that are never listed unless the operator names them in `endpoints.allow`
 * (or sets TDEI_EXPOSE_ALL_RAW_TOOLS=1), with the reason. Names are final tool names.
 */
export const USER_API_HIDDEN: Readonly<Record<string, string>> = {
  // Credentials and sign-in belong to the connector (tdei_sso_login); passwords never go through chat.
  authenticate: "connector-managed sign-in",
  authenticateWithReferralCode: "connector-managed sign-in",
  refresh_token: "connector-managed token refresh",
  resetCredentials: "password reset happens on the Portal, not through chat",
  registerUser: "registration takes a password; done on the Portal",
  // Covered by existing core tools.
  getService: "use tdei_list_services",
  getProjectGroup: "use tdei_list_my_project_groups",
  getUserProfile: "use tdei_get_my_identity",
  // Replaced by tdei_my_project_group_roles, which fills in the caller's user id.
  projectGroupRoles: "use tdei_my_project_group_roles",
  // TDEI_ADMIN only: regular users would only get 403.
  createProjectGroup: "TDEI_ADMIN only",
  updateProjectGroup: "TDEI_ADMIN only",
  deleteProjectGroup: "TDEI_ADMIN only",
  searchUsers: "TDEI_ADMIN only",
  downloadUsers: "TDEI_ADMIN only; bulk personal data",
  listApplicationRoles: "TDEI_ADMIN only",
  getUserApplicationRoles: "TDEI_ADMIN only",
  addApplicationRoles: "TDEI_ADMIN only",
  removeApplicationRoles: "TDEI_ADMIN only",
  // Changes the caller's own membership from a code: done deliberately on the Portal.
  applyReferralCode: "joins a project group from an invite code",
};

/** Tool names for operations always hidden (credentials): an allow-list cannot expose them. */
export const USER_API_NEVER_EXPOSED: ReadonlySet<string> = new Set([
  "authenticate",
  "authenticateWithReferralCode",
  "refresh_token",
  "resetCredentials",
  "registerUser",
]);

export function isUserApiHidden(toolName: string): boolean {
  return Object.hasOwn(USER_API_HIDDEN, toolName);
}
