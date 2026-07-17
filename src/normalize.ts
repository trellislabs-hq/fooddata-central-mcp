/**
 * Module: Food Name Normalization
 * Purpose: Normalizes a raw food name string and, when an alias exists, maps
 *   it to a better search term before the FDC query is issued. Powers
 *   find_food's ability to resolve casual/plural/prep-word phrasing to the
 *   canonical food term FDC's search index expects.
 *
 * Major Sections:
 *   - normalize() — lowercase/whitespace/hyphen/plural cleanup
 *   - SAFE_PREP_WORDS — prep words that never change the underlying food identity
 *   - FOOD_ALIASES — small table of food-identity aliases (not shelf/brand routing)
 *   - dictionaryLookup() — fallback cascade: exact -> plural -> prep-strip ->
 *     drop-last-word -> "or"-split, tried against a candidate key set
 *   - buildCandidateQueries() — produces an ordered list of search terms to try
 *
 * Dependencies: none (pure functions)
 * State: Stateless.
 *
 * Provenance: normalize(), the dictionaryLookup() cascade shape, and the
 * SAFE_PREP_WORDS set are ported (with adaptation for this server's simpler
 * "candidate list" use case, since there is no local ingredient dictionary
 * here — FDC's own search index is the "dictionary") from:
 *   - recipe-app @ 0b7c654 scripts/lib/aggregate.js (normalize, ~L77-94)
 *   - recipe-app @ 0b7c654 scripts/lib/ingredient-parser.js
 *     (dictionaryLookup cascade + SAFE_PREP_WORDS, ~L394-455)
 * The alias table below is a hand-picked subset of recipe-app's
 * QUERY_FALLBACKS (server.js ~L2666-2734), restricted to food-IDENTITY
 * aliases (e.g. "paneer" -> "paneer cheese") and excluding all
 * Kroger-shelf/brand routing entries (tri-tip, pork shoulder, chuck roast,
 * lamb roasts, flank steak, baby potatoes, blue diamond almonds, etc.) —
 * those are shopping concerns, not food-identity concerns, and are out of
 * scope for this MCP server.
 */

// ─── Basic normalization ──────────────────────────────────────────────────────

/**
 * Normalize a food name string: lowercase, trim, collapse whitespace,
 * normalize hyphens to spaces, and strip a basic trailing plural 's'
 * (after a consonant only — preserves words like "hummus", "couscous").
 *
 * Ported from recipe-app @ 0b7c654 scripts/lib/aggregate.js normalize()
 * (~L77-94). The "strip leading quantities" and "strip leading fresh"
 * transforms from the original are intentionally NOT ported here — this
 * server has no quantity-parsing context, and stripping "fresh" is handled
 * by the SAFE_PREP_WORDS cascade below instead (which is the safer,
 * narrower mechanism).
 */
