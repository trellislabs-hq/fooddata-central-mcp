/**
 * Module: dictionary-foods engineering report (CLI)
 * Purpose: ENGINEERING/PROCESS-DEVELOPMENT report over the 585-distinct-food
 *   household-dictionary-foods-v3 frame (see
 *   eval/scripts/assemble-dictionary-foods-fixture-v3.ts) — NOT the
 *   validation protocol. Scores every case on TWO axes and hands back a
 *   ranked triage artifact:
 *     1. IDENTITY TRIAGE — reuses eval/lib/scoring.ts's scoreCase() taxonomy
 *        (hit/near/near_branded/miss/labeled_branded_fallback/refusal)
 *        UNCHANGED, verbatim, against each case's expected.fdcId.
 *     2. NUTRITION DEVIATION — the % difference between find_food's
 *        best-match nutrient snapshot and the recipe-app dictionary
 *        candidate's OWN pinned per-100g nutrition (energy/protein/fat/carb),
 *        used to RANK disagreements by how much they'd actually move a
 *        recipe's computed nutrition if find_food's pick were used instead.
 *
 *   CRITICAL FRAMING (do not lose this reading this file in isolation):
 *   find_food resolves FDC identity INDEPENDENTLY — it never reads the
 *   recipe-app dictionary. Every fixture case's expected.fdcId is the
 *   DICTIONARY's own candidate identity (labelProvenance:
 *   "dictionary-candidate-unverified" on every one of them), not ground
 *   truth. So when find_food's pick differs from the dictionary candidate,
 *   that is a DISAGREEMENT needing human/LLM judgment — NOT a find_food
 *   error; find_food may well be the one that's right. See FRAME_NOTE below,
 *   which is baked into every emitted report so this framing travels with
 *   the artifact. This script NEVER emits a pass/fail, an acceptance
 *   verdict, or a "find_food accuracy" headline number — descriptive stats
 *   only, always labeled ENGINEERING PROXY.
 *
 * Major Sections:
 *   - CandidateNutrition / NutritionAmount / PinnedDictionary — the
 *     recipe-app dictionary-side nutrition shapes (per-100g, as pinned in
 *     data/ingredient-dictionary.base.json's own per-entry `nutrition`
 *     block)
 *   - extractEnergyKcal() / extractGrams() / buildCandidateNutrition() /
 *     buildCandidateNutritionIndex() — dictionary-side extraction. Indexed
 *     by fdc_id (a nutrition value is a property of the FDC FOOD, not of any
 *     one of the 1-15 dictionary entries that may share it) — when multiple
 *     entries share an fdc_id, the FIRST entry (in base.json's on-disk key
 *     order — deterministic, since the file is read at a pinned commit) that
 *     carries a value for a given macro wins, decided INDEPENDENTLY per
 *     macro so one entry's gap can be filled by another's data.
 *   - extractFindFoodNutrition() — find_food-side extraction from a cached
 *     FdcFood.foodNutrients (search-result nutrient shape only — find_food
 *     never makes a detail call, see src/find-food.ts's own header),
 *     matched by nutrientNumber (string "208"/"203"/"204"/"205") OR
 *     nutrientId (1008/1003/1004/1005), via src/format.ts's OWN exported
 *     resolveNutrient() (reused, not reimplemented).
 *   - computeMacroDeviation() / computeNutritionDeviation() — the deviation
 *     math. Per-macro % difference = |candidate - findFood| /
 *     max(|candidate|, |findFood|) * 100 — bounded to [0,100] for the
 *     non-negative macros this report covers, symmetric, and never divides
 *     by zero (both-zero reads as 0% agreement, not NaN/Infinity). A macro
 *     missing on EITHER side is `null` (never a fabricated 0); the
 *     case-level meanAbsPercentDiff averages only the macros both sides
 *     had, and is itself `null` (uncomputable:true) when NEITHER side had
 *     any of the 4.
 *   - loadPinnedDictionary() — reads recipe-app's base.json via `git show
 *     <commit>:<path>` (never the working tree — recipe-app is
 *     prod-maintained and growing), OR a local JSON file override
 *     (--dict-json / dictJsonPath) for fully offline test/dry-run use. Makes
 *     ZERO network calls either way, ZERO FDC API calls, needs no
 *     FDC_API_KEY / .env.
 *   - CaseRecord / classifyBucket() / computeCaseRecords() — the one
 *     ASYNC step: replays each fixture case's find_food call against the
 *     bound cache (eval/lib/cache.js + eval/lib/search-fn.js — REUSED, not a
 *     second cache format) and scores it with eval/lib/scoring.ts's
 *     scoreCase() (REUSED, not reimplemented) — but, unlike
 *     eval/run.ts's runEval(), keeps the full FindFoodResult around (not
 *     just scoreCase's summarized ActualFoodSummary) because nutrition
 *     deviation needs `best.foodNutrients`, which CaseResult never carries.
 *     classifyBucket() is the ONLY new mapping layer: hit/near(+near_branded)
 *     /disagreement(=miss)/branded_fallback(=labeled_branded_fallback)/
 *     refusal/unscored(uncached|error) — see METHODOLOGY_NOTE for the exact
 *     "disagreement" (singular bucket) vs "disagreements" (the broader
 *     DISAGREEMENT QUEUE population) distinction.
 *   - buildEngineeringReport() — the PURE aggregation core (no I/O, no
 *     Date.now/Math.random) — takes an already-computed CaseRecord[] and
 *     produces the 3-part report: SUMMARY, DISAGREEMENT QUEUE (sorted by
 *     nutrition deviation DESC, uncomputable sorts last, ties broken by
 *     query name), ERROR-CLASS GROUPINGS (by find_food pick data type; by
 *     outcome status incl. refusal; by high/low nutrition-deviation bucket;
 *     by cooked/uncooked). Deterministic: identical CaseRecord[] input
 *     always produces byte-identical JSON.
 *   - renderMarkdown() — human-readable mirror of the same 3 parts.
 *   - main() — CLI glue: resolves the "dictionary-foods" FIXTURE_REGISTRY
 *     binding (eval/run.js — REUSED), loads the pinned dictionary, runs
 *     computeCaseRecords + buildEngineeringReport, writes JSON + MD.
 *
 * Dependencies: node:child_process (git show, dictionary read only — never
 *   FDC), node:fs, node:path, node:url, ../../src/fdc-client.js (types),
 *   ../../src/find-food.js (findFood — UNMODIFIED), ../../src/format.js
 *   (resolveNutrient — UNMODIFIED, reused), ../lib/cache.js (loadCache),
 *   ../lib/fixture.js (loadFixture/validateFixtureSchema/types),
 *   ../lib/scoring.js (scoreCase/percentile/SCORED_STATUSES — REUSED),
 *   ../lib/search-fn.js (makeReplaySearchFn/CacheMissError), ../run.js
 *   (resolveFixtureBinding — REUSED, never reimplemented)
 * State: Reads the bound fixture + cache (read-only) and recipe-app's
 *   base.json via git show OR a local override (read-only, no writes to
 *   recipe-app, no working-tree reads). Writes exactly two files at the
 *   --out base path (default eval/reports/dictionary-foods-engineering-
 *   report.{json,md}, gitignored — generated artifacts are never committed).
 *   Never calls the live FDC API, never touches FDC_API_KEY/.env.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FdcFood, FdcNutrient } from "../../src/fdc-client.js";
import { findFood } from "../../src/find-food.js";
import { resolveNutrient } from "../../src/format.js";

import { loadCache } from "../lib/cache.js";
import { loadFixture, validateFixtureSchema, type EvalCase, type EvalFixture, type EvidenceClass, type PreferredDataType } from "../lib/fixture.js";
import { percentile, scoreCase, type CaseStatus } from "../lib/scoring.js";
import { CacheMissError, makeReplaySearchFn } from "../lib/search-fn.js";
import { resolveFixtureBinding } from "../run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── constants ──────────────────────────────────────────────────────────

const REPORT_LABEL = "ENGINEERING PROXY — NOT the validation protocol";

const FRAME_NOTE =
  "find_food resolves FDC identity INDEPENDENTLY of the recipe-app dictionary — it never reads the dictionary. " +
  "Each case's expected.fdcId is the DICTIONARY's own candidate identity (itself unverified — every case carries " +
  "labelProvenance: 'dictionary-candidate-unverified'), not ground truth. So when find_food returns an fdcId " +
  "different from the dictionary candidate, that is a DISAGREEMENT needing human/LLM judgment, NOT a find_food " +
  "error — find_food may well be the one that's right (e.g. returning a 'cooked' variant for a dictionary 'raw' " +
  "entry). Nutrition deviation is a TRIAGE SIGNAL ranking which disagreements most likely matter (a bigger " +
  "nutrient swing is more worth reviewing first) — it is NOT a correctness judgment. The actual acceptable / " +
  "not-acceptable verdict is a LATER, separate human/LLM-judge step; this report never renders one.";

const METHODOLOGY_NOTE =
  "summary.buckets.disagreement counts ONLY the 'miss' taxonomy status (a confident find_food pick that is not " +
  "near, not a Branded fallback, and the dictionary candidate is not exposed anywhere in the top 4). The " +
  "DISAGREEMENT QUEUE and the nutrition-deviation distribution both cover the BROADER union instead — " +
  "near + near_branded (bucket 'near') + miss (bucket 'disagreement') + labeled_branded_fallback (bucket " +
  "'brandedFallback') — every case where find_food returned a pick AND that pick's fdcId differs from the " +
  "dictionary candidate's fdcId. hit (agreement) and refusal (no pick to compare) are excluded from the queue: a " +
  "hit has nothing to disagree about, and a refusal has no find_food pick to line up against the dictionary " +
  "candidate. Per-macro nutrition deviation = |candidate - find_food| / max(|candidate|, |find_food|) * 100 (0% " +
  "identical, 100% one side is zero and the other positive — bounded [0,100], symmetric, never divides by zero); " +
  "the case-level meanAbsPercentDiff averages only the macros where BOTH sides had a value — a case with zero " +
  "computable macros is marked uncomputable, never silently 0.";

const KJ_PER_KCAL = 4.184;
const HIGH_DEVIATION_THRESHOLD_PCT = 50;

const DEFAULT_RECIPE_APP = "/Users/thomasstewart/Projects/recipe-app";
const FALLBACK_COMMIT = "7e681cb";
const FALLBACK_DICT_PATH = "data/ingredient-dictionary.base.json";

export const DEFAULT_REPORTS_DIR = path.join(__dirname, "..", "reports");
export const DEFAULT_OUT_BASE = path.join(DEFAULT_REPORTS_DIR, "dictionary-foods-engineering-report");

// ─── dictionary-side (recipe-app base.json) nutrition ──────────────────────

export interface NutritionAmount {
  amount: number;
  unit: string;
}
export type NutritionBlock = Record<string, NutritionAmount>;

/** Minimal shape read off a base.json entry — only the fields this report needs (not the full recipe-app DictEntry contract). */
export interface PinnedDictEntry {
  product_name?: string;
  fdc_ref?: { fdc_id?: string; data_type?: string };
  nutrition?: NutritionBlock;
}
export type PinnedDictionary = Record<string, PinnedDictEntry>;

