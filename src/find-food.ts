/**
 * Module: find_food core logic
 * Purpose: Resolves a raw food name to the best canonical FDC match plus
 *   alternates, without ever making an LLM call — this is a search/ranking
 *   pipeline, not a disambiguation model. Extracted from src/index.ts's
 *   find_food tool registration so the pipeline can be unit-tested against
 *   recorded fixtures without spinning up a full MCP stdio server.
 *
 * Major Sections:
 *   - PREFERRED_DATA_TYPES — Foundation -> SR Legacy -> Survey (FNDDS) cascade
 *   - dedupeByDescription() — collapses near-identical branded name spam
 *   - ratePassing() — applies the relevance floor (src/relevance.ts) to one
 *     search batch, rated against the loop-local query that produced it
 *   - findFood() — orchestrates: normalize/alias candidates -> preferred-type
 *     search (floor-filtered per batch) -> Branded fallback (opt-in or last
 *     resort, also floor-filtered) -> dedup -> format, or an honest
 *     no-confident-match response when nothing clears the floor anywhere
 *
 * Dependencies:
 *   - ./fdc-client.ts (FdcSearchParams/FdcSearchResult/FdcFood types)
 *   - ./format.ts (formatFoodSummary, formatKeyNutrients)
 *   - ./normalize.ts (buildCandidateQueries)
 *   - ./relevance.ts (rateMatchQuality, MatchQuality) — the relevance floor
 *
 * State: Stateless. Takes a `searchFoods` function as a parameter (typically
 * `client.searchFoods.bind(client)`) rather than importing FdcClient
 * directly, so tests can inject a fixture-backed stub instead of a real
 * HTTP-backed client.
 *
 * Relevance floor (jump-1760): FDC's search always returns a nearest
 * neighbor, even for names FDC has nothing for — the pre-floor baseline
 * eval measured 0% negative-honesty (every one of 31 ratified-unmatchable
 * names got a confident wrong match). Every search batch is now rated
 * IMMEDIATELY against its own loop-local query (rateMatchQuality) and
 * miss-rated foods are dropped before they ever reach `best` or
 * `alternates`. The floor is a FILTER, never a re-ranker — exact/close
 * survivors keep FDC's own relevance order.
 */

import type { FdcFood, FdcSearchParams, FdcSearchResult } from "./fdc-client.js";
import { formatFoodSummary, formatKeyNutrients } from "./format.js";
import { buildCandidateQueries, normalize } from "./normalize.js";
import { rateMatchQuality, type MatchQuality } from "./relevance.js";

export type SearchFoodsFn = (params: FdcSearchParams) => Promise<FdcSearchResult>;

export interface FindFoodOptions {
  includeBranded?: boolean;
}

export interface FindFoodResult {
  /** Rendered tool output text (what the MCP tool call returns). */
  text: string;
  /**
   * Best match, if any cleared the relevance floor. Undefined in two cases:
   * FDC returned nothing at all, or everything returned rated below the
   * floor (the honest no-confident-match case).
   */
  best?: FdcFood;
  /** Up to 3 alternates alongside the best match. */
  alternates: FdcFood[];
  /** True if Branded data had to be used (opt-in or last-resort). */
  usedBranded: boolean;
  /** The candidate query string that actually produced results. */
  matchedQuery: string;
  /**
   * Relevance-floor rating of `best` against `matchedQuery` — 'exact' when
   * every significant query word is covered, 'close' when the food family
   * is right but a modifier doesn't match. Undefined only when `best` is
   * undefined (nothing cleared the floor). Narrowed to the passing grades —
   * 'miss' is impossible here by construction (miss-rated foods never
   * become `best`).
   */
  matchQuality?: Exclude<MatchQuality, "miss">;
}

/**
 * Data type preference cascade for find_food: prefer lab-analyzed/reference
 * data over manufacturer-submitted Branded noise. Branded is only searched
 * when includeBranded is true, or when nothing else matched at all.
 */
