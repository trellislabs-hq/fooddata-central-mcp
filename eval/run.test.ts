/**
 * Module: eval harness self-tests
 * Purpose: Proves the eval harness's own machinery is correct — independent
 *   of any live baseline run (the committed eval/cache/search-cache.json is
 *   empty until the post-merge CoS live-baseline run populates it). Covers:
 *     1. Scoring semantics (hit/near/miss/honest/confident_wrong), including
 *        the usedBranded-honest case.
 *     2. Cache record -> replay round-trip identity.
 *     3. Projection faithfulness — findFood()'s rendered text over a full
 *        response vs its projection, byte-identical.
 *     4. Fixture schema validation, including the string-vs-number fdc_id
 *        coercion footgun the source pins file has (fdc_id is a STRING
 *        there; FdcFood.fdcId is NUMERIC).
 *     5. Replay coverage-threshold failure (<90% cache coverage -> nonzero
 *        exit) vs full-coverage success.
 *     6. The live request path through the REAL FdcClient (not a stub),
 *        under a mocked global.fetch, proving the X-Api-Key header is
 *        attached, no key reaches the URL, and the recording wrapper
 *        captures a projected cache entry.
 *   Plus a sanity check that the committed household-food-eval-v1 fixture
 *   itself passes schema validation with the expected case-count floors.
 *
 * Dependencies: node:test, node:assert/strict, node:fs, node:os, node:path,
 *   ../src/find-food.js, ../src/fdc-client.js, ../tests/helpers/mock-fetch.js
 *   (read-only import — see CONSTRAINTS, tests/ is never modified), and this
 *   module's own eval/lib/*.
 * State: Uses node:fs temp files (os.tmpdir()) for cache/fixture round-trip
 *   tests — never writes to the committed eval/cache/ or eval/fixtures/.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { findFood } from "../src/find-food.js";
import { FdcClient, type FdcFood, type FdcSearchParams, type FdcSearchResult } from "../src/fdc-client.js";
import { installFetchMock, jsonResponse } from "../tests/helpers/mock-fetch.js";

import { DEFAULT_FIXTURE_PATH, loadFixture, validateFixtureSchema, type EvalFixture } from "./lib/fixture.js";
import { scoreCase } from "./lib/scoring.js";
import { projectFoods } from "./lib/projection.js";
import { buildCacheKey, checkCacheSizeBudget, loadCache, writeCache, type CacheFile } from "./lib/cache.js";
import { CacheMissError, makeRecordingSearchFn, makeReplaySearchFn } from "./lib/search-fn.js";
import { runEval } from "./run.js";

const PREFERRED_DATA_TYPES = ["Foundation", "SR Legacy", "Survey (FNDDS)"] as const;

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

// ─── 1. Scoring semantics ──────────────────────────────────────────────────

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

  test("positive: near when expected.fdcId is in alternates but not best", async () => {
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
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "near");
  });

  test("positive: miss when expected.fdcId is neither best nor an alternate", async () => {
    const caseDef = { name: "cheese", kind: "positive" as const, expected: { fdcId: 999999, description: "Nonexistent", dataType: "Foundation" as const } };
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 1, description: "Some cheese", dataType: "Foundation", foodNutrients: [] }],
    });
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "miss");
    assert.equal(scored.actual?.fdcId, 1);
  });

  test("negative: honest when best is undefined (no results anywhere)", async () => {
    const caseDef = { name: "gluten free flour", kind: "negative" as const };
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (): Promise<FdcSearchResult> => emptyResult;
    const result = await findFood(searchFoods, caseDef.name, { includeBranded: false });
    assert.equal(result.best, undefined);
    const scored = scoreCase(caseDef, result);
    assert.equal(scored.status, "honest");
  });

  test("negative: honest when usedBranded === true (Branded last-resort, best defined)", async () => {
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
    assert.equal(scored.status, "honest", "usedBranded===true must count as honest even though best is defined");
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

  test("the committed household-food-eval-v1 fixture itself passes validation with >=60 positive and >=25 negative cases", () => {
    const fixture = loadFixture(DEFAULT_FIXTURE_PATH);
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
    const positive = fixture.cases.filter((c) => c.kind === "positive").length;
    const negative = fixture.cases.filter((c) => c.kind === "negative").length;
    assert.ok(positive >= 60, `expected >=60 positive cases, got ${positive}`);
    assert.ok(negative >= 25, `expected >=25 negative cases, got ${negative}`);
  });
});

// ─── 5. Replay coverage threshold ──────────────────────────────────────────

describe("replay coverage threshold", () => {
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
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fixturePath, JSON.stringify(fixture));

      // Cover only 5 of 10 (50% < 90%).
      const cache: CacheFile = {};
      for (const c of fixture.cases.slice(0, 5)) {
        const key = buildCacheKey({ query: c.name, dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { foods: [{ fdcId: (c as { expected: { fdcId: number } }).expected.fdcId, description: c.name }] };
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
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fixturePath, JSON.stringify(fixture));

      const cache: CacheFile = {};
      for (const c of fixture.cases) {
        const key = buildCacheKey({ query: c.name, dataType: [...PREFERRED_DATA_TYPES], pageSize: 10 });
        cache[key] = { foods: [{ fdcId: (c as { expected: { fdcId: number } }).expected.fdcId, description: c.name }] };
      }
      writeFileSync(cachePath, JSON.stringify(cache));

      const outcome = await runEval({ live: false, fixturePath, cachePath });
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.aggregate.counts.uncached, 0);
      assert.equal(outcome.aggregate.counts.hit, simpleNames.length);
    });
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

// ─── Bonus: cache size budget thresholds ───────────────────────────────────

describe("cache size budget", () => {
  test("warn/exceeded thresholds", () => {
    assert.deepEqual(checkCacheSizeBudget(1024), { bytes: 1024, warn: false, exceeded: false });
    assert.equal(checkCacheSizeBudget(1.6 * 1024 * 1024).warn, true);
    assert.equal(checkCacheSizeBudget(1.6 * 1024 * 1024).exceeded, false);
    assert.equal(checkCacheSizeBudget(2.1 * 1024 * 1024).exceeded, true);
    assert.equal(checkCacheSizeBudget(2 * 1024 * 1024).exceeded, false, "exactly 2MB is within budget (>2MB exceeds)");
  });
});
