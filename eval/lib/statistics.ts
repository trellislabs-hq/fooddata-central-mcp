/**
 * Module: representative-eval statistics layer (Wilson CI, occurrence
 *   weighting, evidence-tier stratification, coverage, per-pack rollups)
 * Purpose: The population-level numbers the README v3 skeleton's [SLOTS]
 *   require (spec_findfood_representative_eval_v1_2026-07-19.md S4/S8),
 *   computed from a run's scored CaseResult rows PLUS the fixture's excluded
 *   rows (coverage and per-pack rollups need both — a case that never
 *   entered `cases` still counts against the denominator). Deliberately
 *   separate from eval/lib/scoring.ts: scoring.ts answers "what happened for
 *   one case" (the kind x result matrix); this module answers "what does
 *   that mean for the battery as a whole." Works for BOTH fixtures — on the
 *   adversarial fixture (no occurrences/packs/evidenceClass data), the
 *   weighted numbers degrade to the unique numbers (every row implicitly
 *   weights 1) and the human-adjudicated stratum is simply empty (n=0).
 *
 * Major Sections:
 *   - wilsonInterval() — Wilson score interval (95% by default), the ONLY
 *     interval ever computed on a proportion here (spec S5: never on the
 *     occurrence-weighted numbers — those are descriptive, no CI). Returns
 *     NULL for n<=0 (jump-1778 second fix-pass: a fake [0,0] interval is a
 *     confidence claim from zero observations — never fabricate one).
 *   - formatBoundOutward() — the ONLY place raw Wilson-interval precision is
 *     ever rounded. Every StratumStats/RepresentativeStats object, and the
 *     manifest JSON, keep FULL PRECISION raw numbers (auditable) — rounding
 *     happens exclusively at this human-facing print/format boundary, and
 *     it rounds OUTWARD (lower floored, upper ceiled), never to nearest:
 *     interpretation sentences key off the lower bound, so rounding it UP
 *     (nearest-rounding can do that) would overstate confidence.
 *   - computeStratumStats() — unique-name top-1/top-4 + Wilson CI over any
 *     row predicate (used for both the full set and the human-adjudicated
 *     subset — same shape, same honesty)
 *   - computeWeightedPositiveStats() — occurrence-weighted top-1/top-4,
 *     DESCRIPTIVE ONLY, labeled "pack-item-weighted" (spec S6 — never
 *     "monthly" or "normal use" framing)
 *   - computeCoverageStats() — eligible/total, unique AND weighted, from
 *     `rows` (eligible) + `excluded` (not eligible) — independent of
 *     whether this particular run managed to SCORE every eligible case
 *   - computePackRollups() — per-pack breakdown, occurrence-weighted,
 *     counting excluded rows into each pack's total denominator
 *   - computeRepresentativeStats() — assembles all of the above
 *
 * Dependencies: ./scoring.js (CaseResult, CaseStatus, SCORED_STATUSES),
 *   ./fixture.js (ExcludedEvalCase)
 * State: Stateless — pure functions.
 */

import { SCORED_STATUSES, type CaseResult, type CaseStatus } from "./scoring.js";
import type { ExcludedEvalCase } from "./fixture.js";

export interface WilsonInterval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a proportion of `successes`/`n`, returned as
 * FULL-PRECISION PERCENTAGES (0-100), clamped to [0, 100] — NEVER rounded
 * here (see formatBoundOutward() for the one place display rounding
 * happens). z=1.96 is the 95% default.
 *
 * n<=0 returns NULL, not a fake {lower: 0, upper: 0} — a [0,0] interval
 * reads as "we're 95% confident the true rate is between 0% and 0%", which
 * is a real (false) confidence claim from zero observations. Every
 * consumer (StratumStats fields, the manifest JSON, the console print)
 * must treat this as "no interval available", not as a degenerate zero.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (center - margin) * 100),
    upper: Math.min(100, (center + margin) * 100),
  };
}

/**
 * The ONLY place a raw Wilson-interval bound is ever rounded for display.
 * Rounds OUTWARD, never to nearest: `direction: 'lower'` floors to 1
 * decimal, `direction: 'upper'` ceils to 1 decimal. This is deliberately
 * asymmetric — nearest-rounding the lower bound can round it UP (e.g. a raw
 * 58.081... nearest-rounds to 58.1), which overstates confidence, since
 * interpretation sentences key off the lower bound (spec S4: "usually
 * right" requires lower bound > 50%). Callers must keep the RAW `x` for any
 * computed/serialized value (StratumStats objects, the manifest JSON) — this
 * function is display-only, called exclusively at the print/format
 * boundary (e.g. eval/run.ts's console report).
 */
export function formatBoundOutward(x: number, direction: "lower" | "upper"): string {
  const rounded = direction === "lower" ? Math.floor(x * 10) / 10 : Math.ceil(x * 10) / 10;
  return rounded.toFixed(1);
}

