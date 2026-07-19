/**
 * Module: eval scoring semantics + aggregate report
 * Purpose: Pure scoring functions for find_food eval cases. Scores are
 *   computed against the FindFoodResult STRUCT (best.fdcId, alternates[].fdcId,
 *   usedBranded) — never by parsing `result.text` — per src/find-food.ts's
 *   FindFoodResult shape. One scoring module serves BOTH fixtures (the
 *   adversarial stress corpus and the representative-traffic corpus) — see
 *   the jump-1778 methodology spec (spec_findfood_representative_eval_v1_
 *   2026-07-19.md) S7/S8.
 *
 *   Outcome taxonomy (spec S7 — REPLACES the old collapsed "honest" bucket,
 *   which hid the difference between a true refusal and an honestly-labeled
 *   Branded fallback):
 *     POSITIVE case (a verified reference answer exists):
 *       hit                      result.best?.fdcId === expected.fdcId
 *       near / near_branded      expected.fdcId is in result.alternates[]
 *                                 (near_branded when usedBranded===true —
 *                                 reported separately, never silently folded
 *                                 into plain "near")
 *       refusal                  result.best === undefined (nothing cleared
 *                                 the floor at all)
 *       labeled_branded_fallback result.best defined, wrong, usedBranded
 *                                 true — an honestly-labeled low-confidence
 *                                 answer, distinct from a confident miss
 *       miss                     result.best defined, wrong, usedBranded
 *                                 false — a confident wrong preferred-type
 *                                 answer
 *     NEGATIVE case (no verified answer — the floor SHOULD decline):
 *       refusal                  result.best === undefined
 *       labeled_branded_fallback result.best defined, usedBranded true
 *       confident_wrong          result.best defined, usedBranded false
 *
 *   The "near"/top-4 metric measures the EXPOSED post-dedup alternates
 *   (dedupeByDescription in src/find-food.ts can drop a same-description
 *   candidate before it ever reaches `alternates`) — this is top-4 recall
 *   over what find_food actually shows a caller, not raw-candidate recall.
 *   Every eval call MUST pass { includeBranded: false } explicitly: with
 *   includeBranded true, usedBranded can be true even after a genuine
 *   preferred-type hit (src/find-food.ts appends Branded results after a
 *   successful preferred-type match when includeBranded is set), which
 *   would corrupt the usedBranded-keyed rules above.
 *
 * Major Sections:
 *   - CaseResult / AggregateReport types — CaseResult carries an optional
 *     EvalCaseMeta pass-through (evidenceClass/expectedSource/resolverSource/
 *     occurrences/packs) so representative-fixture rows keep their fixture
 *     metadata all the way into the results JSON; always undefined for the
 *     adversarial fixture's rows.
 *   - SCORED_STATUSES (exported) — which statuses count as "scored"
 *     (accuracy denominators EXCLUDE uncached/error cases — see
 *     computeAggregate() below AND eval/lib/statistics.ts, which reuses this
 *     same set for its population-level numbers)
 *   - scoreCase() — scores one successfully-completed findFood() call
 *   - percentile() — nearest-rank percentile helper for latency stats
 *   - computeAggregate() — rolls case rows + optional latencies into a
 *     report; every percentage is computed over SCORED cases only
 *     (uncached/error cases carry no accuracy signal and would otherwise
 *     silently distort the percentages on a thin/broken cache). Per-pack/
 *     per-evidenceClass rollups, Wilson intervals, occurrence weighting, and
 *     coverage now live in eval/lib/statistics.ts (jump-1778 fix-pass) — this
 *     module stays scoped to per-case scoring + the row-level matrix.
 *
 * Dependencies: ../../src/find-food.js (FindFoodResult type),
 *   ../../src/fdc-client.js (FdcFood type), ./fixture.js (EvalCase,
 *   EvalCaseMeta, EvidenceClass types)
 * State: Stateless — pure functions.
 */

