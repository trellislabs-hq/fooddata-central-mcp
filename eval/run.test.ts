/**
 * Module: eval harness self-tests
 * Purpose: Proves the eval harness's own machinery is correct — independent
 *   of any live baseline run for the representative fixture (the household
 *   fixture's eval/cache/search-cache.json IS committed and populated — see
 *   section 9). Covers:
 *     1. Scoring semantics — the full kind x result matrix (spec S7): hit/
 *        near/near_branded/miss/labeled_branded_fallback/refusal for
 *        positive cases, refusal/labeled_branded_fallback/confident_wrong
 *        for negative cases. This REPLACES the old collapsed "honest"
 *        bucket, which hid the difference between a true refusal and an
 *        honestly-labeled Branded fallback.
 *     2. Cache record -> replay round-trip identity.
 *     3. Projection faithfulness — findFood()'s rendered text over a full
 *        response vs its projection, byte-identical.
 *     4. Fixture schema validation, including the string-vs-number fdc_id
 *        coercion footgun, and the new representative-fixture-only meta
 *        fields (evidenceClass/occurrences/packs) + excluded[].
 *     5. Replay coverage-threshold failure (<90% cache coverage -> nonzero
 *        exit, non-strict mode) vs full-coverage success.
 *     6. The live request path through the REAL FdcClient (not a stub),
 *        under a mocked global.fetch, proving the X-Api-Key header is
 *        attached, no key reaches the URL, and the recording wrapper
 *        captures a projected cache entry.
 *     7. Multi-call searchFoods cache wiring: an alias-cascade case (2+
 *        candidate queries), a preferred-empty -> Branded-fallback case
 *        (2 calls, both cached), and a PARTIALLY cached multi-call case
 *        (first call cached, second uncached -> the whole case is
 *        classified "uncached", never half-scored).
 *     8. Scored-only denominators: an all-errors replay (every case HAS a
 *        cache entry but it's malformed, so zero are "uncached") must still
 *        exit nonzero — coverage counts errored cases as non-covered, not
 *        just uncached ones — and a hand-computed mixed run proves the new
 *        top1Pct/top4Pct/positive*Pct/negative*Pct fields are computed over
 *        SCORED cases only.
 *     9. The committed adversarial fixture's FULL default replay (real
 *        cache, no stubs) under the new taxonomy — every row lands in a
 *        known status, 100% coverage, exit 0.
 *    10. Published/strict mode (spec S8): ANY uncached or errored row is a
 *        hard failure, independent of the 90% coverage threshold.
 *    11. Fill-missing-only recording (spec S8): makeRecordingSearchFn never
 *        calls the network for a key `existing` already has.
 *    12. Fixture <-> cache binding (--fixture registry).
 *    13. Aggregate cache size budget (spec S8: budget is aggregate over
 *        eval/cache/*.json, not per-file).
 *    14. excluded[] pass-through on RunOutcome.
 *    15. The committed household-representative-v1 fixture's own schema +
 *        spec-measured coverage/evidence-class counts.
 *    16. Statistics layer (eval/lib/statistics.ts, jump-1778 fix-pass):
 *        wilsonInterval() sanity (point estimate always inside its own
 *        interval, known reference values), computeStratumStats() (unique-
 *        name, Wilson-CI'd), computeWeightedPositiveStats() (occurrence-
 *        weighted, descriptive — proven DISTINCT from the unique number on a
 *        skewed synthetic distribution), computeCoverageStats(),
 *        computePackRollups() (occurrence-weighted AND excluded-row-aware —
 *        the two defects the fix-pass named), and computeRepresentativeStats()
 *        end-to-end including the human-adjudicated stratum.
 *    17. Assembly script classification (classifyEvidence/classifyName,
 *        exported from eval/scripts/assemble-representative-fixture.ts):
 *        the PIN-BINDING GUARD (a pin under the right product_name but the
 *        WRONG fdc_id must not count as human_pin for this identity) and the
 *        distinct non_preferred_type exclusion bucket (must not be silently
 *        folded into no_ref).
 *    18. Dry statistics demo: synthetic scoring (NOT a live cache) against
 *        the committed representative fixture's own `cases`/`excluded`,
 *        proving the statistics layer's end-to-end wiring and printing a
 *        full unique+weighted+coverage+stratified+per-pack summary.
 *
 * Dependencies: node:test, node:assert/strict, node:fs, node:os, node:path,
 *   ../src/find-food.js, ../src/fdc-client.js, ../src/normalize.js,
 *   ../tests/helpers/mock-fetch.js (read-only import — see CONSTRAINTS,
 *   tests/ is never modified), and this module's own eval/lib/*, eval/run.js,
 *   and eval/scripts/assemble-representative-fixture.js.
 * State: Uses node:fs temp files (os.tmpdir()) for cache/fixture round-trip
 *   tests — never writes to the committed eval/cache/ or eval/fixtures/.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { findFood, PREFERRED_DATA_TYPES } from "../src/find-food.js";
import { FdcClient, type FdcFood, type FdcSearchParams, type FdcSearchResult } from "../src/fdc-client.js";
import { normalize } from "../src/normalize.js";
// Read-only import of the tests/ fixture helper (see CONSTRAINTS — tests/ is
// never modified). Aliased to avoid colliding with ./lib/fixture.js's
// loadFixture (which loads an EvalFixture, a different shape entirely).
import { installFetchMock, jsonResponse, loadFixture as loadRealApiFixture } from "../tests/helpers/mock-fetch.js";

import { DEFAULT_FIXTURE_PATH, loadFixture, validateFixtureSchema, type EvalFixture } from "./lib/fixture.js";
import { scoreCase, type CaseResult } from "./lib/scoring.js";
import { projectFoods } from "./lib/projection.js";
import {
  aggregateCacheBytes,
  buildCacheKey,
  CACHE_HARD_BYTES,
  CACHE_WARN_BYTES,
  checkCacheSizeBudget,
  DEFAULT_CACHE_PATH,
  loadCache,
  writeCache,
  type CacheEntry,
  type CacheFile,
} from "./lib/cache.js";
import { CacheMissError, makeRecordingSearchFn, makeReplaySearchFn } from "./lib/search-fn.js";
import {
  computeCoverageStats,
  computePackRollups,
  computeRepresentativeStats,
  computeStratumStats,
  computeWeightedPositiveStats,
  wilsonInterval,
} from "./lib/statistics.js";
import { FIXTURE_REGISTRY, resolveFixtureBinding, runEval } from "./run.js";
import {
  classifyEvidence,
  classifyName,
  type Dictionary,
  type FdcPins,
  type IdentityRulings,
  type NameStats,
} from "./scripts/assemble-representative-fixture.js";

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "fdc-mcp-eval-test-"));
  try {
    // Await inside the try so the finally's cleanup can never race ahead of
    // an async callback's file writes (the original bug: a synchronous
    // `finally` ran rmSync() before the async fn's writeFileSync calls had
    // executed, since fn(dir) returns a pending Promise immediately).
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 1. Scoring semantics (full kind x result matrix) ──────────────────────

describe("scoring semantics", () => {
  test("positive: hit when best.fdcId === expected.fdcId", async () => {
    const caseDef = { name: "cheddar cheese", kind: "positive" as const, expected: { fdcId: 328637, description: "Cheese, cheddar", dataType: "Foundation" as const } };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 328637, description: "Cheese, cheddar", dataType: "Foundation", foodNutrients: [] }],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "hit");
  });

  test("positive: near when expected.fdcId is in alternates but not best (usedBranded false)", async () => {
    const caseDef = { name: "cheese", kind: "positive" as const, expected: { fdcId: 2, description: "Second cheese", dataType: "Foundation" as const } };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 2,
      currentPage: 1,
      totalPages: 1,
      foods: [
        { fdcId: 1, description: "First cheese", dataType: "Foundation", foodNutrients: [] },
        { fdcId: 2, description: "Second cheese", dataType: "Foundation", foodNutrients: [] },
      ],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.usedBranded, false);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "near");
  });

  test("positive: near_branded when expected.fdcId is in alternates AND usedBranded is true (Branded automatic last resort)", async () => {
    const caseDef = { name: "cheese", kind: "positive" as const, expected: { fdcId: 2, description: "Second cheese", dataType: "Foundation" as const } };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const brandedResult: FdcSearchResult = {
      totalHits: 2,
      currentPage: 1,
      totalPages: 1,
      foods: [
        { fdcId: 1, description: "First cheese", dataType: "Branded", foodNutrients: [] },
        { fdcId: 2, description: "Second cheese", dataType: "Branded", foodNutrients: [] },
      ],
    };
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> =>
      params.dataType === "Branded" ? brandedResult : emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.usedBranded, true, "sanity: preferred types were empty, Branded automatic last resort fired");
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "near_branded", "a near hit sourced from Branded must be reported separately from plain near, never silently folded in");
  });

  test("positive: miss when expected.fdcId is neither best nor an alternate (usedBranded false)", async () => {
    const caseDef = { name: "cheese", kind: "positive" as const, expected: { fdcId: 999999, description: "Nonexistent", dataType: "Foundation" as const } };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 1, description: "Some cheese", dataType: "Foundation", foodNutrients: [] }],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.usedBranded, false);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "miss");
    assert.equal(scored.actual?.fdcId, 1);
  });

  test("positive: labeled_branded_fallback when usedBranded true and the Branded answer doesn't match expected (not even an alternate)", async () => {
    const caseDef = { name: "widgetcheese", kind: "positive" as const, expected: { fdcId: 999999, description: "Nonexistent Cheese", dataType: "Foundation" as const } };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const brandedResult: FdcSearchResult = {
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 42, description: "Widgetcheese Snack", dataType: "Branded", foodNutrients: [] }],
    };
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> =>
      params.dataType === "Branded" ? brandedResult : emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.usedBranded, true);
    assert.ok(result.best);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "labeled_branded_fallback", "a wrong-in-kind Branded fallback is distinct from a confident miss — it's honestly labeled low-confidence");
    assert.equal(scored.actual?.fdcId, 42);
  });

  test("positive: refusal when nothing clears the floor anywhere (best undefined)", async () => {
    const caseDef = { name: "nonexistentfood", kind: "positive" as const, expected: { fdcId: 123, description: "Nonexistent Food", dataType: "Foundation" as const } };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (): Promise<FdcSearchResult> => emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.best, undefined);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "refusal", "a true refusal (best undefined) is distinct from an honestly-labeled Branded fallback");
  });

  test("negative: refusal when best is undefined (no results anywhere)", async () => {
    const caseDef = { name: "gluten free flour", kind: "negative" as const };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (): Promise<FdcSearchResult> => emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.best, undefined);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "refusal");
  });

  test("negative: labeled_branded_fallback when usedBranded === true (Branded last-resort, best defined)", async () => {
    const caseDef = { name: "candied ginger", kind: "negative" as const };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const brandedResult: FdcSearchResult = {
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 42, description: "Candied Ginger Snack", dataType: "Branded", foodNutrients: [] }],
    };
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> =>
      params.dataType === "Branded" ? brandedResult : emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.ok(result.best, "Branded last-resort should still populate best");
    assert.equal(result.usedBranded, true);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "labeled_branded_fallback", "usedBranded===true must score labeled_branded_fallback, never the old collapsed honest bucket");
  });

  test("negative: confident_wrong when a preferred-type match lands (usedBranded false, best defined)", async () => {
    const caseDef = { name: "everything bagel seasoning", kind: "negative" as const };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 7, description: "Bagels, egg", dataType: "Foundation", foodNutrients: [] }],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.usedBranded, false);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "confident_wrong");
    assert.equal(scored.actual?.fdcId, 7);
  });

  test("scoreCase passes representative-fixture metadata (evidenceClass/expectedSource/occurrences/packs) straight through onto every CaseResult", async () => {
    const caseDef = {
      name: "carrots",
      kind: "positive" as const,
      expected: { fdcId: 100, description: "Carrots, raw", dataType: "Foundation" as const },
      evidenceClass: "human_pin" as const,
      expectedSource: "dictionary-ratified",
      occurrences: 5,
      packs: { "pack-1": 2, "pack-2": 3 },
    };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 100, description: "Carrots, raw", dataType: "Foundation", foodNutrients: [] }],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.evidenceClass, "human_pin");
    assert.equal(scored.expectedSource, "dictionary-ratified");
    assert.equal(scored.occurrences, 5);
    assert.deepEqual(scored.packs, { "pack-1": 2, "pack-2": 3 });
  });
});

// ─── 2. Cache record -> replay round trip ─────────────────────────────────

describe("cache round-trip", () => {
  test("record then replay produces identical findFood results", async () => {
    await withTempDir(async (dir) => {
      const cachePath = path.join(dir, "search-cache.json");

      const liveFoods: FdcFood[] = [
        { fdcId: 328637, description: "Cheese, cheddar", dataType: "Foundation", foodNutrients: [{ nutrientId: 208, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value: 403 }] },
        { fdcId: 746767, description: "Cheese, swiss", dataType: "Foundation", foodNutrients: [{ nutrientId: 208, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value: 380 }] },
      ];
      const stubSearch = async (): Promise<FdcSearchResult> => ({ totalHits: 2, currentPage: 1, totalPages: 1, foods: liveFoods });

      const buffer = new Map();
      const recording = makeRecordingSearchFn(stubSearch, buffer);
      const liveResult = await findFood(recording, "cheddar cheese", { includeBranded: false });

      const cache: CacheFile = {};
      for (const [key, entry] of buffer) cache[key] = entry;
      writeCache(cache, cachePath);

      const loaded = loadCache(cachePath);
      const replay = makeReplaySearchFn(loaded);
      const replayResult = await findFood(replay, "cheddar cheese", { includeBranded: false });

      assert.equal(replayResult.text, liveResult.text, "replayed text must be byte-identical to the live run's text");
      assert.equal(replayResult.best?.fdcId, liveResult.best?.fdcId);
      assert.deepEqual(
        replayResult.alternates.map((a) => a.fdcId),
        liveResult.alternates.map((a) => a.fdcId)
      );
      assert.equal(replayResult.usedBranded, liveResult.usedBranded);
      assert.equal(replayResult.matchedQuery, liveResult.matchedQuery);
    });
  });

  test("replay throws CacheMissError (not a silent network fallthrough) on an uncached key", async () => {
    const replay = makeReplaySearchFn({});
    await assert.rejects(
      () => replay({ query: "nothing cached", dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 }),
      CacheMissError
    );
  });
});

// ─── 3. Projection faithfulness ────────────────────────────────────────────

describe("projection faithfulness", () => {
  test("findFood().text is byte-identical over a full response vs its projection", async () => {
    const fullFoods: FdcFood[] = [
      // Priority-nutrient branch: mixed shapes (search-result, abridged, full-nested),
      // including a duplicate priority id to exercise formatKeyNutrients' own dedup.
      {
        fdcId: 1,
        description: "Priority Nutrient Food",
        dataType: "Foundation",
        brandOwner: "Some Co",
        brandName: "SomeBrand",
        foodNutrients: [
          { nutrientId: 208, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value: 200 },
          { nutrient: { id: 203, name: "Protein", number: "203", unitName: "G", rank: 1 }, amount: 12.5 },
          { name: "Total lipid (fat)", number: "204", amount: 5, unitName: "G" },
          // Duplicate Energy by number (different shape) — dedup must collapse it.
          { name: "Energy", number: "208", amount: 999, unitName: "KCAL" },
          // Non-priority nutrient, should never surface either full or projected.
          { nutrientId: 601, nutrientName: "Cholesterol", nutrientNumber: "601", unitName: "MG", value: 10 },
        ],
      },
      // No-priority-nutrient branch: forces the nutrients.slice(0,5) fallback.
      {
        fdcId: 2,
        description: "Fallback Nutrient Food",
        dataType: "SR Legacy",
        brandOwner: "Only Owner Set",
        foodNutrients: [
          { nutrientId: 601, nutrientName: "Cholesterol", nutrientNumber: "601", unitName: "MG", value: 10 },
          { nutrientId: 602, nutrientName: "Whatever", nutrientNumber: "602", unitName: "MG", value: 20 },
          { nutrientId: 603, nutrientName: "Something", nutrientNumber: "603", unitName: "MG", value: 30 },
          { nutrientId: 604, nutrientName: "Filler A", nutrientNumber: "604", unitName: "MG", value: 40 },
          { nutrientId: 605, nutrientName: "Filler B", nutrientNumber: "605", unitName: "MG", value: 50 },
          { nutrientId: 606, nutrientName: "Filler C (never surfaces — beyond the 5-item fallback slice)", nutrientNumber: "606", unitName: "MG", value: 60 },
        ],
      },
      // No nutrients at all.
      { fdcId: 3, description: "No Nutrient Food", dataType: "Survey (FNDDS)", foodNutrients: [] },
    ];

    const fullResult: FdcSearchResult = { totalHits: fullFoods.length, currentPage: 1, totalPages: 1, foods: fullFoods };
    const fullSearch = async (): Promise<FdcSearchResult> => fullResult;
    const fullOut = await findFood(fullSearch, "priority nutrient food", { includeBranded: false });

    const projectedFoods = projectFoods(fullFoods);
    const projectedResult: FdcSearchResult = { totalHits: projectedFoods.length, currentPage: 1, totalPages: 1, foods: projectedFoods as unknown as FdcFood[] };
    const projectedSearch = async (): Promise<FdcSearchResult> => projectedResult;
    const projectedOut = await findFood(projectedSearch, "priority nutrient food", { includeBranded: false });

    assert.equal(projectedOut.text, fullOut.text, "projected rendering must be byte-identical to the full rendering");
    assert.deepEqual(
      projectedOut.alternates.map((a) => a.fdcId),
      fullOut.alternates.map((a) => a.fdcId)
    );
  });

  test("byte-identical over a REAL recorded 10-food response (tests/fixtures/cheddar-cheese.search-foundation.json)", async () => {
    // Real API data (recorded live 2026-07-03, see tests/fixtures/README.md):
    // 10 Foundation cheeses, 32-121 raw nutrients each, real search-result
    // shape (nutrientId/nutrientName/nutrientNumber/value). Notably food #0
    // ("Cheese, cheddar") carries BOTH nutrientNumber "208" (Energy, KCAL)
    // AND "268" (also named "Energy", KJ) — two distinct dedupe keys (number
    // is the dedupe key, not name) that formatKeyNutrients does NOT collapse
    // into one line. The projection must preserve this exact real-world
    // quirk, not just the synthetic single-Energy case above.
    const realFixture = loadRealApiFixture("cheddar-cheese.search-foundation.json") as FdcSearchResult;
    const realFoods = realFixture.foods;
    assert.equal(realFoods.length, 10, "sanity: this is the recorded 10-food response");

    const fullSearch = async (): Promise<FdcSearchResult> => realFixture;
    const fullOut = await findFood(fullSearch, "cheddar cheese", { includeBranded: false });

    const projectedFoods = projectFoods(realFoods);
    const projectedResult: FdcSearchResult = {
      totalHits: realFixture.totalHits,
      currentPage: 1,
      totalPages: 1,
      foods: projectedFoods as unknown as FdcFood[],
    };
    const projectedSearch = async (): Promise<FdcSearchResult> => projectedResult;
    const projectedOut = await findFood(projectedSearch, "cheddar cheese", { includeBranded: false });

    assert.equal(projectedOut.text, fullOut.text, "projected rendering of the REAL fixture must be byte-identical to the full rendering");
    assert.equal(fullOut.best?.fdcId, 328637, "sanity: still the cheddar-proof result");
  });
});

// ─── 4. Fixture schema validation ──────────────────────────────────────────

describe("fixture schema validation", () => {
  test("accepts a well-formed minimal fixture", () => {
    const fixture = {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: [
        { name: "apple", kind: "positive", expected: { fdcId: 100, description: "Apples, raw", dataType: "Foundation" } },
        { name: "unicorn meat", kind: "negative" },
      ],
    } as EvalFixture;
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
  });

  test("rejects a missing case name", () => {
    const fixture = { provenance: {} as unknown as EvalFixture["provenance"], cases: [{ kind: "negative" }] } as unknown as EvalFixture;
    assert.throws(() => validateFixtureSchema(fixture), /name/);
  });

  test("rejects an invalid kind", () => {
    const fixture = { provenance: {} as unknown as EvalFixture["provenance"], cases: [{ name: "x", kind: "maybe" }] } as unknown as EvalFixture;
    assert.throws(() => validateFixtureSchema(fixture), /kind/);
  });

  test("CRITICAL: rejects a string fdc_id (the source pins file's exact footgun — fdc_id is a STRING there, FdcFood.fdcId is numeric)", () => {
    const fixture = {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: [{ name: "almonds", kind: "positive", expected: { fdcId: "170567", description: "Nuts, almonds", dataType: "SR Legacy" } }],
    } as unknown as EvalFixture;
    assert.throws(() => validateFixtureSchema(fixture), /positive integer/);
  });

  test("rejects a non-positive or non-integer expected.fdcId", () => {
    for (const badId of [0, -5, 1.5, NaN]) {
      const fixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [{ name: "x", kind: "positive", expected: { fdcId: badId, description: "d", dataType: "Foundation" } }],
      } as unknown as EvalFixture;
      assert.throws(() => validateFixtureSchema(fixture), /positive integer/, `fdcId=${badId} should be rejected`);
    }
  });

  test("accepts representative-fixture meta fields (evidenceClass/expectedSource/occurrences/packs) and an excluded[] block", () => {
    const fixture = {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: [
        {
          name: "carrots",
          kind: "positive",
          expected: { fdcId: 100, description: "Carrots, raw", dataType: "Foundation" },
          evidenceClass: "human_pin",
          expectedSource: "dictionary-ratified",
          occurrences: 5,
          packs: { "pack-1": 2, "pack-2": 3 },
        },
      ],
      excluded: [{ name: "some unresolved thing", reason: "names-index resolution miss", occurrences: 1, packs: { "pack-4": 1 } }],
    } as unknown as EvalFixture;
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
  });

  test("rejects an invalid evidenceClass value", () => {
    const fixture = {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: [{ name: "x", kind: "positive", expected: { fdcId: 1, description: "d", dataType: "Foundation" }, evidenceClass: "totally_made_up" }],
    } as unknown as EvalFixture;
    assert.throws(() => validateFixtureSchema(fixture), /evidenceClass/);
  });

  test("rejects an excluded[] entry missing a reason", () => {
    const fixture = {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: [],
      excluded: [{ name: "no reason given", occurrences: 1, packs: {} }],
    } as unknown as EvalFixture;
    assert.throws(() => validateFixtureSchema(fixture), /reason/);
  });

  test("the committed household-food-eval-v1 fixture itself passes validation with >=60 positive and >=25 negative cases", () => {
    const fixture = loadFixture(DEFAULT_FIXTURE_PATH);
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
    const positive = fixture.cases.filter((c) => c.kind === "positive").length;
    const negative = fixture.cases.filter((c) => c.kind === "negative").length;
    assert.ok(positive >= 60, `expected >=60 positive cases, got ${positive}`);
    assert.ok(negative >= 25, `expected >=25 negative cases, got ${negative}`);
  });
});

// ─── 5. Replay coverage threshold (non-strict) ─────────────────────────────

describe("replay coverage threshold (non-strict mode)", () => {
  const simpleNames = ["apple", "banana", "carrot", "date", "eggplant", "fig", "grape", "honeydew", "kiwi", "lime"];

  function buildTinyFixture(): EvalFixture {
    return {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: simpleNames.map((name, i) => ({
        name,
        kind: "positive" as const,
        expected: { fdcId: 1000 + i, description: name, dataType: "Foundation" as const },
      })),
    };
  }

  test("exits nonzero when cache coverage is below 90%", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture = buildTinyFixture();
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // Cover only 5 of 10 (50% < 90%).
      const cache: CacheFile = {};
      for (const c of fixture.cases.slice(0, 5)) {
        const key = buildCacheKey({ query: normalize(c.name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { totalHits: 1, foods: [{ fdcId: (c as { expected: { fdcId: number } }).expected.fdcId, description: c.name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.exitCode, 1, "coverage below 90% must exit nonzero");
      assert.equal(outcome.aggregate.counts.uncached, 5);
    });
  });

  test("exits zero when cache coverage is 100%", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture = buildTinyFixture();
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const cache: CacheFile = {};
      for (const c of fixture.cases) {
        const key = buildCacheKey({ query: normalize(c.name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { totalHits: 1, foods: [{ fdcId: (c as { expected: { fdcId: number } }).expected.fdcId, description: c.name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.aggregate.counts.uncached, 0);
      assert.equal(outcome.aggregate.counts.hit, simpleNames.length);
    });
  });
});

// ─── 7. Multi-call searchFoods cache wiring (replay) ───────────────────────

describe("multi-call searchFoods cache wiring (replay)", () => {
  function cacheKeyFor(name: string, dataType: typeof PREFERRED_DATA_TYPES | "Branded"): string {
    return buildCacheKey({ query: normalize(name), dataType: dataType === "Branded" ? "Branded" : [...dataType], pageSize: 10 });
  }

  test("alias-cascade case: 'paneer' misses on the bare query, hits on the aliased 'paneer cheese' candidate", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [{ name: "paneer", kind: "positive", expected: { fdcId: 9001, description: "Paneer, cheese", dataType: "Foundation" } }],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // buildCandidateQueries("paneer") = ["paneer", "paneer cheese", "indian cheese"]
      // (FOOD_ALIASES, src/normalize.ts). The bare "paneer" query is cached
      // empty; the SECOND candidate ("paneer cheese") is cached with a hit,
      // so the third candidate is never queried and needs no cache entry.
      const cache: Record<string, unknown> = {};
      cache[cacheKeyFor("paneer", PREFERRED_DATA_TYPES)] = { totalHits: 0, foods: [] };
      cache[cacheKeyFor("paneer cheese", PREFERRED_DATA_TYPES)] = {
        totalHits: 1,
        foods: [{ fdcId: 9001, description: "Paneer, cheese", dataType: "Foundation" }],
      };
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.rows.length, 1);
      assert.equal(outcome.rows[0].status, "hit", "the alias-cascade's second candidate query must be the one that scores");
    });
  });

  test("preferred-empty -> Branded-fallback case: both calls cached -> labeled_branded_fallback (negative case)", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [{ name: "widgetfood", kind: "negative" }],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // No alias for "widgetfood" -> exactly one preferred-type call (empty)
      // + one Branded fallback call (last resort) — both cached.
      //
      // jump-1760 EDIT: the description is "Widgetfood Snack" (was "Widget
      // Food Snack") so it clears the relevance floor for the single-token
      // query "widgetfood" — "Widget Food Snack" tokenizes to
      // {widget,food,snack}, none of which is the fused token "widgetfood",
      // so it would rate 'miss' and get floor-filtered, and this scenario
      // would fall through to the OTHER refusal path (best undefined, no
      // Branded fallback at all) instead of the usedBranded=true labeled-
      // fallback path this test is actually named for. The assertion
      // (status === "labeled_branded_fallback") happens to hold either way
      // (scoreCase treats both refusal and labeled_branded_fallback as the
      // "not confidently wrong" side of the taxonomy — see section 1 above),
      // but leaving it broken would silently stop this test from exercising
      // the Branded-fallback-scores-labeled_branded_fallback mechanism it
      // documents.
      const cache: Record<string, unknown> = {};
      cache[cacheKeyFor("widgetfood", PREFERRED_DATA_TYPES)] = { totalHits: 0, foods: [] };
      cache[cacheKeyFor("widgetfood", "Branded")] = {
        totalHits: 1,
        foods: [{ fdcId: 8001, description: "Widgetfood Snack", dataType: "Branded" }],
      };
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.rows.length, 1);
      assert.equal(outcome.rows[0].status, "labeled_branded_fallback", "usedBranded===true (last-resort) is labeled_branded_fallback for a negative case");
    });
  });

  test("PARTIALLY cached multi-call case: preferred call cached (empty), Branded fallback call uncached -> the case is classified 'uncached', never half-scored", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [{ name: "widgetfood2", kind: "negative" }],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // Only the FIRST call (preferred-type, empty) is cached. The second
      // call (Branded fallback, which findFood always issues when the
      // preferred pass returns zero foods) has no cache entry at all.
      const cache: Record<string, unknown> = {};
      cache[cacheKeyFor("widgetfood2", PREFERRED_DATA_TYPES)] = { totalHits: 0, foods: [] };
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.rows.length, 1);
      assert.equal(outcome.rows[0].status, "uncached", "a partially-cached multi-call case must be classified uncached, not scored on incomplete data");
    });
  });
});

// ─── 8. Scored-only denominators (uncached/errored excluded) ──────────────

describe("scored-only denominators and coverage", () => {
  function preferredKey(name: string): string {
    return buildCacheKey({ query: normalize(name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
  }
  function brandedKey(name: string): string {
    return buildCacheKey({ query: normalize(name), dataType: "Branded", pageSize: 10 });
  }

  test("all-errors replay (every case HAS a cache entry, zero uncached) still exits nonzero", async () => {
    await withTempDir(async (dir) => {
      const names = ["errcasea", "errcaseb", "errcasec", "errcased"];
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: names.map((name, i) => ({
          name,
          kind: "positive" as const,
          expected: { fdcId: 3000 + i, description: name, dataType: "Foundation" as const },
        })),
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // Every case HAS a cache entry (so `uncached` stays 0) but each entry
      // is malformed (no `foods` array) — fromCacheEntry() throws a generic
      // Error for every one of them, landing every case in status "error".
      // Before the S1 fix, coverage only subtracted `uncached`, so this
      // scenario reported 100% coverage and exited 0.
      const malformedCache: Record<string, unknown> = {};
      for (const name of names) malformedCache[preferredKey(name)] = { totalHits: 0 };
      writeFileSync(cachePath, JSON.stringify(malformedCache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.aggregate.counts.uncached, 0, "every case DOES have a cache entry — this is not the uncached path");
      assert.equal(outcome.aggregate.counts.error, names.length, "every case fails to score due to the malformed entry");
      assert.equal(outcome.exitCode, 1, "an all-errors replay must exit nonzero — errors count as non-covered too");
    });
  });

  test("mixed run: matrix counts and *Pct fields match hand-computed SCORED-only denominators", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");

      // positive: 2 hit, 1 miss, 1 uncached, 1 error(malformed) -> scored = 3
      // negative: 1 labeled_branded_fallback, 1 confident_wrong, 1 uncached -> scored = 2
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [
          { name: "hitone", kind: "positive", expected: { fdcId: 1, description: "Hit One", dataType: "Foundation" } },
          { name: "hittwo", kind: "positive", expected: { fdcId: 2, description: "Hit Two", dataType: "Foundation" } },
          { name: "missone", kind: "positive", expected: { fdcId: 999, description: "Miss One", dataType: "Foundation" } },
          { name: "uncachedpos", kind: "positive", expected: { fdcId: 3, description: "Uncached Pos", dataType: "Foundation" } },
          { name: "errorpos", kind: "positive", expected: { fdcId: 4, description: "Error Pos", dataType: "Foundation" } },
          { name: "brandedneg", kind: "negative" },
          { name: "wrongone", kind: "negative" },
          { name: "uncachedneg", kind: "negative" },
        ],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // jump-1760 EDIT: every case name here is a single fused token
      // ("hitone", not "hit one"), so a natural-language description like
      // "Hit One" tokenizes to {hit,one} and shares no token with the
      // query — it would rate 'miss' and get floor-filtered, which (for
      // EVERY one of hitone/hittwo/missone/wrongone) empties the preferred
      // batch and triggers findFood's automatic Branded fallback. None of
      // those cases has a cached Branded entry, so each would throw
      // CacheMissError and get reclassified "uncached" instead of its
      // intended hit/miss/confident_wrong status, corrupting every count
      // and hand-computed percentage below. Descriptions are changed to
      // contain the literal query token (single word, comma-free) so this
      // test keeps exercising SCORING semantics rather than becoming an
      // accidental floor test — the fdcId values (what scoreCase actually
      // compares) are unchanged.
      const cache: Record<string, unknown> = {};
      cache[preferredKey("hitone")] = { totalHits: 1, foods: [{ fdcId: 1, description: "Hitone", dataType: "Foundation" }] };
      cache[preferredKey("hittwo")] = { totalHits: 1, foods: [{ fdcId: 2, description: "Hittwo", dataType: "Foundation" }] };
      cache[preferredKey("missone")] = { totalHits: 1, foods: [{ fdcId: 12345, description: "Missone Snack", dataType: "Foundation" }] };
      // "uncachedpos": no entry at all.
      cache[preferredKey("errorpos")] = { totalHits: 0 }; // malformed -> error, not uncached
      // "brandedneg": preferred empty -> Branded fallback hit -> usedBranded=true -> labeled_branded_fallback.
      cache[preferredKey("brandedneg")] = { totalHits: 0, foods: [] };
      cache[brandedKey("brandedneg")] = { totalHits: 1, foods: [{ fdcId: 50, description: "Brandedneg Snack", dataType: "Branded" }] };
      // "wrongone": preferred hit directly -> usedBranded=false, best defined -> confident_wrong.
      cache[preferredKey("wrongone")] = { totalHits: 1, foods: [{ fdcId: 60, description: "Wrongone Snack", dataType: "Foundation" }] };
      // "uncachedneg": no entry at all.
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      const { aggregate } = outcome;

      assert.equal(aggregate.counts.hit, 2);
      assert.equal(aggregate.counts.miss, 1);
      assert.equal(aggregate.counts.labeled_branded_fallback, 1, "brandedneg scores labeled_branded_fallback (negative + usedBranded)");
      assert.equal(aggregate.counts.confident_wrong, 1);
      assert.equal(aggregate.counts.uncached, 2);
      assert.equal(aggregate.counts.error, 1);

      assert.equal(aggregate.scored.positive, 3, "5 positive - 1 uncached - 1 error = 3 scored");
      assert.equal(aggregate.scored.negative, 2, "3 negative - 1 uncached - 0 error = 2 scored");
      assert.deepEqual(aggregate.unscored.positive, { uncached: 1, error: 1 });
      assert.deepEqual(aggregate.unscored.negative, { uncached: 1, error: 0 });

      assert.deepEqual(aggregate.matrix.positive, { hit: 2, near: 0, near_branded: 0, miss: 1, labeled_branded_fallback: 0, refusal: 0 });
      assert.deepEqual(aggregate.matrix.negative, { refusal: 0, labeled_branded_fallback: 1, confident_wrong: 1 });

      // Hand-computed against SCORED denominators only (never against totals.positive=5/totals.negative=3).
      assert.equal(aggregate.top1Pct, (2 / 3) * 100);
      assert.equal(aggregate.top4Pct, (2 / 3) * 100);
      assert.equal(aggregate.positiveRefusalPct, 0);
      assert.equal(aggregate.positiveLabeledBrandedFallbackPct, 0);
      assert.equal(aggregate.negativeRefusalPct, 0);
      assert.equal(aggregate.negativeLabeledBrandedFallbackPct, (1 / 2) * 100);
      assert.equal(aggregate.negativeConfidentWrongPct, (1 / 2) * 100);

      // Coverage = scored.total/total = 5/8 = 62.5% < 90% -> nonzero exit (non-strict).
      assert.equal(outcome.exitCode, 1);
    });
  });
});

// ─── 9. Adversarial fixture — full default replay under the new taxonomy ──

describe("adversarial fixture — full default replay (real committed cache, new scoring matrix)", () => {
  test("household-food-eval-v1 + search-cache.json replays cleanly: 100% coverage, every row a known status, exit 0", async () => {
    const outcome = await runEval({ live: false }); // defaults: DEFAULT_FIXTURE_PATH + DEFAULT_CACHE_PATH
    assert.equal(outcome.aggregate.totals.total, 96);
    assert.equal(outcome.aggregate.scored.total, 96, "the committed cache should give 100% coverage for the committed fixture");
    const knownStatuses = new Set(["hit", "near", "near_branded", "miss", "labeled_branded_fallback", "refusal", "confident_wrong"]);
    for (const row of outcome.rows) {
      assert.ok(knownStatuses.has(row.status), `unexpected status "${row.status}" for "${row.name}"`);
    }
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.excluded, [], "the adversarial fixture carries no excluded[] block");
  });
});

// ─── 10. Published/strict mode (spec S8: zero tolerance) ──────────────────

describe("published/strict mode", () => {
  const names = Array.from({ length: 10 }, (_, i) => `strictname${i}`);

  function buildFixture(): EvalFixture {
    return {
      provenance: {} as unknown as EvalFixture["provenance"],
      cases: names.map((name, i) => ({ name, kind: "positive" as const, expected: { fdcId: 5000 + i, description: name, dataType: "Foundation" as const } })),
    };
  }

  test("strict mode hard-fails on a single uncached row even at 90% coverage (non-strict passes the same cache)", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      writeFileSync(fixturePath, JSON.stringify(buildFixture()));

      const cache: CacheFile = {};
      for (const name of names.slice(0, 9)) {
        // 9 of 10 cached = exactly 90% coverage.
        const key = buildCacheKey({ query: normalize(name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { totalHits: 1, foods: [{ fdcId: 5000 + names.indexOf(name), description: name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const nonStrict = await runEval({ live: false, fixturePath, cachePath, strict: false });
      assert.equal(nonStrict.exitCode, 0, "sanity: non-strict passes at exactly 90% coverage (threshold is coverage < 90%)");

      const strict = await runEval({ live: false, fixturePath, cachePath, strict: true });
      assert.equal(strict.exitCode, 1, "strict mode must hard-fail on the single uncached row, ignoring the 90% threshold entirely");
      assert.equal(strict.aggregate.counts.uncached, 1);
    });
  });

  test("strict mode hard-fails on a single errored row even at high coverage", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      writeFileSync(fixturePath, JSON.stringify(buildFixture()));

      const cache: Record<string, unknown> = {};
      for (const [i, name] of names.entries()) {
        const key = buildCacheKey({ query: normalize(name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = i === 0 ? { totalHits: 0 } /* malformed -> error */ : { totalHits: 1, foods: [{ fdcId: 5000 + i, description: name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const strict = await runEval({ live: false, fixturePath, cachePath, strict: true });
      assert.equal(strict.exitCode, 1, "strict mode must hard-fail on the single errored row");
      assert.equal(strict.aggregate.counts.error, 1);
    });
  });

  test("strict mode exits 0 when every row scores (zero uncached, zero errored)", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      writeFileSync(fixturePath, JSON.stringify(buildFixture()));

      const cache: CacheFile = {};
      for (const [i, name] of names.entries()) {
        const key = buildCacheKey({ query: normalize(name), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { totalHits: 1, foods: [{ fdcId: 5000 + i, description: name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const strict = await runEval({ live: false, fixturePath, cachePath, strict: true });
      assert.equal(strict.exitCode, 0);
    });
  });
});

// ─── 11. Fill-missing-only recording ───────────────────────────────────────

describe("fill-missing-only recording", () => {
  test("makeRecordingSearchFn never calls real() for a key already in `existing`", async () => {
    let callCount = 0;
    const stubReal = async (): Promise<FdcSearchResult> => {
      callCount++;
      return { totalHits: 1, currentPage: 1, totalPages: 1, foods: [{ fdcId: 1, description: "Should not be called" }] };
    };
    const params: FdcSearchParams = { query: "already cached", dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 };
    const key = buildCacheKey(params);
    const existing: CacheFile = { [key]: { totalHits: 1, foods: [{ fdcId: 777, description: "Existing Cached Food" }] } };

    const buffer = new Map<string, CacheEntry>();
    const recording = makeRecordingSearchFn(stubReal, buffer, existing);
    const result = await recording(params);

    assert.equal(callCount, 0, "a key already in `existing` must never trigger a network call");
    assert.equal(result.foods[0].fdcId, 777, "the served result must come from the existing cache entry, not a fresh call");
    assert.equal(buffer.size, 0, "fill-missing-only must not re-write a key it never fetched");
  });

  test("makeRecordingSearchFn DOES call real() for a genuinely new key, and buffers only that one", async () => {
    let callCount = 0;
    const stubReal = async (): Promise<FdcSearchResult> => {
      callCount++;
      return { totalHits: 1, currentPage: 1, totalPages: 1, foods: [{ fdcId: 2, description: "Freshly Fetched" }] };
    };
    const cachedParams: FdcSearchParams = { query: "cached one", dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 };
    const newParams: FdcSearchParams = { query: "new one", dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 };
    const existing: CacheFile = { [buildCacheKey(cachedParams)]: { totalHits: 1, foods: [{ fdcId: 1, description: "Old" }] } };

    const buffer = new Map<string, CacheEntry>();
    const recording = makeRecordingSearchFn(stubReal, buffer, existing);
    await recording(cachedParams);
    await recording(newParams);

    assert.equal(callCount, 1, "only the genuinely new key should hit the network");
    assert.equal(buffer.size, 1);
    assert.ok(buffer.has(buildCacheKey(newParams)));
  });
});

// ─── 12. Fixture <-> cache binding (--fixture registry) ────────────────────

describe("fixture <-> cache binding (--fixture registry)", () => {
  test("resolveFixtureBinding('household') binds the original default paths", () => {
    const binding = resolveFixtureBinding("household");
    assert.equal(binding.fixturePath, DEFAULT_FIXTURE_PATH);
    assert.equal(binding.cachePath, DEFAULT_CACHE_PATH);
  });

  test("resolveFixtureBinding('representative') binds the representative fixture to its OWN cache file, never the household one", () => {
    const binding = resolveFixtureBinding("representative");
    assert.ok(binding.fixturePath.endsWith(path.join("fixtures", "household-representative-v1.json")));
    assert.ok(binding.cachePath.endsWith(path.join("cache", "representative-search-cache.json")));
    assert.notEqual(binding.cachePath, DEFAULT_CACHE_PATH, "the representative fixture must never share a cache file with the household fixture");
  });

  test("resolveFixtureBinding throws a clear error on an unknown key", () => {
    assert.throws(() => resolveFixtureBinding("nonexistent"), /Unknown --fixture/);
  });

  test("FIXTURE_REGISTRY exposes exactly household + representative", () => {
    assert.deepEqual(new Set(Object.keys(FIXTURE_REGISTRY)), new Set(["household", "representative"]));
  });
});

// ─── 13. Aggregate cache size budget (spec S8: aggregate, not per-file) ───

describe("aggregate cache size budget", () => {
  test("checkCacheSizeBudget warn/exceeded thresholds (pure math over a byte count)", () => {
    assert.deepEqual(checkCacheSizeBudget(1024), { bytes: 1024, warn: false, exceeded: false });
    assert.equal(checkCacheSizeBudget(CACHE_WARN_BYTES + 1).warn, true);
    assert.equal(checkCacheSizeBudget(CACHE_WARN_BYTES + 1).exceeded, false);
    assert.equal(checkCacheSizeBudget(CACHE_HARD_BYTES + 1).exceeded, true);
    assert.equal(checkCacheSizeBudget(CACHE_HARD_BYTES).exceeded, false, "exactly the hard budget is within (only >hard exceeds)");
  });

  test("aggregateCacheBytes sums every *.json file directly inside the cache dir, ignoring non-.json files", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(path.join(dir, "search-cache.json"), "a".repeat(1000));
      writeFileSync(path.join(dir, "representative-search-cache.json"), "b".repeat(2000));
      writeFileSync(path.join(dir, "not-json.txt"), "c".repeat(5000));
      assert.equal(aggregateCacheBytes(dir), 3000);
    });
  });

  test("aggregateCacheBytes returns 0 for a nonexistent directory", () => {
    assert.equal(aggregateCacheBytes(path.join(tmpdir(), "definitely-does-not-exist-eval-cache-test")), 0);
  });

  test("two separate under-budget files can together cross the aggregate threshold that neither crosses alone", () => {
    const fileABytes = CACHE_HARD_BYTES - 100;
    const fileBBytes = 200;
    assert.equal(checkCacheSizeBudget(fileABytes).exceeded, false, "file A alone is under budget");
    assert.equal(checkCacheSizeBudget(fileABytes + fileBBytes).exceeded, true, "the AGGREGATE of both exceeds it — this is why the budget must be checked as a sum, never per-file");
  });
});