export const PREFERRED_DATA_TYPES: Array<"Foundation" | "SR Legacy" | "Survey (FNDDS)"> = [
  "Foundation",
  "SR Legacy",
  "Survey (FNDDS)",
];

/**
 * FDC's combined-type search ranks purely by text relevance, so a Survey
 * entry can outrank the canonical Foundation entry for the same food
 * (observed live: "cheddar cheese" -> Survey 2705709 above Foundation
 * 328637). Stable-sort by data-type preference so relevance only breaks
 * ties WITHIN a tier, never across tiers.
 */
const DATA_TYPE_RANK: Record<string, number> = {
  Foundation: 0,
  "SR Legacy": 1,
  "Survey (FNDDS)": 2,
  Branded: 3,
};

export function sortByDataTypePreference(foods: FdcFood[]): FdcFood[] {
  return [...foods].sort(
    (a, b) => (DATA_TYPE_RANK[a.dataType ?? ""] ?? 9) - (DATA_TYPE_RANK[b.dataType ?? ""] ?? 9)
  );
}

/**
 * Collapse near-identical food names (case/whitespace-insensitive) so
 * alternates aren't just the same product from ten different brands.
 * Keeps the first (highest-relevance, since FDC search is score-sorted)
 * occurrence of each normalized description.
 */
