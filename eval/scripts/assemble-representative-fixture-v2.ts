/**
 * Module: household-representative-v2 fixture assembler (CLI)
 * Purpose: Derives eval/fixtures/household-representative-v2.json — the
 *   FREQUENCY-DEFINED corpus frame (spec spec_findfood_representative_eval_v1_
 *   2026-07-19.md "FRAME UPGRADE v2"): the top-1,000 most-recipe-frequent
 *   canonical dictionary entries across the FULL 935-recipe recipe-app
 *   corpus (superseding v1's 142-name four-cart-battery convenience sample).
 *   A SCRIPT, not a hand-built file — re-derivable from the corpus + dictionary
 *   at any pinned SHA, byte-identical given the same --date. DETERMINISTIC
 *   ONLY: this produces CANDIDATE labels (labelProvenance:
 *   "dictionary-candidate-unverified"), never final ground truth — the
 *   independent-judge + human-audit adjudication pass (spec "v2 GROUND
 *   TRUTH") is a SEPARATE, later, out-of-scope pass. Makes ZERO network
 *   calls, ZERO LLM calls: reads the recipe corpus and the dictionary/pins/
 *   rulings via `git -C <recipe-app> show <commit>:<path>` — NEVER the
 *   working tree (data/shared-recipes.json is prod-maintained and growing;
 *   pinning a commit is what makes this fixture reproducible), NEVER a
 *   cross-repo import (recipe-app's ingredient-parser.js/aggregate.js/
 *   ingredient-name-index.js logic is PORTED below, not imported).
 *
 *   jump-1778 P2 (this pass) REPLACED the original "exact resolution tier
 *   only" scope with the FULL production dictionaryLookup() cascade (Thomas
 *   ruling 2026-07-19: exact-tier-only eligibility undercounts — 843/2224
 *   distinct keys — and biases the frame toward easy names). The cascade
 *   added below (SAFE_PREP_WORDS/lookupCandidate/dictionaryLookup) is a
 *   faithful port of recipe-app @ 7e681cb scripts/lib/ingredient-parser.js
 *   lookupCandidate()/dictionaryLookup() (~L439-675) — NOT the simplified,
 *   already-diverged cascade at src/normalize.ts. That file is this MCP
 *   server's OWN find_food candidate-query builder against a 14-entry food-
 *   identity alias table (wired from src/find-food.ts — genuine production
 *   code, just not a faithful recipe-app port), self-documented as "adapted
 *   ...since there is no local ingredient dictionary here." It diverges from
 *   7e681cb's real dictionaryLookup() in every one of: no
 *   QUALIFIER_ONLY_KEYS guard at all; SAFE_PREP_WORDS missing 'freshly'/
 *   'softened'/'torn' (a stale, pre-jump-1701 word list); prep-strip returns
 *   the FIRST hit found rather than the most-specific hit across the whole
 *   safe-prefix chain; or-split tries only a direct alternative match,
 *   missing the or_split+shorten and or_split+front_drop sub-stages
 *   entirely. Left untouched per CONSTRAINTS (out of scope, and correct on
 *   its own terms for its actual job); every divergence above is cited
 *   again, in-line, at each cascade tier below.
 *
 * Algorithm:
 *   1. Read data/shared-recipes.json at the resolved --commit via git show
 *      (raw Buffer, for an exact content sha256 — NOT a decoded-then-
 *      re-encoded string, which could theoretically diverge on edge-case
 *      byte sequences) — 935 recipes, each with an `ingredients: string[]`.
 *   2. Read data/ingredient-dictionary.base.json, fdc-pins.json, and
 *      identity-rulings.json at the SAME commit (unlike v1, there is no
 *      query-production-vs-label-production commit split here — the corpus
 *      and the dictionary are read from one pinned commit).
 *   3. Build the name index from base.json ONLY (buildNameIndex, IMPORTED
 *      from the v1 assembler — no learned.json, per the jump-1778 dispatch
 *      instruction, same as v1).
 *   4. Per ingredient line: extractProductKey(raw, nameIndex) — a faithful
 *      port of recipe-app's scripts/lib/ingredient-parser.js function of the
 *      same name (quantity/unit/prep stripping, container-size folding,
 *      qualifier-only-key guard, THEN an internal canonicalize() call against
 *      the SAME nameIndex — production's OWN inline resolve attempt, exact +
 *      -es/-s plural only) — produces a `key`. That key is then run through
 *      dictionaryLookup(dict, nameIndex, key) — a faithful port of
 *      production's SEPARATE, SECOND resolution stage — mirroring
 *      production's actual resolveIngredientLine() = extractProductKey() +
 *      dictionaryLookup() pipeline (server.js @ 7e681cb, wired live since
 *      jump-1701/P2a per recipe-app/CLAUDE.md's own "dictionaryLookup()
 *      fallbacks" bullet) EXACTLY, MINUS the MISS-ONLY colon-artifact
 *      fallback (tryColonFallback — a narrow blog-formatting special case
 *      layered on top of the cascade, not part of "the resolution cascade"
 *      this pass's dispatch scoped: "exact -> plural -> safe-prep-word-strip
 *      -> drop-last-word -> or-split"). dictionaryLookup's OWN qualifier-
 *      only-key guard (isQualifierOnlyKey, checked BEFORE any dict/index
 *      lookup, at every candidate — already ALSO used inside
 *      extractProductKey's own inline canonicalize gate, so this is the SAME
 *      guard reused, not a new one) is what makes this pass a CORRECTNESS
 *      fix as well as a coverage expansion: the prior exact-tier-only
 *      assembler's raw `dict[key]` check had no such guard at its own layer,
 *      so a qualifier-only parser-tail residue that survives
 *      extractProductKey's inline guard unresolved (e.g. "large", which the
 *      base dictionary carries as a poisoned literal entry — see
 *      QUALIFIER_ONLY_KEYS's own block comment below) could still mis-
 *      resolve via the bare `dict[key]` hasOwnProperty check; the full
 *      cascade now correctly refuses it, matching production.
 *   5. FREQUENCY = count of DISTINCT recipes each canonical entry appears
 *      in — the cascade's OWN matchedKey on a hit (NOT necessarily
 *      extractProductKey's raw `key`, which may still be a pre-cascade
 *      candidate like "sliced mushroom") — or, for unresolved lines, each
 *      raw extracted key. A recipe using the same key twice (e.g. shredded
 *      AND cubed cheddar in one recipe) contributes ONE occurrence, not two
 *      (aggregateCorpus dedupes with a per-recipe Set before the cross-recipe
 *      tally).
 *   6. Each resolved key classifies into eligible (has fdc_ref, preferred
 *      data_type) / no_ref (resolved, no fdc_ref) / non_preferred_type
 *      (resolved, has fdc_ref, but data_type isn't Foundation/SR Legacy/
 *      Survey) — mirroring v1's classifyName bucket split exactly. Every
 *      unresolved key becomes an "unresolved" excluded row. evidence_class
 *      per eligible row is classifyEvidence(), IMPORTED UNCHANGED from the
 *      v1 assembler (same pin-binding guard: a fdc-pins.json entry only
 *      counts as human_pin when its OWN fdc_id matches THIS row's fdc_ref).
 *      Each eligible row's `reason` records which cascade tier resolved it
 *      (spec DONE WHEN: "records WHICH tier resolved each newly-eligible
 *      name") — the FIRST-SEEN tier for that canonical key across the
 *      corpus (a key may be reachable via more than one raw ingredient
 *      phrasing; one representative tier is recorded, not one per
 *      occurrence).
 *   7. A defensive name-collision dedup (dedupeCandidatesByName) runs across
 *      ALL candidates (eligible + all three excluded buckets) BEFORE ranking
 *      — priority eligible > no_ref > non_preferred_type > unresolved, ties
 *      broken by higher occurrence — because the fixture's row identity is
 *      `entity.product_name` (per spec: "query = entity.product_name"), not
 *      the canonical dictionary KEY, and validateFixtureSchema requires
 *      every case/excluded name to be globally unique. Two distinct
 *      canonical keys sharing one product_name string is not expected in a
 *      curated dictionary, but the guard makes that assumption load-bearing
 *      rather than silent (an uncaught collision would otherwise throw deep
 *      inside validateFixtureSchema with a less actionable message).
 *   8. Eligible candidates rank by occurrences DESC, product_name ASC tie-
 *      break, then slice to --target-n (default 1,000; if fewer unique
 *      eligible entries exist, ALL of them are taken and provenance.
 *      parameters.actualN records the true count — spec: "if fewer unique
 *      resolvable exist, take all + report actual N prominently").
 *
 * Major Sections:
 *   - CLI arg parsing (--date REQUIRED, --commit, --recipe-app,
 *     --corpus-path, --out, --target-n)
 *   - gitShowBuffer() / gitShow() / gitRevParseBlob() / gitRevParseCommit() —
 *     recipe-app repo reads (re-implemented locally: v1's equivalents are
 *     NOT exported and the v1 script is never modified)
 *   - Ported recipe-app parsing primitives: normalize() (aggregate.js),
 *     parseFraction(), QUALIFIER_ONLY_KEYS/isQualifierOnlyKey()
 *     (ingredient-parser.js), canonicalize() (wraps v1's imported
 *     resolveName — the SAME strict lookup, passthrough-wrapped here exactly
 *     as production's ingredient-name-index.js does), extractProductKey()
 *     (ingredient-parser.js, the full faithful port)
 *   - jump-1778 P2: the full dictionaryLookup() cascade — SAFE_PREP_WORDS
 *     (35-word set, matches 7e681cb exactly incl. 'freshly'/'softened'/
 *     'torn'), lookupCandidate() (literal dict-key check, then — unless
 *     literalOnly — the names index; qualifier-guarded at every candidate),
 *     dictionaryLookup() (the 5-tier ladder: exact,literalOnly -> plural
 *     -es/-s/+s -> prep-strip most-specific-wins -> drop-last -> or-split
 *     direct/shorten/front-drop) — both re-implemented locally against
 *     explicit dict/nameIndex params (the same module-closure-to-parameter
 *     adaptation canonicalize() above already makes), faithful to
 *     recipe-app @ 7e681cb scripts/lib/ingredient-parser.js L439-675
 *   - aggregateCorpus() — per-recipe within-recipe dedup (now keyed by the
 *     CASCADE's matchedKey, not just extractProductKey's raw key), cross-
 *     recipe distinct-recipe-count tally, first-seen cascade tier per
 *     canonical key, exported for direct unit testing
 *   - classifyResolvedKey() / unresolvedToExcluded() — per-key bucket
 *     decision (eligible/no_ref/non_preferred_type/unresolved), evidence
 *     class wiring, cascade-tier-aware reason string
 *   - dedupeCandidatesByName() / rankEligible() — pure, exported, directly
 *     unit-testable name-collision guard and top-N ranking with documented
 *     tie order
 *   - buildFixtureV2() — the PURE core (no I/O): takes already-loaded
 *     recipes/dict/pins/rulings/hashes and returns the assembled,
 *     schema-validated EvalFixture + a summary object (incl. per-tier
 *     newly-eligible counts — eligible rows resolved via any tier other
 *     than "exact"). Calling this twice with identical input is how the
 *     byte-identical-rerun test works without needing a live git corpus
 *     fetch inside the test.
 *   - main() — orchestrates the git reads, calls buildFixtureV2(), writes
 *     the fixture, prints the summary (coverage unique+weighted, evidence
 *     class counts, per-tier newly-eligible breakdown, top-20 frequency head)
 *
 * Dependencies: node:child_process (git shell-outs), node:crypto (sha256),
 *   node:fs, node:path, node:url, ../lib/fixture.js (types +
 *   validateFixtureSchema), ./assemble-representative-fixture.js (v1 script
 *   — REUSED, never modified: buildNameIndex, resolveName,
 *   PREFERRED_DATA_TYPES, classifyEvidence, and the Dictionary/DictEntry/
 *   FdcPins/IdentityRulings types)
 * State: Reads recipe-app on disk (only to locate the repo for git show) and
 *   via git show (corpus + dictionary/pins/rulings) — READ-ONLY, no writes
 *   to recipe-app, no working-tree reads. Writes ONE file: --out (default
 *   eval/fixtures/household-representative-v2.json).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateFixtureSchema,
  type EvalFixture,
  type EvidenceClass,
  type ExcludedEvalCase,
  type PositiveEvalCase,
  type PreferredDataType,
} from "../lib/fixture.js";
import {
  buildNameIndex,
  resolveName,
  PREFERRED_DATA_TYPES,
  classifyEvidence,
  type Dictionary,
  type DictEntry,
  type FdcPins,
  type IdentityRulings,
} from "./assemble-representative-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RECIPE_APP = "/Users/thomasstewart/Projects/recipe-app";
const DEFAULT_COMMIT = "7e681cb";
const DEFAULT_CORPUS_PATH = "data/shared-recipes.json";
const DEFAULT_OUT = path.join(__dirname, "..", "fixtures", "household-representative-v2.json");
const DEFAULT_TARGET_N = 1000;
const FIXTURE_ID = "household-representative-v2";

// ─── CLI args ────────────────────────────────────────────────────────────

interface Args {
  date: string;
  commit: string;
  recipeAppPath: string;
  corpusPath: string;
  outPath: string;
  targetN: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : undefined;
  };

  const date = get("--date");
  if (!date) {
    throw new Error(
      "--date=<ISO-8601> is required — this fixture's provenance.derivedAt must never come from Date.now() " +
        "(spec S9: 'date passed in as an argument (no Date.now in committed outputs)'). " +
        "Example: --date=2026-07-19T00:00:00.000Z"
    );
  }

  const targetNRaw = get("--target-n");
  const targetN = targetNRaw === undefined ? DEFAULT_TARGET_N : Number(targetNRaw);
  if (!Number.isInteger(targetN) || targetN <= 0) {
    throw new Error(`--target-n must be a positive integer, got ${JSON.stringify(targetNRaw)}`);
  }

  return {
    date,
    commit: get("--commit") ?? DEFAULT_COMMIT,
    recipeAppPath: get("--recipe-app") ?? DEFAULT_RECIPE_APP,
    corpusPath: get("--corpus-path") ?? DEFAULT_CORPUS_PATH,
    outPath: get("--out") ?? DEFAULT_OUT,
    targetN,
  };
}

// ─── recipe-app repo reads (git show — never the working tree) ───────────
// Re-implemented locally rather than imported: the v1 assembler's equivalent
// helpers (gitShow/gitRevParseBlob/gitRevParseCommit) are NOT exported, and
// the v1 script is never modified (CONSTRAINTS).

function gitShowBuffer(repoPath: string, commit: string, filePath: string): Buffer {
  return execFileSync("git", ["-C", repoPath, "show", `${commit}:${filePath}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitShow(repoPath: string, commit: string, filePath: string): string {
  return execFileSync("git", ["-C", repoPath, "show", `${commit}:${filePath}`], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitRevParseBlob(repoPath: string, commit: string, filePath: string): string {
  return execFileSync("git", ["-C", repoPath, "rev-parse", `${commit}:${filePath}`], { encoding: "utf-8" }).trim();
}

function gitRevParseCommit(repoPath: string, ref: string): string {
  return execFileSync("git", ["-C", repoPath, "rev-parse", ref], { encoding: "utf-8" }).trim();
}

// ─── Ported recipe-app parsing primitives ─────────────────────────────────
// Faithful ports of scripts/lib/aggregate.js (normalize) and
// scripts/lib/ingredient-parser.js (parseFraction, the qualifier-only-key
// guard, extractProductKey) — see recipe-app's own files for the originals.
// canonicalize() wraps v1's IMPORTED resolveName exactly as production's
// scripts/lib/ingredient-name-index.js canonicalize() wraps its own
// resolveName: hit -> canonical key, miss -> input lowercased (passthrough).

/** Ported from recipe-app scripts/lib/aggregate.js normalize(). */
export function normalize(name: string): string {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^\d+[\s/-]*(?:oz|ounce|lb|pound|cup|can|jar|bottle|package|pkg|ct)s?\s*/i, "")
    .replace(/-/g, " ")
    .replace(/([bcdfghjklmnpqrtvwxyz])s\b/g, "$1")
    .replace(/^fresh\s+(?!frozen)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ported from recipe-app scripts/lib/ingredient-parser.js parseFraction(). */
export function parseFraction(str: string | null | undefined): number | null {
  if (!str) return null;
  str = str.trim();
  const unicodeFracs: Record<string, number> = {
    "⅛": 0.125, "⅙": 1 / 6, "⅕": 0.2, "¼": 0.25, "⅓": 1 / 3, "⅜": 0.375, "⅖": 0.4,
    "½": 0.5, "⅗": 0.6, "⅝": 0.625, "⅔": 2 / 3, "¾": 0.75, "⅘": 0.8, "⅚": 5 / 6, "⅞": 0.875,
  };
  for (const [ch, val] of Object.entries(unicodeFracs)) {
    if (str.includes(ch)) {
      const before = str.replace(ch, "").trim();
      return (before ? parseInt(before) : 0) + val;
    }
  }
  const fracRangeMatch2 = str.match(/^(\d+\/\d+)\s*[-–]\s*(\d+(?:\/\d+)?)$/);
  if (fracRangeMatch2) {
    const parseSimple = (s: string): number => (s.includes("/") ? parseInt(s.split("/")[0]) / parseInt(s.split("/")[1]) : parseFloat(s));
    return parseSimple(fracRangeMatch2[2]);
  }
  if (str.includes(" ") && str.includes("/")) {
    const parts = str.split(/\s+/);
    const whole = parseInt(parts[0]) || 0;
    const frac = parts.slice(1).join("").replace(/^[-–]/, "");
    const [n, d] = frac.split("/");
    return parseInt(d) ? whole + parseInt(n) / parseInt(d) : whole || null;
  }
  const dashFracMatch = str.match(/^(\d+)\s*[-–]\s*(\d+)\s*\/\s*(\d+)$/);
  if (dashFracMatch) {
    const whole = parseInt(dashFracMatch[1]);
    const num = parseInt(dashFracMatch[2]);
    const den = parseInt(dashFracMatch[3]);
    return den ? whole + num / den : whole || null;
  }
  if (str.includes("/")) {
    const [n, d] = str.split("/");
    return parseInt(d) ? parseInt(n) / parseInt(d) : null;
  }
  if (str.includes("-") || str.includes("–")) {
    const parts = str.split(/[-–]/);
    return parseFloat(parts[parts.length - 1]) || null;
  }
  return parseFloat(str) || null;
}

// ── Qualifier-only key guard (ported from ingredient-parser.js) ──────────
export const QUALIFIER_ONLY_KEYS = new Set([
  "medium", "small", "large", "fresh", "peeled", "cooked",
  "chopped", "sliced", "diced", "minced", "grated", "torn", "softened", "freshly",
  "ripe",
  "big", "bigger", "biggest", "thin", "thick", "heaping", "scant", "packed",
  "level", "generous", "several", "few", "fine", "grind", "whole",
]);
const QUALIFIER_INTENSIFIERS = new Set(["very", "extra", "more", "most", "super"]);

function isQualifierToken(token: string): boolean {
  if (QUALIFIER_ONLY_KEYS.has(token) || QUALIFIER_INTENSIFIERS.has(token)) return true;
  for (const suffix of ["s", "es", "r", "er", "st", "est"]) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    if (QUALIFIER_ONLY_KEYS.has(stem)) return true;
    if (
      (suffix === "er" || suffix === "est") &&
      stem.length >= 2 &&
      stem[stem.length - 1] === stem[stem.length - 2] &&
      QUALIFIER_ONLY_KEYS.has(stem.slice(0, -1))
    )
      return true;
  }
  return false;
}

