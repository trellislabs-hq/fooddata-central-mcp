/**
 * Module: find-food.test.ts
 * Purpose: Golden-path and cascade tests for src/find-food.ts, mocked
 *   against recorded FDC fixtures (see tests/fixtures/README.md). This is
 *   the "cheddar proof" test — find_food("cheddar cheese") must surface FDC
 *   328637 "Cheese, cheddar" (Foundation) first, not Branded noise. Also
 *   covers the relevance floor (jump-1760): per-batch rating against the
 *   loop-local query, honest no-confident-match, Branded rescue, and the
 *   candidate-loop-continues-past-a-miss-only-batch behavior.
 * Dependencies: node:test, node:assert, ../src/find-food.ts, ../src/fdc-client.ts
 * State: Recorded fixtures for the golden path and dedup test; synthetic
 *   fixtures (labeled) for the floor/Branded-rescue/honest-no-match paths,
 *   since no recorded fixture demonstrates a floor-miss or a zero-hit query.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findFood, dedupeByDescription, PREFERRED_DATA_TYPES } from "../src/find-food.js";
import type { FdcFood, FdcSearchParams, FdcSearchResult } from "../src/fdc-client.js";
import { loadFixture } from "./helpers/mock-fetch.js";

const foundationFixture = loadFixture("cheddar-cheese.search-foundation.json") as FdcSearchResult;
const brandedFixture = loadFixture("cheddar-cheese.search-all.json") as FdcSearchResult;

describe("findFood() — cheddar golden path (recorded fixtures)", () => {
  test("returns FDC 328637 'Cheese, cheddar' as the best match, Branded excluded by default", async () => {
    const calls: FdcSearchParams[] = [];
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      calls.push(params);
      // Preferred-type search (Foundation/SR Legacy/Survey cascade) returns
      // the recorded Foundation-filtered fixture regardless of which
      // dataType array is passed, matching how the real API would respond
      // to this exact recorded query.
      return foundationFixture;
    };

    const result = await findFood(searchFoods, "cheddar cheese");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 328637);
    assert.equal(result.best!.description, "Cheese, cheddar");
    assert.match(result.text, /Best match for "cheddar cheese":/);
    assert.match(result.text, /FDC ID: 328637/);
    assert.match(result.text, /Name: Cheese, cheddar/);
    assert.match(result.text, /Nutrient summary: /);
    assert.match(result.text, /Use get_food\(fdcId: 328637\)/);

    // Nutrient summary must be non-trivial (sourced from the search
    // response's embedded foodNutrients — no follow-up detail call).
    assert.doesNotMatch(result.text, /Nutrient summary: No nutrient data/);

    assert.ok(result.alternates.length <= 3);
    assert.equal(result.usedBranded, false);

    // Confirm the search cascade only ever requested preferred data types —
    // Branded must never be queried when the preferred cascade succeeds.
    for (const call of calls) {
      assert.deepEqual(call.dataType, PREFERRED_DATA_TYPES);
    }
  });

  test("includeBranded: false means Branded is never included even if requested via options default", async () => {
    const searchFoods = async (): Promise<FdcSearchResult> => foundationFixture;
    const result = await findFood(searchFoods, "cheddar cheese", { includeBranded: false });
    assert.equal(result.usedBranded, false);
  });
});

describe("findFood() — Branded dedup (recorded fixture: 10 Branded 'CHEDDAR CHEESE' rows collapse to 1)", () => {
  test("dedupeByDescription collapses the 10 identical-description Branded rows", () => {
    assert.equal(brandedFixture.foods.length, 10);
    const deduped = dedupeByDescription(brandedFixture.foods);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].fdcId, brandedFixture.foods[0].fdcId, "keeps the first/highest-relevance occurrence");
  });

  test("findFood with includeBranded:true appends deduped, floor-passing Branded results after the preferred matches (MODIFIED for jump-1760: the Foundation fixture's other 9 cheeses — swiss, cotija, parmesan, etc. — now rate 'miss' against 'cheddar cheese' and are floor-filtered out, so the Branded entry is no longer crowded out of the 3-alternate cap by same-query Foundation noise)", async () => {
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") return brandedFixture;
      return foundationFixture;
    };

    const result = await findFood(searchFoods, "cheddar cheese", { includeBranded: true });

    assert.equal(result.best!.fdcId, 328637, "Foundation match still wins the #1 slot");
    assert.equal(result.usedBranded, true);
    // Every OTHER Foundation cheese in the fixture (swiss, cotija, oaxaca,
    // parmesan, provolone, process cheese, monterey jack) rates 'miss'
    // against "cheddar cheese" and is dropped by the floor — only 328637
    // survives from the preferred batch. The deduped Branded entry (10
    // identical all-caps "CHEDDAR CHEESE" rows -> 1, all floor-passing
    // since a comma-free description is one giant segment) is what fills
    // the alternates slot instead.
    assert.equal(result.alternates.length, 1);
    assert.equal(result.alternates[0].dataType, "Branded");
    // Still present in the underlying merged/deduped list before the
    // 3-alternate truncation — confirm via dedupeByDescription directly on
    // the same merged input findFood would have built (unaffected by the
    // floor, which is a separate filtering step upstream of dedupe).
    const merged = foundationFixture.foods.concat(brandedFixture.foods);
    const deduped = dedupeByDescription(merged);
    assert.ok(deduped.some((f) => f.dataType === "Branded"));
  });
});

describe("findFood() — preference cascade: Branded only as last resort", () => {
  test("Branded used automatically (last resort) when preferred-type search returns zero hits (SYNTHETIC: no recorded fixture has a zero-Foundation-hit query)", async () => {
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") return brandedFixture;
      return emptyResult;
    };

    const result = await findFood(searchFoods, "cheddar cheese");

    assert.equal(result.usedBranded, true);
    assert.ok(result.best);
    assert.equal(result.best!.dataType, "Branded");
    assert.match(result.text, /showing Branded \(manufacturer\) data as a last resort/);
  });

  test("Foundation outranks a higher-relevance Survey entry in combined-type results (SYNTHETIC: regression for live cheddar Survey-first, 2026-07-03 — FDC relevance ranking put Survey 2705709 above Foundation 328637) (MODIFIED for jump-1760: 'Cheese, cheshire' rates 'miss' against 'cheddar cheese' — no 'cheddar' anywhere in its description — so the floor now drops it instead of it surviving as an alternate)", async () => {
    // Mirrors the live combined-type response shape: FDC's ranker returns the
    // Survey entry FIRST. The preference sort must put Foundation on top anyway.
    const mixed: FdcSearchResult = {
      totalHits: 3,
      currentPage: 1,
      totalPages: 1,
      foods: [
        { fdcId: 2705709, description: "Cheese, Cheddar", dataType: "Survey (FNDDS)", foodNutrients: [] },
        { fdcId: 328637, description: "Cheese, cheddar", dataType: "Foundation", foodNutrients: [] },
        { fdcId: 171244, description: "Cheese, cheshire", dataType: "SR Legacy", foodNutrients: [] },
      ] as unknown as FdcFood[],
    };
    const searchFoods = async (): Promise<FdcSearchResult> => mixed;

    const result = await findFood(searchFoods, "cheddar cheese");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 328637);
    assert.equal(result.best!.dataType, "Foundation");
    assert.equal(result.matchQuality, "exact");
    // "Cheese, cheshire" carries no non-neutral overlap with "cheddar
    // cheese" (identity gate fails — 'cheddar' never appears) and is
    // floor-filtered out entirely, both from `best` consideration and from
    // `alternates`. The Survey "Cheese, Cheddar" entry (which DOES pass the
    // floor as 'exact') collapses into the Foundation best match via
    // case-insensitive dedupe, leaving no alternates at all.
    assert.ok(!result.text.includes("Cheese, cheshire"));
    assert.deepEqual(result.alternates, []);
  });

  test("no results anywhere returns a helpful no-match message, not an error (SYNTHETIC)", async () => {
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (): Promise<FdcSearchResult> => emptyResult;

    const result = await findFood(searchFoods, "nonexistent food xyz123");

    assert.equal(result.best, undefined);
    assert.match(result.text, /No foods found matching/);
  });
});

describe("dedupeByDescription()", () => {
  test("is case/whitespace-insensitive (SYNTHETIC)", () => {
    const foods = [
      { fdcId: 1, description: "Cheese, Cheddar" },
      { fdcId: 2, description: "  cheese,  cheddar " },
      { fdcId: 3, description: "Cheese, Swiss" },
    ] as FdcFood[];
    const deduped = dedupeByDescription(foods);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].fdcId, 1);
    assert.equal(deduped[1].fdcId, 3);
  });
});

// ─── jump-1760: relevance floor ────────────────────────────────────────────

describe("findFood() — relevance floor: honest no-confident-match (SYNTHETIC)", () => {
  test("nothing survives the floor anywhere -> best undefined, alternates [], below-floor closest candidates listed (the 'old bay seasoning' -> SCALLOPS baseline failure)", async () => {
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") {
        return {
          totalHits: 1,
          currentPage: 1,
          totalPages: 1,
          foods: [{ fdcId: 200, description: "Chocolate Chip Cookies", dataType: "Branded", foodNutrients: [] }],
        };
      }
      return {
        totalHits: 1,
        currentPage: 1,
        totalPages: 1,
        foods: [{ fdcId: 100, description: "Scallops, raw", dataType: "Foundation", foodNutrients: [] }],
      };
    };

    const result = await findFood(searchFoods, "old bay seasoning");

    assert.equal(result.best, undefined);
    assert.deepEqual(result.alternates, []);
    assert.equal(result.usedBranded, false);
    assert.equal(result.matchQuality, undefined);
    assert.match(result.text, /No confident match for "old bay seasoning" in FDC's preferred data types\./);
    assert.match(result.text, /Closest candidates \(below the confidence floor/);
    // Preferred-type candidate first, then Branded.
    assert.ok(result.text.includes("Scallops, raw"));
    assert.ok(result.text.includes("Chocolate Chip Cookies"));
    assert.match(result.text, /Try search_foods for a broader search/);
  });

  test("truly nothing found anywhere (raw-empty every query) keeps the ORIGINAL no-foods-found message, not the honest-no-match variant (SYNTHETIC)", async () => {
    const emptyResult: FdcSearchResult = { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    const searchFoods = async (): Promise<FdcSearchResult> => emptyResult;

    const result = await findFood(searchFoods, "totally nonexistent food xyz");

    assert.equal(result.best, undefined);
    assert.doesNotMatch(result.text, /No confident match for/);
    assert.match(result.text, /No foods found matching/);
  });
});

describe("findFood() — relevance floor: Branded rescue (SYNTHETIC)", () => {
  test("a floor-passing Branded product resolves via automatic last resort ('old bay seasoning' finding the actual Old Bay product — a feature, not a bug)", async () => {
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") {
        return {
          totalHits: 1,
          currentPage: 1,
          totalPages: 1,
          foods: [{ fdcId: 300, description: "OLD BAY SEASONING", dataType: "Branded", foodNutrients: [] }],
        };
      }
      return {
        totalHits: 1,
        currentPage: 1,
        totalPages: 1,
        foods: [{ fdcId: 100, description: "Scallops, raw", dataType: "Foundation", foodNutrients: [] }],
      };
    };

    const result = await findFood(searchFoods, "old bay seasoning");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 300);
    assert.equal(result.usedBranded, true);
    assert.equal(result.matchQuality, "exact");
    assert.match(result.text, /showing Branded \(manufacturer\) data as a last resort/);
  });
});

describe("findFood() — relevance floor: candidate loop continues past a miss-only batch (SYNTHETIC)", () => {
  test("preferred-type loop: a miss-only bare-query batch doesn't stop the search — the alias candidate that follows still wins", async () => {
    const calls: FdcSearchParams[] = [];
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      calls.push(params);
      if (params.dataType === "Branded") {
        return { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
      }
      if (params.query === "paneer") {
        return {
          totalHits: 1,
          currentPage: 1,
          totalPages: 1,
          foods: [{ fdcId: 400, description: "Something Unrelated", dataType: "Foundation", foodNutrients: [] }],
        };
      }
      if (params.query === "paneer cheese") {
        return {
          totalHits: 1,
          currentPage: 1,
          totalPages: 1,
          foods: [{ fdcId: 401, description: "Cheese, paneer", dataType: "Foundation", foodNutrients: [] }],
        };
      }
      throw new Error(`unexpected preferred-type query: ${params.query}`);
    };

    const result = await findFood(searchFoods, "paneer");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 401);
    assert.equal(result.matchedQuery, "paneer cheese");
    assert.match(result.text, /\(Matched via normalized\/alias query: "paneer cheese"\)/);
    assert.ok(
      !calls.some((c) => c.dataType !== "Branded" && c.query === "indian cheese"),
      "the third alias candidate must never be queried once 'paneer cheese' clears the floor"
    );
  });

  test("Branded automatic-last-resort loop: a miss-only first candidate doesn't stop the rescue — a later alias candidate still resolves", async () => {
    const preferredCalls: string[] = [];
    const brandedCalls: string[] = [];
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") {
        brandedCalls.push(params.query);
        if (params.query === "perilla") {
          return {
            totalHits: 1,
            currentPage: 1,
            totalPages: 1,
            foods: [{ fdcId: 500, description: "Frozen Peas", dataType: "Branded", foodNutrients: [] }],
          };
        }
        if (params.query === "shiso") {
          return {
            totalHits: 1,
            currentPage: 1,
            totalPages: 1,
            foods: [{ fdcId: 501, description: "Shiso leaves, raw", dataType: "Branded", foodNutrients: [] }],
          };
        }
        throw new Error(`unexpected Branded query: ${params.query}`);
      }
      preferredCalls.push(params.query);
      return { totalHits: 0, currentPage: 1, totalPages: 0, foods: [] };
    };

    const result = await findFood(searchFoods, "perilla");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 501);
    assert.equal(result.usedBranded, true);
    assert.equal(result.matchedQuery, "shiso");
    assert.equal(result.matchQuality, "exact");
    assert.match(result.text, /\(Matched via normalized\/alias query: "shiso"\)/);
    assert.match(result.text, /showing Branded \(manufacturer\) data as a last resort/);
    assert.deepEqual(preferredCalls, ["perilla", "shiso", "perilla leaves"]);
    assert.deepEqual(
      brandedCalls,
      ["perilla", "shiso"],
      "the third alias candidate ('perilla leaves') must never be queried once 'shiso' rescues"
    );
  });
});

describe("findFood() — relevance floor: CLOSE match note (SYNTHETIC)", () => {
  test("a 'close' match gets an approximate-match note; matchQuality reflects it", async () => {
    const searchFoods = async (): Promise<FdcSearchResult> => ({
      totalHits: 1,
      currentPage: 1,
      totalPages: 1,
      foods: [{ fdcId: 600, description: "Ginger root, raw", dataType: "Foundation", foodNutrients: [] }],
    });

    const result = await findFood(searchFoods, "fresh ginger");

    assert.ok(result.best);
    assert.equal(result.best!.fdcId, 600);
    assert.equal(result.matchQuality, "close");
    assert.match(result.text, /Note: closest match is approximate — right food family, but not an exact name match\./);
  });
});

describe("findFood() — relevance floor: opt-in Branded append filtering (SYNTHETIC)", () => {
  test("(a) a mixed pass/miss opt-in Branded batch appends only the floor-passing foods", async () => {
    const preferredFood = { fdcId: 1, description: "Ketchup, tomato", dataType: "Foundation", foodNutrients: [] } as unknown as FdcFood;
    const passingBranded = { fdcId: 2, description: "HEINZ KETCHUP", dataType: "Branded", foodNutrients: [] } as unknown as FdcFood;
    const missingBranded = { fdcId: 3, description: "MUSTARD", dataType: "Branded", foodNutrients: [] } as unknown as FdcFood;

    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") {
        return { totalHits: 2, currentPage: 1, totalPages: 1, foods: [passingBranded, missingBranded] };
      }
      return { totalHits: 1, currentPage: 1, totalPages: 1, foods: [preferredFood] };
    };

    const result = await findFood(searchFoods, "ketchup", { includeBranded: true });

    assert.equal(result.best!.fdcId, 1);
    assert.equal(result.usedBranded, true);
    assert.ok(
      result.alternates.some((f) => f.fdcId === 2),
      "the floor-passing Branded food must be appended"
    );
    assert.ok(
      !result.alternates.some((f) => f.fdcId === 3),
      "the miss-rated Branded food must be dropped, never appended"
    );
  });

  test("(b) usedBranded stays false when the opt-in Branded batch appends nothing (every candidate misses the floor)", async () => {
    const preferredFood = { fdcId: 10, description: "Broccoli, raw", dataType: "Foundation", foodNutrients: [] } as unknown as FdcFood;
    const missingBranded = { fdcId: 11, description: "CHOCOLATE BAR", dataType: "Branded", foodNutrients: [] } as unknown as FdcFood;

    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") {
        return { totalHits: 1, currentPage: 1, totalPages: 1, foods: [missingBranded] };
      }
      return { totalHits: 1, currentPage: 1, totalPages: 1, foods: [preferredFood] };
    };

    const result = await findFood(searchFoods, "broccoli", { includeBranded: true });

    assert.equal(result.best!.fdcId, 10);
    assert.equal(result.usedBranded, false, "nothing actually got appended, so usedBranded must not flip true");
    assert.ok(!result.alternates.some((f) => f.fdcId === 11));
  });
});
