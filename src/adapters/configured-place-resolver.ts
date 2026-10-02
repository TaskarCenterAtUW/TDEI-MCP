import { NominatimPlaceResolver } from "./nominatim-place-resolver.js";
import type { ResolvedConfig } from "../config.js";
import type { PlaceResolver } from "../intents/place-resolver.js";

const NO_GEOCODER: PlaceResolver = {
  async forwardGeocode() { return []; },
};

export function createConfiguredPlaceResolver(
  config: Pick<ResolvedConfig, "geocoderUrl" | "geocoderUserAgent">,
  fetchImpl?: typeof fetch,
): PlaceResolver {
  if (!config.geocoderUrl) return NO_GEOCODER;
  return new NominatimPlaceResolver({
    endpoint: config.geocoderUrl,
    userAgent: config.geocoderUserAgent,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