/** Per-100g macro snapshot — undefined means "not derivable from this side's data", never a fabricated 0. */
export interface CandidateNutrition {
  energyKcal?: number;
  proteinG?: number;
  fatG?: number;
  carbG?: number;
}

function isKilojoules(unit: string | undefined): boolean {
  return typeof unit === "string" && unit.trim().toLowerCase() === "kj";
}

function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}

/**
 * base.json's per-entry `nutrition` block stores Energy under either
 * "Energy (Atwater General Factors)" (a computed macro-derived kcal value —
 * ALWAYS kcal on the pinned dictionary, 362/1738 entries) or the bare
 * "Energy" key (915/1738 in kJ, 157/1738 in kcal — FDC's raw nutrient list
 * literally has two DIFFERENT nutrients both named "Energy", one per unit;
 * which one survived under this single JS key depends on enrichment-time
 * ordering). Atwater is preferred when present (unambiguous unit); "Energy"
 * is the fallback, unit-converted when it says kJ.
 */
export function extractEnergyKcal(nutrition: NutritionBlock | undefined): number | undefined {
  if (!nutrition) return undefined;
  const atwater = nutrition["Energy (Atwater General Factors)"];
  if (atwater && typeof atwater.amount === "number") {
    return isKilojoules(atwater.unit) ? kjToKcal(atwater.amount) : atwater.amount;
  }
  const energy = nutrition["Energy"];
  if (energy && typeof energy.amount === "number") {
    return isKilojoules(energy.unit) ? kjToKcal(energy.amount) : energy.amount;
  }
  return undefined;
}