export function isQualifierOnlyKey(key: string): boolean {
  if (!key) return false;
  return key.split(" ").every(isQualifierToken);
}

/** Ported from recipe-app scripts/lib/ingredient-name-index.js canonicalize() — wraps v1's imported resolveName (the SAME strict exact+plural lookup) with production's passthrough-on-miss behavior. */
export function canonicalize(name: string, nameIndex: Map<string, string>): string {
  const resolved = resolveName(name, nameIndex);
  if (resolved !== undefined) return resolved;
  return (name || "").toLowerCase();
}

// ── extractProductKey (ported from ingredient-parser.js) ─────────────────
const PREP_COMMA = /,\s*(?!or\b|and\b|about\b|plus\b).*$/;
const PAREN_STRIP = /\s*\([^)]*\)\s*/g;
const QTY_RE =
  /^([⅛⅙⅕¼⅓⅜⅖½⅗⅝⅔¾⅘⅚⅞]|\d+\s*[⅛⅙⅕¼⅓⅜⅖½⅗⅝⅔¾⅘⅚⅞]|\d+\s*[-–\s]\s*\d+\s*\/\s*\d+|\d+\s*\/\s*\d+\s*[-–]\s*\d+(?:\s*\/\s*\d+)?|\d+\s*\/\s*\d+|\d+\.?\d*(?:\s*[-–]\s*\d+\.?\d*)?)\s*/;
