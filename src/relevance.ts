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
 *   - DERIVED_PRODUCT_HEADS / passesDerivedProductGuard() (round-3, jump-1778
 *     P5) — reject a food's own manufactured derivative (oil/flour/juice/
 *     vinegar/...) landing for a query naming the base food itself
 *   - DISH_HEAD_NOUNS / BABYFOOD_MARKERS / COMPOSITE_DISH_MARKERS /
 *     passesDishGuard() (round-3, jump-1778 P5) — reject a prepared dish,
 *     composite, or babyfood/toddler product landing for a plain
 *     base-ingredient query
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

// ─── Round-3: derived-product guard ────────────────────────────────────────
// jump-1778 P5 (engineering eval of find_food over the 585-food
// household-dictionary corpus). 24/585 cases (the "derived_product" error
// class) were a food's own manufactured/extracted BYPRODUCT returned for a
// query naming the base food itself — "salmon" -> "Fish oil, salmon",
// "coconut" -> "Flour, coconut", "orange" -> "Marmalade, orange". Round-1 and
// Rule-1 both let these through: the query's identity head DOES land in
// segment 1/2 (it's segment 2, the VARIETY slot — "salmon" is a variety of
// "Fish oil"), so passesHeadInGate is satisfied even though the CATEGORY
// slot (segment 1) names the wrong kind of product entirely.

/**
 * Segment-1 word-count ceiling for the round-3 head-noun checks below
 * (derived-product AND dish). Every genuine FDC comma-taxonomy category slot
 * in this corpus is short — 1-3 words ("Flour", "Fish oil", "Bologna",
 * "Sweet potato tots") — even a 5-word Branded segment-1 stays a real
 * category label ("CHOCOLATE WITH CHOCOLATE BUTTERCREAM CAKE" — a real
 * prepared_dish corpus catch). A LONGER segment-1 means the description
 * isn't using the comma as a category/variety divider at all — it's a
 * comma-free (or first-comma-mid-sentence) Survey/FNDDS free-text sentence,
 * and a head-noun word landing inside it is incidental, not a category
 * claim. Corpus-driven: found via a live regression on the adversarial
 * fixture — "chang's pad thai dried rice sticks" search results included
 * "Cake made with glutinous rice and dried beans" (a 7-word, comma-free
 * segment-1 whose FIRST word happens to be "cake"), which the dish guard
 * was wrongly treating as a self-declared-dish category rather than the
 * prose it is. Applying the same cap to the derived-product guard is
 * precautionary symmetry (no known corpus case needs it there today, but
 * the failure mode is identical by construction).
 */
const MAX_CATEGORY_SEGMENT_WORDS = 5;

/**
 * Category-noun vocabulary for a food's own manufactured/extracted
 * derivative — oils, flours, juices, and similar single-ingredient
 * byproducts that are nutritionally distinct from the base food they're
 * made from. Both singular and plural forms are listed explicitly and
 * checked via plain Set membership on normalized words (the same convention
 * ANIMAL_BASE_TERMS uses above — e.g. its own "egg"/"eggs" pair — not
 * wordInSet, whose simple +s/+es suffix tolerance doesn't cover this list's
 * irregular plurals: 'jelly'->'jellies', 'candy'->'candies' in
 * DISH_HEAD_NOUNS below share the same issue). Derived from the real
 * jump-1778 P5 corpus (guard-error-corpus.json "derived_product", 24 rows) —
 * every member here is the literal segment-1 word of an actual wrong
 * find_food pick in that corpus.
 */
export const DERIVED_PRODUCT_HEADS: Set<string> = new Set([
  "oil", "oils",
  "flour", "flours",
  "juice", "juices",
  "vinegar", "vinegars",
  "marmalade", "marmalades",
  "jam", "jams",
  "jelly", "jellies",
  "meal", "meals",
  "starch", "starches",
  "extract", "extracts",
  "butter", "butters",
]);