/** Protein / Total lipid (fat) / Carbohydrate, by difference — observed unit is always "g"/"G" on the pinned dictionary; used verbatim (no conversion). */
export function extractGrams(nutrition: NutritionBlock | undefined, key: string): number | undefined {
  const entry = nutrition?.[key];
  if (!entry || typeof entry.amount !== "number") return undefined;
  return entry.amount;
}

export function buildCandidateNutrition(nutrition: NutritionBlock | undefined): CandidateNutrition {
  return {
    energyKcal: extractEnergyKcal(nutrition),
    proteinG: extractGrams(nutrition, "Protein"),
    fatG: extractGrams(nutrition, "Total lipid (fat)"),
    carbG: extractGrams(nutrition, "Carbohydrate, by difference"),
  };
}

/**
 * Index candidate nutrition by fdc_id (string, matching base.json's own
 * fdc_ref.fdc_id representation) — nutrition is a property of the FDC FOOD,
 * not of any single one of the (possibly many) dictionary entries sharing
 * it. When multiple entries share an fdc_id, each macro is filled
 * independently by the FIRST entry (in base.json's on-disk key order —
 * Object.values() preserves JSON insertion order, which is fixed once the
 * file is read at a pinned commit, so this is fully deterministic) that
 * carries a value for THAT macro — a gap in one entry can be filled by a
 * different entry's data for a different macro. Verified against the
 * pinned dictionary (2026-07-19): zero of the 585 fdc_id groups have
 * genuinely conflicting nutrition across their member entries, so this rule
 * is a documented-but-currently-inert tie-break, not a live arbitration.
 */
export function buildCandidateNutritionIndex(dict: PinnedDictionary): Map<string, CandidateNutrition> {
  const index = new Map<string, CandidateNutrition>();
  for (const entry of Object.values(dict)) {
    const fdcId = entry.fdc_ref?.fdc_id;
    if (!fdcId) continue;
    const thisEntry = buildCandidateNutrition(entry.nutrition);
    const existing = index.get(fdcId) ?? {};
    index.set(fdcId, {
      energyKcal: existing.energyKcal ?? thisEntry.energyKcal,
      proteinG: existing.proteinG ?? thisEntry.proteinG,
      fatG: existing.fatG ?? thisEntry.fatG,
      carbG: existing.carbG ?? thisEntry.carbG,
    });
  }
  return index;
}

// ─── find_food-side nutrition (cached FdcFood.foodNutrients) ──────────────

/** nutrientNumber (search-result string field) and nutrientId (numeric) pairs for the 4 tracked macros — USDA standard. */
const MACRO_NUTRIENT_KEYS: Record<"energy" | "protein" | "fat" | "carb", { numbers: readonly string[]; ids: readonly number[] }> = {
  energy: { numbers: ["208"], ids: [1008] },
  protein: { numbers: ["203"], ids: [1003] },
  fat: { numbers: ["204"], ids: [1004] },
  carb: { numbers: ["205"], ids: [1005] },
};