function occurrencesOf(row: CaseResult): number {
  // Rows with no occurrences metadata (the adversarial fixture's cases)
  // default to weight 1 — this is what makes the weighted numbers degrade
  // gracefully to the unique numbers when there's no pack data at all.
  return row.occurrences ?? 1;
}

function isTop4Status(status: CaseStatus): boolean {
  return status === "hit" || status === "near" || status === "near_branded";
}

export interface StratumStats {
  /** Unique names in this stratum that completed scoring (SCORED_STATUSES only). */
  n: number;
  hits: number;
  top1Pct: number;
  /** NULL when n===0 — never a fake {lower:0,upper:0}. See wilsonInterval()'s header note. */
  top1Wilson: WilsonInterval | null;
  top4Hits: number;
  top4Pct: number;
  /** NULL when n===0 — never a fake {lower:0,upper:0}. See wilsonInterval()'s header note. */
  top4Wilson: WilsonInterval | null;
}

const EMPTY_STRATUM: StratumStats = {
  n: 0,
  hits: 0,
  top1Pct: 0,
  top1Wilson: null,
  top4Hits: 0,
  top4Pct: 0,
  top4Wilson: null,
};

/**
 * Unique-name top-1/top-4 + Wilson 95% CI over any row predicate — the SAME
 * function computes both the full-set stratum (predicate: () => true) and
 * the human-adjudicated-only stratum, so both numbers share one code path
 * and one honesty bar. Model (spec S5, stated wherever this is printed):
 * treats each unique name as an independent Bernoulli draw from the fixed
 * battery name set.
 */
export function computeStratumStats(rows: CaseResult[], predicate: (row: CaseResult) => boolean): StratumStats {
  const subset = rows.filter((r) => r.kind === "positive" && SCORED_STATUSES.has(r.status) && predicate(r));
  if (subset.length === 0) return { ...EMPTY_STRATUM };
  const n = subset.length;
  const hits = subset.filter((r) => r.status === "hit").length;
  const top4Hits = subset.filter((r) => isTop4Status(r.status)).length;
  return {
    n,
    hits,
    top1Pct: (hits / n) * 100,
    top1Wilson: wilsonInterval(hits, n),
    top4Hits,
    top4Pct: (top4Hits / n) * 100,
    top4Wilson: wilsonInterval(top4Hits, n),
  };
}

export interface WeightedStats {
  /** Occurrence-weighted denominator (sum of `occurrences` over scored positive rows). */
  n: number;
  hits: number;
  top1Pct: number;
  top4Hits: number;
  top4Pct: number;
  /** Always "pack-item-weighted" — spec S6: never "monthly"/"normal use" framing; the 251 are post-aggregation cart items. */
  label: "pack-item-weighted";
}

/**
 * Occurrence-weighted top-1/top-4 — DESCRIPTIVE ONLY, no CI (spec S5:
 * repeated occurrences of the same name are perfectly correlated, not
 * independent draws — a CI computed on the weighted n would overstate
 * precision). Always present unique-name-first alongside this in any
 * printed report (spec S6).
 */
export function computeWeightedPositiveStats(rows: CaseResult[]): WeightedStats {
  const subset = rows.filter((r) => r.kind === "positive" && SCORED_STATUSES.has(r.status));
  const n = subset.reduce((sum, r) => sum + occurrencesOf(r), 0);
  const hits = subset.filter((r) => r.status === "hit").reduce((sum, r) => sum + occurrencesOf(r), 0);
  const top4Hits = subset.filter((r) => isTop4Status(r.status)).reduce((sum, r) => sum + occurrencesOf(r), 0);
  return {
    n,
    hits,
    top1Pct: n > 0 ? (hits / n) * 100 : 0,
    top4Hits,
    top4Pct: n > 0 ? (top4Hits / n) * 100 : 0,
    label: "pack-item-weighted",
  };
}

export interface CoverageStats {
  uniqueEligible: number;
  uniqueTotal: number;
  uniqueCoveragePct: number;
  weightedEligible: number;
  weightedTotal: number;
  weightedCoveragePct: number;
}

/**
 * Eligible/total, unique AND weighted — FIXTURE-ASSEMBLY-TIME truth
 * (spec S1/S4), independent of whether THIS run's cache happened to score
 * every eligible case (that's a separate notion — replay cache coverage —
 * tracked elsewhere by the exit-code coverage threshold). `rows` supplies
 * the eligible side (every positive-kind row is one eligible name,
 * regardless of its scored/uncached/error status this run); `excluded`
 * supplies the not-eligible side.
 */