const UNIT_RE =
  /^(cups?|tablespoons?|tbsps?|teaspoons?|tsps?|ounces?|oz|pounds?|lbs?|cloves?|heads?|bunch(?:es)?|cans?|jars?|bottles?|packages?|pkgs?|bags?|stalks?|sprigs?|slices?|pieces?|sticks?|strips?|pinch(?:es)?|dash(?:es)?|handfuls?|quarts?|qts?|gallons?|gals?|pints?|pts?|litres?|liters?|ml|grams?|g|kilograms?|kg)\b\.?\s*/i;

export interface ExtractedKey {
  key: string;
  qty: number | null;
  unit: string | null;
}

/**
 * Faithful port of recipe-app scripts/lib/ingredient-parser.js
 * extractProductKey(raw) — identical logic, with the module-level `nameIndex`
 * closure variable replaced by an explicit parameter (the same adaptation
 * v1's ported buildNameIndex/resolveName made — a pure/testable function out
 * of a stateful module, not a behavior change).
 */
export function extractProductKey(raw: string, nameIndex: Map<string, string>): ExtractedKey {
  let text = raw.trim();

  const UNICODE_FRACS: Record<string, string> = {
    "⅛": "1/8", "⅙": "1/6", "⅕": "1/5", "¼": "1/4", "⅓": "1/3", "⅜": "3/8", "⅖": "2/5",
    "½": "1/2", "⅗": "3/5", "⅝": "5/8", "⅔": "2/3", "¾": "3/4", "⅘": "4/5", "⅚": "5/6", "⅞": "7/8",
  };
  for (const [uc, ascii] of Object.entries(UNICODE_FRACS)) {
    if (text.includes(uc)) {
      text = text.replace(new RegExp("(\\d)" + uc, "g"), "$1 " + ascii);
      text = text.replace(new RegExp(uc, "g"), ascii);
    }
  }

  let containerOz: number | null = null;
  const CONTAINER_WORDS = "cans?|jars?|bottles?|packages?|pkgs?";

  const containerParenMatch = text.match(new RegExp(`\\((\\d+\\.?\\d*)\\s*[-–]?\\s*(?:ounces?|oz\\.?)(?:\\s*weight)?\\)\\s*(?=${CONTAINER_WORDS})`, "i"));
  if (containerParenMatch) {
    containerOz = parseFloat(containerParenMatch[1]);
    text = text.replace(containerParenMatch[0], " ").trim();
  }

  if (!containerOz) {
    const containerInlineMatch = text.match(new RegExp(`^(\\d+\\.?\\d*)\\s+(\\d+\\.?\\d*)\\s*[-–]?\\s*(?:ounces?|oz\\.?)\\s+(${CONTAINER_WORDS})\\b`, "i"));
    if (containerInlineMatch) {
      const count = parseFloat(containerInlineMatch[1]);
      containerOz = parseFloat(containerInlineMatch[2]);
      const totalOz = count * containerOz;
      text = totalOz + " oz " + text.slice(containerInlineMatch[0].length).trim();
      containerOz = null;
    }
  }

  if (!containerOz) {
    const containerAfterMatch = text.match(
      new RegExp(`(?:${CONTAINER_WORDS})\\s*\\((\\d+\\.?\\d*)\\s*[-–]?\\s*(?:ounces?|oz\\.?)(?:\\s*(?:each|weight))?(?:[;,]\\s*\\d+g)?\\)`, "i")
    );
    if (containerAfterMatch) {
      containerOz = parseFloat(containerAfterMatch[1]);
      text = text.replace(containerAfterMatch[0], text.match(new RegExp(`(${CONTAINER_WORDS})`, "i"))?.[0] || "").trim();
    }
  }

  text = text.replace(PAREN_STRIP, " ").trim();
  text = text.replace(/^optional:\s*/i, "");

  const WORD_NUMBERS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12" };
  const wordMatch = text.match(/^(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b\s*/i);
  if (wordMatch) {
    text = WORD_NUMBERS[wordMatch[1].toLowerCase()] + " " + text.slice(wordMatch[0].length);
  }

  text = text.replace(/^half\s+(?:a|of|an)\s+/i, "0.5 ");
  text = text.replace(/^half\s+/i, "0.5 ");

  text = text.replace(/^(\d+(?:\/\d+)?(?:\.\d+)?)\s+to\s+(\d+(?:\/\d+)?(?:\.\d+)?)\s+/i, "$1-$2 ");
  text = text.replace(/^(\d+)\s+and\s+(\d+\s*\/\s*\d+)/i, "$1 $2");

  let qty: number | null = null;
  const qtyMatch = text.match(QTY_RE);
  if (qtyMatch) {
    qty = parseFraction(qtyMatch[1]);
    text = text.slice(qtyMatch[0].length).trim();
    text = text.replace(/^[-–]\s*/, "");
    text = text.replace(/^(?:heaping|scant|packed|level|generous|rounded|overflowing)\s+/i, "");
  }

  if (containerOz && qty) {
    qty = qty * containerOz;
    text = text.replace(/^(cans?|jars?|bottles?|packages?|pkgs?)\b\s*/i, "").trim();
    text = text.replace(PAREN_STRIP, " ").trim();
    text = text.replace(PREP_COMMA, "").trim();
    text = text.replace(/^(?:(?:small|medium|large|big|thin|thick|fresh|heaping|scant|packed|level|generous|several|few|fine|ripe|grind)\s+)+/i, "");
    text = text.replace(/\*+/g, "");
    text = text.replace(/^(?:jar|can|package|tin|carton)\s+/i, "");
    text = text.replace(/\s*\)\s*$/, "").trim();
    const normalized = normalize(text);
    const key = isQualifierOnlyKey(normalized) ? normalized : canonicalize(normalized, nameIndex);
    return { key, qty, unit: "oz" };
  }

  let unit: string | null = null;
  const metricMatch = text.match(/^(kg|g|ml|l)\b\s*/i);
  if (metricMatch) {
    unit = metricMatch[1].toLowerCase();
    text = text.slice(metricMatch[0].length).trim();
    text = text.replace(/^\/\s*[\d.]+\s*(oz|lb|lbs|pound|pounds)\b\s*/i, "").trim();
  }
  if (!unit) {
    const unitMatch = text.match(UNIT_RE);
    if (unitMatch) {
      unit = unitMatch[1].toLowerCase().replace(/\.$/, "");
      text = text.slice(unitMatch[0].length).trim();
    }
  }
  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text.replace(/^\/\s*[\d.\s-]+\s*(?:g|kg|ml|l|oz|lb|lbs|cups?|tbsp|tablespoons?|tsp|teaspoons?|fl\s*oz|pints?|quarts?|ounces?|pounds?)\b\.?\s*/i, "").trim();
    if (text === before) break;
  }
  text = text.replace(PREP_COMMA, "").trim();
  text = text.replace(/^(?:(?:small|medium|large|big|thin|thick|fresh|heaping|scant|packed|level|generous|several|few|fine|ripe|grind)\s+)+/i, "");
  text = text.replace(/^(?:of|or|each[:]?)\s+/i, "");
  text = text.replace(/^(?:a|an)\s+/i, "");
  text = text.replace(/\*+/g, "");
  text = text.replace(/\s*\)\s*/g, " ").trim();
  text = text.replace(/^(?:jar|can|package|tin|carton)\s+/i, "");
  text = text.replace(/\s*\)\s*$/, "").trim();
  const normalized = normalize(text);
  const key = isQualifierOnlyKey(normalized) ? normalized : canonicalize(normalized, nameIndex);
  return { key, qty, unit };
}

