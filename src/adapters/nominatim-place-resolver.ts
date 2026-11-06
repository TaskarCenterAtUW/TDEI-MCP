import type { PlaceCandidate, PlaceResolver } from "../intents/place-resolver.js";

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
  /** Minimum gap between upstream requests. Nominatim's policy is 1 request per second. */
  minIntervalMs?: number;
  /** How long a result is reused (default 24h). Place boundaries do not move. */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60_000;
const EMPTY_RESULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 500;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Seconds or an HTTP date -> milliseconds, clamped; undefined when absent or unusable. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_WAIT_MS) : undefined;
}

export class NominatimPlaceResolver implements PlaceResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, { expires: number; value: Promise<PlaceCandidate[]> }>();
  private nextSlot = 0;

  constructor(private readonly options: NominatimPlaceResolverOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  /**
   * Cached per normalized place name, and concurrent lookups of the same place
   * share one upstream request. Failures are never cached.
   */
  forwardGeocode(place: string): Promise<PlaceCandidate[]> {
    const key = place.trim().toLowerCase().replace(/\s+/g, " ");
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;

    const value = this.lookup(place);
    this.cache.set(key, { expires: now + this.cacheTtlMs, value });
    if (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    value.then(
      (candidates) => {
        // A miss may be a typo or a place not yet indexed; do not pin it for a day.
        if (candidates.length === 0 && this.cache.get(key)?.value === value) {
          this.cache.set(key, { expires: Date.now() + EMPTY_RESULT_TTL_MS, value });
        }
      },
      () => {
        if (this.cache.get(key)?.value === value) this.cache.delete(key);
      },
    );
    return value;
  }

  /** Spaces upstream requests at least minIntervalMs apart, across concurrent callers. */
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await sleep(start - now);
  }

  private async lookup(place: string): Promise<PlaceCandidate[]> {
    const url = new URL(this.options.endpoint);
    url.searchParams.set("q", place);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    let response: Response | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.waitForSlot();
      response = await this.fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": this.options.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
        const wait = retryAfterMs(response.headers.get("Retry-After")) ?? 1_000 * attempt;
        await response.body?.cancel().catch(() => undefined);
        await sleep(wait);
        continue;
      }
      break;
    }
    if (!response?.ok) {
      throw new Error(`Forward geocoder failed with status ${response?.status}.`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error("Forward geocoder returned an invalid response.");
    }
    return body.flatMap((raw): PlaceCandidate[] => {
      const result = raw as NominatimResult;
      const box = result.boundingbox?.map(Number);
      if (!result.display_name || !box || box.length !== 4 || box.some((coordinate) => !Number.isFinite(coordinate))) {
        return [];
      }
      const [south, north, west, east] = box;
      if (south === undefined || north === undefined || west === undefined || east === undefined) return [];
      return [
        {
          label: result.display_name,
          bbox: [west, south, east, north],
          ...(result.importance !== undefined ? { confidence: result.importance } : {}),
          ...(result.place_id !== undefined ? { providerId: String(result.place_id) } : {}),
        },
      ];
    });
  }
}