// ─── 14. excluded[] pass-through on RunOutcome ─────────────────────────────

describe("excluded[] pass-through", () => {
  test("runEval's outcome.excluded mirrors fixture.excluded verbatim", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      const fixture: EvalFixture = {
        provenance: {} as unknown as EvalFixture["provenance"],
        cases: [{ name: "known", kind: "positive", expected: { fdcId: 1, description: "Known", dataType: "Foundation" } }],
        excluded: [{ name: "unknownthing", reason: "names-index resolution miss", occurrences: 3, packs: { "pack-1": 3 } }],
      };
      writeFileSync(fixturePath, JSON.stringify(fixture));
      const cache: CacheFile = {};
      cache[buildCacheKey({ query: normalize("known"), dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 })] = { totalHits: 1, foods: [{ fdcId: 1, description: "Known" }] };
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.deepEqual(outcome.excluded, fixture.excluded);
    });
  });

  test("runEval's outcome.excluded is [] when the fixture has no excluded field (adversarial-fixture shape)", async () => {
    await withTempDir(async (dir) => {
      const fixturePath = path.join(dir, "fixture.json");
      const cachePath = path.join(dir, "cache.json");
      writeFileSync(fixturePath, JSON.stringify({ provenance: {}, cases: [] }));
      writeFileSync(cachePath, JSON.stringify({}));
      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.deepEqual(outcome.excluded, []);
    });
  });
});

