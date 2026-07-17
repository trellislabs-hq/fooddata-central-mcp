/**
 * Module: eval scoring semantics + aggregate report
 * Purpose: Pure scoring functions for find_food eval cases. Scores are
 *   computed against the FindFoodResult STRUCT (best.fdcId, alternates[].fdcId,
 *   usedBranded) — never by parsing `result.text` — per src/find-food.ts's
 *   FindFoodResult shape.
 *
 *   Scoring semantics (see the jump-1759 spec for the exact rationale):
 *     POSITIVE case:
 *       hit   iff result.best?.fdcId === expected.fdcId
 *       near  iff expected.fdcId is present in result.alternates[].fdcId
 *       miss  otherwise
 *     NEGATIVE case:
 *       honest          iff result.best === undefined OR result.usedBranded === true
 *       confident_wrong otherwise
 *
 *   The "near"/top-4 metric measures the EXPOSED post-dedup alternates
 *   (dedupeByDescription in src/find-food.ts can drop a same-description
 *   candidate before it ever reaches `alternates`) — this is top-4 recall
 *   over what find_food actually shows a caller, not raw-candidate recall.
 *   Every eval call MUST pass { includeBranded: false } explicitly: with
 *   includeBranded true, usedBranded can be true even after a genuine
 *   preferred-type hit (src/find-food.ts appends Branded results after a
 *   successful preferred-type match when includeBranded is set), which
 *   would corrupt the negative-case honesty rule above.
 *
 * Major Sections:
 *   - CaseResult / AggregateReport types
 *   - scoreCase() — scores one successfully-completed findFood() call
 *   - percentile() — nearest-rank percentile helper for latency stats
 *   - computeAggregate() — rolls case rows + optional latencies into a report
 *
 * Dependencies: ../../src/find-food.js (FindFoodResult type),
 *   ../../src/fdc-client.js (FdcFood type), ./fixture.js (EvalCase types)
 * State: Stateless — pure functions.
 */

import type { FdcFood } from "../../src/fdc-client.js";
import type { FindFoodResult } from "../../src/find-food.js";
import type { EvalCase } from "./fixture.js";

export type CaseStatus = "hit" | "near" | "miss" | "honest" | "confident_wrong" | "uncached" | "error";

export interface ActualFoodSummary {
  fdcId: number;
  description: string;
  dataType?: string;
}

export interface CaseResult {
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

/** Score one successfully-completed findFood() call against its eval case definition. */
export function scoreCase(caseDef: EvalCase, result: FindFoodResult): CaseResult {
  if (caseDef.kind === "positive") {
    const expectedId = caseDef.expected.fdcId;
    if (result.best !== undefined && result.best.fdcId === expectedId) {
      return { name: caseDef.name, kind: "positive", status: "hit" };
    }
    const isNear = result.alternates.some((alt) => alt.fdcId === expectedId);
    if (isNear) {
      return { name: caseDef.name, kind: "positive", status: "near", actual: summarize(result.best) };
    }
    return { name: caseDef.name, kind: "positive", status: "miss", actual: summarize(result.best) };
  }

  // Negative case.
  if (result.best === undefined || result.usedBranded === true) {
    return { name: caseDef.name, kind: "negative", status: "honest" };
  }
  return { name: caseDef.name, kind: "negative", status: "confident_wrong", actual: summarize(result.best) };
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

export interface AggregateReport {
  totals: { positive: number; negative: number; total: number };
  counts: Record<CaseStatus, number>;
  top1Pct: number;
  top4Pct: number;
  negativeHonestyPct: number;
  latency: LatencyStats | "cached";
  failures: {
    misses: CaseResult[];
    confidentWrong: CaseResult[];
    uncached: CaseResult[];
    errors: CaseResult[];
  };
  method: string;
}

const METHOD_NOTE =
  "top1Pct = hits/positives; top4Pct = (hits+near)/positives measures the EXPOSED, " +
  "post-dedup top-4 (best + up to 3 alternates) as rendered by find_food — not raw-candidate " +
  "recall, since dedupeByDescription (src/find-food.ts) can drop a same-description candidate " +
  "before it reaches the alternates list; negativeHonestyPct = honest/negatives.";

export function computeAggregate(rows: CaseResult[], latencies: number[] | "cached"): AggregateReport {
  const counts: Record<CaseStatus, number> = {
    hit: 0,
    near: 0,
    miss: 0,
    honest: 0,
    confident_wrong: 0,
    uncached: 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;

  const positive = rows.filter((r) => r.kind === "positive").length;
  const negative = rows.filter((r) => r.kind === "negative").length;

  const top1Pct = positive > 0 ? (counts.hit / positive) * 100 : 0;
  const top4Pct = positive > 0 ? ((counts.hit + counts.near) / positive) * 100 : 0;
  const negativeHonestyPct = negative > 0 ? (counts.honest / negative) * 100 : 0;

  const latency: LatencyStats | "cached" =
    latencies === "cached"
      ? "cached"
      : { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length > 0 ? Math.max(...latencies) : 0 };

  return {
    totals: { positive, negative, total: rows.length },
    counts,
    top1Pct,
    top4Pct,
    negativeHonestyPct,
    latency,
    failures: {
      misses: rows.filter((r) => r.status === "miss"),
      confidentWrong: rows.filter((r) => r.status === "confident_wrong"),
      uncached: rows.filter((r) => r.status === "uncached"),
      errors: rows.filter((r) => r.status === "error"),
    },
    method: METHOD_NOTE,
  };
}
