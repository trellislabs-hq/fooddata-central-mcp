/**
 * Module: eval cache (recorded FDC search responses)
 * Purpose: The committed, size-budgeted replay cache that lets `npm run
 *   test:eval` and default `node --import tsx eval/run.ts` runs be
 *   deterministic and burn zero FDC API budget. Keyed by a stable hash of
 *   the exact searchFoods() params find-food.ts issues (query, dataType,
 *   pageSize — pageSize is always pinned to 10 by src/find-food.ts).
 *   Stores the PROJECTED (see eval/lib/projection.ts) response shape, not
 *   the raw FDC payload. As of jump-1778, eval/cache/ holds ONE FILE PER
 *   FIXTURE (search-cache.json for the adversarial fixture,
 *   representative-search-cache.json for the representative fixture — see
 *   eval/run.ts's FIXTURE_REGISTRY) — every function here is parametrized by
 *   `cachePath` so it works identically against either file.
 *
 * Major Sections:
 *   - buildCacheKey() — stable sha256 hex key from search params
 *   - loadCache() / writeCache() — JSON file I/O, sorted keys for a
 *     byte-stable, diffable committed cache file
 *   - CACHE_WARN_BYTES / CACHE_HARD_BYTES — size budget constants +
 *     checkCacheSizeBudget() (pure math over a byte count)
 *   - aggregateCacheBytes() — sums every *.json file directly inside
 *     eval/cache/. The budget is AGGREGATE, not per-file (spec S8: "the
 *     4MiB budget must be defined explicitly as per-file or aggregate over
 *     eval/cache/ and enforced accordingly"). Decision: AGGREGATE, because
 *     eval/ ships as repo-only weight (package.json "files" ships only
 *     dist/, server.json, README.md — npm package size is unaffected either
 *     way) and the real constraint this budget protects is git-clone/CI
 *     checkout weight for the repo as a whole. Sizing a second fixture's
 *     cache "in isolation" would let eval/cache/ balloon past the intended
 *     ceiling one fixture at a time while each individual file stayed under
 *     budget — the aggregate check is what actually enforces the ceiling.
 *     Every live-mode budget check (eval/run.ts's runLive) MUST call this
 *     against the whole directory, never checkCacheSizeBudget() against a
 *     single just-written file's byte count.
 *
 * Dependencies: node:crypto, node:fs, node:path, ./projection.js,
 *   ../../src/fdc-client.js (FdcSearchParams, FdcSearchResult types)
 * State: File I/O against eval/cache/*.json. Callers own when to
 *   read/write (recording is buffered in memory during a live run — see
 *   eval/lib/search-fn.ts — and flushed once at the end).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FdcSearchParams, FdcSearchResult } from "../../src/fdc-client.js";
import { projectFoods, type ProjectedFood } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = path.join(__dirname, "..", "cache");
export const DEFAULT_CACHE_PATH = path.join(DEFAULT_CACHE_DIR, "search-cache.json");

export interface CacheEntry {
  /** The real FDC totalHits for this query — find-food.ts doesn't read it today, but a faithful replay shouldn't fabricate it. */
  totalHits: number;
  foods: ProjectedFood[];
}

export type CacheFile = Record<string, CacheEntry>;

/**
 * Hard/warn thresholds for the total committed eval/cache/ directory size.
 * The first full live run measured 2.57MB for the 96-case corpus (each case
 * fans out to multiple candidate-query + Branded-fallback searches), so the
 * original 2MB estimate was short. eval/ is repo-only weight — package.json
 * "files" ships only dist/, server.json, and README.md — so 4MB is the
 * budget, sized to hold the current corpus plus fixture growth.
 */
export const CACHE_WARN_BYTES = 3 * 1024 * 1024;
export const CACHE_HARD_BYTES = 4 * 1024 * 1024;

/**
 * Stable cache key for a searchFoods() call: sha256 hex of a canonical
 * (sorted-key) JSON encoding of {query, dataType, pageSize}. dataType is
 * used verbatim (array for the preferred-type cascade, the literal string
 * "Branded" for the fallback pass) — find-food.ts always passes one of
 * those two exact shapes, so no further normalization is needed.
 */
export function buildCacheKey(params: FdcSearchParams): string {
  const canonical = JSON.stringify({
    dataType: params.dataType,
    pageSize: params.pageSize,
    query: params.query,
  });
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/** Project a real FdcSearchResult down to the cache entry shape. */
export function toCacheEntry(result: FdcSearchResult): CacheEntry {
  return { totalHits: result.totalHits, foods: projectFoods(result.foods ?? []) };
}

/**
 * Reconstruct a full FdcSearchResult from a cache entry. totalHits is the
 * REAL value recorded from the live response (find-food.ts doesn't read it
 * today, but a faithful replay shouldn't fabricate it from foods.length —
 * FDC caps foods at pageSize=10 while totalHits can be in the thousands).
 * currentPage/totalPages ARE synthesized — find-food.ts never reads either.
 */
export function fromCacheEntry(entry: CacheEntry): FdcSearchResult {
  return {
    totalHits: entry.totalHits,
    currentPage: 1,
    totalPages: entry.foods.length > 0 ? 1 : 0,
    foods: entry.foods,
  };
}

export function loadCache(cachePath: string = DEFAULT_CACHE_PATH): CacheFile {
  if (!existsSync(cachePath)) return {};
  const raw = readFileSync(cachePath, "utf-8");
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as CacheFile;
}

/** Merge `updates` over `existing` (updates win on key collision) — new sorted-key file. */
export function mergeCache(existing: CacheFile, updates: CacheFile): CacheFile {
  const merged: CacheFile = { ...existing, ...updates };
  const sorted: CacheFile = {};
  for (const key of Object.keys(merged).sort()) {
    sorted[key] = merged[key];
  }
  return sorted;
}

/** Serialize with sorted keys (JSON.stringify already emits insertion order — callers must pre-sort). */
export function serializeCache(cache: CacheFile): string {
  return JSON.stringify(cache, null, 2) + "\n";
}

export function writeCache(cache: CacheFile, cachePath: string = DEFAULT_CACHE_PATH): number {
  const json = serializeCache(cache);
  writeFileSync(cachePath, json, "utf-8");
  return Buffer.byteLength(json, "utf-8");
}

export interface CacheSizeStatus {
  bytes: number;
  warn: boolean;
  exceeded: boolean;
}

export function checkCacheSizeBudget(bytes: number): CacheSizeStatus {
  return {
    bytes,
    warn: bytes >= CACHE_WARN_BYTES,
    exceeded: bytes > CACHE_HARD_BYTES,
  };
}

/**
 * Sum the byte size of every *.json file directly inside `cacheDir` (not
 * recursive — eval/cache/ is a flat directory, one committed file per
 * fixture). This is the AGGREGATE budget input — see this module's header
 * for why the budget is aggregate rather than per-file. Returns 0 if the
 * directory doesn't exist yet (a fresh checkout before any live run).
 */
export function aggregateCacheBytes(cacheDir: string = DEFAULT_CACHE_DIR): number {
  if (!existsSync(cacheDir)) return 0;
  let total = 0;
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      total += statSync(path.join(cacheDir, entry.name)).size;
    }
  }
  return total;
}