// ─── jump-1778 P2: the full dictionaryLookup() cascade ─────────────────────
// Faithful port of recipe-app @ 7e681cb scripts/lib/ingredient-parser.js
// lookupCandidate() (~L513-523) and dictionaryLookup() (~L528-675) — the
// SECOND resolution stage production runs AFTER extractProductKey's own
// inline canonicalize() call above (production: resolveIngredientLine() =
// extractProductKey() -> dictionaryLookup(extracted.key), server.js @
// 7e681cb, wired live since jump-1701/P2a). Module-closure `ingredientDict`/
// `nameIndex` variables replaced by explicit parameters — the SAME
// adaptation canonicalize() above already makes, not a behavior change.
//
// Divergence from src/normalize.ts's dictionaryLookup() (this MCP server's
// OWN find_food candidate-query builder, a DIFFERENT, already-diverged,
// intentionally-simplified cascade over a 14-entry alias table — left
// untouched per CONSTRAINTS): see the file header's jump-1778 P2 note for
// the full list (no qualifier guard, stale SAFE_PREP_WORDS, first-hit-wins
// prep-strip, missing two of three or-split sub-stages).

/**
 * Words that NEVER change what physical product you buy at the store — safe
 * to strip from the front of a candidate key during the prep-strip cascade
 * tier. Ported VERBATIM from recipe-app @ 7e681cb
 * scripts/lib/ingredient-parser.js dictionaryLookup() (~L585-594) — 35
 * words, including 'freshly'/'softened'/'torn' (added jump-1701/P1; the
 * src/normalize.ts port above predates that addition and is missing all
 * three). Words NOT in this list (fresh, frozen, dried, canned, cooked, raw,
 * uncooked, boneless, skinless, whole, ground, roasted, toasted, boiled)
 * intentionally excluded — they can change the product/food identity (e.g.
 * "roasted red pepper" is a different product than "red pepper").
 */
export const SAFE_PREP_WORDS = new Set([
  "chopped", "sliced", "diced", "minced", "grated", "shredded",
  "sauteed", "steamed",
  "roughly", "finely", "coarsely", "thinly", "thickly",
  "lightly", "firmly", "loosely", "tightly", "packed",
  "good", "quality", "crusty", "sturdy", "hard",
  "peeled", "halved", "quartered", "julienned", "cubed",
  "rinsed", "drained", "trimmed", "pitted",
  "freshly", "softened", "torn",
]);

export type CascadeMethod =
  | "exact"
  | "plural_es"
  | "plural_s"
  | "plural_add_s"
  | "prep_strip"
  | "prep_strip+plural"
  | "drop_last"
  | "or_split"
  | "or_split+shorten"
  | "or_split+front_drop";

export interface CascadeMatchMeta {
  method: CascadeMethod;
  matchedKey: string;
  /** The prep words stripped off the front, when method starts with "prep_strip". */
  stripped?: string;
}

export interface CascadeHit {
  entry: DictEntry;
  matchedKey: string;
}

/**
 * Ported from recipe-app scripts/lib/ingredient-parser.js lookupCandidate()
 * (~L513-523). Resolves a single candidate string: qualifier-only guard
 * FIRST (a bare qualifier word, or a trivial inflection of one, is never a
 * valid product key at ANY cascade stage — see QUALIFIER_ONLY_KEYS above),
 * then the literal dict KEY (production: `ingredientDict[candidate]`, a
 * plain truthy check — ported as-is, including its theoretical
 * prototype-property quirk, since this is a faithful port, not a rewrite),
 * then — unless `literalOnly` — the names index. Returns null on a miss at
 * every stage.
 */
export function lookupCandidate(dict: Dictionary, nameIndex: Map<string, string>, candidate: string, literalOnly = false): CascadeHit | null {
  if (isQualifierOnlyKey(candidate)) return null;
  if (dict[candidate]) return { entry: dict[candidate], matchedKey: candidate };
  if (literalOnly) return null;
  const indexed = nameIndex.get(candidate.toLowerCase());
  if (indexed !== undefined && dict[indexed]) return { entry: dict[indexed], matchedKey: indexed };
  return null;
}