export function normalize(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    // Normalize hyphens to spaces (fire-roasted -> fire roasted)
    .replace(/-/g, " ")
    // Strip trailing 's' for basic plurals (breasts -> breast, cashews -> cashew)
    // Only after consonants, not after vowels/s (hummus, couscous, tomatoes stay),
    // and only when the resulting stem keeps >=3 chars — the same honorific
    // guard as relevance.ts's wordInSet (jump-1760): the unguarded rule turned
    // "mrs." into "mr.", making "Mrs. Dash seasoning" search as "mr. dash
    // seasoning" and exact-match "MR. GOODBAR". Real food plurals all have
    // stems >=3 ("ribs" -> "rib" still strips). Divergence from the recipe-app
    // port source (aggregate.js normalize) — flagged for backport there.
    .replace(/\b([a-z]{2,}[bcdfghjklmnpqrtvwxyz])s\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Safe prep-word stripping ─────────────────────────────────────────────────

/**
 * Words that NEVER change what physical food you're asking about — safe to
 * strip from the front of a query when the exact/plural key isn't found.
 *
 * Ported VERBATIM from recipe-app @ 0b7c654
 * scripts/lib/ingredient-parser.js (~L415-423).
 *
 * Words NOT in this list (fresh, frozen, dried, canned, cooked, raw,
 * uncooked, boneless, skinless, whole, ground) are intentionally excluded —
 * they can change the product/food identity (e.g. "fresh mozzarella" is a
 * different food than "mozzarella"; "dried cranberries" is a different food
 * than "cranberries"). Also excluded: roasted (roasted red pepper != red
 * pepper), toasted (toasted coconut != coconut), boiled (boiled peanuts !=
 * peanuts) — these can denote a materially different product.
 */
export const SAFE_PREP_WORDS = new Set([
  "chopped", "sliced", "diced", "minced", "grated", "shredded",
  "sauteed", "steamed",
  "roughly", "finely", "coarsely", "thinly", "thickly",
  "lightly", "firmly", "loosely", "tightly", "packed",
  "good", "quality", "crusty", "sturdy", "hard",
  "peeled", "halved", "quartered", "julienned", "cubed",
  "rinsed", "drained", "trimmed", "pitted",
]);

// ─── Food-identity alias table ────────────────────────────────────────────────

/**
 * Small alias table mapping colloquial/regional food names to a term more
 * likely to resolve in FDC's search index. Hand-picked subset of recipe-app's
 * QUERY_FALLBACKS (server.js @ 0b7c654, ~L2666-2734) — food IDENTITY aliases
 * only. Shelf-routing / brand-substitution entries from the original table
 * are deliberately excluded (out of scope for a nutrition-lookup MCP server).
 */
export const FOOD_ALIASES: Record<string, string[]> = {
  paneer: ["paneer cheese", "indian cheese"],
  dashi: ["dashi powder", "hon dashi"],
  "dashi packet": ["dashi powder", "hon dashi"],
  "tokyo negi": ["japanese green onion", "green onion"],
  perilla: ["shiso", "perilla leaves"],
  "enoki mushrooms": ["enoki", "mushrooms"],
  "enoki mushroom": ["enoki", "mushrooms"],
  "scotch fillet": ["ribeye", "rib eye steak"],
  "peeled prawns": ["shrimp", "raw shrimp"],
  "birds eye chilli": ["serrano peppers", "thai chili peppers"],
  "birds eye chili": ["serrano peppers", "thai chili peppers"],
  "green chilies": ["green chiles", "hatch green chiles", "canned green chiles"],
  "green chillies": ["green chiles", "hatch green chiles"],
  "chiles de arbol": ["chile de arbol", "arbol chili powder"],
  "dried chiles de arbol": ["chile de arbol", "arbol chili powder"],
  "ricotta cheese": ["ricotta", "whole milk ricotta"],
  nori: ["seaweed sheets", "nori sheets"],
  "dried nori": ["seaweed sheets", "nori sheets"],
};

// ─── Dictionary-style lookup cascade ──────────────────────────────────────────

export interface LookupMatch {
  matchedKey: string;
  method:
    | "exact"
    | "plural_es"
    | "plural_s"
    | "plural_add_s"
    | "prep_strip"
    | "drop_last"
    | "or_split";
}

/**
 * Try to resolve `key` against `known` (a Set of keys considered
 * "resolvable" — here, the alias table's keys) using the same fallback
 * cascade recipe-app uses against its local ingredient dictionary:
 * exact -> plural/singular variants -> safe-prep-word strip -> drop-last-word
 * -> "or"-split.
 *
 * Ported from recipe-app @ 0b7c654 scripts/lib/ingredient-parser.js
 * dictionaryLookup() (~L394-455), adapted to take an explicit `known` key
 * set instead of a module-level ingredientDict.
 */
export function dictionaryLookup(
  key: string,
  known: Set<string>
): LookupMatch | null {
  if (!key) return null;

  if (known.has(key)) {
    return { matchedKey: key, method: "exact" };
  }

  // Plural/singular variants
  if (key.endsWith("es") && known.has(key.slice(0, -2))) {
    return { matchedKey: key.slice(0, -2), method: "plural_es" };
  }
  if (key.endsWith("s") && known.has(key.slice(0, -1))) {
    return { matchedKey: key.slice(0, -1), method: "plural_s" };
  }
  if (!key.endsWith("s") && known.has(key + "s")) {
    return { matchedKey: key + "s", method: "plural_add_s" };
  }

  // Safe prep-word stripping from the front
  const words = key.split(" ");
  for (let start = 1; start < words.length; start++) {
    if (!SAFE_PREP_WORDS.has(words[start - 1])) break;
    const shorter = words.slice(start).join(" ");
    if (known.has(shorter)) {
      return { matchedKey: shorter, method: "prep_strip" };
    }
    if (shorter.endsWith("es") && known.has(shorter.slice(0, -2))) {
      return { matchedKey: shorter.slice(0, -2), method: "prep_strip" };
    }
    if (shorter.endsWith("s") && known.has(shorter.slice(0, -1))) {
      return { matchedKey: shorter.slice(0, -1), method: "prep_strip" };
    }
    if (!shorter.endsWith("s") && known.has(shorter + "s")) {
      return { matchedKey: shorter + "s", method: "prep_strip" };
    }
  }

  // Drop the last word
  if (words.length > 1) {
    const shorter = words.slice(0, -1).join(" ");
    if (known.has(shorter)) {
      return { matchedKey: shorter, method: "drop_last" };
    }
  }

  // Split on " or " (or "/")
  const orKey = key.includes("/") ? key.replace(/\//g, " or ") : key;
  if (orKey.includes(" or ")) {
    const alternatives = orKey
      .split(" or ")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const alt of alternatives) {
      if (known.has(alt)) {
        return { matchedKey: alt, method: "or_split" };
      }
    }
  }

  return null;
}

// ─── Candidate query builder ──────────────────────────────────────────────────

/**
 * Build an ordered list of candidate search terms for a raw food name:
 * 1. The normalized input itself (always tried first — FDC's own index is
 *    usually the best "dictionary").
 * 2. If the normalized input (or a fallback-cascade match against the
 *    alias table) resolves to a known alias, its mapped terms follow.
 *
 * Order matters: callers should try candidates in sequence and stop at the
 * first that yields results, so the raw normalized term is never skipped
 * in favor of an alias.
 */
export function buildCandidateQueries(rawName: string): string[] {
  const normalized = normalize(rawName);
  const candidates: string[] = [normalized];

  const known = new Set(Object.keys(FOOD_ALIASES));
  const match = dictionaryLookup(normalized, known);

  if (match) {
    for (const alias of FOOD_ALIASES[match.matchedKey]) {
      if (!candidates.includes(alias)) candidates.push(alias);
    }
  }

  return candidates;
}
