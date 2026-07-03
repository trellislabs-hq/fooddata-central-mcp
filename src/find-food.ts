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
 *   - findFood() — orchestrates: normalize/alias candidates -> preferred-type
 *     search -> Branded fallback (opt-in or last-resort) -> dedup -> format
 *
 * Dependencies:
 *   - ./fdc-client.ts (FdcSearchParams/FdcSearchResult/FdcFood types)
 *   - ./format.ts (formatFoodSummary, formatKeyNutrients)
 *   - ./normalize.ts (buildCandidateQueries)
 *
 * State: Stateless. Takes a `searchFoods` function as a parameter (typically
 * `client.searchFoods.bind(client)`) rather than importing FdcClient
 * directly, so tests can inject a fixture-backed stub instead of a real
 * HTTP-backed client.
 */

import type { FdcFood, FdcSearchParams, FdcSearchResult } from "./fdc-client.js";
import { formatFoodSummary, formatKeyNutrients } from "./format.js";
import { buildCandidateQueries, normalize } from "./normalize.js";

export type SearchFoodsFn = (params: FdcSearchParams) => Promise<FdcSearchResult>;

export interface FindFoodOptions {
  includeBranded?: boolean;
}

export interface FindFoodResult {
  /** Rendered tool output text (what the MCP tool call returns). */
  text: string;
  /** Best match, if any were found (undefined only for the no-results case). */
  best?: FdcFood;
  /** Up to 3 alternates alongside the best match. */
  alternates: FdcFood[];
  /** True if Branded data had to be used (opt-in or last-resort). */
  usedBranded: boolean;
  /** The candidate query string that actually produced results. */
  matchedQuery: string;
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
 * Core find_food pipeline: normalize/alias -> FDC search with preference
 * cascade -> Branded fallback -> dedup -> render text output. The nutrient
 * summary is built entirely from the search response's embedded
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

  for (const query of candidateQueries) {
    const result = await searchFoods({
      query,
      dataType: PREFERRED_DATA_TYPES,
      pageSize: 10,
    });
    if (result.foods && result.foods.length > 0) {
      foods = result.foods;
      matchedQuery = query;
      break;
    }
  }

  // Branded fallback: explicit opt-in, or automatic last resort when
  // nothing else matched across any candidate query.
  let usedBranded = false;
  if (foods.length === 0 || includeBranded) {
    for (const query of candidateQueries) {
      const result = await searchFoods({
        query,
        dataType: "Branded",
        pageSize: 10,
      });
      if (result.foods && result.foods.length > 0) {
        if (foods.length === 0) {
          // Automatic last resort: Branded is all we have.
          foods = result.foods;
          matchedQuery = query;
          usedBranded = true;
        } else if (includeBranded) {
          // Explicit opt-in: append Branded results after preferred-type matches.
          foods = foods.concat(result.foods);
          usedBranded = true;
        }
        break;
      }
    }
  }

  if (foods.length === 0) {
    return {
      text:
        `No foods found matching "${name}". Try search_foods for a broader search, ` +
        `or find_food with includeBranded: true to search manufacturer data.`,
      alternates: [],
      usedBranded: false,
      matchedQuery,
    };
  }

  const deduped = dedupeByDescription(foods);
  const best = deduped[0];
  const alternates = deduped.slice(1, 4);

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
  };
}