/**
 * Ported from recipe-app scripts/lib/ingredient-parser.js dictionaryLookup()
 * (~L528-675) — the full 5-tier fallback ladder run on extractProductKey's
 * output, matching recipe-app/CLAUDE.md's own summary exactly: "exact ->
 * plural (-s, -es, +s) -> safe prep word stripping ... -> drop last word ->
 * or-split (tries all alternatives)". Returns null on a total miss (never
 * resolves to a qualifier-only residue, at any tier — the guard runs before
 * even the top-level exact check, so a key that WOULD pluralize into a
 * resolvable-but-wrong candidate, e.g. "large" -> "larges", is refused
 * unconditionally).
 *
 * Tier 1 — exact (literalOnly): dict-key-only match on `key` itself, no
 *   names-index fallback (production: this keeps the cascade's FIRST stage
 *   byte-identical to the dict's own literal keys, distinguishing which
 *   DERIVED stage — prep_strip, drop_last, etc. — restores a name absorbed
 *   into another entry's names[]).
 * Tier 2 — plural: -es strip, then -s strip, then +s add (each via
 *   lookupCandidate, non-literal — dict key OR names index).
 * Tier 3 — prep-strip: walks the SAFE_PREP_WORDS prefix chain one word at a
 *   time (stopping at the first non-safe word), trying each remaining
 *   suffix AND its -es/-s/+s plural variants at every step, then picks the
 *   MOST SPECIFIC resolving candidate across the WHOLE chain (matchedKey
 *   word count DESC, ties keep first-found order) — NOT the first hit found
 *   while walking (a shorter strip can hit a more-generic entry's names[]
 *   before a deeper strip reaches the product's own specific literal entry;
 *   production's own jump-1701/P1b fix-pass comment documents this exactly).
 * Tier 4 — drop-last-word: single attempt, one word off the end.
 * Tier 5 — or-split: splits on " or " (a bare "/" is first rewritten to
 *   " or "), then per alternative tries (a) a direct match, (b) progressive
 *   shortening from the END (or_split+shorten), (c) progressive dropping
 *   from the FRONT (or_split+front_drop) — in that order, first hit wins.
 */
export function dictionaryLookup(dict: Dictionary, nameIndex: Map<string, string>, key: string): { entry: DictEntry; matchMeta: CascadeMatchMeta } | null {
  if (!key) return null;
  if (isQualifierOnlyKey(key)) return null;

  {
    const hit = lookupCandidate(dict, nameIndex, key, true);
    if (hit) return { entry: hit.entry, matchMeta: { method: "exact", matchedKey: hit.matchedKey } };
  }

  if (key.endsWith("es")) {
    const hit = lookupCandidate(dict, nameIndex, key.slice(0, -2));
    if (hit) return { entry: hit.entry, matchMeta: { method: "plural_es", matchedKey: hit.matchedKey } };
  }
  if (key.endsWith("s")) {
    const hit = lookupCandidate(dict, nameIndex, key.slice(0, -1));
    if (hit) return { entry: hit.entry, matchMeta: { method: "plural_s", matchedKey: hit.matchedKey } };
  }
  if (!key.endsWith("s")) {
    const hit = lookupCandidate(dict, nameIndex, key + "s");
    if (hit) return { entry: hit.entry, matchMeta: { method: "plural_add_s", matchedKey: hit.matchedKey } };
  }

  const words = key.split(" ");
  const prepStripCandidates: Array<{ stripped: string; method: CascadeMethod; hit: CascadeHit }> = [];
  for (let start = 1; start < words.length; start++) {
    if (!SAFE_PREP_WORDS.has(words[start - 1])) break;
    const stripped = words.slice(0, start).join(" ");
    const shorter = words.slice(start).join(" ");
    const attempts: Array<{ text: string; method: CascadeMethod }> = [{ text: shorter, method: "prep_strip" }];
    if (shorter.endsWith("es")) attempts.push({ text: shorter.slice(0, -2), method: "prep_strip+plural" });
    if (shorter.endsWith("s")) attempts.push({ text: shorter.slice(0, -1), method: "prep_strip+plural" });
    if (!shorter.endsWith("s")) attempts.push({ text: shorter + "s", method: "prep_strip+plural" });
    for (const attempt of attempts) {
      const hit = lookupCandidate(dict, nameIndex, attempt.text);
      if (hit) prepStripCandidates.push({ stripped, method: attempt.method, hit });
    }
  }
  if (prepStripCandidates.length > 0) {
    const sorted = [...prepStripCandidates].sort((a, b) => b.hit.matchedKey.split(" ").length - a.hit.matchedKey.split(" ").length);
    const best = sorted[0];
    return { entry: best.hit.entry, matchMeta: { method: best.method, matchedKey: best.hit.matchedKey, stripped: best.stripped } };
  }

  if (words.length > 1) {
    const shorter = words.slice(0, -1).join(" ");
    const hit = lookupCandidate(dict, nameIndex, shorter);
    if (hit) return { entry: hit.entry, matchMeta: { method: "drop_last", matchedKey: hit.matchedKey } };
  }

  const orKey = key.includes("/") ? key.replace(/\//g, " or ") : key;
  if (orKey.includes(" or ")) {
    const alternatives = orKey.split(" or ").map((s) => s.trim()).filter(Boolean);
    for (const alt of alternatives) {
      {
        const hit = lookupCandidate(dict, nameIndex, alt);
        if (hit) return { entry: hit.entry, matchMeta: { method: "or_split", matchedKey: hit.matchedKey } };
      }
      const altWords = alt.split(" ");
      for (let len = altWords.length - 1; len >= 1; len--) {
        const shorter = altWords.slice(0, len).join(" ");
        if (shorter) {
          const hit = lookupCandidate(dict, nameIndex, shorter);
          if (hit) return { entry: hit.entry, matchMeta: { method: "or_split+shorten", matchedKey: hit.matchedKey } };
        }
      }
      for (let start = 1; start < altWords.length; start++) {
        const trimmed = altWords.slice(start).join(" ");
        if (trimmed) {
          const hit = lookupCandidate(dict, nameIndex, trimmed);
          if (hit) return { entry: hit.entry, matchMeta: { method: "or_split+front_drop", matchedKey: hit.matchedKey } };
        }
      }
    }
  }

  return null;
}

// ─── corpus loading + per-recipe frequency aggregation ────────────────────

export interface RecipeCorpusEntry {
  id?: string;
  title?: string;
  ingredients?: unknown;
}

export function loadCorpusRecipes(raw: string): RecipeCorpusEntry[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("corpus file did not parse to a JSON array of recipes");
  }
  return parsed as RecipeCorpusEntry[];
}

export interface CorpusAggregate {
  /** Canonical dict key (the CASCADE's matchedKey, per dictionaryLookup — not necessarily extractProductKey's raw key) -> count of DISTINCT recipes it appears in (within-recipe duplicates collapsed). */
  resolvedKeyRecipeCount: Map<string, number>;
  /** Raw extractProductKey key with NO cascade resolution -> count of DISTINCT recipes it appears in. */
  unresolvedKeyRecipeCount: Map<string, number>;
  /** Canonical dict key -> the FIRST-SEEN cascade tier that resolved it (jump-1778 P2, spec DONE WHEN: "records WHICH tier resolved each newly-eligible name"). A key reachable via more than one raw phrasing keeps whichever tier was encountered first in corpus order — one representative tier per key, not one per occurrence. */
  resolvedKeyTier: Map<string, CascadeMethod>;
  corpusIngredientLineCount: number;
  /** Lines whose extractProductKey key was empty/falsy — skipped entirely (no name to report under the fixture schema's non-empty-name rule), tallied here for honest provenance. */
  emptyKeyLineCount: number;
  recipesProcessed: number;
}

/**
 * Per recipe: extractProductKey every ingredient line, then run the result
 * through the FULL dictionaryLookup() cascade (jump-1778 P2 — exact,
 * literalOnly -> plural -> prep-strip -> drop-last -> or-split; see that
 * function's own doc comment for the tier-by-tier detail), dedupe by the
 * CASCADE's resolved matchedKey WITHIN the recipe (a Set — the within-recipe
 * dedup rule spec S1 requires; two lines that resolve to the SAME canonical
 * entry via DIFFERENT tiers, e.g. "mushroom" and "sliced mushrooms" in one
 * recipe, still dedupe to one occurrence), then tally each distinct key's
 * cross-recipe occurrence count. Exported for direct unit testing (the
 * "within-recipe dedup" DONE WHEN item).
 */