// ─── 15. household-representative-v1 fixture ───────────────────────────────

describe("household-representative-v1 fixture", () => {
  test("passes schema validation with the spec-measured coverage + evidence-class counts", () => {
    const binding = resolveFixtureBinding("representative");
    const fixture = loadFixture(binding.fixturePath);
    assert.doesNotThrow(() => validateFixtureSchema(fixture));

    assert.equal(fixture.cases.length, 142);
    assert.equal(fixture.excluded?.length, 36);

    assert.equal(fixture.provenance.coverage?.uniqueNames, 178);
    assert.equal(fixture.provenance.coverage?.uniqueEligible, 142);
    assert.equal(fixture.provenance.coverage?.uniqueUnresolved, 30);
    assert.equal(fixture.provenance.coverage?.uniqueNoRef, 6);
    assert.equal(fixture.provenance.coverage?.weightedOccurrences, 251);
    assert.equal(fixture.provenance.coverage?.weightedEligible, 212);

    const evidence = fixture.provenance.evidenceClassCounts;
    assert.equal(evidence?.human_pin, 30);
    assert.equal(evidence?.human_ruling, 8);
    assert.equal(evidence?.automated_screened, 104);
    assert.equal((evidence?.human_pin ?? 0) + (evidence?.human_ruling ?? 0) + (evidence?.automated_screened ?? 0), 142);

    // Every case must carry expectedSource "dictionary-ratified" (the constant
    // answer-provenance tag) AND a per-row resolverSource (spec S11's actual
    // "resolver source" — fdc_ref.match_method, e.g. exact/close/pinned;
    // jump-1778 fix-pass — these are two DIFFERENT fields, never conflated).
    for (const c of fixture.cases) {
      assert.equal(c.expectedSource, "dictionary-ratified", `case "${c.name}" is missing expectedSource`);
      assert.ok(typeof c.resolverSource === "string" && c.resolverSource.length > 0, `case "${c.name}" is missing resolverSource`);
    }
  });

  test("provenance carries a FULL 40-hex dictionaryCommit SHA (never the short --commit arg) plus the pack-input file hashes and assembly parameters", () => {
    const binding = resolveFixtureBinding("representative");
    const fixture = loadFixture(binding.fixturePath);
    const p = fixture.provenance;

    assert.ok(p.dictionaryCommit && /^[0-9a-f]{40}$/.test(p.dictionaryCommit), `dictionaryCommit must be a full 40-hex SHA, got ${p.dictionaryCommit}`);
    assert.ok(p.queryProductionCommit && /^[0-9a-f]{40}$/.test(p.queryProductionCommit), `queryProductionCommit must be a full 40-hex SHA, got ${p.queryProductionCommit}`);

    assert.ok(p.packInputSha256, "packInputSha256 must be present (distinct from packSnapshotSha256)");
    assert.equal(Object.keys(p.packInputSha256 ?? {}).length, 4);
    for (const [packId, inputHash] of Object.entries(p.packInputSha256 ?? {})) {
      assert.notEqual(inputHash, p.packSnapshotSha256?.[packId], `${packId}: input file hash must differ from its (much larger) run-snapshot hash`);
    }

    assert.ok(p.parameters, "parameters block must be present");
    assert.equal(p.parameters?.commitResolved, p.dictionaryCommit);
    assert.equal(p.parameters?.date, p.derivedAt);

    assert.equal(p.coverage?.uniqueNonPreferredType, 0, "v1's battery has zero non-preferred-type exclusions (verified) — but the bucket must exist and be a number, not undefined");
  });

  test("cases[] and excluded[] names are disjoint and together cover all 178 unique battery names", () => {
    const binding = resolveFixtureBinding("representative");
    const fixture = loadFixture(binding.fixturePath);
    const caseNames = new Set(fixture.cases.map((c) => c.name));
    const excludedNames = new Set((fixture.excluded ?? []).map((x) => x.name));
    const overlap = [...caseNames].filter((n) => excludedNames.has(n));
    assert.deepEqual(overlap, [], "a name must never be both a scoreable case and an excluded row");
    assert.equal(caseNames.size + excludedNames.size, 178);
  });
});