/**
 * find_food never makes a detail call (search hits already embed
 * foodNutrients — see src/find-food.ts's own header), so every nutrient
 * object here is the SEARCH-RESULT shape (nutrientId/nutrientNumber/value) —
 * resolveNutrient() (src/format.ts, imported unmodified) normalizes it the
 * same way format.ts's own formatKeyNutrients() does. Matched by
 * nutrientNumber (string) OR nutrientId (number) so either representation
 * resolves the same macro. A kJ-unit guard mirrors the dictionary side's
 * defensive handling even though FDC's search-result "208" entry is
 * observed to always be KCAL — cheap insurance against a rare landmine.
 */
function findMacroValue(nutrients: FdcNutrient[] | undefined, spec: { numbers: readonly string[]; ids: readonly number[] }): number | undefined {
  if (!nutrients) return undefined;
  for (const n of nutrients) {
    const { id, number, value, unit } = resolveNutrient(n);
    if (value === undefined) continue;
    if (spec.numbers.includes(number) || (id !== undefined && spec.ids.includes(id))) {
      return isKilojoules(unit) ? kjToKcal(value) : value;
    }
  }
  return undefined;
}

export function extractFindFoodNutrition(food: FdcFood | undefined): CandidateNutrition {
  const nutrients = food?.foodNutrients;
  return {
    energyKcal: findMacroValue(nutrients, MACRO_NUTRIENT_KEYS.energy),
    proteinG: findMacroValue(nutrients, MACRO_NUTRIENT_KEYS.protein),
    fatG: findMacroValue(nutrients, MACRO_NUTRIENT_KEYS.fat),
    carbG: findMacroValue(nutrients, MACRO_NUTRIENT_KEYS.carb),
  };
}

// ─── deviation math ─────────────────────────────────────────────────────

export interface MacroDeviation {
  candidate: number | null;
  findFood: number | null;
  /** |candidate - findFood| / max(|candidate|,|findFood|) * 100. null when either side is null (never a fabricated 0). */
  percentDiff: number | null;
}

export interface NutritionDeviation {
  energy: MacroDeviation;
  protein: MacroDeviation;
  fat: MacroDeviation;
  carb: MacroDeviation;
  /** Mean of the macros that were computable on BOTH sides. null iff computableMacroCount === 0. */
  meanAbsPercentDiff: number | null;
  computableMacroCount: number;
  uncomputable: boolean;
}

/**
 * max-based (not candidate-based) percent difference: for non-negative
 * values, |a-b| <= max(a,b) always holds, so this is bounded to [0,100]%,
 * symmetric (order-independent), and never divides by zero — a
 * candidate-relative percent (|a-b|/a) would be undefined/infinite whenever
 * a macro is legitimately 0 (e.g. carbs for a pure fat/meat), which is
 * common enough in this corpus to make that formula unusable here.
 */
export function computeMacroDeviation(candidate: number | undefined, findFoodVal: number | undefined): MacroDeviation {
  if (candidate === undefined || findFoodVal === undefined) {
    return { candidate: candidate ?? null, findFood: findFoodVal ?? null, percentDiff: null };
  }
  const absDiff = Math.abs(candidate - findFoodVal);
  const maxVal = Math.max(Math.abs(candidate), Math.abs(findFoodVal));
  const percentDiff = maxVal === 0 ? 0 : (absDiff / maxVal) * 100;
  return { candidate, findFood: findFoodVal, percentDiff };
}

export function computeNutritionDeviation(candidate: CandidateNutrition, findFoodNutrition: CandidateNutrition): NutritionDeviation {
  const energy = computeMacroDeviation(candidate.energyKcal, findFoodNutrition.energyKcal);
  const protein = computeMacroDeviation(candidate.proteinG, findFoodNutrition.proteinG);
  const fat = computeMacroDeviation(candidate.fatG, findFoodNutrition.fatG);
  const carb = computeMacroDeviation(candidate.carbG, findFoodNutrition.carbG);

  const computable = [energy, protein, fat, carb].filter((m): m is MacroDeviation & { percentDiff: number } => m.percentDiff !== null);
  const meanAbsPercentDiff = computable.length > 0 ? computable.reduce((sum, m) => sum + m.percentDiff, 0) / computable.length : null;

  return {
    energy,
    protein,
    fat,
    carb,
    meanAbsPercentDiff,
    computableMacroCount: computable.length,
    uncomputable: meanAbsPercentDiff === null,
  };
}

// ─── dictionary load (git show, or a local override for offline/test use) ──

export interface DictionarySourceOptions {
  /** Local JSON file override — bypasses git entirely (offline/test use). */
  dictJsonPath?: string;
  recipeAppPath?: string;
  commit?: string;
  dictPath?: string;
}

export interface DictionarySourceResult {
  dict: PinnedDictionary;
  /** Human-readable provenance string for the report's meta block — how this dictionary snapshot was obtained. */
  description: string;
}

/**
 * Reads recipe-app's ingredient dictionary — via `git show <commit>:<path>`
 * (never the working tree, same discipline the fixture assemblers use), or
 * from a local JSON file when dictJsonPath is given (fully offline — the
 * ONLY path exercised by this module's own automated tests, per CONSTRAINTS:
 * build+test entirely offline). Makes no FDC/network call either way.
 */
