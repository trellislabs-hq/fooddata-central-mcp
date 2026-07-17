/**
 * Module: src/relevance.ts — text-overlap match quality heuristic
 * Purpose: Rates how well an FDC search hit's description actually matches
 *   the query that produced it (exact/close/miss), giving find_food a
 *   relevance FLOOR so it can honestly say "no confident match" instead of
 *   unconditionally taking FDC's nearest neighbor (see jump-1760: the
 *   repo's own eval measured a 0% negative-honesty baseline before this —
 *   "old bay seasoning" -> SCALLOPS, "Mrs. Dash" -> MR. GOODBAR chocolate,
 *   "whole grain mustard" -> BUCKWHEAT, all confidently wrong).
 *
 * Major Sections:
 *   - STOP_WORDS / normalizeWords() / getSignificantWords() / wordInSet() —
 *     tokenization + plural-tolerant set membership
 *   - NEUTRAL_QUERY_WORDS / isNeutralQueryWord() — form/shape/category words
 *     that can never BY THEMSELVES establish food identity
 *   - rateMatchQuality() — EXACT / CLOSE / MISS heuristic vs a description
 *
 * Dependencies: none
 * State: Stateless.
 *
 * Provenance — full circle: this heuristic originated in THIS repo
 * (scripts/audit-pipeline.js rateMatchQuality, ~L261-280), was ported to
 * recipe-app as scripts/dict-pg/lib/fdc-match-quality.js, then hardened
 * across a full-corpus enrichment run there (P1c matched-query provenance,
 * P1d modifier-first CLOSE handling, P1e neutral-word identity gate +
 * deaccenting + plural tolerance — see that file's history). This module
 * ports fdc-match-quality.js's rating logic (rateMatchQuality and its
 * helpers) back into this repo, verbatim in semantics, as a TypeScript
 * module — READ-ONLY source, not modified by this port:
 *   ~/Projects/recipe-app/scripts/dict-pg/lib/fdc-match-quality.js
 * deriveMatchRecord() (the dictionary's match_method/confidence-bucket
 * policy) is intentionally NOT ported — find_food has its own policy
 * (src/find-food.ts) for what a floor-passing/failing food means in an
 * MCP search-and-rank pipeline, distinct from the dictionary's baking
 * pipeline.
 */

// ─── Tokenization ──────────────────────────────────────────────────────────

export const STOP_WORDS: Set<string> = new Set([
  "a", "an", "the", "and", "or", "of", "in", "with", "for", "to", "by",
  "from", "on", "at", "as", "is", "be", "are", "was", "were",
  // Generic food qualifiers that don't narrow down what food it is
  "food", "product", "item", "ingredient", "raw", "prepared",
]);

/**
 * Normalize a string into a word list: lowercase, deaccent, strip
 * punctuation, split on whitespace, drop single-char tokens.
 *
 * Deaccent BEFORE the ascii filter (P1e): 'gruyère' must become 'gruyere',
 * not 'gruy re' — the corpus run matched Gruyère/jalapeño entities to wrong
 * foods because the ñ/è died into a space and the real FDC entries
 * ("Cheese, gruyere", "Peppers, jalapeno") are ASCII.
 */
export function normalizeWords(str: string | undefined | null): string[] {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ") // strip punctuation
    .split(/\s+/)
    .filter((w) => w.length > 1); // drop single-char tokens
}

export function getSignificantWords(words: string[]): string[] {
  return words.filter((w) => !STOP_WORDS.has(w));
}

/**
 * Plural-tolerant set membership: 'tortillas' matches a set containing
 * 'tortilla' and vice versa. A plural-only difference is never a different
 * food.
 */
export function wordInSet(word: string, set: Set<string>): boolean {
  if (set.has(word)) return true;
  if (set.has(word + "s") || set.has(word + "es")) return true;
  if (word.endsWith("es") && set.has(word.slice(0, -2))) return true;
  if (word.endsWith("s") && set.has(word.slice(0, -1))) return true;
  return false;
}

// ─── Identity-neutral query words (P1e — full-corpus review finding) ───────
// Form/shape/category words that can never BY THEMSELVES establish which
// food a query means: 'garlic powder' matching only 'powder' produced
// "Baobab powder"; 'beef broth' matching only 'broth' produced "Fish
// broth"; 'cod fillets' matching only 'fillets' produced "Vegetarian
// fillets". A query word on this list still counts toward total coverage
// (it IS signal — the right "Soup, beef broth" covers 'broth' too); it just
// cannot be the ONLY overlap, and it never serves as the identity head.
// Deliberately NOT on the list: words that name a food-as-such even alone —
// salt, sugar, oil, flour, rice, pepper, wine, juice, butter, cream
// ('kosher salt' -> "Salt, table" is a nutritionally-correct keeper).
export const NEUTRAL_QUERY_WORDS: Set<string> = new Set([
  "powder", "powdered", "paste", "broth", "stock", "sauce", "mix", "blend",
  "seasoning", "seasoned", "flakes", "extract", "spray", "soda", "cheese", "milk",
  "stick", "sticks", "strip", "strips", "fillet", "fillets", "snack", "snacks",
  "wrap", "wraps", "aminos", "sheets", "chips", "meal", "crumbs", "cracker",
  "crackers", "puree", "heart", "hearts", "leaf", "leaves", "mince", "greens",
  "sweetener", "free", "choice", "cubes",
  // P1e Codex-critic Criticals — category-heads behaving exactly like the
  // class above: 'focaccia BREAD' -> "Bread, cheese", 'lobster MEAT' ->
  // "Meat loaf", 'arrowroot STARCH' -> a fish meal. The head rule preferred
  // the generic-head coverer over the right food.
  "bread", "meat", "starch",
  // Full-replay read: 'balsamic GLAZE' -> "Frostings, glaze".
  "glaze",
]);