// ─── 16. Statistics layer (eval/lib/statistics.ts, jump-1778 fix-pass) ────

describe("statistics layer: wilsonInterval", () => {
  test("n<=0 returns {lower:0, upper:0} — no claim can be made from zero draws", () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 0 });
    assert.deepEqual(wilsonInterval(5, -1), { lower: 0, upper: 0 });
  });

  test("known reference values (hand-computed Wilson score interval, z=1.96)", () => {
    const half = wilsonInterval(50, 100);
    assert.ok(Math.abs(half.lower - 40.383) < 0.01, `lower ${half.lower}`);
    assert.ok(Math.abs(half.upper - 59.617) < 0.01, `upper ${half.upper}`);

    const zero = wilsonInterval(0, 10);
    assert.ok(Math.abs(zero.lower - 0) < 0.01);
    assert.ok(Math.abs(zero.upper - 27.754) < 0.01);

    const all = wilsonInterval(10, 10);
    assert.ok(Math.abs(all.lower - 72.246) < 0.01);
    assert.equal(all.upper, 100);
  });

  test("the point estimate always falls within its own Wilson interval", () => {
    const cases: Array<[number, number]> = [
      [1, 3],
      [5, 7],
      [0, 10],
      [10, 10],
      [38, 142],
      [142, 142],
    ];
    for (const [hits, n] of cases) {
      const pointPct = (hits / n) * 100;
      const interval = wilsonInterval(hits, n);
      assert.ok(pointPct >= interval.lower - 1e-9 && pointPct <= interval.upper + 1e-9, `${hits}/${n}: point ${pointPct} not in [${interval.lower}, ${interval.upper}]`);
    }
  });
});