/**
 * Reject a candidate whose description's SEGMENT-1 head (the category slot)
 * names a derived-product form the query never asked for. Filter-only, like
 * Rule-2 above — never upgrades a candidate, only rejects one round-1/Rule-1
 * already let through.
 *
 * SELF-DECLARATION (mandatory, corpus-verified): exempt whenever the query
 * contains ANY DERIVED_PRODUCT_HEADS word — not necessarily the SAME one the
 * description carries. This deliberately broadens past
 * passesCategoricalGuards' same-term pattern: 'arrowroot starch' vs FDC's
 * "Arrowroot flour" is a real household-dictionary HIT (find_food and the
 * dictionary candidate already agree) — arrowroot flour and arrowroot starch
 * are the same product under two names, so requiring the literal word
 * 'flour' in the query would falsely reject a currently-correct match.
 * Family-level self-declaration costs nothing against the real corpus: every
 * one of the 24 "derived_product" error rows' queries contains ZERO
 * DERIVED_PRODUCT_HEADS words (verified directly against the corpus), so
 * broadening same-word to same-family never reopens a hole for a real bad
 * match.
 *
 * KNOWN ACCEPTED GAP (documented, not fixed — mirrors passesHeadInGate's
 * spring-mix gap above): 'balsamic glaze' -> "Vinegar, balsamic" and
 * 'cooking spray' -> "Oil, PAM cooking spray, original" are both real
 * household-dictionary HITS this guard rejects (neither query contains any
 * DERIVED_PRODUCT_HEADS word, yet both are the correct/only practical FDC
 * match — no separate "glaze" or "spray" entry exists in FDC). No
 * formulation over the corpus-derived vocabulary distinguishes these two
 * from the real oil/flour/juice mismatches without reopening a hole for them
 * (e.g. treating 'spray' or 'glaze' as family words would also exempt
 * unrelated bad matches carrying those words) — round-4 backlog if this
 * proves costly in practice.
 */
export function passesDerivedProductGuard(query: string, description: string | undefined | null): boolean {
  if (!description) return true; // no description: round-1's own miss-on-no-description already governs

  const seg1Words = normalizeWords(description.split(",")[0] || "");
  if (seg1Words.length > MAX_CATEGORY_SEGMENT_WORDS) return true; // too long to be a genuine category slot — prose, not a taxonomy head

  const seg1Set = new Set(seg1Words);
  const hasDerivedHead = [...DERIVED_PRODUCT_HEADS].some((h) => seg1Set.has(h));
  if (!hasDerivedHead) return true; // no-op: segment-1 doesn't name a derived-product category

  const queryWords = new Set(normalizeWords(query));
  return [...DERIVED_PRODUCT_HEADS].some((h) => queryWords.has(h));
}

// ─── Round-3: dish / composite guard ───────────────────────────────────────
// jump-1778 P5. 47/585 cases (the LARGEST single error class,
// "prepared_dish") were a prepared DISH, composite, or babyfood/toddler
// product returned for a query naming a plain base ingredient — "steak" ->
// "Pepper steak", "Oreos" -> "McFLURRY with OREO cookies", "turkey" ->
// "Bologna, turkey". Same root cause as the derived-product guard above: the
// query's identity head lands in segment 2 (the variety slot of a DISH, not
// a plain food), so passesHeadInGate lets it through.

/** Dish/confection category-noun heads — checked against description segment 1 (the category slot), same convention as DERIVED_PRODUCT_HEADS. */
export const DISH_HEAD_NOUNS: Set<string> = new Set([
  "pie", "pies",
  "cake", "cakes",
  "cookie", "cookies",
  "croissant", "croissants",
  "cocktail", "cocktails",
  "succotash",
  "spritzer", "spritzers",
  "candy", "candies",
  "bologna",
  "bratwurst",
  "loaf", "loaves",
  "tots",
]);

/**
 * Babyfood/toddler-food markers — checked ANYWHERE in the description (not
 * just segment 1), since these commonly trail in a later segment: "Babyfood,
 * banana with mixed berries, STRAINED", "Baby Toddler sweet potatoes, STAGE
 * 1".
 */
export const BABYFOOD_MARKERS: Set<string> = new Set(["babyfood", "toddler", "junior", "strained", "stage"]);