/**
 * Plural-tolerant list membership: normalizeWords()'s trailing-s strip
 * turns 'chips' into 'chip' and 'greens' into 'green' on the QUERY side,
 * which must not smuggle a listed word past the check (mirrors wordInSet).
 */
export function isNeutralQueryWord(word: string): boolean {
  if (NEUTRAL_QUERY_WORDS.has(word)) return true;
  if (NEUTRAL_QUERY_WORDS.has(word + "s") || NEUTRAL_QUERY_WORDS.has(word + "es")) return true;
  if (word.endsWith("es") && NEUTRAL_QUERY_WORDS.has(word.slice(0, -2))) return true;
  if (word.endsWith("s") && NEUTRAL_QUERY_WORDS.has(word.slice(0, -1))) return true;
  return false;
}

// ─── Match quality rating ──────────────────────────────────────────────────

export type MatchQuality = "exact" | "close" | "miss";

/**
 * Rate the quality of an FDC search hit's description against the query
 * that produced it.
 *
 * Heuristic (approximate — designed to be fast and consistent, not
 * perfect):
 *
 * Step 1: Normalize both strings — lowercase, strip punctuation, split on
 *   whitespace.
 * Step 2: Extract "significant words" from the query by removing common
 *   stop words (articles, prepositions, very generic food words like
 *   "product", "food").
 * Step 3: Check how many significant query words appear in the FDC
 *   description.
 *
 * Rating rules:
 *   EXACT  — ALL significant words from the query appear in the FDC
 *            description (plural-tolerant; description clearly covers the
 *            queried ingredient)
 *   CLOSE  — At least one significant query word names segment 1 or 2 of
 *            the description (the segment gate proved food identity), but
 *            not every modifier matches (right food, wrong form/prep)
 *   MISS   — No significant query word appears in segment 1 or 2, OR no
 *            NON-NEUTRAL query word appears anywhere (form-word-only
 *            overlap like 'powder'/'broth' is not food identity)
 *
 * Why this approach: Exact string matching is too strict (FDC says "Flour,
 * wheat, all-purpose" not "all-purpose flour"). Token-set overlap catches
 * content matches regardless of word order while still penalizing truly
 * wrong matches.
 */
export function rateMatchQuality(query: string, description: string | undefined | null): MatchQuality {
  if (!description) return "miss";

  const queryWords = normalizeWords(query);
  const descWords = new Set(normalizeWords(description));
  const significant = getSignificantWords(queryWords);

  if (significant.length === 0) return "close"; // degenerate case

  // SEGMENT GATE (P1c — live-smoke finding): FDC descriptions are
  // comma-headed taxonomies — segment 1 names the food's category/type
  // ("Tomatoes, canned, ... diced" IS tomatoes), segment 2 typically the
  // variety ("Cheese, cheddar"). A query word must appear (plural-tolerant)
  // in segment 1 OR 2; presence only in trailing segments ('diced' in
  // segment 5) is modifier noise on the WRONG food and rates miss.
  const segs = description.split(",");
  const gateWords = new Set(normalizeWords(`${segs[0] || ""} ${segs[1] || ""}`));
  if (!significant.some((w) => wordInSet(w, gateWords))) return "miss";

  // IDENTITY GATE (P1e — full-corpus review finding): at least one
  // NON-NEUTRAL significant word must appear somewhere in the description,
  // unless the query consists ONLY of neutral words (degenerate — 'milk'
  // is a real query; neutrality is vacuous when there is nothing else).
  const nonNeutral = significant.filter((w) => !isNeutralQueryWord(w));
  if (nonNeutral.length > 0 && !nonNeutral.some((w) => wordInSet(w, descWords))) {
    return "miss";
  }

  // EXACT: all significant query words appear in FDC description
  // (plural-tolerant — "flour tortillas" vs "Tortilla, wheat flour" is exact)
  const allMatch = significant.every((w) => wordInSet(w, descWords));
  if (allMatch) return "exact";

  // CLOSE (P1d — full-corpus finding): the gates above already proved food
  // identity (segment gate: a significant word names segment 1/2; identity
  // gate: a non-neutral word appears). Gate-pass without all-words = right
  // food, wrong form/prep — 'fresh ginger' vs "Ginger root, raw" put the
  // modifier in the primary slot, so the right food shouldn't lose on a
  // word the gates never needed.
  return "close";
}