import type { FdcFood } from "../../src/fdc-client.js";
import type { FindFoodResult } from "../../src/find-food.js";
import type { EvalCase, EvalCaseMeta } from "./fixture.js";

export type CaseStatus =
  | "hit"
  | "near"
  | "near_branded"
  | "miss"
  | "labeled_branded_fallback"
  | "refusal"
  | "confident_wrong"
  | "uncached"
  | "error";

export interface ActualFoodSummary {
  fdcId: number;
  description: string;
  dataType?: string;
}

export interface CaseResult extends EvalCaseMeta {
  name: string;
  kind: "positive" | "negative";
  status: CaseStatus;
  latencyMs?: number;
  actual?: ActualFoodSummary;
  errorMessage?: string;
}

function summarize(food: FdcFood | undefined): ActualFoodSummary | undefined {
  if (!food) return undefined;
  return { fdcId: food.fdcId, description: food.description, dataType: food.dataType };
}

/** Copies the representative-fixture-only metadata fields off a case def, for spreading into every CaseResult it produces (scored or not). */
function metaOf(caseDef: EvalCase): EvalCaseMeta {
  return {
    evidenceClass: caseDef.evidenceClass,
    expectedSource: caseDef.expectedSource,
    resolverSource: caseDef.resolverSource,
    occurrences: caseDef.occurrences,
    packs: caseDef.packs,
  };
}

/** Score one successfully-completed findFood() call against its eval case definition. */
export function scoreCase(caseDef: EvalCase, result: FindFoodResult): CaseResult {
  const meta = metaOf(caseDef);

  if (caseDef.kind === "positive") {
    const expectedId = caseDef.expected.fdcId;

    if (result.best !== undefined && result.best.fdcId === expectedId) {
      return { name: caseDef.name, kind: "positive", status: "hit", ...meta };
    }

    const isNear = result.alternates.some((alt) => alt.fdcId === expectedId);
    if (isNear) {
      return {
        name: caseDef.name,
        kind: "positive",
        status: result.usedBranded === true ? "near_branded" : "near",
        actual: summarize(result.best),
        ...meta,
      };
    }

    if (result.best === undefined) {
      return { name: caseDef.name, kind: "positive", status: "refusal", ...meta };
    }

    if (result.usedBranded === true) {
      return { name: caseDef.name, kind: "positive", status: "labeled_branded_fallback", actual: summarize(result.best), ...meta };
    }

    return { name: caseDef.name, kind: "positive", status: "miss", actual: summarize(result.best), ...meta };
  }

  // Negative case: no verified answer exists — the taxonomy measures HOW
  // find_food behaves in the absence of ground truth.
  if (result.best === undefined) {
    return { name: caseDef.name, kind: "negative", status: "refusal", ...meta };
  }
  if (result.usedBranded === true) {
    return { name: caseDef.name, kind: "negative", status: "labeled_branded_fallback", actual: summarize(result.best), ...meta };
  }
  return { name: caseDef.name, kind: "negative", status: "confident_wrong", actual: summarize(result.best), ...meta };
}

/** Nearest-rank percentile over a numeric array (does not mutate the input). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

export interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
}

/**
 * A case is "scored" iff findFood() actually completed and scoreCase() ran
 * on its result — i.e. status is one of the seven scoring outcomes, not
 * uncached/error. uncached/error cases carry no signal about find_food's
 * accuracy (a missing cache entry or a network blip says nothing about
 * whether the pipeline would have found the right food) — including them in
 * an accuracy denominator would silently understate accuracy on thin runs
 * and, worse, let a broken/near-empty cache masquerade as a real result.
 */
export const SCORED_STATUSES: ReadonlySet<CaseStatus> = new Set([
  "hit",
  "near",
  "near_branded",
  "miss",
  "labeled_branded_fallback",
  "refusal",
  "confident_wrong",
]);