describe("statistics layer: computeStratumStats / computeWeightedPositiveStats / computeCoverageStats / computePackRollups", () => {
  function row(overrides: Partial<CaseResult> & Pick<CaseResult, "name" | "status">): CaseResult {
    return { kind: "positive", ...overrides };
  }

  test("computeStratumStats: unique-name accuracy is Wilson-CI'd and ignores occurrences entirely", () => {
    const rows: CaseResult[] = [row({ name: "a", status: "hit", occurrences: 100 }), row({ name: "b", status: "miss", occurrences: 1 })];
    const stratum = computeStratumStats(rows, () => true);
    assert.equal(stratum.n, 2);
    assert.equal(stratum.hits, 1);
    assert.equal(stratum.top1Pct, 50);
    assert.deepEqual(stratum.top1Wilson, wilsonInterval(1, 2));
  });

  test("computeWeightedPositiveStats produces a DIFFERENT number than the unique stratum when occurrences are skewed — proves weighting actually changes the answer", () => {
    const rows: CaseResult[] = [row({ name: "a", status: "hit", occurrences: 100 }), row({ name: "b", status: "miss", occurrences: 1 })];
    const unique = computeStratumStats(rows, () => true);
    const weighted = computeWeightedPositiveStats(rows);
    assert.equal(unique.top1Pct, 50, "unique: 1 hit / 2 names = 50%");
    assert.equal(weighted.top1Pct, (100 / 101) * 100, "weighted: 100 occurrences hit / 101 total occurrences");
    assert.notEqual(Math.round(unique.top1Pct), Math.round(weighted.top1Pct), "the whole point of weighting: these must differ on a skewed distribution");
    assert.equal(weighted.label, "pack-item-weighted");
  });

  test("computeWeightedPositiveStats degrades to the unique numbers when rows carry no occurrences metadata (adversarial-fixture shape)", () => {
    const rows: CaseResult[] = [row({ name: "a", status: "hit" }), row({ name: "b", status: "miss" })];
    const unique = computeStratumStats(rows, () => true);
    const weighted = computeWeightedPositiveStats(rows);
    assert.equal(weighted.n, unique.n, "no occurrences metadata -> every row implicitly weights 1 -> weighted n === unique n");
    assert.equal(weighted.top1Pct, unique.top1Pct);
  });

  test("computeCoverageStats: eligible/total, unique AND weighted, includes excluded rows in the denominator", () => {
    const rows: CaseResult[] = [row({ name: "a", status: "hit", occurrences: 5 }), row({ name: "b", status: "uncached", occurrences: 2 })];
    const excluded = [
      { name: "c", reason: "unresolved", occurrences: 3, packs: {} },
      { name: "d", reason: "unresolved", occurrences: 1, packs: {} },
    ];
    const coverage = computeCoverageStats(rows, excluded);
    // eligible = every POSITIVE row regardless of scored status (fixture-assembly-time truth, not run-time coverage).
    assert.equal(coverage.uniqueEligible, 2);
    assert.equal(coverage.uniqueTotal, 4);
    assert.equal(coverage.uniqueCoveragePct, 50);
    assert.equal(coverage.weightedEligible, 7);
    assert.equal(coverage.weightedTotal, 11);
    assert.ok(Math.abs(coverage.weightedCoveragePct - (7 / 11) * 100) < 1e-9);
  });

  test("computePackRollups is occurrence-weighted AND counts excluded rows into each pack's total (the two named defects)", () => {
    const rows: CaseResult[] = [
      row({ name: "a", status: "hit", occurrences: 4, packs: { "pack-1": 4 } }),
      row({ name: "b", status: "miss", occurrences: 1, packs: { "pack-1": 1 } }),
    ];
    const excluded = [{ name: "c", reason: "unresolved", occurrences: 10, packs: { "pack-1": 10 } }];
    const rollups = computePackRollups(rows, excluded);
    const p1 = rollups["pack-1"];
    assert.equal(p1.uniqueEligible, 2, "2 eligible names in pack-1");
    assert.equal(p1.uniqueTotal, 3, "2 eligible + 1 excluded name");
    assert.equal(p1.weightedEligible, 5, "4+1 occurrences");
    assert.equal(p1.weightedTotal, 15, "4+1+10 occurrences INCLUDING the excluded row — this is the fix");
    assert.equal(p1.weightedScored, 5);
    assert.equal(p1.weightedHits, 4);
    assert.equal(p1.top1Pct, 80, "4/5 weighted hit rate — NOT unique 1/2=50%, proving it's occurrence-weighted");
  });

  test("computeRepresentativeStats assembles coverage/unique/weighted/humanAdjudicated/byPack/model in one call", () => {
    const rows: CaseResult[] = [
      row({ name: "a", status: "hit", occurrences: 2, packs: { "pack-1": 2 }, evidenceClass: "human_pin" }),
      row({ name: "b", status: "miss", occurrences: 1, packs: { "pack-1": 1 }, evidenceClass: "automated_screened" }),
    ];
    const stats = computeRepresentativeStats(rows, []);
    assert.equal(stats.coverage.uniqueEligible, 2);
    assert.equal(stats.unique.n, 2);
    assert.equal(stats.weighted.n, 3);
    assert.equal(stats.humanAdjudicated.n, 1, "only the human_pin row counts toward the human-adjudicated stratum");
    assert.equal(stats.humanAdjudicated.hits, 1);
    assert.ok(stats.byPack["pack-1"]);
    assert.ok(stats.model.includes("Wilson"));
  });
});

