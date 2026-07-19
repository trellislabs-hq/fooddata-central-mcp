/**
 * Module: searchFoods() wrappers for live-recording and cached-replay modes
 * Purpose: findFood() (src/find-food.ts) takes a `SearchFoodsFn` parameter —
 *   this module supplies the two variants the eval runner needs: one that
 *   calls the real FdcClient and buffers a projected copy of every response
 *   into an in-memory cache map (flushed to disk once, after the run's
 *   latency timers have all stopped), and one that serves exclusively from
 *   an already-loaded cache map and throws CacheMissError on a miss (never
 *   silently falls through to a real network call).
 *
 * Major Sections:
 *   - CacheMissError — thrown by the replay searchFn; callers catch this
 *     specifically to mark a case "uncached" rather than "error"
 *   - makeRecordingSearchFn() — live mode: FILL-MISSING-ONLY (spec S8: "recording
 *     mode must consult existing cache entries before any network call" —
 *     the pre-jump-1778 version always called the network and overwrote,
 *     burning API budget re-fetching answers the cache already had). Checks
 *     the in-run buffer, then the pre-loaded on-disk `existing` cache,
 *     before ever calling `real()`; a hit in either short-circuits the
 *     network call entirely and NEVER re-writes the existing entry.
 *   - makeReplaySearchFn() — replay mode: cache-only, no network
 *
 * Dependencies: ../../src/fdc-client.js (SearchFoodsFn's param/result types),
 *   ./cache.js (buildCacheKey, toCacheEntry, fromCacheEntry, CacheFile)
 * State: makeRecordingSearchFn mutates the `buffer` Map passed in (by
 *   design — the caller owns flushing it to disk) but only ever WRITES a key
 *   that was actually fetched fresh; `existing` is read-only. makeReplaySearchFn
 *   reads an already-loaded, immutable CacheFile.
 */

import type { FdcSearchParams, FdcSearchResult } from "../../src/fdc-client.js";
import type { SearchFoodsFn } from "../../src/find-food.js";
import { buildCacheKey, fromCacheEntry, toCacheEntry, type CacheFile, type CacheEntry } from "./cache.js";

export class CacheMissError extends Error {
  constructor(
    public readonly cacheKey: string,
    public readonly params: FdcSearchParams
  ) {
    super(`No cached response for query=${JSON.stringify(params.query)} dataType=${JSON.stringify(params.dataType)} (key ${cacheKey}).`);
    this.name = "CacheMissError";
  }
}

/**
 * Wrap a real searchFoods function: FILL-MISSING-ONLY. Before ever calling
 * `real()`, checks `buffer` (this run's already-fetched keys) and then
 * `existing` (the pre-loaded on-disk cache) for a hit — a hit in either
 * short-circuits straight to fromCacheEntry(), no network call, no rewrite.
 * Only a genuine miss in both calls `real()` and writes a PROJECTED copy of
 * the response into `buffer`, keyed by buildCacheKey(). Does not write to
 * disk itself — the caller flushes `buffer` once, after all latency timing
 * for the run is complete.
 */
export function makeRecordingSearchFn(
  real: SearchFoodsFn,
  buffer: Map<string, CacheEntry>,
  existing: CacheFile = {}
): SearchFoodsFn {
  return async (params: FdcSearchParams): Promise<FdcSearchResult> => {
    const key = buildCacheKey(params);

    const cached = buffer.get(key) ?? existing[key];
    if (cached) return fromCacheEntry(cached);

    const result = await real(params);
    buffer.set(key, toCacheEntry(result));
    return result;
  };
}

/**
 * Cache-only searchFn: never touches the network. Throws CacheMissError
 * (not a generic Error) so the runner can distinguish "this case's cache
 * coverage is incomplete" from a genuine pipeline bug.
 */
export function makeReplaySearchFn(cache: CacheFile): SearchFoodsFn {
  return async (params: FdcSearchParams): Promise<FdcSearchResult> => {
    const key = buildCacheKey(params);
    const entry = cache[key];
    if (!entry) throw new CacheMissError(key, params);
    return fromCacheEntry(entry);
  };
}