export function aggregateCorpus(recipes: RecipeCorpusEntry[], dict: Dictionary, nameIndex: Map<string, string>): CorpusAggregate {
  const resolvedKeyRecipeCount = new Map<string, number>();
  const unresolvedKeyRecipeCount = new Map<string, number>();
  const resolvedKeyTier = new Map<string, CascadeMethod>();
  let corpusIngredientLineCount = 0;
  let emptyKeyLineCount = 0;

  for (const recipe of recipes) {
    const ingredients = Array.isArray(recipe.ingredients) ? (recipe.ingredients as unknown[]) : [];
    const recipeResolvedKeys = new Set<string>();
    const recipeUnresolvedKeys = new Set<string>();

    for (const raw of ingredients) {
      corpusIngredientLineCount++;
      if (typeof raw !== "string" || raw.trim().length === 0) {
        emptyKeyLineCount++;
        continue;
      }
      const { key } = extractProductKey(raw, nameIndex);
      if (!key) {
        emptyKeyLineCount++;
        continue;
      }
      const resolution = dictionaryLookup(dict, nameIndex, key);
      if (resolution) {
        const canonicalKey = resolution.matchMeta.matchedKey;
        recipeResolvedKeys.add(canonicalKey);
        if (!resolvedKeyTier.has(canonicalKey)) resolvedKeyTier.set(canonicalKey, resolution.matchMeta.method);
      } else {
        recipeUnresolvedKeys.add(key);
      }
    }

    for (const key of recipeResolvedKeys) resolvedKeyRecipeCount.set(key, (resolvedKeyRecipeCount.get(key) ?? 0) + 1);
    for (const key of recipeUnresolvedKeys) unresolvedKeyRecipeCount.set(key, (unresolvedKeyRecipeCount.get(key) ?? 0) + 1);
  }

  return { resolvedKeyRecipeCount, unresolvedKeyRecipeCount, resolvedKeyTier, corpusIngredientLineCount, emptyKeyLineCount, recipesProcessed: recipes.length };
}

// ─── classification (bucket decision + evidence class) ────────────────────

export type ExclusionBucketV2 = "unresolved" | "no_ref" | "non_preferred_type";

export interface EligibleCandidateV2 {
  canonicalKey: string;
  productName: string;
  occurrences: number;
  fdcRef: { fdc_id: string; description?: string; data_type: PreferredDataType; match_method?: string };
  evidenceClass: EvidenceClass;
  /** jump-1778 P2: the dictionaryLookup() cascade tier that resolved this canonical key ("exact" when it came from extractProductKey's own inline canonicalize() call, one of the other CascadeMethod values when the cascade's own tiers were needed). Undefined only when classifyResolvedKey is called without a tier (test-only convenience). */
  resolutionTier?: CascadeMethod;
}

export interface ExcludedCandidateV2 {
  name: string;
  bucket: ExclusionBucketV2;
  occurrences: number;
  reason: string;
}

export type ClassifyResolvedResult = { kind: "eligible"; candidate: EligibleCandidateV2 } | { kind: "excluded"; candidate: ExcludedCandidateV2 };

/**
 * Per resolved canonical key: no_ref / non_preferred_type / eligible, same
 * three-way split as v1's classifyName (non_preferred_type kept DISTINCT
 * from no_ref — a jump-1778 fix-pass finding on v1, preserved here).
 * evidence_class for eligible rows is classifyEvidence(), IMPORTED from v1
 * unchanged (same pin-binding guard). `tier` (jump-1778 P2, optional —
 * callers that don't care, e.g. existing unit tests, may omit it) is the
 * dictionaryLookup() cascade tier that resolved `canonicalKey`; when
 * present it's recorded on the eligible candidate AND folded into the
 * excluded reason string, satisfying the spec DONE WHEN "records WHICH tier
 * resolved each newly-eligible name."
 */
export function classifyResolvedKey(
  canonicalKey: string,
  occurrences: number,
  dict: Dictionary,
  pins: FdcPins,
  rulings: IdentityRulings,
  tier?: CascadeMethod
): ClassifyResolvedResult {
  const entry = dict[canonicalKey];
  const fdcRef = entry?.fdc_ref;
  const displayName = entry?.product_name ?? canonicalKey;
  const tierSuffix = tier ? ` [cascade tier: ${tier}]` : "";

  if (!fdcRef || !fdcRef.fdc_id) {
    return {
      kind: "excluded",
      candidate: {
        name: displayName,
        bucket: "no_ref",
        occurrences,
        reason: `Resolved to canonical dictionary entry "${canonicalKey}" (${occurrences} distinct recipe(s)) but it carries no fdc_ref.${tierSuffix}`,
      },
    };
  }

  const dataType = fdcRef.data_type;
  if (!PREFERRED_DATA_TYPES.has(dataType as PreferredDataType)) {
    return {
      kind: "excluded",
      candidate: {
        name: displayName,
        bucket: "non_preferred_type",
        occurrences,
        reason: `Resolved to canonical dictionary entry "${canonicalKey}" (${occurrences} distinct recipe(s)) but its fdc_ref.data_type ("${dataType}") is not one of Foundation | SR Legacy | Survey (FNDDS) — HAS an fdc_ref, so this is distinct from no_ref.${tierSuffix}`,
      },
    };
  }

  const evidenceClass = classifyEvidence(displayName, fdcRef.fdc_id, pins, rulings);
  return {
    kind: "eligible",
    candidate: {
      canonicalKey,
      productName: displayName,
      occurrences,
      fdcRef: { fdc_id: fdcRef.fdc_id, description: fdcRef.description, data_type: dataType as PreferredDataType, match_method: fdcRef.match_method },
      evidenceClass,
      resolutionTier: tier,
    },
  };
}

export function unresolvedToExcluded(rawKey: string, occurrences: number): ExcludedCandidateV2 {
  return {
    name: rawKey,
    bucket: "unresolved",
    occurrences,
    reason: `extractProductKey resolved to "${rawKey}", which dictionaryLookup's full cascade (exact/plural/prep-strip/drop-last/or-split) still could not match to any dictionary entry — parser-tail, not a dictionary identity gap.`,
  };
}

// ─── name-collision dedup + top-N ranking (pure, directly testable) ───────

interface TaggedCandidate {
  name: string;
  occurrences: number;
  /** Lower priority number wins a name collision. */
  priority: number;
  ref: { kind: "eligible"; c: EligibleCandidateV2 } | { kind: "excluded"; c: ExcludedCandidateV2 };
}

export interface DedupResult {
  eligible: EligibleCandidateV2[];
  excluded: ExcludedCandidateV2[];
  droppedCount: number;
}

/**
 * Defensive guard: the fixture's row identity is `entity.product_name`
 * (spec: "query = entity.product_name"), not the canonical dictionary key —
 * so two DIFFERENT canonical keys sharing one product_name string would
 * otherwise produce a duplicate case/excluded name, which
 * validateFixtureSchema rejects. Priority on a collision: eligible > no_ref >
 * non_preferred_type > unresolved; within the same priority, higher
 * occurrences wins, canonicalKey/name ASC breaks remaining ties
 * (deterministic regardless of Map/array iteration order).
 */
export function dedupeCandidatesByName(candidates: TaggedCandidate[]): DedupResult {
  const byName = new Map<string, TaggedCandidate[]>();
  for (const c of candidates) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  const eligible: EligibleCandidateV2[] = [];
  const excluded: ExcludedCandidateV2[] = [];
  let droppedCount = 0;

  for (const list of byName.values()) {
    const sorted = [...list].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
      const aKey = a.ref.kind === "eligible" ? a.ref.c.canonicalKey : a.ref.c.name;
      const bKey = b.ref.kind === "eligible" ? b.ref.c.canonicalKey : b.ref.c.name;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
    const winner = sorted[0];
    if (winner.ref.kind === "eligible") eligible.push(winner.ref.c);
    else excluded.push(winner.ref.c);
    droppedCount += sorted.length - 1;
  }

  return { eligible, excluded, droppedCount };
}

/**
 * Rank desc by occurrences, ties broken by product name asc, then slice to
 * targetN. Exported for direct unit testing (the "top-N + tie ordering"
 * DONE WHEN item).
 */
export function rankEligible(candidates: EligibleCandidateV2[], targetN: number): EligibleCandidateV2[] {
  const sorted = [...candidates].sort((a, b) => {
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0;
  });
  return sorted.slice(0, targetN);
}

