/**
 * Fail fast when Keycloak will reject the SSO redirect_uri.
 *
 * `tdei_sso_login` hands the caller a URL that the browser opens. If the
 * Keycloak client has no matching Valid Redirect URI, that URL renders
 * "We are sorry... Invalid parameter: redirect_uri" and the login dies in the
 * browser with no signal back to MCP. Fetching the same URL once before the
 * caller opens it turns that dead end into an actionable error.
 */

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 64 * 1024;

export interface SsoPreflightContext {
  redirectUri: string;
  clientId: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

interface SsoPreflightResponse {
  status: number;
  body: string;
  finalUrl: string;
}

function realmDetails(finalUrl: string): { host: string; realm: string } {
  try {
    const url = new URL(finalUrl);
    const match = /\/realms\/([^/]+)/.exec(url.pathname);
    return { host: url.origin, realm: match?.[1] ?? "tdei" };
  } catch {
    return { host: finalUrl, realm: "tdei" };
  }
}

/**
 * Returns a remediation message when the response is a Keycloak rejection,
 * or undefined when the page is a normal login form (or not recognisable).
 */
function describeKeycloakRejection(response: SsoPreflightResponse, context: SsoPreflightContext): string | undefined {
  const body = response.body;
  if (!body) return undefined;

  const { host, realm } = realmDetails(response.finalUrl);
  const client = `client "${context.clientId}"`;

  if (/client not found/i.test(body)) {
    return (
      `Keycloak at ${host} does not know the SSO ${client} in realm "${realm}". ` +
      `Create that client in the realm (or fix TDEI_SSO_CLIENT_ID) and retry.`
    );
  }

  if (/invalid parameter:\s*redirect_uri/i.test(body)) {
    return (
      `Keycloak rejected the SSO redirect_uri "${context.redirectUri}" for ${client} in realm "${realm}" at ${host}. ` +
      `The browser would stop on "We are sorry... Invalid parameter: redirect_uri" and the login would never reach this server. ` +
      `Fix (requires Keycloak admin): open ${host}/admin -> realm "${realm}" -> Clients -> "${context.clientId}" -> Settings, ` +
      `add "${context.redirectUri}" to "Valid redirect URIs" (and "Valid post logout redirect URIs"), then call tdei_sso_login again. ` +
      `No MCP-side setting can work around this: the redirect URI must be registered on the Keycloak client.`
    );
  }

  return undefined;
}

/**
 * GET the login URL once and report a Keycloak redirect_uri/client rejection.
 * Returns undefined on any non-Keycloak outcome (healthy form, network error,
 * timeout, unexpected status) so a flaky preflight never blocks a real login.
 */
export async function preflightSsoLogin(loginUrl: string, context: SsoPreflightContext): Promise<string | undefined> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const timeoutMs = context.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(loginUrl, {
      redirect: "follow",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = (await response.text()).slice(0, MAX_BODY_CHARS);
  } catch {
    return undefined;
  }

  return describeKeycloakRejection({ status: response.status, body, finalUrl: response.url || loginUrl }, context);
}
