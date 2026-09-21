const DEFAULT_API_URL = "https://api-dev.tdei.us";

const DEFAULT_SPEC_URL =
  "https://raw.githubusercontent.com/TaskarCenterAtUW/TDEI-ExternalAPIs/dev/tdei-api-gateway.json";

const DEFAULT_AWS_MCP_PACKAGE =
  "awslabs.openapi-mcp-server@1.1.2";

const DEFAULT_SSO_CALLBACK_URL = "http://127.0.0.1:8765/callback";

function readHttpsUrl(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }

  return url.toString().replace(/\/+$/, "");
}

export const config = {
  apiUrl: readHttpsUrl(
    "TDEI_API_URL",
    DEFAULT_API_URL,
  ),

  specUrl: readHttpsUrl(
    "TDEI_SPEC_URL",
    DEFAULT_SPEC_URL,
  ),

  ssoClientId: process.env.TDEI_SSO_CLIENT_ID?.trim() || "tdei-mcp",

  ssoCallbackUrl: (() => {
    const value = process.env.TDEI_SSO_CALLBACK_URL?.trim() || DEFAULT_SSO_CALLBACK_URL;
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/callback") {
      throw new Error("TDEI_SSO_CALLBACK_URL must use http://127.0.0.1:<port>/callback");
    }
    return url.toString();
  })(),

  awsMcpPackage:
    process.env.TDEI_AWS_MCP_PACKAGE?.trim() ||
    DEFAULT_AWS_MCP_PACKAGE,
};