export function dedupeByDescription(foods: FdcFood[]): FdcFood[] {
  const seen = new Set<string>();
  const result: FdcFood[] = [];
  for (const food of foods) {
    const key = (food.description || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(food);
  }
  return result;
}

/**
 * Apply the relevance floor to one search batch: keep only foods whose
 * description rates 'exact' or 'close' against `query` — the SAME query
 * that produced this batch (loop-local), never `name` nor a different
 * candidate. A filter, never a re-ranker: survivors keep their original
 * (FDC relevance) order.
 */
function ratePassing(foods: FdcFood[], query: string): FdcFood[] {
  return foods.filter((food) => rateMatchQuality(query, food.description) !== "miss");
}

/**
 * Core find_food pipeline: normalize/alias -> FDC search with preference
 * cascade (floor-filtered per batch) -> Branded fallback (also
 * floor-filtered) -> dedup -> render text output, or an honest
 * no-confident-match response when nothing clears the floor anywhere. The
 * nutrient summary is built entirely from the search response's embedded
 * foodNutrients — no follow-up detail call is made (search hits already
 * embed foodNutrients; see tests/fixtures/README.md fact #2).
 */
export async function findFood(
  searchFoods: SearchFoodsFn,
  name: string,
  options: FindFoodOptions = {}
): Promise<FindFoodResult> {
  const includeBranded = options.includeBranded ?? false;
  const candidateQueries = buildCandidateQueries(name);

  // Preferred data types first (Foundation -> SR Legacy -> Survey), for each
  // candidate query in order (normalized name, then alias fallbacks).
  let foods: FdcFood[] = [];
  let matchedQuery = candidateQueries[0];

  // Remembers the FIRST miss-only preferred-type batch (raw, unfiltered),
  // for the "closest candidates" display if nothing anywhere ever clears
  // the floor. Preferred-type takes priority over Branded — set once,
  // never overwritten.
  let closestPreferred: FdcFood[] = [];

  for (const query of candidateQueries) {
    const result = await searchFoods({
      query,
      dataType: PREFERRED_DATA_TYPES,
      pageSize: 10,
    });
    if (result.foods && result.foods.length > 0) {
      const passing = ratePassing(result.foods, query);
      if (passing.length > 0) {
        foods = passing;
        matchedQuery = query;
        break;
      }
      // Miss-only batch: remember it (if nothing's remembered yet) and
      // continue to the next candidate query instead of breaking — a later
      // alias candidate may still resolve.
      if (closestPreferred.length === 0) {
        closestPreferred = result.foods;
      }
    }
  }

  // Branded fallback: automatic last resort (nothing preferred-type cleared
  // the floor), or explicit opt-in append after a preferred-type success.
  let usedBranded = false;
  let closestBranded: FdcFood[] = [];
  if (foods.length === 0 || includeBranded) {
    for (const query of candidateQueries) {
      const result = await searchFoods({
        query,
        dataType: "Branded",
        pageSize: 10,
      });
      if (!result.foods || result.foods.length === 0) continue;

      const passing = ratePassing(result.foods, query);

      if (foods.length === 0) {
        // Automatic last resort: Branded is all we have. Apply the same
        // floor; a miss-only batch doesn't end the search — a later
        // candidate query might still rescue it.
        if (passing.length > 0) {
          foods = passing;
          matchedQuery = query;
          usedBranded = true;
          break;
        }
        if (closestBranded.length === 0) {
          closestBranded = result.foods;
        }
        continue;
      }

      if (includeBranded) {
        // Explicit opt-in: append only floor-passing Branded results after
        // the preferred-type matches. usedBranded only flips true when
        // something is actually appended.
        if (passing.length > 0) {
          foods = foods.concat(passing);
          usedBranded = true;
        }
        break;
      }
    }
  }

  if (foods.length === 0) {
    // Preferred-type first, then Branded — matches the priority the floor
    // itself applies (preferred data types before Branded last resort).
    const closest = [...closestPreferred, ...closestBranded].slice(0, 3);

    if (closest.length === 0) {
      // Nothing was found at all (raw-empty on every candidate query, every
      // data type) — distinct from "found things, none confident enough".
      return {
        text:
          `No foods found matching "${name}". Try search_foods for a broader search, ` +
          `or find_food with includeBranded: true to search manufacturer data.`,
        alternates: [],
        usedBranded: false,
        matchedQuery,
      };
    }

    const lines: string[] = [
      `No confident match for "${name}" in FDC's preferred data types.`,
      "",
      "Closest candidates (below the confidence floor — likely NOT what you asked for):",
      ...closest.map(formatFoodSummary),
      "",
      `Try search_foods for a broader search, or find_food with includeBranded: true to search manufacturer data.`,
    ];

    return {
      text: lines.join("\n"),
      alternates: [],
      usedBranded: false,
      matchedQuery,
    };
  }

  const deduped = dedupeByDescription(sortByDataTypePreference(foods));
  const best = deduped[0];
  const alternates = deduped.slice(1, 4);
  // `best` always originates from the batch rated against `matchedQuery`
  // (either the winning preferred-type query, or the winning Branded
  // last-resort query — opt-in appends never change matchedQuery, and
  // Foundation/SR Legacy/Survey always outrank Branded in
  // sortByDataTypePreference), so it is guaranteed to have survived the
  // floor as 'exact' or 'close', never 'miss' — the assertion narrows the
  // re-rating to the public field's passing-grade type on that invariant.
  const matchQuality = rateMatchQuality(matchedQuery, best.description) as Exclude<MatchQuality, "miss">;

  const lines: string[] = [];
  lines.push(`Best match for "${name}":`);
  lines.push(formatFoodSummary(best));
  lines.push(`Nutrient summary: ${formatKeyNutrients(best.foodNutrients)}`);
  lines.push(`Use get_food(fdcId: ${best.fdcId}) for the full nutrient breakdown.`);

  if (alternates.length > 0) {
    lines.push("");
    lines.push("Alternates:");
    for (const alt of alternates) {
      lines.push(formatFoodSummary(alt));
    }
  }

  if (matchedQuery !== name.trim().toLowerCase() && matchedQuery !== name && matchedQuery !== normalize(name)) {
    lines.push("");
    lines.push(`(Matched via normalized/alias query: "${matchedQuery}")`);
  }

  if (matchQuality === "close") {
    lines.push("");
    lines.push("Note: closest match is approximate — right food family, but not an exact name match.");
  }

  if (usedBranded && !includeBranded) {
    lines.push("");
    lines.push(
      "Note: no Foundation/SR Legacy/Survey match was found — showing Branded (manufacturer) data as a last resort."
    );
  }

  return {
    text: lines.join("\n"),
    best,
    alternates,
    usedBranded,
    matchedQuery,
    matchQuality,
  };
}