// ─── buildFixtureV2 — the pure core (no I/O) ───────────────────────────────

const LICENSE_TEXT =
  "FDC identifiers and food composition data are U.S. public domain (USDA FoodData Central, a U.S. Government work). " +
  "The recipe corpus and dictionary curation were authored by this project's maintainers and are released " +
  "under this repository's MIT license (see LICENSE).";

const DERIVATION_RULE_TEXT =
  "Assembled by eval/scripts/assemble-representative-fixture-v2.ts from the FULL recipe-app recipe corpus " +
  "(data/shared-recipes.json at a pinned commit — 935 recipes, ~11,873 raw ingredient lines). Each ingredient " +
  "line is run through extractProductKey (a faithful port of recipe-app's scripts/lib/ingredient-parser.js " +
  "function of the same name — quantity/unit/prep stripping, container-size folding, then an internal " +
  "canonicalize() call against the base.json-only name index), and the resulting key is run through the FULL " +
  "production dictionaryLookup() cascade (jump-1778 P2 — a faithful port of recipe-app's own second resolution " +
  "stage: exact,literalOnly -> plural -es/-s/+s -> SAFE_PREP_WORDS stripping, most-specific-match-wins across the " +
  "whole safe-prefix chain -> drop-last-word -> or-split, three sub-stages: direct/shorten/front-drop — matching " +
  "production's resolveIngredientLine() = extractProductKey() + dictionaryLookup(), MINUS the MISS-ONLY colon- " +
  "artifact fallback, the ingredient cache, and the LLM fallback, all of which stay out of scope). FREQUENCY is " +
  "the count of DISTINCT recipes each canonical entry (the cascade's own matchedKey on a hit — or, for unresolved " +
  "lines, each raw extracted key) appears in — a recipe using the same entry twice contributes one occurrence, " +
  "not two. Eligible entries (resolved, have an fdc_ref, preferred data_type) rank by occurrences DESC / " +
  "product_name ASC and are cut to the top --target-n (default 1,000; ALL eligible entries are kept if fewer " +
  "exist). Names that fail resolution entirely even after the full cascade (unresolved — parser-tail), resolve " +
  "to an entry with no fdc_ref (no_ref), or resolve to an entry whose fdc_ref.data_type isn't a preferred type " +
  "(non_preferred_type — distinct from no_ref) are EXCLUDED (never scored) and recorded with a reason (which " +
  "cascade tier resolved it, for eligible/no_ref/non_preferred_type rows) for honest coverage reporting. " +
  "evidence_class is IMPORTED unchanged from the v1 assembler (human_pin / human_ruling / automated_screened, " +
  "pin-binding guarded) — an orthogonal concept from the cascade tier: evidence_class is about HUMAN " +
  "ADJUDICATION of the dictionary-entry-to-FDC-record identity, the cascade tier is about HOW the corpus text " +
  "resolved to that dictionary entry in the first place. Every case additionally carries labelProvenance: " +
  "'dictionary-candidate-unverified' — these are CANDIDATE labels for the SEPARATE, later independent-judge + " +
  "human-audit ground-truth pass (spec spec_findfood_representative_eval_v1_2026-07-19.md 'v2 GROUND TRUTH'), " +
  "NOT final ratified identities. This is a ONE-TIME SNAPSHOT — the eval harness never re-reads the recipe-app " +
  "repo at runtime; only this assembly script does, and only at assembly time.";

export interface BuildInputV2 {
  recipes: RecipeCorpusEntry[];
  dict: Dictionary;
  pins: FdcPins;
  rulings: IdentityRulings;
  targetN: number;
  date: string;
  commitArg: string;
  commitResolved: string;
  dictionaryBlobSha: string;
  corpusPath: string;
  corpusBlobSha256: string;
  recipeAppPath: string;
  assemblyScriptSha256: string;
}

export interface BuildSummaryV2 {
  corpusRecipeCount: number;
  corpusIngredientLineCount: number;
  emptyKeyLineCount: number;
  uniqueEligibleTotal: number;
  uniqueEligibleSelected: number;
  weightedEligibleTotal: number;
  weightedEligibleSelected: number;
  uniqueNoRef: number;
  uniqueNonPreferredType: number;
  uniqueUnresolved: number;
  weightedNoRef: number;
  weightedNonPreferredType: number;
  weightedUnresolved: number;
  evidenceClassCounts: Record<EvidenceClass, number>;
  /** jump-1778 P2: count of ELIGIBLE entries (total pool, pre-target-N-cutoff) per dictionaryLookup() cascade tier — "exact" is what an exact-tier-only assembler would already have found; every other key is "newly eligible" that tier contributes. */
  perTierEligibleCounts: Record<string, number>;
  nameDedupDropped: number;
  topFrequencyHead: Array<{ name: string; occurrences: number }>;
}

export interface BuildOutputV2 {
  fixture: EvalFixture;
  summary: BuildSummaryV2;
}

/**
 * The pure assembly core — no filesystem/git I/O. Deterministic given
 * identical input: Map insertion order follows `recipes` array order (stable
 * across runs of the SAME corpus), and every sort below uses an explicit,
 * total comparator. Calling this twice with byte-identical `input` produces
 * byte-identical output — this is what the "byte-identical re-run" DONE WHEN
 * test exercises directly, without needing a live git corpus fetch.
 */
