/**
 * Redirect URI registered for the tdei-mcp OAuth client.
 * Keycloak accepts one address for every gateway child:
 * `https://<host>/auth/callback`. A per-slug path is rejected.
 */
export function publicAuthCallbackUrl(publicBaseUrl: string): string {
  const origin = publicBaseUrl.replace(/\/$/, "");
  return `${origin}/auth/callback`;
}

export function isAuthCallbackPath(pathname: string, gatewaySlug?: string): boolean {
  if (pathname === "/auth/callback" || pathname === "/callback") return true;
  const slug = gatewaySlug?.trim();
  return Boolean(slug) && pathname === `/${slug}/auth/callback`;
}