export function computeCoverageStats(rows: CaseResult[], excluded: ExcludedEvalCase[]): CoverageStats {
  const eligibleRows = rows.filter((r) => r.kind === "positive");
  const uniqueEligible = eligibleRows.length;
  const uniqueTotal = uniqueEligible + excluded.length;
  const weightedEligible = eligibleRows.reduce((sum, r) => sum + occurrencesOf(r), 0);
  const weightedExcluded = excluded.reduce((sum, x) => sum + x.occurrences, 0);
  const weightedTotal = weightedEligible + weightedExcluded;
  return {
    uniqueEligible,
    uniqueTotal,
    uniqueCoveragePct: uniqueTotal > 0 ? (uniqueEligible / uniqueTotal) * 100 : 0,
    weightedEligible,
    weightedTotal,
    weightedCoveragePct: weightedTotal > 0 ? (weightedEligible / weightedTotal) * 100 : 0,
  };
}

export interface PackRollup {
  /** Fixture-assembly-time: eligible + excluded unique names appearing in this pack. */
  uniqueTotal: number;
  uniqueEligible: number;
  /** Of the eligible names in this pack, how many actually scored THIS run. */
  uniqueScored: number;
  uniqueHits: number;
  weightedTotal: number;
  weightedEligible: number;
  weightedScored: number;
  weightedHits: number;
  /** weightedHits / weightedScored * 100 — 0 when weightedScored is 0 (nothing to divide by, never a misleading 100%). */
  top1Pct: number;
}

/**
 * Per-pack breakdown, occurrence-weighted, counting EXCLUDED rows into each
 * pack's total denominator (the two defects named in the jump-1778 fix-pass:
 * the pre-fix version ignored both occurrence counts and excluded rows).
 */
export function computePackRollups(rows: CaseResult[], excluded: ExcludedEvalCase[]): Record<string, PackRollup> {
  const packs: Record<string, PackRollup> = {};
  const bucket = (packId: string): PackRollup =>
    packs[packId] ??
    (packs[packId] = {
      uniqueTotal: 0,
      uniqueEligible: 0,
      uniqueScored: 0,
      uniqueHits: 0,
      weightedTotal: 0,
      weightedEligible: 0,
      weightedScored: 0,
      weightedHits: 0,
      top1Pct: 0,
    });

  for (const row of rows) {
    if (row.kind !== "positive" || !row.packs) continue;
    for (const [packId, count] of Object.entries(row.packs)) {
      const b = bucket(packId);
      b.uniqueTotal++;
      b.uniqueEligible++;
      b.weightedTotal += count;
      b.weightedEligible += count;
      if (SCORED_STATUSES.has(row.status)) {
        b.uniqueScored++;
        b.weightedScored += count;
        if (row.status === "hit") {
          b.uniqueHits++;
          b.weightedHits += count;
        }
      }
    }
  }

  for (const excludedRow of excluded) {
    for (const [packId, count] of Object.entries(excludedRow.packs)) {
      const b = bucket(packId);
      b.uniqueTotal++;
      b.weightedTotal += count;
    }
  }

  for (const b of Object.values(packs)) {
    b.top1Pct = b.weightedScored > 0 ? (b.weightedHits / b.weightedScored) * 100 : 0;
  }

  return packs;
}

export interface RepresentativeStats {
  coverage: CoverageStats;
  /** Full-set unique-name stats (every scored positive row), Wilson-CI'd. Always present first — spec S6. */
  unique: StratumStats;
  /** Occurrence-weighted, descriptive only, no CI. */
  weighted: WeightedStats;
  /** Same shape as `unique`, filtered to evidenceClass in {human_pin, human_ruling} — spec S2 stratified reporting. n=0 on the adversarial fixture (no evidenceClass data) or a representative fixture with no human-adjudicated rows scored yet. */
  humanAdjudicated: StratumStats;
  byPack: Record<string, PackRollup>;
  /** States the independence-assumption caveat — print verbatim wherever a Wilson CI is shown. */
  model: string;
}

const MODEL_NOTE =
  "Wilson 95% intervals treat each UNIQUE NAME as an independent Bernoulli draw from the battery's fixed name " +
  "set (spec S5) — a stated simplification, not a claim of random sampling from all possible household " +
  "ingredient names. Occurrence-weighted numbers are DESCRIPTIVE ONLY (no CI): repeated occurrences of the same " +
  "name are perfectly correlated, not independent draws, so a CI on the weighted n would overstate precision.";

export function computeRepresentativeStats(rows: CaseResult[], excluded: ExcludedEvalCase[]): RepresentativeStats {
  const HUMAN_ADJUDICATED = new Set(["human_pin", "human_ruling"]);
  return {
    coverage: computeCoverageStats(rows, excluded),
    unique: computeStratumStats(rows, () => true),
    weighted: computeWeightedPositiveStats(rows),
    humanAdjudicated: computeStratumStats(rows, (r) => r.evidenceClass !== undefined && HUMAN_ADJUDICATED.has(r.evidenceClass)),
    byPack: computePackRollups(rows, excluded),
    model: MODEL_NOTE,
  };
}
