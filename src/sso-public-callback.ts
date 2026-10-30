/**
 * Redirect URI registered for the tdei-mcp Keycloak client.
 * The dev realm rejects the gateway's public https URL. Login must
 * send the browser here. A local relay forwards that hit to the gateway.
 */
export const REGISTERED_SSO_REDIRECT_URI = "http://127.0.0.1:8765/callback";

/**
 * Gateway path that receives the relay. Keycloak does not redirect here.
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
