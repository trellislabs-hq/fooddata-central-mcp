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
 *   - passesHeadInGate() (round-2 Rule-1) — the query's IDENTITY HEAD (the
 *     LAST non-neutral token; CoS-revised from the falsified two-token
 *     design) must land in description segment 1/2, not merely any shared
 *     word there
 *   - VEGAN_FAMILY_MARKERS / ANIMAL_BASE_TERMS / CANDIED_FAMILY_MARKERS /
 *     passesCategoricalGuards() (round-2 Rule-2) — reject vegan/plant-based
 *     queries landing on an animal-derived description, and
 *     candied/crystallized queries landing on a raw/fresh description
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
 *
 * PORT-HARDENING GUARD (jump-1760 F1 — divergence from the port source;
 * flag for backporting to recipe-app's fdc-match-quality.js, do not edit
 * that repo from here): naive ±s/es tolerance lets honorifics collide with
 * real plurals. 'mrs' strips to 'mr' (2 chars) and false-matched
 * "MR. GOODBAR"'s segment-2 token 'mr', rating "Mrs. Dash seasoning"
 * CLOSE against an unrelated candy bar — the exact motivating
 * confident-wrong case the floor exists to catch. The dictionary corpus
 * (recipe-app) never exercised this bug class because grocery product
 * names don't contain 2-letter honorific fragments the way FDC Branded
 * marketing copy does ("MR. GOODBAR", "DR PEPPER", etc.).
 *
 * Fix: plural tolerance now requires the RESULTING STEM to be >=3
 * characters in BOTH directions — stripping a trailing 's'/'es' only
 * counts if what's left is >=3 chars, and appending 's'/'es' only counts
 * if the base word itself is >=3 chars. Every real food plural survives
 * this ('peas' -> 'pea' = 3 chars; 'tomatoes' -> 'tomato' = 6 chars);
 * 2-letter stems/bases ('mrs' -> 'mr', 'mr' + 's') do not.
 */