export function loadPinnedDictionary(opts: DictionarySourceOptions = {}): DictionarySourceResult {
  if (opts.dictJsonPath) {
    const raw = readFileSync(opts.dictJsonPath, "utf-8");
    return { dict: JSON.parse(raw) as PinnedDictionary, description: `local file: ${opts.dictJsonPath}` };
  }
  const recipeAppPath = opts.recipeAppPath ?? DEFAULT_RECIPE_APP;
  const commit = opts.commit ?? FALLBACK_COMMIT;
  const dictPath = opts.dictPath ?? FALLBACK_DICT_PATH;
  const raw = execFileSync("git", ["-C", recipeAppPath, "show", `${commit}:${dictPath}`], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { dict: JSON.parse(raw) as PinnedDictionary, description: `git show ${commit}:${dictPath} (recipe-app at ${recipeAppPath})` };
}

// ─── case records (identity triage + nutrition deviation, per case) ───────

export type Bucket = "hit" | "near" | "disagreement" | "branded_fallback" | "refusal" | "unscored";

/**
 * Coarse triage bucket for the SUMMARY's 5-way breakdown. `status` (the raw
 * scoreCase() taxonomy value) is always preserved verbatim alongside this on
 * every CaseRecord — see METHODOLOGY_NOTE for exactly which raw statuses
 * fold into which bucket, and why "disagreement" (this bucket, == "miss"
 * only) is narrower than the broader disagreement-QUEUE population.
 */
export function classifyBucket(status: CaseStatus): Bucket {
  switch (status) {
    case "hit":
      return "hit";
    case "near":
    case "near_branded":
      return "near";
    case "miss":
    case "confident_wrong":
      return "disagreement";
    case "labeled_branded_fallback":
      return "branded_fallback";
    case "refusal":
      return "refusal";
    case "uncached":
    case "error":
      return "unscored";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export interface CaseRecord {
  name: string;
  kind: "positive" | "negative";
  status: CaseStatus | "uncached" | "error";
  bucket: Bucket;
  /** The dictionary's own candidate identity for this case (undefined for a negative case, which carries none). */
  expected?: { fdcId: number; description: string; dataType: PreferredDataType };
  cooked?: boolean;
  occurrences?: number;
  evidenceClass?: EvidenceClass;
  /** find_food's best match, if any cleared the relevance floor. Undefined for refusal AND for unscored (uncached/error) rows. */
  findFoodPick?: { fdcId: number; description: string; dataType?: string };
  /** Computed for every SCORED case (hit through refusal) — undefined only for unscored (uncached/error) rows, which produced no FindFoodResult at all to compute against. */
  nutritionDeviation?: NutritionDeviation;
  errorMessage?: string;
}

/**
 * The one async step: replays every case's find_food call against the bound
 * cache (eval/lib/cache.js's loadCache + eval/lib/search-fn.js's
 * makeReplaySearchFn — REUSED verbatim, never a second cache format) and
 * scores it with eval/lib/scoring.ts's scoreCase() (REUSED verbatim, never
 * reimplemented). Unlike eval/run.ts's runEval(), this keeps the FULL
 * FindFoodResult (not just scoreCase's summarized ActualFoodSummary) because
 * nutrition deviation needs best.foodNutrients, which CaseResult never
 * carries. Sorted by case name first (byte-stable ordering, mirrors
 * eval/run.ts's own runEval()) so output order never depends on the
 * fixture's on-disk case order or cache Map iteration order.
 */
export async function computeCaseRecords(
  cases: EvalCase[],
  cachePath: string,
  candidateIndex: Map<string, CandidateNutrition>
): Promise<CaseRecord[]> {
  const cache = loadCache(cachePath);
  const replay = makeReplaySearchFn(cache);
  const sorted = [...cases].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const records: CaseRecord[] = [];
  for (const caseDef of sorted) {
    const expected = caseDef.kind === "positive" ? caseDef.expected : undefined;
    const base = {
      name: caseDef.name,
      kind: caseDef.kind,
      expected,
      cooked: caseDef.cooked,
      occurrences: caseDef.occurrences,
      evidenceClass: caseDef.evidenceClass,
    };

    try {
      const result = await findFood(replay, caseDef.name, { includeBranded: false });
      const scored = scoreCase(caseDef, result);
      const bucket = classifyBucket(scored.status);
      const findFoodPick = result.best ? { fdcId: result.best.fdcId, description: result.best.description, dataType: result.best.dataType } : undefined;

      const candidateNutrition = expected ? candidateIndex.get(String(expected.fdcId)) ?? {} : {};
      const findFoodNutrition = extractFindFoodNutrition(result.best);
      const nutritionDeviation = computeNutritionDeviation(candidateNutrition, findFoodNutrition);

      records.push({ ...base, status: scored.status, bucket, findFoodPick, nutritionDeviation });
    } catch (err) {
      if (err instanceof CacheMissError) {
        records.push({ ...base, status: "uncached", bucket: "unscored" });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        records.push({ ...base, status: "error", bucket: "unscored", errorMessage: message });
      }
    }
  }
  return records;
}

// ─── buildEngineeringReport — the pure aggregation core ────────────────────

export interface NutritionDeviationDistribution {
  n: number;
  computableN: number;
  uncomputableN: number;
  uncomputablePct: number;
  medianPct: number | null;
  p90Pct: number | null;
}

export interface EngineeringSummary {
  totalCases: number;
  scored: number;
  unscored: { uncached: number; error: number };
  /** hit / near / disagreement(=miss only) / refusal / brandedFallback — see METHODOLOGY_NOTE. */
  buckets: { hit: number; near: number; disagreement: number; refusal: number; brandedFallback: number };
  /** Same buckets, as a % of scored (0 when scored===0, never NaN). */
  rates: { hitPct: number; nearPct: number; disagreementPct: number; refusalPct: number; brandedFallbackPct: number };
  /** near + near_branded + miss + labeled_branded_fallback — the full DISAGREEMENT QUEUE population (part b). */
  disagreementQueueTotal: number;
  disagreementNutritionDeviation: NutritionDeviationDistribution;
  /** Informational only — dictionary entries with no scoreable FDC identity at all (fixture.excluded); never scored, never part of any rate above. */
  excludedCount: number;
  methodologyNote: string;
}

export interface DisagreementRow {
  query: string;
  status: CaseStatus | "uncached" | "error";
  findFoodPick: { fdcId: number; description: string; dataType?: string };
  dictionaryCandidate: { fdcId: number; description: string; dataType: PreferredDataType };
  nutritionDeviation: NutritionDeviation;
  cooked?: boolean;
  occurrences?: number;
}

export interface ErrorClassGroupings {
  /** near / near_branded / miss / labeled_branded_fallback / refusal — every non-hit SCORED status, so refusal's rate is visible alongside the disagreement subtypes. */
  byOutcomeStatus: Record<string, number>;
  /** Within the disagreement queue only (refusal has no pick to group by). */
  byFindFoodPickDataType: Record<string, number>;
  /** Within the disagreement queue only, split at HIGH_DEVIATION_THRESHOLD_PCT. */
  byNutritionDeviationBucket: { high: number; low: number; uncomputable: number };
  /** Within the disagreement queue only. */
  byCookedStatus: { cooked: number; uncooked: number; unknown: number };
}

export interface EngineeringReport {
  reportLabel: string;
  frameNote: string;
  meta: {
    fixtureId: string;
    fixtureCaseCount: number;
    dictionarySource: string;
  };
  summary: EngineeringSummary;
  disagreementQueue: DisagreementRow[];
  errorClassGroupings: ErrorClassGroupings;
}

function isDisagreementBucket(bucket: Bucket): boolean {
  return bucket === "near" || bucket === "disagreement" || bucket === "branded_fallback";
}

/**
 * Pure function of (fixture, records, dictionarySource) — no I/O, no
 * Date.now()/Math.random() anywhere in the returned content, so identical
 * inputs always produce byte-identical JSON.stringify output. `records` is
 * expected to already be in a deterministic order (computeCaseRecords sorts
 * by name); every grouping table here is built by iterating `records` in
 * that same fixed order, so key-insertion order (and therefore
 * JSON.stringify key order) is deterministic too.
 */
export function buildEngineeringReport(fixture: EvalFixture, records: CaseRecord[], dictionarySource: string): EngineeringReport {
  const scoredRecords = records.filter((r) => r.bucket !== "unscored");
  const unscoredUncached = records.filter((r) => r.status === "uncached").length;
  const unscoredError = records.filter((r) => r.status === "error").length;

  const bucketCount = (b: Bucket) => records.filter((r) => r.bucket === b).length;
  const buckets = {
    hit: bucketCount("hit"),
    near: bucketCount("near"),
    disagreement: bucketCount("disagreement"),
    refusal: bucketCount("refusal"),
    brandedFallback: bucketCount("branded_fallback"),
  };
  const scored = scoredRecords.length;
  const rate = (n: number) => (scored > 0 ? (n / scored) * 100 : 0);
  const rates = {
    hitPct: rate(buckets.hit),
    nearPct: rate(buckets.near),
    disagreementPct: rate(buckets.disagreement),
    refusalPct: rate(buckets.refusal),
    brandedFallbackPct: rate(buckets.brandedFallback),
  };

  const disagreements = records.filter((r) => isDisagreementBucket(r.bucket));
  const deviationValues = disagreements
    .map((r) => r.nutritionDeviation?.meanAbsPercentDiff)
    .filter((v): v is number => v !== null && v !== undefined);
  const uncomputableCount = disagreements.length - deviationValues.length;
  const disagreementNutritionDeviation: NutritionDeviationDistribution = {
    n: disagreements.length,
    computableN: deviationValues.length,
    uncomputableN: uncomputableCount,
    uncomputablePct: disagreements.length > 0 ? (uncomputableCount / disagreements.length) * 100 : 0,
    medianPct: deviationValues.length > 0 ? percentile(deviationValues, 50) : null,
    p90Pct: deviationValues.length > 0 ? percentile(deviationValues, 90) : null,
  };

  const disagreementQueue: DisagreementRow[] = disagreements
    .filter(
      (r): r is CaseRecord & { findFoodPick: NonNullable<CaseRecord["findFoodPick"]>; expected: NonNullable<CaseRecord["expected"]>; nutritionDeviation: NutritionDeviation } =>
        r.findFoodPick !== undefined && r.expected !== undefined && r.nutritionDeviation !== undefined
    )
    .map((r) => ({
      query: r.name,
      status: r.status,
      findFoodPick: r.findFoodPick,
      dictionaryCandidate: r.expected,
      nutritionDeviation: r.nutritionDeviation,
      cooked: r.cooked,
      occurrences: r.occurrences,
    }))
    .sort((a, b) => {
      // Uncomputable (null) sorts LAST regardless of direction — -Infinity
      // always loses a DESC comparison — never "0% deviation" (that would
      // misrepresent "we don't know" as "identical").
      const av = a.nutritionDeviation.meanAbsPercentDiff ?? -Infinity;
      const bv = b.nutritionDeviation.meanAbsPercentDiff ?? -Infinity;
      return bv - av || a.query.localeCompare(b.query);
    });

  // ── error-class groupings ──────────────────────────────────────────
  const byOutcomeStatus: Record<string, number> = {};
  for (const r of records) {
    if (r.bucket === "near" || r.bucket === "disagreement" || r.bucket === "branded_fallback" || r.bucket === "refusal") {
      byOutcomeStatus[r.status] = (byOutcomeStatus[r.status] ?? 0) + 1;
    }
  }

  const byFindFoodPickDataType: Record<string, number> = {};
  for (const r of disagreements) {
    const dt = r.findFoodPick?.dataType ?? "Unknown";
    byFindFoodPickDataType[dt] = (byFindFoodPickDataType[dt] ?? 0) + 1;
  }

  const byNutritionDeviationBucket = { high: 0, low: 0, uncomputable: 0 };
  for (const r of disagreements) {
    const v = r.nutritionDeviation?.meanAbsPercentDiff;
    if (v === null || v === undefined) byNutritionDeviationBucket.uncomputable++;
    else if (v >= HIGH_DEVIATION_THRESHOLD_PCT) byNutritionDeviationBucket.high++;
    else byNutritionDeviationBucket.low++;
  }

  const byCookedStatus = { cooked: 0, uncooked: 0, unknown: 0 };
  for (const r of disagreements) {
    if (r.cooked === true) byCookedStatus.cooked++;
    else if (r.cooked === false) byCookedStatus.uncooked++;
    else byCookedStatus.unknown++;
  }

  return {
    reportLabel: REPORT_LABEL,
    frameNote: FRAME_NOTE,
    meta: {
      fixtureId: fixture.provenance.fixtureId,
      fixtureCaseCount: fixture.cases.length,
      dictionarySource,
    },
    summary: {
      totalCases: records.length,
      scored,
      unscored: { uncached: unscoredUncached, error: unscoredError },
      buckets,
      rates,
      disagreementQueueTotal: disagreements.length,
      disagreementNutritionDeviation,
      excludedCount: fixture.excluded?.length ?? 0,
      methodologyNote: METHODOLOGY_NOTE,
    },
    disagreementQueue,
    errorClassGroupings: { byOutcomeStatus, byFindFoodPickDataType, byNutritionDeviationBucket, byCookedStatus },
  };
}

// ─── markdown rendering ─────────────────────────────────────────────────

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtDev(v: number | null): string {
  return v === null ? "n/a" : `${v.toFixed(1)}%`;
}

export function renderMarkdown(report: EngineeringReport): string {
  const lines: string[] = [];
  lines.push(`# find_food dictionary-foods engineering report`);
  lines.push("");
  lines.push(`**${report.reportLabel}**`);
  lines.push("");
  lines.push(report.frameNote);
  lines.push("");
  lines.push(`Fixture: \`${report.meta.fixtureId}\` (${report.meta.fixtureCaseCount} cases) | Dictionary source: ${report.meta.dictionarySource}`);
  lines.push("");

  lines.push(`## Summary`);
  lines.push("");
  const s = report.summary;
  lines.push(`- Total cases: ${s.totalCases}`);
  lines.push(`- Scored: ${s.scored} (unscored: ${s.unscored.uncached} uncached, ${s.unscored.error} errored)`);
  lines.push(`- Excluded (dictionary entries with no scoreable FDC identity at all): ${s.excludedCount}`);
  lines.push("");
  lines.push(`| Bucket | Count | Rate (of scored) |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| hit (agrees with dictionary candidate) | ${s.buckets.hit} | ${pct(s.rates.hitPct)} |`);
  lines.push(`| near (candidate in alternates, incl. near_branded) | ${s.buckets.near} | ${pct(s.rates.nearPct)} |`);
  lines.push(`| disagreement (miss — confident different pick) | ${s.buckets.disagreement} | ${pct(s.rates.disagreementPct)} |`);
  lines.push(`| branded-fallback (honest low-confidence Branded pick) | ${s.buckets.brandedFallback} | ${pct(s.rates.brandedFallbackPct)} |`);
  lines.push(`| refusal (no pick at all) | ${s.buckets.refusal} | ${pct(s.rates.refusalPct)} |`);
  lines.push("");
  lines.push(
    `**Disagreement queue** (near + disagreement + branded-fallback — every case where find_food both found ` +
      `something AND it differs from the dictionary candidate): ${s.disagreementQueueTotal}`
  );
  lines.push("");
  const d = s.disagreementNutritionDeviation;
  lines.push(`Nutrition-deviation distribution over the disagreement queue (mean abs % diff across energy/protein/fat/carb, max-based [0,100]% bound):`);
  lines.push(`- n=${d.n}, computable=${d.computableN}, uncomputable=${d.uncomputableN} (${pct(d.uncomputablePct)})`);
  lines.push(`- median: ${fmtDev(d.medianPct)} | p90: ${fmtDev(d.p90Pct)}`);
  lines.push("");
  lines.push(`_Methodology: ${s.methodologyNote}_`);
  lines.push("");

  lines.push(`## Disagreement Queue`);
  lines.push("");
  lines.push(`_Sorted by nutrition deviation, descending — highest-deviation disagreements first (these most likely change a recipe's computed nutrition). Uncomputable deviations sort last._`);
  lines.push("");
  if (report.disagreementQueue.length === 0) {
    lines.push(`_No disagreements — either every scored case was a hit/refusal, or nothing has been scored yet (empty/partial cache; run the live recording first)._`);
  } else {
    lines.push(`| query | status | find_food pick | dictionary candidate | deviation |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const row of report.disagreementQueue) {
      const ff = `${row.findFoodPick.description} (FDC ${row.findFoodPick.fdcId}, ${row.findFoodPick.dataType ?? "?"})`;
      const dc = `${row.dictionaryCandidate.description} (FDC ${row.dictionaryCandidate.fdcId}, ${row.dictionaryCandidate.dataType})`;
      lines.push(`| ${row.query} | ${row.status} | ${ff} | ${dc} | ${fmtDev(row.nutritionDeviation.meanAbsPercentDiff)} |`);
    }
  }
  lines.push("");

  lines.push(`## Error-Class Groupings`);
  lines.push("");
  lines.push(`### By outcome status (non-hit, scored — surfaces refusal alongside the disagreement subtypes)`);
  const statusEntries = Object.entries(report.errorClassGroupings.byOutcomeStatus);
  if (statusEntries.length === 0) lines.push(`_none_`);
  for (const [status, count] of statusEntries) lines.push(`- ${status}: ${count}`);
  lines.push("");
  lines.push(`### By find_food pick data type (within the disagreement queue)`);
  const dtEntries = Object.entries(report.errorClassGroupings.byFindFoodPickDataType);
  if (dtEntries.length === 0) lines.push(`_none_`);
  for (const [dt, count] of dtEntries) lines.push(`- ${dt}: ${count}`);
  lines.push("");
  lines.push(`### By nutrition-deviation bucket (within the disagreement queue, threshold ${HIGH_DEVIATION_THRESHOLD_PCT}%)`);
  const nb = report.errorClassGroupings.byNutritionDeviationBucket;
  lines.push(`- high (>=${HIGH_DEVIATION_THRESHOLD_PCT}%): ${nb.high}`);
  lines.push(`- low (<${HIGH_DEVIATION_THRESHOLD_PCT}%): ${nb.low}`);
  lines.push(`- uncomputable: ${nb.uncomputable}`);
  lines.push("");
  lines.push(`### By cooked/uncooked (within the disagreement queue)`);
  const cb = report.errorClassGroupings.byCookedStatus;
  lines.push(`- cooked (occurrences>0 in the pinned recipe corpus): ${cb.cooked}`);
  lines.push(`- uncooked (occurrences===0): ${cb.uncooked}`);
  if (cb.unknown > 0) lines.push(`- unknown (cooked flag missing): ${cb.unknown}`);
  lines.push("");

  return lines.join("\n");
}

// ─── CLI-only glue ─────────────────────────────────────────────────────

interface CliArgs {
  fixturePath?: string;
  cachePath?: string;
  dictJsonPath?: string;
  recipeAppPath?: string;
  commit?: string;
  dictPath?: string;
  outBase: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : undefined;
  };
  return {
    fixturePath: get("--fixture-path"),
    cachePath: get("--cache"),
    dictJsonPath: get("--dict-json"),
    recipeAppPath: get("--recipe-app"),
    commit: get("--commit"),
    dictPath: get("--dict-path"),
    outBase: get("--out") ?? DEFAULT_OUT_BASE,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const binding = resolveFixtureBinding("dictionary-foods");
  const fixturePath = args.fixturePath ?? binding.fixturePath;
  const cachePath = args.cachePath ?? binding.cachePath;

  const fixture = loadFixture(fixturePath);
  validateFixtureSchema(fixture);

  const commitDefault = fixture.provenance.dictionaryCommit ?? FALLBACK_COMMIT;
  const dictPathDefault = fixture.provenance.sourcePath?.replace(/^recipe-app\//, "") ?? FALLBACK_DICT_PATH;

  const { dict, description } = loadPinnedDictionary({
    dictJsonPath: args.dictJsonPath,
    recipeAppPath: args.recipeAppPath,
    commit: args.commit ?? commitDefault,
    dictPath: args.dictPath ?? dictPathDefault,
  });

  const candidateIndex = buildCandidateNutritionIndex(dict);
  const records = await computeCaseRecords(fixture.cases, cachePath, candidateIndex);
  const report = buildEngineeringReport(fixture, records, description);

  mkdirSync(path.dirname(args.outBase), { recursive: true });
  const jsonPath = `${args.outBase}.json`;
  const mdPath = `${args.outBase}.md`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf-8");
  writeFileSync(mdPath, renderMarkdown(report), "utf-8");

  console.log(`dictionary-foods engineering report written:\n  ${jsonPath}\n  ${mdPath}`);
  console.log(`Scored ${report.summary.scored}/${report.summary.totalCases}; disagreement queue: ${report.summary.disagreementQueueTotal}`);
  if (report.summary.unscored.uncached > 0) {
    console.log(`${report.summary.unscored.uncached} cases are uncached — run the live recording (see eval/run.ts, --fixture=dictionary-foods --live) to populate them.`);
  }
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