export function buildFixtureV2(input: BuildInputV2): BuildOutputV2 {
  const nameIndex = buildNameIndex(input.dict);
  const agg = aggregateCorpus(input.recipes, input.dict, nameIndex);

  const tagged: TaggedCandidate[] = [];
  for (const [key, occurrences] of agg.resolvedKeyRecipeCount) {
    const result = classifyResolvedKey(key, occurrences, input.dict, input.pins, input.rulings, agg.resolvedKeyTier.get(key));
    if (result.kind === "eligible") {
      tagged.push({ name: result.candidate.productName, occurrences, priority: 0, ref: { kind: "eligible", c: result.candidate } });
    } else {
      const priority = result.candidate.bucket === "no_ref" ? 1 : 2; // non_preferred_type
      tagged.push({ name: result.candidate.name, occurrences, priority, ref: { kind: "excluded", c: result.candidate } });
    }
  }
  for (const [rawKey, occurrences] of agg.unresolvedKeyRecipeCount) {
    const candidate = unresolvedToExcluded(rawKey, occurrences);
    tagged.push({ name: candidate.name, occurrences, priority: 3, ref: { kind: "excluded", c: candidate } });
  }

  const { eligible: dedupedEligible, excluded: dedupedExcluded, droppedCount } = dedupeCandidatesByName(tagged);

  const rankedEligible = rankEligible(dedupedEligible, input.targetN);

  const cases: PositiveEvalCase[] = rankedEligible.map((c) => ({
    name: c.productName,
    kind: "positive",
    expected: { fdcId: Number(c.fdcRef.fdc_id), description: c.fdcRef.description ?? c.productName, dataType: c.fdcRef.data_type },
    // jump-1778 P2: "[cascade tier: X]" records WHICH dictionaryLookup() tier
    // resolved this corpus identity (spec DONE WHEN) — distinct from
    // match_method just after it, which is the DICT ENTRY's OWN fdc_ref
    // match method (how recipe-app matched this entry to an FDC record),
    // an orthogonal, already-existing concept.
    reason: `Corpus-frequency battery: canonical entry "${c.canonicalKey}" (product_name "${c.productName}") appears in ${c.occurrences} of ${input.recipes.length} recipes; match_method "${c.fdcRef.match_method ?? "?"}". [cascade tier: ${c.resolutionTier ?? "unknown"}]`,
    evidenceClass: c.evidenceClass,
    expectedSource: "dictionary-ratified",
    labelProvenance: "dictionary-candidate-unverified",
    resolverSource: c.fdcRef.match_method ?? "unknown",
    occurrences: c.occurrences,
  }));
  cases.sort((a, b) => (b.occurrences ?? 0) - (a.occurrences ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const excluded: ExcludedEvalCase[] = dedupedExcluded
    .map((c) => ({ name: c.name, reason: c.reason, occurrences: c.occurrences, packs: {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const evidenceClassCounts: Record<EvidenceClass, number> = { human_pin: 0, human_ruling: 0, automated_screened: 0 };
  for (const c of rankedEligible) evidenceClassCounts[c.evidenceClass]++;

  // jump-1778 P2: per-cascade-tier eligible counts over the TOTAL eligible
  // pool (pre-target-N — matches how uniqueEligibleTotal/weightedEligibleTotal
  // are computed just below), not just the selected top-N — "how many keys
  // does each tier make eligible" is a pool-level question, independent of
  // where the --target-n cutoff happens to fall.
  const perTierEligibleCounts: Record<string, number> = {};
  for (const c of dedupedEligible) {
    const tier = c.resolutionTier ?? "unknown";
    perTierEligibleCounts[tier] = (perTierEligibleCounts[tier] ?? 0) + 1;
  }

  const noRefRows = dedupedExcluded.filter((c) => c.bucket === "no_ref");
  const nonPreferredRows = dedupedExcluded.filter((c) => c.bucket === "non_preferred_type");
  const unresolvedRows = dedupedExcluded.filter((c) => c.bucket === "unresolved");

  const uniqueNoRef = noRefRows.length;
  const uniqueNonPreferredType = nonPreferredRows.length;
  const uniqueUnresolved = unresolvedRows.length;
  const weightedNoRef = noRefRows.reduce((s, c) => s + c.occurrences, 0);
  const weightedNonPreferredType = nonPreferredRows.reduce((s, c) => s + c.occurrences, 0);
  const weightedUnresolved = unresolvedRows.reduce((s, c) => s + c.occurrences, 0);

  const uniqueEligibleTotal = dedupedEligible.length;
  const weightedEligibleTotal = dedupedEligible.reduce((s, c) => s + c.occurrences, 0);
  const uniqueEligibleSelected = rankedEligible.length;
  const weightedEligibleSelected = rankedEligible.reduce((s, c) => s + c.occurrences, 0);

  const uniqueNames = uniqueEligibleTotal + uniqueNoRef + uniqueNonPreferredType + uniqueUnresolved;
  const weightedOccurrences = weightedEligibleTotal + weightedNoRef + weightedNonPreferredType + weightedUnresolved;

  const fixture: EvalFixture = {
    provenance: {
      fixtureId: FIXTURE_ID,
      sourcePath: `recipe-app/${input.corpusPath}`,
      sourceRepoCommit: input.commitResolved,
      derivedAt: input.date,
      derivationRule: DERIVATION_RULE_TEXT,
      counts: { positive: cases.length, negative: 0, total: cases.length },
      license: LICENSE_TEXT,
      dictionaryCommit: input.commitResolved,
      dictionaryBlobSha: input.dictionaryBlobSha,
      assemblyScriptSha256: input.assemblyScriptSha256,
      parameters: {
        commitArg: input.commitArg,
        commitResolved: input.commitResolved,
        recipeAppPath: input.recipeAppPath,
        date: input.date,
        targetN: input.targetN,
        actualN: cases.length,
      },
      coverage: {
        uniqueNames,
        uniqueEligible: uniqueEligibleTotal,
        uniqueUnresolved,
        uniqueNoRef,
        uniqueNonPreferredType,
        weightedOccurrences,
        weightedEligible: weightedEligibleTotal,
        uniqueEligibleSelected,
        weightedEligibleSelected,
      },
      evidenceClassCounts,
      corpusPath: input.corpusPath,
      corpusRecipeCount: input.recipes.length,
      corpusIngredientLineCount: agg.corpusIngredientLineCount,
      corpusBlobSha256: input.corpusBlobSha256,
    },
    cases,
    excluded,
  };

  validateFixtureSchema(fixture);

  return {
    fixture,
    summary: {
      corpusRecipeCount: input.recipes.length,
      corpusIngredientLineCount: agg.corpusIngredientLineCount,
      emptyKeyLineCount: agg.emptyKeyLineCount,
      uniqueEligibleTotal,
      uniqueEligibleSelected,
      weightedEligibleTotal,
      weightedEligibleSelected,
      uniqueNoRef,
      uniqueNonPreferredType,
      uniqueUnresolved,
      weightedNoRef,
      weightedNonPreferredType,
      weightedUnresolved,
      evidenceClassCounts,
      perTierEligibleCounts,
      nameDedupDropped: droppedCount,
      topFrequencyHead: cases.slice(0, 20).map((c) => ({ name: c.name, occurrences: c.occurrences ?? 0 })),
    },
  };
}

// ─── main ────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const resolvedCommit = gitRevParseCommit(args.recipeAppPath, args.commit);

  const corpusBuffer = gitShowBuffer(args.recipeAppPath, resolvedCommit, args.corpusPath);
  const corpusBlobSha256 = createHash("sha256").update(corpusBuffer).digest("hex");
  const recipes = loadCorpusRecipes(corpusBuffer.toString("utf-8"));

  const dictRaw = gitShow(args.recipeAppPath, resolvedCommit, "data/ingredient-dictionary.base.json");
  const dict = JSON.parse(dictRaw) as Dictionary;
  const pinsRaw = gitShow(args.recipeAppPath, resolvedCommit, "scripts/dict-pg/fdc-pins.json");
  const pins = JSON.parse(pinsRaw) as FdcPins;
  const rulingsRaw = gitShow(args.recipeAppPath, resolvedCommit, "scripts/dict-pg/identity-rulings.json");
  const rulings = JSON.parse(rulingsRaw) as IdentityRulings;

  const dictionaryBlobSha = gitRevParseBlob(args.recipeAppPath, resolvedCommit, "data/ingredient-dictionary.base.json");
  const assemblyScriptSha256 = createHash("sha256").update(readFileSync(__filename)).digest("hex");

  const { fixture, summary } = buildFixtureV2({
    recipes,
    dict,
    pins,
    rulings,
    targetN: args.targetN,
    date: args.date,
    commitArg: args.commit,
    commitResolved: resolvedCommit,
    dictionaryBlobSha,
    corpusPath: args.corpusPath,
    corpusBlobSha256,
    recipeAppPath: args.recipeAppPath,
    assemblyScriptSha256,
  });

  writeFileSync(args.outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`household-representative-v2 assembled -> ${args.outPath}`);
  console.log("");
  console.log(`Corpus:               ${summary.corpusRecipeCount} recipes, ${summary.corpusIngredientLineCount} ingredient lines (${summary.emptyKeyLineCount} produced an empty extracted key)`);
  console.log(`Target N / Actual N:  ${args.targetN} / ${fixture.cases.length}`);
  console.log(`Name-collision drops: ${summary.nameDedupDropped}`);
  console.log("");
  console.log("Coverage (unique / weighted, distinct-recipe-occurrence-weighted):");
  console.log(`  eligible (total pool):     ${summary.uniqueEligibleTotal} / ${summary.weightedEligibleTotal}`);
  console.log(`  eligible (selected top-N): ${summary.uniqueEligibleSelected} / ${summary.weightedEligibleSelected}`);
  console.log(`  no_ref:                    ${summary.uniqueNoRef} / ${summary.weightedNoRef}`);
  console.log(`  non_preferred_type:        ${summary.uniqueNonPreferredType} / ${summary.weightedNonPreferredType}`);
  console.log(`  unresolved (parser-tail):  ${summary.uniqueUnresolved} / ${summary.weightedUnresolved}`);
  console.log("");
  console.log("Evidence class counts (selected cases only):");
  for (const [cls, count] of Object.entries(summary.evidenceClassCounts)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log("");
  console.log("Eligible entries by cascade tier (total pool, jump-1778 P2 — 'exact' is what an exact-tier-only assembler already found; every other tier is newly eligible this pass):");
  for (const [tier, count] of Object.entries(summary.perTierEligibleCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier}: ${count}`);
  }
  console.log("");
  console.log("Top-20 frequency head:");
  for (const [i, row] of summary.topFrequencyHead.entries()) {
    console.log(`  ${i + 1}. ${row.name} — ${row.occurrences} recipes`);
  }
  console.log("");
  console.log(`dictionaryCommit:      ${resolvedCommit} (arg: "${args.commit}")`);
  console.log(`dictionaryBlobSha:     ${dictionaryBlobSha}`);
  console.log(`corpusBlobSha256:      ${corpusBlobSha256}`);
  console.log(`assemblyScriptSha256:  ${assemblyScriptSha256}`);
}

const isMain = path.resolve(process.argv[1] ?? "") === __filename;
if (isMain) {
  main();
}