// ─── 17. Assembly classification: pin-binding guard + distinct data_type bucket ───

describe("assembly classification: pin-binding guard (spec S2, jump-1778 fix-pass)", () => {
  test("classifyEvidence returns human_pin ONLY when the pin's fdc_id matches THIS row's fdc_ref.fdc_id", () => {
    const pins: FdcPins = {
      carrots: { fdc_id: "100" }, // matches the row under test below
      onions: { fdc_id: "999" }, // does NOT match the row we'll test against (777)
    };
    const rulings: IdentityRulings = { decisions: {} };

    assert.equal(classifyEvidence("carrots", "100", pins, rulings), "human_pin", "matching pin -> human_pin");
    assert.equal(
      classifyEvidence("onions", "777", pins, rulings),
      "automated_screened",
      "a pin exists under this product_name but points at a DIFFERENT fdc_id (999 != 777) — must NOT count as human_pin for this identity"
    );
  });

  test("classifyEvidence falls through to human_ruling when the pin is a binding mismatch but a ruling exists for this exact identity", () => {
    const pins: FdcPins = { onions: { fdc_id: "999" } }; // mismatched pin
    const rulings: IdentityRulings = { decisions: { "onions|777": { ruling: "keep" } } };
    assert.equal(classifyEvidence("onions", "777", pins, rulings), "human_ruling");
  });

  test("classifyEvidence falls through to automated_screened when the pin's fdc_id is null (an explicit negative pin, not an identity match)", () => {
    const pins: FdcPins = { widget: { fdc_id: null } };
    const rulings: IdentityRulings = { decisions: {} };
    assert.equal(classifyEvidence("widget", "555", pins, rulings), "automated_screened");
  });

  test("classifyEvidence tolerates a numeric pin.fdc_id vs a string fdcId argument (String-compared, source vintage varies)", () => {
    const pins = { thing: { fdc_id: 42 as unknown as string } };
    const rulings: IdentityRulings = { decisions: {} };
    assert.equal(classifyEvidence("thing", "42", pins, rulings), "human_pin");
  });
});

