/**
 * Module: dictionary-foods-engineering-report.ts self-tests
 * Purpose: Proves the engineering-report generator's own machinery, fully
 *   offline (no live FDC call, no FDC_API_KEY/.env, no dependency on
 *   recipe-app's git history — loadPinnedDictionary's git-show path is
 *   exercised only by main()/a manual dry run, never by this suite). Covers
 *   the jump-1778 P4 DONE WHEN list:
 *     1. Nutrition-deviation math (computeMacroDeviation/
 *        computeNutritionDeviation): a hand-computed known deviation,
 *        uncomputable when either side is missing (never a fabricated 0),
 *        the both-zero convention, and a PARTIAL case (some macros
 *        computable, others not) staying computable overall.
 *     2. Dictionary-side nutrition extraction (extractEnergyKcal/
 *        extractGrams/buildCandidateNutrition): Atwater-preferred energy,
 *        kJ->kcal conversion, missing data.
 *     3. buildCandidateNutritionIndex: merges across dict entries sharing an
 *        fdc_id, first-non-missing-per-macro wins, decided independently
 *        per macro.
 *     4. find_food-side extraction (extractFindFoodNutrition): matches by
 *        nutrientNumber (string) OR nutrientId (number), via the real
 *        search-result nutrient shape.
 *     5. classifyBucket: taxonomy status -> bucket mapping, incl. the
 *        disagreement-vs-error framing (miss maps to "disagreement", never
 *        "error"; refusal is its own bucket, not folded into disagreement).
 *     6. buildEngineeringReport: determinism (identical input -> byte-
 *        identical JSON twice), disagreement-queue ranking order
 *        (descending by deviation, uncomputable last, ties broken by
 *        query name), summary counts/rates, error-class groupings.
 *     7. computeCaseRecords: end-to-end wiring against a small synthetic
 *        fixture + cache + dictionary (hit/miss/near/refusal/branded-
 *        fallback cases), proving nutritionDeviation attaches correctly and
 *        uncached/error rows are marked "unscored" with no fabricated
 *        deviation.
 *     8. loadPinnedDictionary: local-file override path (offline).
 *     9. Recording-path wiring (jump-1778 P4 DONE WHEN): resolveFixtureBinding
 *        ('dictionary-foods') resolves + the replay runner (eval/run.js's
 *        runEval) accepts the REAL 585-case fixture + its own (currently
 *        empty) cache without throwing and without any live call — so a CoS
 *        operator can run --live to populate it later. This pass performs NO
 *        live call.
 *
 * Dependencies: node:test, node:assert/strict, node:fs, node:os, node:path,
 *   ./dictionary-foods-engineering-report.js (module under test), ../run.js
 *   (resolveFixtureBinding/runEval — read-only reuse), ../lib/fixture.js
 *   (loadFixture, read-only reuse)
 * State: Uses node:fs temp files (os.tmpdir()) for the local-dictionary-
 *   override test — never writes to the committed eval/fixtures/eval/cache/
 *   eval/reports/. The recording-path-wiring test reads the already-
 *   committed household-dictionary-foods-v3.json + its (not yet populated)
 *   cache file — no writes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { FdcFood, FdcSearchResult } from "../../src/fdc-client.js";
import {
  buildCandidateNutrition,
  buildCandidateNutritionIndex,
  buildEngineeringReport,
  classifyBucket,
  computeCaseRecords,
  computeMacroDeviation,
  computeNutritionDeviation,
  extractEnergyKcal,
  extractFindFoodNutrition,
  extractGrams,
  loadPinnedDictionary,
  renderMarkdown,
  type CaseRecord,
  type PinnedDictionary,
} from "./dictionary-foods-engineering-report.js";
import { loadFixture, type EvalCase, type EvalFixture } from "../lib/fixture.js";
import { buildCacheKey } from "../lib/cache.js";
import { resolveFixtureBinding, runEval } from "../run.js";

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "fdc-mcp-dfreport-test-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 1. Nutrition-deviation math ───────────────────────────────────────────

describe("computeMacroDeviation", () => {
  test("hand-computed known deviation: candidate=100, findFood=200 -> |100|/max(100,200)*100 = 50%", () => {
    const dev = computeMacroDeviation(100, 200);
    assert.equal(dev.candidate, 100);
    assert.equal(dev.findFood, 200);
    assert.equal(dev.percentDiff, 50);
  });

  test("identical values -> 0%", () => {
    assert.equal(computeMacroDeviation(42, 42).percentDiff, 0);
  });

  test("both zero -> 0% (not NaN/Infinity)", () => {
    const dev = computeMacroDeviation(0, 0);
    assert.equal(dev.percentDiff, 0);
  });

  test("one side zero, other positive -> 100% (the max of the bounded [0,100] scale)", () => {
    assert.equal(computeMacroDeviation(0, 5).percentDiff, 100);
    assert.equal(computeMacroDeviation(5, 0).percentDiff, 100);
  });

  test("candidate undefined -> uncomputable (null), never a fabricated 0", () => {
    const dev = computeMacroDeviation(undefined, 200);
    assert.equal(dev.candidate, null);
    assert.equal(dev.findFood, 200);
    assert.equal(dev.percentDiff, null);
  });

  test("findFood undefined -> uncomputable (null)", () => {
    const dev = computeMacroDeviation(100, undefined);
    assert.equal(dev.findFood, null);
    assert.equal(dev.percentDiff, null);
  });

  test("both undefined -> uncomputable (null)", () => {
    const dev = computeMacroDeviation(undefined, undefined);
    assert.equal(dev.candidate, null);
    assert.equal(dev.findFood, null);
    assert.equal(dev.percentDiff, null);
  });
});

describe("computeNutritionDeviation", () => {
  test("hand-computed mean across all 4 computable macros", () => {
    // energy 100 vs 200 -> 50%; protein 10 vs 10 -> 0%; fat 0 vs 0 -> 0%; carb 20 vs 0 -> 100%.
    // mean = (50+0+0+100)/4 = 37.5%.
    const dev = computeNutritionDeviation(
      { energyKcal: 100, proteinG: 10, fatG: 0, carbG: 20 },
      { energyKcal: 200, proteinG: 10, fatG: 0, carbG: 0 }
    );
    assert.equal(dev.energy.percentDiff, 50);
    assert.equal(dev.protein.percentDiff, 0);
    assert.equal(dev.fat.percentDiff, 0);
    assert.equal(dev.carb.percentDiff, 100);
    assert.equal(dev.meanAbsPercentDiff, 37.5);
    assert.equal(dev.computableMacroCount, 4);
    assert.equal(dev.uncomputable, false);
  });

  test("zero computable macros (candidate side entirely empty) -> case-level uncomputable, never silently 0", () => {
    const dev = computeNutritionDeviation({}, { energyKcal: 100, proteinG: 10, fatG: 5, carbG: 20 });
    assert.equal(dev.energy.percentDiff, null);
    assert.equal(dev.protein.percentDiff, null);
    assert.equal(dev.fat.percentDiff, null);
    assert.equal(dev.carb.percentDiff, null);
    assert.equal(dev.meanAbsPercentDiff, null);
    assert.equal(dev.computableMacroCount, 0);
    assert.equal(dev.uncomputable, true);
  });

  test("PARTIAL case: some macros computable, others not — overall stays computable, per-macro nulls preserved", () => {
    // candidate has protein+fat only; findFood has all 4 -> energy/carb null per-macro, protein/fat computable.
    const dev = computeNutritionDeviation({ proteinG: 10, fatG: 10 }, { energyKcal: 100, proteinG: 20, fatG: 10, carbG: 20 });
    assert.equal(dev.energy.percentDiff, null, "energy uncomputable per-macro (candidate side missing)");
    assert.equal(dev.carb.percentDiff, null, "carb uncomputable per-macro (candidate side missing)");
    assert.equal(dev.protein.percentDiff, 50, "protein computable: |10-20|/max(10,20)*100 = 50%");
    assert.equal(dev.fat.percentDiff, 0, "fat computable: identical");
    assert.equal(dev.computableMacroCount, 2);
    assert.equal(dev.meanAbsPercentDiff, 25, "mean of the 2 computable macros only: (50+0)/2 = 25%");
    assert.equal(dev.uncomputable, false, "case overall is NOT uncomputable — at least one macro computed");
  });
});

// ─── 2. Dictionary-side nutrition extraction ───────────────────────────────

describe("extractEnergyKcal", () => {
  test("prefers 'Energy (Atwater General Factors)' (kcal) when present", () => {
    const kcal = extractEnergyKcal({
      "Energy (Atwater General Factors)": { amount: 150, unit: "kcal" },
      Energy: { amount: 9999, unit: "kJ" },
    });
    assert.equal(kcal, 150, "Atwater must win even when a bare Energy key is also present");
  });

  test("falls back to 'Energy' in kcal used verbatim", () => {
    assert.equal(extractEnergyKcal({ Energy: { amount: 200, unit: "kcal" } }), 200);
  });

  test("falls back to 'Energy' in kJ, converted (divide by 4.184)", () => {
    const kcal = extractEnergyKcal({ Energy: { amount: 418.4, unit: "kJ" } });
    assert.ok(kcal !== undefined);
    assert.ok(Math.abs((kcal as number) - 100) < 1e-9, `expected ~100 kcal, got ${kcal}`);
  });

  test("neither key present -> undefined", () => {
    assert.equal(extractEnergyKcal({ Protein: { amount: 5, unit: "g" } }), undefined);
    assert.equal(extractEnergyKcal(undefined), undefined);
  });
});

describe("extractGrams", () => {
  test("reads the named key's amount verbatim", () => {
    assert.equal(extractGrams({ Protein: { amount: 22.5, unit: "g" } }, "Protein"), 22.5);
  });

  test("missing key -> undefined", () => {
    assert.equal(extractGrams({ Protein: { amount: 22.5, unit: "g" } }, "Total lipid (fat)"), undefined);
    assert.equal(extractGrams(undefined, "Protein"), undefined);
  });
});

describe("buildCandidateNutrition", () => {
  test("assembles all 4 macros from a nutrition block", () => {
    const cn = buildCandidateNutrition({
      "Energy (Atwater General Factors)": { amount: 106.034, unit: "kcal" },
      Protein: { amount: 22.525, unit: "g" },
      "Total lipid (fat)": { amount: 1.934, unit: "g" },
      "Carbohydrate, by difference": { amount: 0, unit: "g" },
    });
    assert.equal(cn.energyKcal, 106.034);
    assert.equal(cn.proteinG, 22.525);
    assert.equal(cn.fatG, 1.934);
    assert.equal(cn.carbG, 0);
  });
});

// ─── 3. buildCandidateNutritionIndex — merge across shared fdc_id ─────────

describe("buildCandidateNutritionIndex", () => {
  test("merges two entries sharing an fdc_id: first-non-missing-per-macro wins, decided independently per macro", () => {
    const dict: PinnedDictionary = {
      "entry a": {
        product_name: "Thing A",
        fdc_ref: { fdc_id: "5000", data_type: "Foundation" },
        nutrition: { Protein: { amount: 10, unit: "g" } },
      },
      "entry b": {
        product_name: "Thing B",
        fdc_ref: { fdc_id: "5000", data_type: "Foundation" },
        // Protein here must be IGNORED (entry a already provided it) — fat is NEW (fills the gap).
        nutrition: { Protein: { amount: 999, unit: "g" }, "Total lipid (fat)": { amount: 5, unit: "g" } },
      },
    };
    const index = buildCandidateNutritionIndex(dict);
    const merged = index.get("5000");
    assert.ok(merged);
    assert.equal(merged?.proteinG, 10, "entry a's protein wins (first non-missing, on-disk order)");
    assert.equal(merged?.fatG, 5, "entry b fills the fat gap entry a never provided");
  });

  test("entries with no fdc_ref/fdc_id are skipped", () => {
    const dict: PinnedDictionary = {
      "no ref": { product_name: "No Ref Thing" },
      "empty id": { product_name: "Empty Id Thing", fdc_ref: { fdc_id: "" } },
    };
    const index = buildCandidateNutritionIndex(dict);
    assert.equal(index.size, 0);
  });
});

// ─── 4. find_food-side extraction ──────────────────────────────────────────

describe("extractFindFoodNutrition", () => {
  test("matches by nutrientNumber (string) — the real search-result shape", () => {
    const food: FdcFood = {
      fdcId: 1,
      description: "Test Food",
      foodNutrients: [
        { nutrientId: 1008, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value: 298 },
        { nutrientId: 1003, nutrientName: "Protein", nutrientNumber: "203", unitName: "G", value: 31.84 },
        { nutrientId: 1004, nutrientName: "Total lipid (fat)", nutrientNumber: "204", unitName: "G", value: 4.01 },
        { nutrientId: 1005, nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", unitName: "G", value: 52.39 },
      ],
    };
    const cn = extractFindFoodNutrition(food);
    assert.equal(cn.energyKcal, 298);
    assert.equal(cn.proteinG, 31.84);
    assert.equal(cn.fatG, 4.01);
    assert.equal(cn.carbG, 52.39);
  });

  test("food undefined (refusal — no best match) -> everything undefined", () => {
    const cn = extractFindFoodNutrition(undefined);
    assert.equal(cn.energyKcal, undefined);
    assert.equal(cn.proteinG, undefined);
    assert.equal(cn.fatG, undefined);
    assert.equal(cn.carbG, undefined);
  });

  test("no matching nutrients present -> undefined per macro, not a crash", () => {
    const food: FdcFood = { fdcId: 1, description: "Sparse", foodNutrients: [{ nutrientId: 601, nutrientName: "Cholesterol", nutrientNumber: "601", value: 10 }] };
    const cn = extractFindFoodNutrition(food);
    assert.equal(cn.energyKcal, undefined);
    assert.equal(cn.proteinG, undefined);
  });
});

// ─── 5. classifyBucket — disagreement-vs-error framing ─────────────────────

describe("classifyBucket", () => {
  test("hit -> hit", () => assert.equal(classifyBucket("hit"), "hit"));
  test("near and near_branded both -> near", () => {
    assert.equal(classifyBucket("near"), "near");
    assert.equal(classifyBucket("near_branded"), "near");
  });
  test("miss -> disagreement (a JUDGMENT flag, never labeled 'error')", () => {
    assert.equal(classifyBucket("miss"), "disagreement");
  });
  test("confident_wrong -> disagreement (negative-case analogue of miss)", () => {
    assert.equal(classifyBucket("confident_wrong"), "disagreement");
  });
  test("labeled_branded_fallback -> branded_fallback", () => {
    assert.equal(classifyBucket("labeled_branded_fallback"), "branded_fallback");
  });
  test("refusal -> refusal (its own bucket, never folded into disagreement)", () => {
    assert.equal(classifyBucket("refusal"), "refusal");
  });
  test("uncached and error both -> unscored", () => {
    assert.equal(classifyBucket("uncached"), "unscored");
    assert.equal(classifyBucket("error"), "unscored");
  });
});

// ─── 6. buildEngineeringReport — determinism, ranking, summary, groupings ──

function makeFixture(caseNames: string[]): EvalFixture {
  return {
    provenance: { fixtureId: "test-fixture", counts: { positive: caseNames.length, negative: 0, total: caseNames.length } } as unknown as EvalFixture["provenance"],
    cases: [],
    excluded: [{ name: "excluded-thing", reason: "no fdc_ref", occurrences: 0, packs: {} }],
  };
}

function makeRecord(overrides: Partial<CaseRecord>): CaseRecord {
  return {
    name: "unnamed",
    kind: "positive",
    status: "hit",
    bucket: "hit",
    ...overrides,
  };
}

describe("buildEngineeringReport", () => {
  test("determinism: identical input produces byte-identical JSON across two calls", () => {
    const fixture = makeFixture(["a", "b"]);
    const records: CaseRecord[] = [
      makeRecord({ name: "a", status: "hit", bucket: "hit" }),
      makeRecord({
        name: "b",
        status: "miss",
        bucket: "disagreement",
        expected: { fdcId: 100, description: "Dictionary B", dataType: "Foundation" },
        findFoodPick: { fdcId: 200, description: "FindFood B", dataType: "Foundation" },
        nutritionDeviation: computeNutritionDeviation({ energyKcal: 100 }, { energyKcal: 150 }),
        cooked: true,
        occurrences: 2,
      }),
    ];
    const r1 = buildEngineeringReport(fixture, records, "test-source");
    const r2 = buildEngineeringReport(fixture, records, "test-source");
    assert.equal(JSON.stringify(r1), JSON.stringify(r2), "identical input must produce byte-identical JSON");
  });

  test("summary buckets/rates: hand-computed against a small mixed set", () => {
    const fixture = makeFixture([]);
    const records: CaseRecord[] = [
      makeRecord({ name: "h1", status: "hit", bucket: "hit" }),
      makeRecord({ name: "h2", status: "hit", bucket: "hit" }),
      makeRecord({ name: "n1", status: "near", bucket: "near" }),
      makeRecord({ name: "d1", status: "miss", bucket: "disagreement" }),
      makeRecord({ name: "r1", status: "refusal", bucket: "refusal" }),
      makeRecord({ name: "u1", status: "uncached", bucket: "unscored" }),
      makeRecord({ name: "e1", status: "error", bucket: "unscored", errorMessage: "boom" }),
    ];
    const report = buildEngineeringReport(fixture, records, "src");
    assert.equal(report.summary.totalCases, 7);
    assert.equal(report.summary.scored, 5, "7 total - 1 uncached - 1 error = 5 scored");
    assert.deepEqual(report.summary.unscored, { uncached: 1, error: 1 });
    assert.deepEqual(report.summary.buckets, { hit: 2, near: 1, disagreement: 1, refusal: 1, brandedFallback: 0 });
    assert.equal(report.summary.rates.hitPct, (2 / 5) * 100);
    assert.equal(report.summary.rates.nearPct, (1 / 5) * 100);
    assert.equal(report.summary.rates.disagreementPct, (1 / 5) * 100);
    assert.equal(report.summary.rates.refusalPct, (1 / 5) * 100);
    assert.equal(report.summary.disagreementQueueTotal, 2, "near + disagreement (branded_fallback=0) = 2; refusal and hit excluded");
    assert.equal(report.summary.excludedCount, 1, "fixture.excluded pass-through");
  });

  test("scored===0 -> rates are 0, never NaN", () => {
    const fixture = makeFixture([]);
    const records: CaseRecord[] = [makeRecord({ name: "u1", status: "uncached", bucket: "unscored" })];
    const report = buildEngineeringReport(fixture, records, "src");
    assert.equal(report.summary.scored, 0);
    for (const v of Object.values(report.summary.rates)) assert.equal(v, 0);
  });

  test("disagreement queue: sorted by nutrition deviation DESC, uncomputable sorts LAST, ties broken by query name ASC", () => {
    const fixture = makeFixture([]);
    const mk = (name: string, meanAbsPercentDiff: number | null, fdcId: number): CaseRecord =>
      makeRecord({
        name,
        status: "miss",
        bucket: "disagreement",
        expected: { fdcId, description: `Dict ${name}`, dataType: "Foundation" },
        findFoodPick: { fdcId: fdcId + 1000, description: `Found ${name}`, dataType: "Foundation" },
        nutritionDeviation: {
          energy: { candidate: null, findFood: null, percentDiff: meanAbsPercentDiff },
          protein: { candidate: null, findFood: null, percentDiff: null },
          fat: { candidate: null, findFood: null, percentDiff: null },
          carb: { candidate: null, findFood: null, percentDiff: null },
          meanAbsPercentDiff,
          computableMacroCount: meanAbsPercentDiff === null ? 0 : 1,
          uncomputable: meanAbsPercentDiff === null,
        },
      });
    const records = [
      mk("zzz-low", 10, 1),
      mk("some-uncomputable", null, 2),
      mk("tie-b", 50, 3),
      mk("tie-a", 50, 4),
      mk("aaa-high", 90, 5),
    ];
    const report = buildEngineeringReport(fixture, records, "src");
    const order = report.disagreementQueue.map((r) => r.query);
    assert.deepEqual(order, ["aaa-high", "tie-a", "tie-b", "zzz-low", "some-uncomputable"], "90 > tie(50,50 broken by name) > 10 > null(last)");
  });

  test("error-class groupings: by outcome status (incl. refusal), by find_food pick data type, by deviation bucket, by cooked/uncooked", () => {
    const fixture = makeFixture([]);
    const highDev = computeNutritionDeviation({ energyKcal: 0 }, { energyKcal: 100 }); // 100%, "high"
    const lowDev = computeNutritionDeviation({ energyKcal: 100 }, { energyKcal: 105 }); // ~4.76%, "low"
    const records: CaseRecord[] = [
      makeRecord({
        name: "near1",
        status: "near",
        bucket: "near",
        cooked: true,
        expected: { fdcId: 1, description: "d", dataType: "Foundation" },
        findFoodPick: { fdcId: 2, description: "f", dataType: "Foundation" },
        nutritionDeviation: lowDev,
      }),
      makeRecord({
        name: "miss1",
        status: "miss",
        bucket: "disagreement",
        cooked: false,
        expected: { fdcId: 3, description: "d", dataType: "SR Legacy" },
        findFoodPick: { fdcId: 4, description: "f", dataType: "Branded" },
        nutritionDeviation: highDev,
      }),
      makeRecord({ name: "ref1", status: "refusal", bucket: "refusal" }),
    ];
    const report = buildEngineeringReport(fixture, records, "src");
    assert.deepEqual(report.errorClassGroupings.byOutcomeStatus, { near: 1, miss: 1, refusal: 1 });
    assert.deepEqual(report.errorClassGroupings.byFindFoodPickDataType, { Foundation: 1, Branded: 1 });
    assert.deepEqual(report.errorClassGroupings.byNutritionDeviationBucket, { high: 1, low: 1, uncomputable: 0 });
    assert.deepEqual(report.errorClassGroupings.byCookedStatus, { cooked: 1, uncooked: 1, unknown: 0 });
  });

  test("renderMarkdown produces a non-empty string covering all 3 report parts, without throwing on an empty disagreement queue", () => {
    const fixture = makeFixture([]);
    const report = buildEngineeringReport(fixture, [makeRecord({ name: "onlyhit", status: "hit", bucket: "hit" })], "src");
    const md = renderMarkdown(report);
    assert.ok(md.includes("## Summary"));
    assert.ok(md.includes("## Disagreement Queue"));
    assert.ok(md.includes("## Error-Class Groupings"));
    assert.ok(md.includes(report.reportLabel), "the ENGINEERING PROXY label must appear in the human-readable output");
    assert.ok(!md.includes("undefined"), "no stray undefined leaking into rendered text");
  });
});

// ─── 7. computeCaseRecords — end-to-end wiring against a synthetic fixture ─

function preferredKey(name: string): string {
  return buildCacheKey({ query: name, dataType: ["Foundation", "SR Legacy", "Survey (FNDDS)"], pageSize: 10 });
}
function brandedKey(name: string): string {
  return buildCacheKey({ query: name, dataType: "Branded", pageSize: 10 });
}

describe("computeCaseRecords", () => {
  test("wires hit / miss(disagreement) / near / refusal / branded-fallback end-to-end, with nutrition deviation attached where expected", async () => {
    await withTempDir(async (dir) => {
      const cachePath = path.join(dir, "cache.json");

      const cases: EvalCase[] = [
        { name: "dfreporthit", kind: "positive", expected: { fdcId: 9001, description: "Dfreporthit", dataType: "Foundation" }, cooked: true, occurrences: 5 },
        { name: "dfreportmiss", kind: "positive", expected: { fdcId: 9002, description: "Dfreportmiss Expected", dataType: "Foundation" }, cooked: false, occurrences: 0 },
        { name: "dfreportnear", kind: "positive", expected: { fdcId: 9003, description: "Dfreportnear Expected", dataType: "Foundation" }, cooked: true, occurrences: 1 },
        { name: "dfreportrefusal", kind: "positive", expected: { fdcId: 9004, description: "Dfreportrefusal Expected", dataType: "Foundation" }, cooked: true, occurrences: 2 },
        { name: "dfreportbranded", kind: "positive", expected: { fdcId: 9005, description: "Dfreportbranded Expected", dataType: "Foundation" }, cooked: false, occurrences: 0 },
      ];

      const energyNutrient = (value: number) => [{ nutrientId: 1008, nutrientName: "Energy", nutrientNumber: "208", unitName: "KCAL", value }];

      const cache: Record<string, unknown> = {};
      // hit: preferred search returns the SAME fdcId as expected.
      cache[preferredKey("dfreporthit")] = { totalHits: 1, foods: [{ fdcId: 9001, description: "Dfreporthit", dataType: "Foundation", foodNutrients: energyNutrient(100) }] };
      // miss(disagreement): preferred search returns a DIFFERENT fdcId, description still passes the relevance floor (contains the query token).
      cache[preferredKey("dfreportmiss")] = { totalHits: 1, foods: [{ fdcId: 9099, description: "Dfreportmiss Snack", dataType: "Foundation", foodNutrients: energyNutrient(200) }] };
      // near: two results, the SECOND (alternate) matches expected.fdcId; best is the first (non-matching).
      cache[preferredKey("dfreportnear")] = {
        totalHits: 2,
        foods: [
          { fdcId: 9199, description: "Dfreportnear Alt", dataType: "Foundation", foodNutrients: energyNutrient(50) },
          { fdcId: 9003, description: "Dfreportnear Expected", dataType: "Foundation", foodNutrients: energyNutrient(60) },
        ],
      };
      // refusal: empty everywhere (preferred AND Branded).
      cache[preferredKey("dfreportrefusal")] = { totalHits: 0, foods: [] };
      cache[brandedKey("dfreportrefusal")] = { totalHits: 0, foods: [] };
      // branded-fallback: preferred empty, Branded returns a non-matching food.
      cache[preferredKey("dfreportbranded")] = { totalHits: 0, foods: [] };
      cache[brandedKey("dfreportbranded")] = { totalHits: 1, foods: [{ fdcId: 9299, description: "Dfreportbranded Snack", dataType: "Branded", foodNutrients: energyNutrient(300) }] };

      writeFileSync(cachePath, JSON.stringify(cache));

      const candidateIndex = new Map([
        ["9001", { energyKcal: 100 }],
        ["9002", { energyKcal: 100 }],
        ["9003", { energyKcal: 60 }],
        ["9004", { energyKcal: 100 }],
        ["9005", { energyKcal: 100 }],
      ]);

      const records = await computeCaseRecords(cases, cachePath, candidateIndex);
      assert.equal(records.length, 5);

      const byName = new Map(records.map((r) => [r.name, r]));

      const hit = byName.get("dfreporthit");
      assert.equal(hit?.status, "hit");
      assert.equal(hit?.bucket, "hit");
      assert.ok(hit?.nutritionDeviation, "nutritionDeviation is computed even for hits");
      assert.equal(hit?.nutritionDeviation?.meanAbsPercentDiff, 0, "hit's own candidate/find_food energy are both 100 -> 0% deviation");

      const miss = byName.get("dfreportmiss");
      assert.equal(miss?.status, "miss");
      assert.equal(miss?.bucket, "disagreement", "a miss is a DISAGREEMENT, never labeled 'error'");
      assert.equal(miss?.findFoodPick?.fdcId, 9099);
      assert.equal(miss?.nutritionDeviation?.meanAbsPercentDiff, 50, "|100-200|/max(100,200)*100 = 50%");

      const near = byName.get("dfreportnear");
      assert.equal(near?.status, "near");
      assert.equal(near?.bucket, "near");
      assert.equal(near?.findFoodPick?.fdcId, 9199, "best is the non-matching first result");

      const refusal = byName.get("dfreportrefusal");
      assert.equal(refusal?.status, "refusal");
      assert.equal(refusal?.bucket, "refusal");
      assert.equal(refusal?.findFoodPick, undefined, "no pick at all for a refusal");
      assert.equal(refusal?.nutritionDeviation?.uncomputable, true, "no find_food data at all -> uncomputable, not a fabricated 0");

      const branded = byName.get("dfreportbranded");
      assert.equal(branded?.status, "labeled_branded_fallback");
      assert.equal(branded?.bucket, "branded_fallback");
      assert.equal(branded?.findFoodPick?.dataType, "Branded");
    });
  });

  test("uncached case -> status 'uncached', bucket 'unscored', no nutritionDeviation (never attempted, not merely uncomputable)", async () => {
    await withTempDir(async (dir) => {
      const cachePath = path.join(dir, "cache.json");
      writeFileSync(cachePath, JSON.stringify({})); // empty cache -> every case misses
      const cases: EvalCase[] = [{ name: "dfreportuncached", kind: "positive", expected: { fdcId: 1, description: "d", dataType: "Foundation" } }];
      const records = await computeCaseRecords(cases, cachePath, new Map());
      assert.equal(records.length, 1);
      assert.equal(records[0].status, "uncached");
      assert.equal(records[0].bucket, "unscored");
      assert.equal(records[0].nutritionDeviation, undefined);
    });
  });

  test("malformed cache entry -> status 'error', bucket 'unscored'", async () => {
    await withTempDir(async (dir) => {
      const cachePath = path.join(dir, "cache.json");
      const cache: Record<string, unknown> = { [preferredKey("dfreporterr")]: { totalHits: 0 } }; // no `foods` array -> throws inside fromCacheEntry
      writeFileSync(cachePath, JSON.stringify(cache));
      const cases: EvalCase[] = [{ name: "dfreporterr", kind: "positive", expected: { fdcId: 1, description: "d", dataType: "Foundation" } }];
      const records = await computeCaseRecords(cases, cachePath, new Map());
      assert.equal(records[0].status, "error");
      assert.equal(records[0].bucket, "unscored");
      assert.ok(records[0].errorMessage);
    });
  });
});

// ─── 8. loadPinnedDictionary — local-file override (offline) ──────────────

describe("loadPinnedDictionary", () => {
  test("dictJsonPath reads a local file, bypassing git entirely", () => {
    void withTempDir((dir) => {
      const dictPath = path.join(dir, "dict.json");
      const dict: PinnedDictionary = { thing: { product_name: "Thing", fdc_ref: { fdc_id: "1" }, nutrition: { Protein: { amount: 1, unit: "g" } } } };
      writeFileSync(dictPath, JSON.stringify(dict));
      const result = loadPinnedDictionary({ dictJsonPath: dictPath });
      assert.deepEqual(result.dict, dict);
      assert.ok(result.description.includes(dictPath));
    });
  });
});

// ─── 9. Recording-path wiring (jump-1778 P4 DONE WHEN) ─────────────────────

describe("dictionary-foods recording path — verified wired, no live call performed", () => {
  test("resolveFixtureBinding('dictionary-foods') resolves, and the replay runner (eval/run.js runEval) accepts the REAL fixture + its own cache without throwing or making any live call", async () => {
    const binding = resolveFixtureBinding("dictionary-foods");
    assert.equal(binding.key, "dictionary-foods");
    assert.ok(binding.fixturePath.endsWith(path.join("fixtures", "household-dictionary-foods-v3.json")));
    assert.ok(binding.cachePath.endsWith(path.join("cache", "dictionary-foods-search-cache.json")));

    const fixture = loadFixture(binding.fixturePath);
    const outcome = await runEval({ live: false, fixturePath: binding.fixturePath, cachePath: binding.cachePath });

    assert.equal(outcome.rows.length, fixture.cases.length, "the runner scores/attempts every fixture case");
    assert.equal(outcome.searchCallCount, undefined, "replay mode makes ZERO network calls");
    assert.equal(outcome.recordedAt, undefined, "replay mode never sets recordedAt (nothing was recorded)");
    // Every row must land in a KNOWN status (uncached today, since no live
    // recording has been performed yet per the P3 registration note) — never
    // an unhandled throw escaping the runner.
    const knownStatuses = new Set(["hit", "near", "near_branded", "miss", "labeled_branded_fallback", "refusal", "uncached", "error"]);
    for (const row of outcome.rows) assert.ok(knownStatuses.has(row.status), `unexpected status "${row.status}"`);
  });

  test("computeCaseRecords (this module's own engine) also accepts the REAL fixture + its own cache without throwing, given an empty candidate index", async () => {
    const binding = resolveFixtureBinding("dictionary-foods");
    const fixture = loadFixture(binding.fixturePath);
    const records = await computeCaseRecords(fixture.cases, binding.cachePath, new Map());
    assert.equal(records.length, fixture.cases.length);
    for (const r of records) assert.ok(["hit", "near", "near_branded", "miss", "labeled_branded_fallback", "refusal", "uncached", "error"].includes(r.status));
  });
});
