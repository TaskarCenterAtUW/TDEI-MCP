/** Browser callback for one gateway child: `https://<host>/<slug>/auth/callback`. */
export function publicAuthCallbackUrl(publicBaseUrl: string, gatewaySlug?: string): string {
  const origin = publicBaseUrl.replace(/\/$/, "");
  const slug = gatewaySlug?.trim();
  if (!slug) return `${origin}/auth/callback`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("TDEI gateway slug is invalid");
  }
  return `${origin}/${slug}/auth/callback`;
}

export function isAuthCallbackPath(pathname: string, gatewaySlug?: string): boolean {
  if (pathname === "/auth/callback" || pathname === "/callback") return true;
  const slug = gatewaySlug?.trim();
  return Boolean(slug) && pathname === `/${slug}/auth/callback`;
}
