import type {
  PlaceCandidate,
  PlaceResolver,
} from "../intents/place-resolver.js";

interface NominatimResult {
  place_id?: number | string;
  display_name?: string;
  importance?: number;
  boundingbox?: [string, string, string, string];
}

export interface NominatimPlaceResolverOptions {
  endpoint: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class NominatimPlaceResolver implements PlaceResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: NominatimPlaceResolverOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async forwardGeocode(place: string): Promise<PlaceCandidate[]> {
    const url = new URL(this.options.endpoint);
    url.searchParams.set("q", place);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.options.userAgent,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Forward geocoder failed with status ${response.status}.`);
    }
    const body = await response.json() as unknown;
    if (!Array.isArray(body)) {
      throw new Error("Forward geocoder returned an invalid response.");
    }
    return body.flatMap((raw): PlaceCandidate[] => {
      const result = raw as NominatimResult;
      const box = result.boundingbox?.map(Number);
      if (
        !result.display_name || !box || box.length !== 4 ||
        box.some((coordinate) => !Number.isFinite(coordinate))
      ) {
        return [];
      }
      const [south, north, west, east] = box;
      if (
        south === undefined || north === undefined ||
        west === undefined || east === undefined
      ) return [];
      return [{
        label: result.display_name,
        bbox: [west, south, east, north],
        ...(result.importance !== undefined
          ? { confidence: result.importance }
          : {}),
        ...(result.place_id !== undefined
          ? { providerId: String(result.place_id) }
          : {}),
      }];
    });
  }
}
