/**
 * Module: find-food.test.ts
 * Purpose: Golden-path and cascade tests for src/find-food.ts, mocked
 *   against recorded FDC fixtures (see tests/fixtures/README.md). This is
 *   the "cheddar proof" test — find_food("cheddar cheese") must surface FDC
 *   328637 "Cheese, cheddar" (Foundation) first, not Branded noise.
 * Dependencies: node:test, node:assert, ../src/find-food.ts, ../src/fdc-client.ts
 * State: Recorded fixtures for the golden path and dedup test; ONE synthetic
 *   fixture (labeled) for the Branded-last-resort path, since no recorded
 *   fixture demonstrates a query with zero non-Branded hits.
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

  test("findFood with includeBranded:true appends deduped Branded results after the preferred matches", async () => {
    const searchFoods = async (params: FdcSearchParams): Promise<FdcSearchResult> => {
      if (params.dataType === "Branded") return brandedFixture;
      return foundationFixture;
    };

    const result = await findFood(searchFoods, "cheddar cheese", { includeBranded: true });

    assert.equal(result.best!.fdcId, 328637, "Foundation match still wins the #1 slot");
    assert.equal(result.usedBranded, true);
    // The Foundation fixture alone has 10 distinct cheeses, so alternates
    // 1-3 (the 3-alternate cap) are already filled by Foundation results —
    // the deduped Branded entry (10 identical "CHEDDAR CHEESE" rows -> 1) is
    // appended after them and doesn't displace a preferred-type alternate.
    assert.ok(result.alternates.every((f) => f.dataType === "Foundation"));
    // But it IS present in the underlying merged/deduped list before the
    // 3-alternate truncation — confirm via dedupeByDescription directly on
    // the same merged input findFood would have built.
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

  test("Foundation outranks a higher-relevance Survey entry in combined-type results (SYNTHETIC: regression for live cheddar Survey-first, 2026-07-03 — FDC relevance ranking put Survey 2705709 above Foundation 328637)", async () => {
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
    // Survey entry survives as an alternate (dedupe is case-insensitive on
    // description, so "Cheese, Cheddar" (Survey) collapses into the Foundation
    // best match) — the SR Legacy cheshire remains.
    assert.ok(result.text.includes("Cheese, cheshire"));
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