/**
 * Composite/assembled-dish token pairs — order-independent (same
 * marker-array shape as VEGAN_FAMILY_MARKERS/CANDIED_FAMILY_MARKERS above,
 * reused via queryHasMarker()), checked against the FULL description since
 * these phrases land past segment 1: "Hamburger, ON WHITE BUN, 1 small
 * patty" (bun in segment 2), "CORN DOGs, frozen, prepared" (spans segment 1
 * itself).
 */
export const COMPOSITE_DISH_MARKERS: string[][] = [
  ["on", "bun"],
  ["on", "buns"],
  ["corn", "dog"],
  ["corn", "dogs"],
];

/**
 * Reject a candidate whose description signals a prepared dish, composite,
 * or babyfood/toddler product the query (a plain base-ingredient name) never
 * asked for. Filter-only, like the guards above.
 *
 * Deliberately CONSERVATIVE (spec instruction — a false reject costs a
 * correct answer): only the three explicit, corpus-derived signal families
 * below trigger a reject. A bare modifier+food compound with no marker word
 * ("Pepper steak" for query "steak", "Dirty rice" for query "rice") is NOT
 * caught here — round-4 backlog; no marker vocabulary separates those from a
 * legitimate "Grilled chicken" or "Basmati rice" without a dish-name
 * gazetteer, and guessing wrong there is exactly the failure mode this
 * module exists to avoid.
 *
 * SELF-DECLARATION (mandatory): a query naming the SAME marker the
 * description carries always passes — 'shrimp cocktail' vs "Shrimp
 * cocktail", 'bologna' vs "Bologna, turkey", 'cake' vs "Cake, ...".
 *
 * KNOWN ACCEPTED GAP (documented, not fixed): FDC's "Candies"/"Cookies"
 * segment-1 category is ALSO USDA's actual, only entry for several
 * legitimately candy/cookie-classified snack foods — 'sprinkles' ->
 * "Candy, sprinkles", 'mini marshmallows' -> "Candies, marshmallows",
 * 'miniature peanut butter cups' -> "Candies, REESE'S Peanut Butter Cups",
 * 'semi-sweet chocolate' -> "Candies, sweet chocolate", and 'brownie mix' ->
 * "Cookies, brownies, dry mix, regular" are all real household-dictionary
 * HITS this guard rejects under strict same-word self-declaration. Unlike
 * the derived-product guard's arrowroot case, family-broadening doesn't
 * rescue these (none of the five queries contains ANY DISH_HEAD_NOUNS word),
 * and candy/candies is itself a required catch for real errors ('tamarind
 * puree' -> "Candies, Tamarind", 'mint' -> "Candy, mint") — no
 * vocabulary-level fix separates the two groups. Round-4 backlog.
 */
export function passesDishGuard(query: string, description: string | undefined | null): boolean {
  if (!description) return true; // no description: round-1's own miss-on-no-description already governs

  const queryWords = normalizeWords(query);
  const querySet = new Set(queryWords);
  const seg1Words = normalizeWords(description.split(",")[0] || "");
  const seg1Set = new Set(seg1Words);
  const descWords = normalizeWords(description);
  const descSet = new Set(descWords);

  // Dish head-noun: segment-1 (the category slot) names a dish/confection.
  // Skipped when segment-1 is too long to be a genuine category slot — see
  // MAX_CATEGORY_SEGMENT_WORDS's own comment (the "Cake made with glutinous
  // rice and dried beans" false trigger this cap exists to fix).
  if (seg1Words.length <= MAX_CATEGORY_SEGMENT_WORDS) {
    const presentHeadNouns = [...DISH_HEAD_NOUNS].filter((h) => seg1Set.has(h));
    if (presentHeadNouns.length > 0 && !presentHeadNouns.some((h) => querySet.has(h))) {
      return false;
    }
  }

  // Babyfood/toddler/junior/strained/stage.
  const presentBaby = [...BABYFOOD_MARKERS].filter((m) => descSet.has(m));
  if (presentBaby.length > 0 && !presentBaby.some((m) => querySet.has(m))) {
    return false;
  }

  // Composite/assembled-dish phrases.
  if (queryHasMarker(descWords, COMPOSITE_DISH_MARKERS) && !queryHasMarker(queryWords, COMPOSITE_DISH_MARKERS)) {
    return false;
  }

  return true;
}