/** Explicit kind x result matrix (spec S7) — every positive/negative outcome, decided nowhere silently. */
export interface PositiveMatrix {
  hit: number;
  near: number;
  near_branded: number;
  miss: number;
  labeled_branded_fallback: number;
  refusal: number;
}
export interface NegativeMatrix {
  refusal: number;
  labeled_branded_fallback: number;
  confident_wrong: number;
}

// NOTE (jump-1778 fix-pass): the per-pack/per-evidenceClass rollup that used
// to live here was UNIQUE-COUNT-only and never saw excluded rows — both
// named defects in the fix-pass review. It has been REMOVED and replaced by
// eval/lib/statistics.ts's computePackRollups(), which is occurrence-
// weighted and takes `excluded` as an explicit input. See that module for
// the full population-level statistics layer (Wilson CI, occurrence
// weighting, evidence-tier stratification, coverage, per-pack rollups) —
// this module (scoring.ts) stays scoped to per-case scoring + the kind x
// result matrix aggregation, which computeRepresentativeStats() builds on.

export interface AggregateReport {
  totals: { positive: number; negative: number; total: number };
  /** Cases that actually completed scoring (excludes uncached/error) — the denominators for every *Pct field below. */
  scored: { positive: number; negative: number; total: number };
  /** Cases that did NOT complete scoring, broken out by kind and reason. */
  unscored: {
    positive: { uncached: number; error: number };
    negative: { uncached: number; error: number };
  };
  counts: Record<CaseStatus, number>;
  /** Explicit kind x result matrix (spec S7) — the authoritative breakdown; every *Pct below is derived from it. */
  matrix: { positive: PositiveMatrix; negative: NegativeMatrix };
  top1Pct: number;
  /** hit + near + near_branded, over scored positives — top-4 recall of the EXPOSED (post-dedup) alternates. */
  top4Pct: number;
  /** On names WITH a verified answer: how often the floor refused outright (spec: "the floor's cost side on real traffic"). */
  positiveRefusalPct: number;
  /** On names WITH a verified answer: how often the floor fell through to an honestly-labeled Branded fallback (right OR wrong-in-kind — see the "actual" field per row). */
  positiveLabeledBrandedFallbackPct: number;
  /** On names with NO verified answer: how often the floor refused (the honest outcome). */
  negativeRefusalPct: number;
  /** On names with NO verified answer: how often it fell through to a labeled Branded fallback (also honest, just lower-confidence). */
  negativeLabeledBrandedFallbackPct: number;
  /** On names with NO verified answer: how often it presented an UNLABELED confident wrong match — the worst outcome (looks authoritative, isn't). */
  negativeConfidentWrongPct: number;
  latency: LatencyStats | "cached";
  failures: {
    misses: CaseResult[];
    confidentWrong: CaseResult[];
    refusals: CaseResult[];
    labeledBrandedFallback: CaseResult[];
    uncached: CaseResult[];
    errors: CaseResult[];
  };
  method: string;
}

const METHOD_NOTE =
  "top1Pct = hits/scored-positives; top4Pct = (hits+near+near_branded)/scored-positives measures the " +
  "EXPOSED, post-dedup top-4 (best + up to 3 alternates) as rendered by find_food — not " +
  "raw-candidate recall, since dedupeByDescription (src/find-food.ts) can drop a " +
  "same-description candidate before it reaches the alternates list. positiveRefusalPct/" +
  "positiveLabeledBrandedFallbackPct measure the floor's cost side on names WITH a verified " +
  "answer; negativeRefusalPct/negativeLabeledBrandedFallbackPct/negativeConfidentWrongPct " +
  "are the three-way split on names with NO verified answer (this REPLACES the old collapsed " +
  "negativeHonestyPct, which hid the difference between a true refusal and a labeled Branded " +
  "fallback). 'Scored' EXCLUDES uncached and errored cases from every denominator — see the " +
  "report's scored/unscored breakdown for how many cases that was.";

