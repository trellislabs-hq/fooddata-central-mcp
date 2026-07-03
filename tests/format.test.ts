/**
 * Module: format.test.ts
 * Purpose: Regression tests for src/format.ts. Captures the CURRENT (v1.0.0,
 *   pre-refactor) text output of the four original tools' formatters against
 *   a recorded fixture input, so the format.ts extraction (module-private ->
 *   exported module) cannot silently change what a stranger sees on
 *   search_foods/get_food/get_foods/list_foods.
 * Dependencies: node:test, node:assert, ../src/format.ts, ../src/fdc-client.ts
 * State: Uses recorded fixtures (cheddar-cheese.search-foundation.json,
 *   food-328637.detail-abridged.json). Snapshot strings below were captured
 *   by running these exact formatters against these exact fixtures BEFORE
 *   the format.ts extraction (identical logic, only the file/export
 *   boundary changed) — see the "Formatter regressions" section of the P1
 *   spec.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatFoodSummary, formatFoodDetail, formatKeyNutrients, formatError } from "../src/format.js";
import { FdcError, type FdcFood } from "../src/fdc-client.js";
import { loadFixture } from "./helpers/mock-fetch.js";

describe("formatFoodSummary() — search_foods / list_foods snapshot", () => {
  test("cheddar cheese (FDC 328637, Foundation) summary is unchanged", () => {
    const fixture = loadFixture("cheddar-cheese.search-foundation.json") as {
      foods: FdcFood[];
    };
    const food = fixture.foods.find((f) => f.fdcId === 328637);
    assert.ok(food, "fixture must contain FDC 328637");

    const summary = formatFoodSummary(food!);

    // Note: order follows the fixture's foodNutrients array order (not the
    // priority-list order), and both Energy entries (KCAL and kJ) appear
    // since dedup keys on nutrientNumber and FDC assigns them different
    // numbers (208 vs 268/957 depending on source) — this is existing
    // pre-refactor behavior, captured as-is per the byte-identical-output
    // requirement.
    assert.equal(
      summary,
      "FDC ID: 328637 | Name: Cheese, cheddar | Type: Foundation | Nutrients: Carbohydrate: 2.44 G | Energy: 408 KCAL | Protein: 23.3 G | Energy: 1710 kJ | Total lipid (fat): 34 G | Sodium, Na: 654 MG | Sugars, Total: 0.33 G"
    );
  });
});

describe("formatFoodDetail() — get_food / get_foods snapshot", () => {
  test("cheddar cheese abridged detail (FDC 328637) is unchanged", () => {
    const food = loadFixture("food-328637.detail-abridged.json") as FdcFood;

    const detail = formatFoodDetail(food);

    // Snapshot the stable header lines (full 105-nutrient body is verified
    // by count + spot lines below rather than a giant inline string).
    const lines = detail.split("\n");
    assert.equal(lines[0], "=== Cheese, cheddar ===");
    assert.equal(lines[1], "FDC ID: 328637");
    assert.equal(lines[2], "Data Type: Foundation");
    assert.equal(lines[3], "");
    assert.equal(lines[4], "--- Nutrients ---");

    // Spot-check a known nutrient line survives formatting unchanged.
    assert.ok(lines.includes("  Energy: 408 KCAL"));
    assert.ok(lines.includes("  Protein: 23.3 G"));

    // Total line count: 5 header/section lines + all nutrient lines from the
    // fixture (abridged detail has more entries than the search-response
    // shape used elsewhere — some nutrients lack a `value` and are skipped
    // by formatFoodDetail's `value !== undefined` guard).
    assert.equal(lines.length, 110);
  });
});

describe("formatKeyNutrients() — priority nutrient extraction snapshot", () => {
  test("cheddar cheese search-result nutrient shape (FDC 328637)", () => {
    const fixture = loadFixture("cheddar-cheese.search-foundation.json") as {
      foods: FdcFood[];
    };
    const food = fixture.foods.find((f) => f.fdcId === 328637);
    assert.ok(food);

    const summary = formatKeyNutrients(food!.foodNutrients);
    assert.equal(
      summary,
      "Carbohydrate: 2.44 G | Energy: 408 KCAL | Protein: 23.3 G | Energy: 1710 kJ | Total lipid (fat): 34 G | Sodium, Na: 654 MG | Sugars, Total: 0.33 G"
    );
  });

  test("empty/undefined nutrient list falls back to the no-data message", () => {
    assert.equal(formatKeyNutrients(undefined), "No nutrient data available");
    assert.equal(formatKeyNutrients([]), "No nutrient data available");
  });
});

describe("formatError()", () => {
  test("FdcError produces the specialized message format", () => {
    const err = new FdcError(404, "Not Found", "Food not found (HTTP 404).");
    assert.equal(formatError(err), "FDC API Error (404): Food not found (HTTP 404).");
  });

  test("generic Error produces the Error: prefix format", () => {
    assert.equal(formatError(new Error("boom")), "Error: boom");
  });

  test("non-Error thrown values get the unexpected-error fallback", () => {
    assert.equal(formatError("a string"), "Unexpected error: a string");
  });
});