export function wordInSet(word: string, set: Set<string>): boolean {
  if (set.has(word)) return true;
  if (word.length >= 3 && (set.has(word + "s") || set.has(word + "es"))) return true;
  if (word.endsWith("es") && word.length - 2 >= 3 && set.has(word.slice(0, -2))) return true;
  if (word.endsWith("s") && word.length - 1 >= 3 && set.has(word.slice(0, -1))) return true;
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

// ─── Round-2 Rule-1: head-in-gate ──────────────────────────────────────────
// jump-1773 (round-2 floor). Round-1's segment gate only requires ANY
// significant query word in segment 1/2 — a compound name's DISTINGUISHER
// word can satisfy that gate while the real identity head never appears
// ("old BAY seasoning" gates on "bay" -> bay scallops; "gluten free FLOUR"
// gates on "gluten" -> gluten-free pasta, "flour" itself buried in segment
// 3). Rule-1 tightens this: the query's identity HEAD — the LAST non-neutral
// token — must land in segment 1/2.
//
// CoS revision (jump-1773): the wiki design added (a) a first-significant-
// token requirement to also catch distinguisher-first compounds ("old BAY"
// -> bay scallops, "chipotle in ADOBO"). The corpus replay falsified that
// half: 7 positive rows have a modifier first word ("fresh kale", "dried
// sage", "low sodium chicken broth", "french lentils") absent from their
// CORRECT descriptions, and no rule over the two authorized vocabularies
// separates those from old-bay-class compounds. Last-non-neutral-only keeps
// the gluten-free-flour-class catches at zero positive cost; the compound-
// name catches are round-3 backlog (modifier vocabulary or negative pins).
//
// Known accepted gap ("spring mix" class, DELIBERATE — not a bug): when a
// two-word query's second word is neutral ('mix' is in NEUTRAL_QUERY_WORDS),
// both the first-significant and last-non-neutral tokens collapse to the
// SAME single word ("spring"). Rule-1 cannot distinguish that from a
// legitimately single-headed query in this case, so "spring mix" still
// gates on "spring" alone and is not rejected by this rule (round-1's floor
// already governs it, unchanged). This is a documented, accepted worst-case
// — see eval/round2-delta.md.
export function passesHeadInGate(query: string, description: string | undefined | null): boolean {
  if (!description) return true; // no description: round-1's own miss-on-no-description already governs

  const queryWords = normalizeWords(query);
  const significant = getSignificantWords(queryWords);
  if (significant.length === 0) return true; // degenerate query: round-1 floor already handles it, no-op here

  const nonNeutral = significant.filter((w) => !isNeutralQueryWord(w));
  if (nonNeutral.length === 0) return true; // all-neutral query: round-1 floor already handles it, no-op here

  // Head = the LAST non-neutral token only (jump-1773 CoS revision of the
  // wiki's two-token formulation). The corpus replay FALSIFIED the
  // first-significant-token requirement: for 7 positive rows the first
  // significant word is a genuine prep/freshness/variety modifier ("fresh
  // kale", "dried sage", "low sodium chicken broth", "french lentils") that
  // the CORRECT description never carries — round-1's CLOSE tier tolerates
  // exactly that by design, and no formulation over STOP_WORDS +
  // NEUTRAL_QUERY_WORDS can distinguish those from the distinguisher-first
  // compounds the first-token check aimed at ("old bay" vs "fresh kale" are
  // structurally identical two-non-neutral-word queries). Dropping the
  // first-token requirement keeps every last-token gate catch (the
  // gluten-free-flour class — identity buried past segment 2) at ZERO
  // positive regressions; the old-bay / chipotle-in-adobo compound-name
  // catches move to the round-3 backlog (they need a modifier vocabulary or
  // negative pins — see eval/round2-delta.md).
  const headLast = nonNeutral[nonNeutral.length - 1];

  // Same segment-1/2 gate window as round-1's rateMatchQuality() — a
  // comma-headed FDC taxonomy names category in segment 1, variety in
  // segment 2; a comma-free ALL-CAPS Branded description is one segment.
  const segs = description.split(",");
  const gateWords = new Set(normalizeWords(`${segs[0] || ""} ${segs[1] || ""}`));

  return wordInSet(headLast, gateWords);
}

// ─── Round-2 Rule-2: categorical guards ────────────────────────────────────
// jump-1773 (round-2 floor). Two food-family categories where the query
// asserts a PROPERTY the FDC candidate's description directly contradicts —
// round-1's token-overlap floor is blind to this because the contradicting
// word ('cheese' in "vegan cream cheese" -> "Cheese, cream") is itself part
// of the shared vocabulary, not an absence of overlap.

/**
 * Query markers for the vegan/plant-based family. Token sequences (not
 * strings) so a hyphenated or spaced form of the same phrase both match
 * after normalizeWords() collapses punctuation to whitespace ("dairy-free"
 * and "dairy free" both tokenize to ["dairy", "free"]).
 */
export const VEGAN_FAMILY_MARKERS: string[][] = [
  ["vegan"],
  ["plant", "based"],
  ["meatless"],
  ["dairy", "free"],
];

/**
 * Animal-derived base terms that contradict a vegan-family query anywhere
 * in a candidate's FULL description (not just segment 1/2 — "Sauce, fish,
 * ready-to-serve" must be caught for "vegan fish sauce" even though 'fish'
 * lands in segment 2 there, and a term buried in a later segment, e.g. a
 * "contains milk solids" trailing modifier, must be caught too).
 *
 * Deliberate asymmetry, documented: 'milk', 'butter', and 'cheese' are
 * NEUTRAL on the QUERY side (NEUTRAL_QUERY_WORDS above — a query for
 * "milk" alone is a real, specific food and must not be rejected as
 * vacuous). Here they are DESCRIPTION-side contradiction vocabulary for a
 * different query family (vegan/plant-based) — the two lists serve
 * different purposes and are not meant to mirror each other.
 */
export const ANIMAL_BASE_TERMS: Set<string> = new Set([
  "cheese", "milk", "cream", "butter", "yogurt", "egg", "eggs", "fish",
  "chicken", "beef", "pork", "bacon", "turkey", "meat", "honey", "gelatin",
  "whey", "lard",
]);

/** Query markers for the candied/crystallized family. */
export const CANDIED_FAMILY_MARKERS: string[][] = [["candied"], ["crystallized"]];

/**
 * Description terms that contradict a candied/crystallized query — a
 * simplification (documented, not exhaustive): 'raw' or 'fresh' anywhere in
 * the description is treated as "this is the plain/uncandied form", which
 * covers the corpus's motivating case ("candied ginger" -> "Ginger root,
 * raw") without attempting a full candied-vs-plain taxonomy.
 */
export const CANDIED_CONTRADICTION_TERMS: Set<string> = new Set(["raw", "fresh"]);

/** True if every token of at least one marker sequence appears in queryWords (order-independent). */
function queryHasMarker(queryWords: string[], markers: string[][]): boolean {
  const wordSet = new Set(queryWords);
  return markers.some((marker) => marker.every((tok) => wordSet.has(tok)));
}

/**
 * Rule-2: reject a candidate whose description contradicts a categorical
 * query marker. Filter-only — never upgrades a candidate, only rejects one
 * that round-1 (and Rule-1) already let through.
 */
export function passesCategoricalGuards(query: string, description: string | undefined | null): boolean {
  if (!description) return true; // no description: round-1's own miss-on-no-description already governs

  const queryWords = normalizeWords(query);
  const descWords = normalizeWords(description);
  const descWordSet = new Set(descWords);

  // Self-declaration exemptions (jump-1773 Codex code-review Significants —
  // without these, correctly-labeled Branded matches become false refusals):
  //
  // VEGAN family: an animal noun is exempt ONLY when BOTH hold — the
  // description SELF-DECLARES the family marker AND the noun is one the
  // query itself contains (the product name being veganized). "VEGAN CREAM
  // CHEESE" passes for 'vegan cream cheese' (self-declares; reuses the
  // query's own nouns); plain "Cheese, cream" still rejects (no marker —
  // the guard's core catch); "Spread, vegan, ... contains milk solids"
  // still rejects for 'vegan butter' (self-declares, but 'milk' is not a
  // query noun).
  if (queryHasMarker(queryWords, VEGAN_FAMILY_MARKERS)) {
    const descSelfDeclares = queryHasMarker(descWords, VEGAN_FAMILY_MARKERS);
    const querySet = new Set(queryWords);
    for (const term of ANIMAL_BASE_TERMS) {
      if (descWordSet.has(term)) {
        if (descSelfDeclares && querySet.has(term)) continue;
        return false;
      }
    }
  }

  // CANDIED family: a description that itself says candied/crystallized
  // asserts the candied form — 'fresh'/'raw' in it is provenance wording
  // ("Candied ginger, made from fresh ginger"), not a plain-form landing.
  if (queryHasMarker(queryWords, CANDIED_FAMILY_MARKERS) && !queryHasMarker(descWords, CANDIED_FAMILY_MARKERS)) {
    for (const term of CANDIED_CONTRADICTION_TERMS) {
      if (descWordSet.has(term)) return false;
    }
  }

  return true;
}