export function computeAggregate(rows: CaseResult[], latencies: number[] | "cached"): AggregateReport {
  const counts: Record<CaseStatus, number> = {
    hit: 0,
    near: 0,
    near_branded: 0,
    miss: 0,
    labeled_branded_fallback: 0,
    refusal: 0,
    confident_wrong: 0,
    uncached: 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;

  const positiveRows = rows.filter((r) => r.kind === "positive");
  const negativeRows = rows.filter((r) => r.kind === "negative");
  const scoredPositiveRows = positiveRows.filter((r) => SCORED_STATUSES.has(r.status));
  const scoredNegativeRows = negativeRows.filter((r) => SCORED_STATUSES.has(r.status));

  const scoredPositive = scoredPositiveRows.length;
  const scoredNegative = scoredNegativeRows.length;

  const countIn = (list: CaseResult[], status: CaseStatus): number => list.filter((r) => r.status === status).length;

  const positiveMatrix: PositiveMatrix = {
    hit: countIn(positiveRows, "hit"),
    near: countIn(positiveRows, "near"),
    near_branded: countIn(positiveRows, "near_branded"),
    miss: countIn(positiveRows, "miss"),
    labeled_branded_fallback: countIn(positiveRows, "labeled_branded_fallback"),
    refusal: countIn(positiveRows, "refusal"),
  };
  const negativeMatrix: NegativeMatrix = {
    refusal: countIn(negativeRows, "refusal"),
    labeled_branded_fallback: countIn(negativeRows, "labeled_branded_fallback"),
    confident_wrong: countIn(negativeRows, "confident_wrong"),
  };

  const top1Pct = scoredPositive > 0 ? (positiveMatrix.hit / scoredPositive) * 100 : 0;
  const top4Pct =
    scoredPositive > 0 ? ((positiveMatrix.hit + positiveMatrix.near + positiveMatrix.near_branded) / scoredPositive) * 100 : 0;
  const positiveRefusalPct = scoredPositive > 0 ? (positiveMatrix.refusal / scoredPositive) * 100 : 0;
  const positiveLabeledBrandedFallbackPct = scoredPositive > 0 ? (positiveMatrix.labeled_branded_fallback / scoredPositive) * 100 : 0;

  const negativeRefusalPct = scoredNegative > 0 ? (negativeMatrix.refusal / scoredNegative) * 100 : 0;
  const negativeLabeledBrandedFallbackPct = scoredNegative > 0 ? (negativeMatrix.labeled_branded_fallback / scoredNegative) * 100 : 0;
  const negativeConfidentWrongPct = scoredNegative > 0 ? (negativeMatrix.confident_wrong / scoredNegative) * 100 : 0;

  const latency: LatencyStats | "cached" =
    latencies === "cached"
      ? "cached"
      : { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length > 0 ? Math.max(...latencies) : 0 };

  return {
    totals: { positive: positiveRows.length, negative: negativeRows.length, total: rows.length },
    scored: { positive: scoredPositive, negative: scoredNegative, total: scoredPositive + scoredNegative },
    unscored: {
      positive: { uncached: countIn(positiveRows, "uncached"), error: countIn(positiveRows, "error") },
      negative: { uncached: countIn(negativeRows, "uncached"), error: countIn(negativeRows, "error") },
    },
    counts,
    matrix: { positive: positiveMatrix, negative: negativeMatrix },
    top1Pct,
    top4Pct,
    positiveRefusalPct,
    positiveLabeledBrandedFallbackPct,
    negativeRefusalPct,
    negativeLabeledBrandedFallbackPct,
    negativeConfidentWrongPct,
    latency,
    failures: {
      misses: rows.filter((r) => r.status === "miss"),
      confidentWrong: rows.filter((r) => r.status === "confident_wrong"),
      refusals: rows.filter((r) => r.status === "refusal"),
      labeledBrandedFallback: rows.filter((r) => r.status === "labeled_branded_fallback"),
      uncached: rows.filter((r) => r.status === "uncached"),
      errors: rows.filter((r) => r.status === "error"),
    },
    method: METHOD_NOTE,
  };
}