describe("assembly classification: classifyName full decision tree", () => {
  function nameStats(occ = 1, packs: Record<string, number> = { "pack-1": occ }): NameStats {
    return { name: "x", occurrences: occ, packs };
  }

  test("unresolved: a name not in the index becomes excluded, bucket unresolved", () => {
    const nameIndex = new Map<string, string>();
    const result = classifyName("mystery ingredient", nameStats(), {}, nameIndex, {}, { decisions: {} });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") assert.equal(result.bucket, "unresolved");
  });

  test("no_ref: resolves, but the entry carries no fdc_ref at all", () => {
    const dict: Dictionary = { k: { product_name: "k", names: ["k"] } };
    const nameIndex = new Map([["k", "k"]]);
    const result = classifyName("k", nameStats(), dict, nameIndex, {}, { decisions: {} });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") assert.equal(result.bucket, "no_ref");
  });

  test("non_preferred_type: resolves, HAS an fdc_ref, but data_type is Branded — a DISTINCT bucket from no_ref, never silently folded in", () => {
    const dict: Dictionary = { k: { product_name: "k", names: ["k"], fdc_ref: { fdc_id: "9", description: "K Snack", data_type: "Branded", match_method: "exact" } } };
    const nameIndex = new Map([["k", "k"]]);
    const result = classifyName("k", nameStats(), dict, nameIndex, {}, { decisions: {} });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") {
      assert.equal(result.bucket, "non_preferred_type");
      assert.notEqual(result.bucket, "no_ref");
    }
  });

  test("eligible: resolves, has a preferred-type fdc_ref -> a positive case carrying resolverSource = match_method", () => {
    const dict: Dictionary = { k: { product_name: "carrots", names: ["k"], fdc_ref: { fdc_id: "100", description: "Carrots, raw", data_type: "Foundation", match_method: "exact" } } };
    const nameIndex = new Map([["k", "k"]]);
    const result = classifyName("k", nameStats(3, { "pack-2": 3 }), dict, nameIndex, { carrots: { fdc_id: "100" } }, { decisions: {} });
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.evidenceClass, "human_pin");
      assert.equal(result.case.expected.fdcId, 100);
      assert.equal(result.case.resolverSource, "exact");
      assert.equal(result.case.occurrences, 3);
      assert.deepEqual(result.case.packs, { "pack-2": 3 });
    }
  });

  test("PIN-BINDING GUARD end-to-end through classifyName: a mismatched pin does not leak human_pin onto the wrong identity", () => {
    const dict: Dictionary = { k: { product_name: "onions", names: ["k"], fdc_ref: { fdc_id: "777", description: "Onions, raw", data_type: "Foundation", match_method: "close" } } };
    const nameIndex = new Map([["k", "k"]]);
    const pins: FdcPins = { onions: { fdc_id: "999" } }; // pinned to a DIFFERENT identity than 777
    const result = classifyName("k", nameStats(), dict, nameIndex, pins, { decisions: {} });
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.evidenceClass, "automated_screened", "a same-name pin bound to a different fdc_id must not count as human_pin here");
    }
  });
});

