/**
 * Module: eval cache (recorded FDC search responses)
 * Purpose: The committed, size-budgeted replay cache that lets `npm run
 *   test:eval` and default `node --import tsx eval/run.ts` runs be
 *   deterministic and burn zero FDC API budget. Keyed by a stable hash of
 *   the exact searchFoods() params find-food.ts issues (query, dataType,
 *   pageSize — pageSize is always pinned to 10 by src/find-food.ts).
 *   Stores the PROJECTED (see eval/lib/projection.ts) response shape, not
 *   the raw FDC payload.
 *
 * Major Sections:
 *   - buildCacheKey() — stable sha256 hex key from search params
 *   - loadCache() / writeCache() — JSON file I/O, sorted keys for a
 *     byte-stable, diffable committed cache file
 *   - CACHE_WARN_BYTES / CACHE_HARD_BYTES — size budget constants + checkCacheSizeBudget()
 *
 * Dependencies: node:crypto, node:fs, node:path, ./projection.js,
 *   ../../src/fdc-client.js (FdcSearchParams, FdcSearchResult types)
 * State: File I/O against eval/cache/search-cache.json. Callers own when to
 *   read/write (recording is buffered in memory during a live run — see
 *   eval/lib/search-fn.ts — and flushed once at the end).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FdcSearchParams, FdcSearchResult } from "../../src/fdc-client.js";
import { projectFoods, type ProjectedFood } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_PATH = path.join(__dirname, "..", "cache", "search-cache.json");

export interface CacheEntry {
  /** The real FDC totalHits for this query — find-food.ts doesn't read it today, but a faithful replay shouldn't fabricate it. */
  totalHits: number;
  foods: ProjectedFood[];
}

export type CacheFile = Record<string, CacheEntry>;

/** Hard/warn thresholds for the total committed eval/cache/ directory size. */
export const CACHE_WARN_BYTES = 1.5 * 1024 * 1024;
export const CACHE_HARD_BYTES = 2 * 1024 * 1024;

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