// ─── 18. Dry statistics demo (no live cache; synthetic scoring) ───────────

describe("representative fixture — dry statistics demo (no live cache; synthetic scoring against `expected` directly)", () => {
  test("computeRepresentativeStats produces coherent unique/weighted/human-subset/coverage/byPack numbers from the committed fixture's cases, and prints a full summary", () => {
    const binding = resolveFixtureBinding("representative");
    const fixture = loadFixture(binding.fixturePath);

    // Synthetic "would-be" scoring — NOT a real find_food measurement (no
    // live cache exists yet for this fixture; the recording run is the
    // coordinator's step). Every 3rd case (by sorted order) is marked a
    // miss, everything else a hit, so the distribution is non-trivial
    // enough to prove the statistics layer's wiring (Wilson/weighted/
    // stratified/coverage/per-pack) actually computes something, not just
    // returns 100% everywhere.
    const rows: CaseResult[] = fixture.cases.map(
      (c, i): CaseResult => ({
        name: c.name,
        kind: "positive",
        status: i % 3 === 0 ? "miss" : "hit",
        evidenceClass: c.evidenceClass,
        expectedSource: c.expectedSource,
        resolverSource: c.resolverSource,
        occurrences: c.occurrences,
        packs: c.packs,
      })
    );

    const stats = computeRepresentativeStats(rows, fixture.excluded ?? []);

    // Coverage is fixture-assembly-time truth, independent of the synthetic scoring.
    assert.equal(stats.coverage.uniqueEligible, 142);
    assert.equal(stats.coverage.uniqueTotal, 178);
    assert.equal(stats.coverage.weightedEligible, 212);
    assert.equal(stats.coverage.weightedTotal, 251);

    assert.equal(stats.unique.n, 142);
    assert.ok(stats.unique.top1Pct > stats.unique.top1Wilson.lower && stats.unique.top1Pct < stats.unique.top1Wilson.upper);

    assert.equal(stats.humanAdjudicated.n, 38, "30 human_pin + 8 human_ruling");

    assert.ok(stats.weighted.n >= stats.unique.n, "weighted denominator counts every occurrence, so it's >= the unique denominator");

    assert.equal(Object.keys(stats.byPack).length, 4, "all four packs should appear in the rollup");

    console.log("");
    console.log("── representative fixture: dry statistics demo (synthetic scoring, NOT a real measurement) ──");
    console.log(
      `coverage: unique ${stats.coverage.uniqueEligible}/${stats.coverage.uniqueTotal} (${stats.coverage.uniqueCoveragePct.toFixed(1)}%) | ` +
        `weighted ${stats.coverage.weightedEligible}/${stats.coverage.weightedTotal} (${stats.coverage.weightedCoveragePct.toFixed(1)}%)`
    );
    console.log(
      `unique top-1:   ${stats.unique.top1Pct.toFixed(1)}% (n=${stats.unique.n}) 95% CI [${stats.unique.top1Wilson.lower.toFixed(1)}, ${stats.unique.top1Wilson.upper.toFixed(1)}]`
    );
    console.log(
      `unique top-4:   ${stats.unique.top4Pct.toFixed(1)}% (n=${stats.unique.n}) 95% CI [${stats.unique.top4Wilson.lower.toFixed(1)}, ${stats.unique.top4Wilson.upper.toFixed(1)}]`
    );
    console.log(`weighted top-1: ${stats.weighted.top1Pct.toFixed(1)}% (pack-item-weighted, n=${stats.weighted.n}, descriptive — no CI)`);
    console.log(`weighted top-4: ${stats.weighted.top4Pct.toFixed(1)}% (pack-item-weighted, n=${stats.weighted.n}, descriptive — no CI)`);
    console.log(
      `human-adjudicated top-1: ${stats.humanAdjudicated.top1Pct.toFixed(1)}% (n=${stats.humanAdjudicated.n}) 95% CI [${stats.humanAdjudicated.top1Wilson.lower.toFixed(1)}, ${stats.humanAdjudicated.top1Wilson.upper.toFixed(1)}]`
    );
    for (const packId of Object.keys(stats.byPack).sort()) {
      const p = stats.byPack[packId];
      console.log(`  ${packId}: weighted top-1 ${p.top1Pct.toFixed(1)}% (scored ${p.weightedHits}/${p.weightedScored} weighted, ${p.uniqueHits}/${p.uniqueScored} unique)`);
    }
  });
});

// ─── 6. Live request path through the real client ─────────────────────────

describe("live request path (real FdcClient, mocked fetch)", () => {
  test("attaches X-Api-Key header, never puts the key in the URL, and the recording wrapper captures a projected entry", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;

    const restore = installFetchMock((url, init) => {
      capturedUrl = url;
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({
        totalHits: 1,
        currentPage: 1,
        totalPages: 1,
        foods: [
          {
            fdcId: 555,
            description: "Live Path Test Food",
            dataType: "Foundation",
            foodNutrients: [{ nutrientId: 208, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value: 123 }],
          },
        ],
      });
    });

    try {
      const client = new FdcClient("test-key");
      const real = client.searchFoods.bind(client);
      const buffer = new Map();
      const recording = makeRecordingSearchFn(real, buffer);

      const result = await recording({ query: "live path test food", dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });

      assert.equal(capturedHeaders?.get("X-Api-Key"), "test-key", "the real client must attach the key via the X-Api-Key header");
      assert.ok(!capturedUrl.includes("test-key"), "the API key must never appear in the request URL");

      assert.equal(result.foods[0].fdcId, 555, "the recording wrapper forwards the real response untouched to the caller");

      assert.equal(buffer.size, 1);
      const [entry] = [...buffer.values()];
      assert.equal(entry.foods[0].fdcId, 555, "the buffered cache entry captures the (projected) response");
      assert.equal(entry.foods[0].description, "Live Path Test Food");
    } finally {
      restore();
    }
  });
});
