/**
 * Module: household-dictionary-foods-v3 fixture assembler (CLI)
 * Purpose: Derives eval/fixtures/household-dictionary-foods-v3.json — the
 *   DICTIONARY-IDENTITY frame (spec spec_findfood_representative_eval_v1_
 *   2026-07-19.md "FRAME v3 (585 DISTINCT FDC FOODS)"), which SUPERSEDES
 *   household-representative-v2.json as the PUBLISHED find_food frame. v2
 *   frames the corpus by NAME (856 eligible query strings, many of them
 *   cart/brand/size/prep variants of the SAME food — "Diamond Crystal kosher
 *   salt" and "salt" are two different v2 rows). v3 instead frames the
 *   recipe-app dictionary by DISTINCT FDC FOOD: exactly one query per
 *   distinct fdc_id the dictionary carries under a PREFERRED data_type
 *   (Foundation | SR Legacy | Survey (FNDDS)), using the single MOST GENERIC
 *   name that food is known by. This is nutrition-lookup-shaped (find_food's
 *   actual job — see the spec's "THE PRODUCT DISTINCTION"), not
 *   grocery-cart-shaped. v2's own corpus-frequency computation is REUSED
 *   UNCHANGED as this fixture's SECOND LENS (see `occurrences`/`cooked`
 *   below) — v2 itself is untouched and remains the corpus-frequency data
 *   source (CONSTRAINTS: this pass is purely additive).
 *
 *   Makes ZERO network calls, ZERO LLM calls: reads recipe-app's dictionary/
 *   corpus/pins/rulings via `git -C <recipe-app> show <commit>:<path>` —
 *   NEVER the working tree (recipe-app is prod-maintained and growing;
 *   pinning a commit is what makes this fixture reproducible), NEVER a
 *   cross-repo import. Like v2, every case's `expected` is a CANDIDATE label
 *   (labelProvenance: "dictionary-candidate-unverified"), not final ground
 *   truth — see spec S2/v2.1 for why ("curated reference identities", NOT
 *   "human-verified"; only the human_pin/human_ruling evidence-class strata
 *   carry direct human review).
 *
 * Algorithm:
 *   1. Read data/ingredient-dictionary.base.json at the resolved --commit via
 *      `git show` — 1,738 entries (MEASURED 2026-07-19). Every entry is
 *      classified independently of corpus content (classifyDictEntryV3):
 *        - fdc_ref present with fdc_id AND a PREFERRED data_type -> ELIGIBLE
 *          (participates in the 585-food frame below).
 *        - No fdc_ref at all (fdc_id missing/falsy) -> EXCLUDED, bucketed by
 *          the entry's OWN `status` field: "legacy" (83 measured) / "flagged"
 *          (56 measured) / anything else (no_ref_other — 0 measured, a
 *          generic bucket kept for future data changes).
 *        - fdc_ref present but data_type is NOT preferred (e.g. Branded)
 *          -> EXCLUDED, bucket non_preferred_type (0 measured today — no
 *          Branded entries currently exist in base.json; kept generic
 *          because CONSTRAINTS explicitly names this as a real bucket).
 *      1,599 eligible + 139 excluded = 1,738 (MEASURED, matches CONSTRAINTS'
 *      "~139 = 83 legacy + 56 flagged" expectation exactly).
 *   2. Group ELIGIBLE entries by fdc_id (string form) -> 585 distinct groups
 *      (MEASURED — equals the distinct-fdc_id count exactly, by
 *      construction: grouping IS the dedup).
 *   3. Per group, pick ONE representative entry via selectRepresentative() —
 *      the deterministic 4-rung ladder from the dispatch spec, PLUS one
 *      implicit rung 5 this file adds for full determinism (see that
 *      function's own doc comment for why rung 5 is necessary and why rung 3
 *      MUST be a PER-ENTRY, not food-level-summed, corpus frequency to ever
 *      function as a real tie-break).
 *   4. Read data/shared-recipes.json at the SAME commit and run it through
 *      v2's OWN aggregateCorpus() (imported, unmodified) against the SAME
 *      base.json dictionary — this reproduces v2's exact per-dict-key
 *      distinct-recipe frequency map (resolvedKeyRecipeCount), keyed by
 *      canonical dict KEY (which is exactly what a base.json entry's OWN key
 *      already is). Every eligible entry's `occurrences` (rung 3's per-entry
 *      value) and every food's `occurrences` (the second-lens FOOD-LEVEL sum
 *      — see below) come from this ONE shared computation; nothing here
 *      re-derives or diverges from v2's corpus resolution logic.
 *   5. SECOND LENS (food-level occurrences): for each fdc_id group, SUM the
 *      per-entry corpus frequency (step 4) across EVERY entry in the group
 *      (not just the winning representative) — "how often is ANY name for
 *      this food cooked in this corpus." cooked = occurrences > 0. A food
 *      whose every dictionary name has zero corpus occurrences still gets a
 *      case, with occurrences:0, cooked:false — NEVER dropped (this is why
 *      eval/lib/fixture.ts's occurrences validator was widened from
 *      "positive integer" to "non-negative integer" this pass).
 *   6. evidence_class per case is classifyEvidence() — IMPORTED UNCHANGED
 *      from the v1 assembler (same pin-binding guard), keyed by the WINNING
 *      representative's product_name + fdc_id, exactly as v1/v2 already do.
 *   7. Two defensive collision guards (both 0-triggered on the real pinned
 *      dictionary, verified by direct analysis before writing this file —
 *      see the Builder completion report — but real, load-bearing code, not
 *      dead code):
 *        - CASE-vs-CASE: if two DIFFERENT fdc_id groups both select the same
 *          representative product_name, buildFixtureV3 THROWS (does not
 *          silently drop either side — unlike v1/v2's dedupeCandidatesByName
 *          precedent, silently dropping here would violate the "case count
 *          == distinct fdc_id count" DONE WHEN invariant no matter which side
 *          lost, so this must fail loud and get a manual dictionary fix).
 *        - EXCLUDED-vs-CASE: if an excluded (no-ref/non-preferred-type)
 *          entry's product_name collides with a case's winning name, that
 *          EXCLUDED row is dropped (excluded rows carry no per-frame identity
 *          requirement the way cases do, so this mirrors v1/v2's own
 *          eligible-outranks-excluded precedent) and tallied in
 *          provenance.dictionaryFoodsStats.nameCollisionDropped.
 *
 * Major Sections:
 *   - CLI arg parsing (--date REQUIRED, --commit, --recipe-app, --dict-path,
 *     --corpus-path, --out)
 *   - gitShowBuffer() / gitShow() / gitRevParseBlob() / gitRevParseCommit() —
 *     recipe-app repo reads, re-implemented locally (same discipline v2 used
 *     relative to v1: neither v1 nor v2 is modified or re-exports these)
 *   - DictEntryV3 / DictionaryV3 — LOCAL extension of v1's imported DictEntry
 *     adding `status`/`cart_modifiers` (fields v1/v2 never needed), composed
 *     via `extends`, not a v1 file edit
 *   - classifyDictEntryV3() — per-entry eligible/excluded + bucket decision
 *     (directly unit-testable)
 *   - tokenCount() / narrowMinNumber() / narrowMaxNumber() / narrowMinString()
 *     — tiny pure helpers behind selectRepresentative()
 *   - groupEligibleByFdcId() / selectRepresentative() / computeFoodLevel
 *     Occurrences() — the tie-break ladder and the second-lens sum, each
 *     directly unit-testable in isolation
 *   - buildFixtureV3() — the PURE core (no I/O): takes an already-loaded
 *     dict/recipes/pins/rulings and returns the assembled, schema-validated
 *     EvalFixture + a summary object (incl. the full 585-row table and the
 *     past-tie-break-2 spot-review list). Calling this twice with identical
 *     input is how the byte-identical-rerun test works without a live git
 *     fetch inside the test.
 *   - main() — orchestrates the git reads, calls buildFixtureV3(), writes the
 *     fixture, prints the summary
 *
 * Dependencies: node:child_process (git shell-outs), node:crypto (sha256),
 *   node:fs, node:path, node:url, ../lib/fixture.js (types +
 *   validateFixtureSchema), ./assemble-representative-fixture.js (v1 —
 *   REUSED, never modified: buildNameIndex, PREFERRED_DATA_TYPES,
 *   classifyEvidence, Dictionary/DictEntry/FdcPins/IdentityRulings types),
 *   ./assemble-representative-fixture-v2.js (v2 — REUSED, never modified:
 *   aggregateCorpus, loadCorpusRecipes, RecipeCorpusEntry type — the SAME
 *   corpus-frequency computation v2 itself uses)
 * State: Reads recipe-app on disk (only to locate the repo for git show) and
 *   via git show (dictionary/corpus/pins/rulings) — READ-ONLY, no writes to
 *   recipe-app, no working-tree reads. Writes ONE file: --out (default
 *   eval/fixtures/household-dictionary-foods-v3.json). NOT wired into
 *   FIXTURE_REGISTRY's live-recording path by this pass — eval/run.ts gains
 *   a "dictionary-foods" registry entry with its own cache-file binding, but
 *   no live recording run is performed (CoS-gated API-spend step, out of
 *   scope for this pass).
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
  classifyEvidence,
  PREFERRED_DATA_TYPES,
  type DictEntry,
  type FdcPins,
  type IdentityRulings,
} from "./assemble-representative-fixture.js";
import { aggregateCorpus, loadCorpusRecipes, type RecipeCorpusEntry } from "./assemble-representative-fixture-v2.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RECIPE_APP = "/Users/thomasstewart/Projects/recipe-app";
const DEFAULT_COMMIT = "7e681cb";
const DEFAULT_DICT_PATH = "data/ingredient-dictionary.base.json";
const DEFAULT_CORPUS_PATH = "data/shared-recipes.json";
const DEFAULT_OUT = path.join(__dirname, "..", "fixtures", "household-dictionary-foods-v3.json");
const FIXTURE_ID = "household-dictionary-foods-v3";

// ─── CLI args ────────────────────────────────────────────────────────────

interface Args {
  date: string;
  commit: string;
  recipeAppPath: string;
  dictPath: string;
  corpusPath: string;
  outPath: string;
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

  return {
    date,
    commit: get("--commit") ?? DEFAULT_COMMIT,
    recipeAppPath: get("--recipe-app") ?? DEFAULT_RECIPE_APP,
    dictPath: get("--dict-path") ?? DEFAULT_DICT_PATH,
    corpusPath: get("--corpus-path") ?? DEFAULT_CORPUS_PATH,
    outPath: get("--out") ?? DEFAULT_OUT,
  };
}

// ─── recipe-app repo reads (git show — never the working tree) ───────────
// Re-implemented locally rather than imported, same discipline v2 used
// relative to v1: neither v1 nor v2 exports these, and neither is modified.

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

// ─── DictEntryV3 — local extension of v1's imported DictEntry ────────────

/**
 * v1's DictEntry never declared `status`/`cart_modifiers` (v1/v2 never
 * needed them). Extended LOCALLY via `extends` — composition, not a v1 file
 * edit (CONSTRAINTS: v1's assembler is reused, never modified).
 */
export interface DictEntryV3 extends DictEntry {
  status?: string;
  cart_modifiers?: string[];
}
export type DictionaryV3 = Record<string, DictEntryV3>;

// ─── per-entry classification (eligible / excluded + bucket) ─────────────

export type ExclusionReasonV3 = "no_ref_legacy" | "no_ref_flagged" | "no_ref_other" | "non_preferred_type";

export interface EligibleEntryV3 {
  /** The base.json dictionary KEY this entry lives under (e.g. "10 inch tortillas") — distinct from productName. */
  key: string;
  productName: string;
  cartModifierCount: number;
  tokenCount: number;
  charLength: number;
  fdcId: string;
  fdcRef: { fdc_id: string; description?: string; data_type: PreferredDataType; match_method?: string };
}

export interface ExcludedEntryV3 {
  key: string;
  productName: string;
  bucket: ExclusionReasonV3;
  status?: string;
  dataType?: string;
}

export type ClassifyEntryV3Result = { kind: "eligible"; entry: EligibleEntryV3 } | { kind: "excluded"; entry: ExcludedEntryV3 };

/** Number of whitespace-separated tokens in a (trimmed) string — rung 2's "token-count" measure. */
export function tokenCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Per base.json entry: eligible (fdc_ref present, fdc_id present, data_type
 * is one of Foundation | SR Legacy | Survey (FNDDS)) or excluded, bucketed
 * by WHY. The no-ref buckets split by the entry's OWN `status` field
 * (legacy/flagged/other) rather than folding everything into one generic
 * "no_ref" the way v1/v2 do — CONSTRAINTS explicitly names
 * "no_ref / non_preferred_type / legacy / flagged status" as the reason
 * taxonomy for this frame, and the pinned dictionary's own no-fdc_ref
 * entries are ENTIRELY explained by status (83 legacy + 56 flagged, 0
 * other — verified against the real file before writing this function).
 */
export function classifyDictEntryV3(key: string, entry: DictEntryV3): ClassifyEntryV3Result {
  const productName = entry.product_name ?? key;
  const fdcRef = entry.fdc_ref;

  if (!fdcRef || !fdcRef.fdc_id) {
    const status = entry.status;
    const bucket: ExclusionReasonV3 = status === "legacy" ? "no_ref_legacy" : status === "flagged" ? "no_ref_flagged" : "no_ref_other";
    return { kind: "excluded", entry: { key, productName, bucket, status } };
  }

  const dataType = fdcRef.data_type;
  if (!PREFERRED_DATA_TYPES.has(dataType as PreferredDataType)) {
    return { kind: "excluded", entry: { key, productName, bucket: "non_preferred_type", status: entry.status, dataType } };
  }

  return {
    kind: "eligible",
    entry: {
      key,
      productName,
      cartModifierCount: Array.isArray(entry.cart_modifiers) ? entry.cart_modifiers.length : 0,
      tokenCount: tokenCount(productName),
      charLength: productName.trim().length,
      fdcId: fdcRef.fdc_id,
      fdcRef: { fdc_id: fdcRef.fdc_id, description: fdcRef.description, data_type: dataType as PreferredDataType, match_method: fdcRef.match_method },
    },
  };
}

// ─── grouping + the representative-name tie-break ladder ─────────────────

/** Groups ELIGIBLE entries by fdc_id — 585 groups on the pinned dictionary (one per distinct preferred-type FDC food). */
export function groupEligibleByFdcId(entries: EligibleEntryV3[]): Map<string, EligibleEntryV3[]> {
  const groups = new Map<string, EligibleEntryV3[]>();
  for (const entry of entries) {
    const list = groups.get(entry.fdcId);
    if (list) list.push(entry);
    else groups.set(entry.fdcId, [entry]);
  }
  return groups;
}

function narrowMinNumber<T>(items: T[], keyFn: (t: T) => number): T[] {
  let min = keyFn(items[0]);
  for (const item of items) {
    const v = keyFn(item);
    if (v < min) min = v;
  }
  return items.filter((item) => keyFn(item) === min);
}

function narrowMaxNumber<T>(items: T[], keyFn: (t: T) => number): T[] {
  let max = keyFn(items[0]);
  for (const item of items) {
    const v = keyFn(item);
    if (v > max) max = v;
  }
  return items.filter((item) => keyFn(item) === max);
}

function narrowMinString<T>(items: T[], keyFn: (t: T) => string): T[] {
  let min = keyFn(items[0]);
  for (const item of items) {
    const v = keyFn(item);
    if (v < min) min = v;
  }
  return items.filter((item) => keyFn(item) === min);
}

/** 1-4 are the dispatch spec's own ladder; 5 is this file's own deterministic-fallback addition (see selectRepresentative's doc comment). */
export type TieBreakRung = 1 | 2 | 3 | 4 | 5;

export interface RepresentativeSelection {
  winner: EligibleEntryV3;
  decidedAtRung: TieBreakRung;
  groupSize: number;
  /** How many candidates remained tied after rung 1 (cart_modifiers) + rung 2 (token-count then char-length) both ran. >1 means this fdc_id needed rung 3+ to decide — the "past tie-break 2" spot-review flag. */
  survivorsAfterRung2: number;
  /** The DISTINCT product_name strings among the rung-2 survivor pool, sorted. Length 1 means every rung-2 survivor already shares the SAME query text (e.g. several differently-phrased "salt" entries — cosmetically tied, no real ambiguity in the OUTPUT). Length >1 (e.g. "bok choy" vs "choy sum") means rung 3/4/5 chose between genuinely different candidate query strings — the cases that most need human spot-review. */
  distinctNamesAfterRung2: string[];
}

/**
 * The representative-name tie-break ladder (spec FRAME v3 / this dispatch's
 * REPRESENTATIVE-NAME RULE), applied to all base.json entries sharing one
 * fdc_id:
 *   Rung 1 — fewest cart_modifiers [most generic].
 *   Rung 2 — shortest product_name: fewest tokens first, then fewest
 *     characters (both measured on the TRIMMED string) [barest].
 *   Rung 3 — highest PER-ENTRY corpus frequency [most-cooked]: each
 *     surviving candidate's OWN dict key's distinct-recipe count (from
 *     `corpusFreq`, v2's aggregateCorpus() output — see this file's header
 *     for why it's reused rather than re-derived). This MUST be the
 *     per-candidate value, not the food-level SUM used for the second lens
 *     (`computeFoodLevelOccurrences` below): the sum is IDENTICAL for every
 *     candidate in the same fdc_id group, so it could never break a tie
 *     within one group — only a per-entry value can. Verified necessary
 *     against the real dictionary: e.g. fdc_id 2685572 ("bok choy" /
 *     "choy sum") and 16 other fdc_ids leave 2+ DIFFERENT product_name
 *     strings tied after rung 1+2 alone.
 *   Rung 4 — lexicographic product_name ASC [determinism].
 *   Rung 5 (this file's own addition, NOT in the dispatch's 4-rung list) —
 *     lexicographic dict KEY ASC. Necessary because rungs 1-4 can ALL still
 *     tie: many fdc_id groups (e.g. the "salt" family, fdc_id 746775, 44
 *     entries) contain several DIFFERENT dict keys ("salt to taste", "salt
 *     and pepper", "pinch of salt", …) that all share the IDENTICAL
 *     product_name "salt" — rung 4's lexicographic-product_name comparison
 *     ties too (same string), and without a further, unconditionally total
 *     tie-break the pick would depend on Map/array iteration order (not
 *     deterministic across engines/versions). Rung 5 never changes the
 *     OUTPUT query text in that scenario (every survivor already shares one
 *     product_name) — it only pins down which underlying entry's metadata
 *     (match_method, etc.) is used, deterministically.
 */
export function selectRepresentative(candidates: EligibleEntryV3[], corpusFreq: Map<string, number>): RepresentativeSelection {
  if (candidates.length === 0) {
    throw new Error("selectRepresentative called with an empty candidate list");
  }
  const groupSize = candidates.length;

  let pool = narrowMinNumber(candidates, (c) => c.cartModifierCount);
  if (pool.length === 1) {
    return { winner: pool[0], decidedAtRung: 1, groupSize, survivorsAfterRung2: 1, distinctNamesAfterRung2: [pool[0].productName] };
  }

  pool = narrowMinNumber(pool, (c) => c.tokenCount);
  pool = narrowMinNumber(pool, (c) => c.charLength);
  const survivorsAfterRung2 = pool.length;
  const distinctNamesAfterRung2 = [...new Set(pool.map((c) => c.productName))].sort();
  if (pool.length === 1) {
    return { winner: pool[0], decidedAtRung: 2, groupSize, survivorsAfterRung2, distinctNamesAfterRung2 };
  }

  pool = narrowMaxNumber(pool, (c) => corpusFreq.get(c.key) ?? 0);
  if (pool.length === 1) {
    return { winner: pool[0], decidedAtRung: 3, groupSize, survivorsAfterRung2, distinctNamesAfterRung2 };
  }

  pool = narrowMinString(pool, (c) => c.productName);
  if (pool.length === 1) {
    return { winner: pool[0], decidedAtRung: 4, groupSize, survivorsAfterRung2, distinctNamesAfterRung2 };
  }

  pool = narrowMinString(pool, (c) => c.key);
  return { winner: pool[0], decidedAtRung: 5, groupSize, survivorsAfterRung2, distinctNamesAfterRung2 };
}

/** Second lens: SUM of per-entry corpus frequency across EVERY entry in an fdc_id group (not just the winner) — "how often is any name for this food cooked in this corpus." */
export function computeFoodLevelOccurrences(group: EligibleEntryV3[], corpusFreq: Map<string, number>): number {
  return group.reduce((sum, c) => sum + (corpusFreq.get(c.key) ?? 0), 0);
}

function excludedReasonText(ex: ExcludedEntryV3): string {
  switch (ex.bucket) {
    case "no_ref_legacy":
      return `Dictionary entry "${ex.key}" (product_name "${ex.productName}") has status "legacy" and carries no fdc_ref — excluded from this frame (no confident FDC identity).`;
    case "no_ref_flagged":
      return `Dictionary entry "${ex.key}" (product_name "${ex.productName}") has status "flagged" and carries no fdc_ref — excluded from this frame (no confident FDC identity).`;
    case "no_ref_other":
      return `Dictionary entry "${ex.key}" (product_name "${ex.productName}") carries no fdc_ref (status: ${ex.status ?? "none"}) — excluded from this frame (no confident FDC identity).`;
    case "non_preferred_type":
      return `Dictionary entry "${ex.key}" (product_name "${ex.productName}") has an fdc_ref but its data_type ("${ex.dataType ?? "?"}") is not one of Foundation | SR Legacy | Survey (FNDDS) — HAS an fdc_ref, so this is distinct from the no-ref buckets.`;
  }
}

// ─── buildFixtureV3 — the pure core (no I/O) ───────────────────────────────

const LICENSE_TEXT =
  "FDC identifiers and food composition data are U.S. public domain (USDA FoodData Central, a U.S. Government work). " +
  "The recipe-app dictionary curation was authored by this project's maintainers and is released under this " +
  "repository's MIT license (see LICENSE).";

const DERIVATION_RULE_TEXT =
  "Assembled by eval/scripts/assemble-dictionary-foods-fixture-v3.ts from EVERY entry in the recipe-app ingredient " +
  "dictionary (data/ingredient-dictionary.base.json at a pinned commit — 1,738 entries). Each entry with an fdc_ref " +
  "of a preferred data_type (Foundation | SR Legacy | Survey (FNDDS)) is ELIGIBLE; entries are grouped by their " +
  "shared fdc_id (585 distinct groups), and ONE representative entry per group is chosen by a deterministic " +
  "tie-break ladder: (1) fewest cart_modifiers, (2) shortest product_name (fewest tokens, then fewest characters), " +
  "(3) highest per-entry corpus frequency (that entry's OWN dict key's distinct-recipe count against the pinned " +
  "recipe corpus, via the SAME aggregateCorpus() computation household-representative-v2.json uses), " +
  "(4) lexicographic product_name, (5) lexicographic dict key (a determinism-only fallback beyond the source " +
  "spec's own 4 rungs). The winning entry's product_name becomes the case's query; its fdc_ref becomes the " +
  "expected answer. Every case ALSO carries a food-level `occurrences`: the SUM of per-entry corpus frequency " +
  "across EVERY dictionary entry sharing that fdc_id (not just the winner) — and `cooked`: occurrences > 0. A food " +
  "with zero corpus occurrences under any of its dictionary names still gets a case (occurrences:0, cooked:false) " +
  "— never dropped. Entries with no fdc_ref at all are EXCLUDED, bucketed by their own dictionary `status` field " +
  "(legacy / flagged / other); entries with an fdc_ref of a non-preferred data_type (e.g. Branded) are EXCLUDED as " +
  "non_preferred_type — distinct buckets, matching v1/v2's own no_ref/non_preferred_type split. evidence_class is " +
  "IMPORTED unchanged from the v1 assembler (human_pin / human_ruling / automated_screened, pin-binding guarded). " +
  "Every case carries labelProvenance: 'dictionary-candidate-unverified' — these are CANDIDATE labels for the " +
  "SEPARATE, later independent-judge + human-audit ground-truth pass (spec " +
  "spec_findfood_representative_eval_v1_2026-07-19.md 'v2 GROUND TRUTH'), NOT final ratified identities. This is a " +
  "ONE-TIME SNAPSHOT — the eval harness never re-reads the recipe-app repo at runtime; only this assembly script " +
  "does, and only at assembly time.";

export interface BuildInputV3 {
  dict: DictionaryV3;
  recipes: RecipeCorpusEntry[];
  pins: FdcPins;
  rulings: IdentityRulings;
  date: string;
  commitArg: string;
  commitResolved: string;
  dictionaryBlobSha: string;
  dictPath: string;
  corpusPath: string;
  corpusBlobSha256: string;
  recipeAppPath: string;
  assemblyScriptSha256: string;
}

export interface TieBreakReportRow {
  fdcId: string;
  chosenName: string;
  decidedAtRung: TieBreakRung;
  groupSize: number;
  distinctNamesAfterRung2: string[];
  /** true when rung 1+2 left 2+ DIFFERENT candidate query strings tied (not just several keys sharing one string) — these most need human spot-review. */
  textAmbiguous: boolean;
}

export interface FullTableRow {
  productName: string;
  fdcId: string;
  dataType: PreferredDataType;
  cooked: boolean;
  occurrences: number;
  evidenceClass: EvidenceClass;
}

export interface BuildSummaryV3 {
  totalDictEntries: number;
  preferredRefEntries: number;
  distinctPreferredFoods: number;
  duplicateNameEntriesCollapsed: number;
  noRefLegacy: number;
  noRefFlagged: number;
  noRefOther: number;
  nonPreferredType: number;
  cookedFoods: number;
  uncookedFoods: number;
  evidenceClassCounts: Record<EvidenceClass, number>;
  pastTieBreak2: TieBreakReportRow[];
  nameCollisionDropped: number;
  corpusRecipeCount: number;
  corpusIngredientLineCount: number;
  fullTable: FullTableRow[];
}

export interface BuildOutputV3 {
  fixture: EvalFixture;
  summary: BuildSummaryV3;
}

/**
 * The pure assembly core — no filesystem/git I/O. Deterministic given
 * identical input: every grouping/sort below uses an explicit, total
 * comparator (never relying on Map/object iteration order alone — see
 * selectRepresentative's rung 5). Calling this twice with byte-identical
 * `input` produces byte-identical output.
 */
export function buildFixtureV3(input: BuildInputV3): BuildOutputV3 {
  const nameIndex = buildNameIndex(input.dict);
  const agg = aggregateCorpus(input.recipes, input.dict, nameIndex);
  const corpusFreq = agg.resolvedKeyRecipeCount;

  const eligible: EligibleEntryV3[] = [];
  const excludedRaw: ExcludedEntryV3[] = [];
  let noRefLegacy = 0;
  let noRefFlagged = 0;
  let noRefOther = 0;
  let nonPreferredType = 0;

  for (const [key, entry] of Object.entries(input.dict)) {
    const result = classifyDictEntryV3(key, entry);
    if (result.kind === "eligible") {
      eligible.push(result.entry);
    } else {
      excludedRaw.push(result.entry);
      if (result.entry.bucket === "no_ref_legacy") noRefLegacy++;
      else if (result.entry.bucket === "no_ref_flagged") noRefFlagged++;
      else if (result.entry.bucket === "no_ref_other") noRefOther++;
      else nonPreferredType++;
    }
  }

  const groups = groupEligibleByFdcId(eligible);

  const pastTieBreak2: TieBreakReportRow[] = [];
  const evidenceClassCounts: Record<EvidenceClass, number> = { human_pin: 0, human_ruling: 0, automated_screened: 0 };
  const fullTable: FullTableRow[] = [];
  const cases: PositiveEvalCase[] = [];
  const seenCaseNames = new Set<string>();

  for (const [fdcId, group] of groups) {
    const selection = selectRepresentative(group, corpusFreq);
    const winner = selection.winner;

    if (seenCaseNames.has(winner.productName)) {
      // Real-data verified: 0 occurrences today. Fails LOUD rather than
      // silently dropping either side — see this file's header for why a
      // silent drop is wrong here (unlike v1/v2's dedupeCandidatesByName).
      throw new Error(
        `Representative-name collision: two DIFFERENT fdc_id groups both selected product_name "${winner.productName}" as their representative ` +
          `(current group fdc_id ${fdcId}). This needs a manual dictionary fix, not a silent drop — dropping either case would break the ` +
          `"case count == distinct fdc_id count" invariant this fixture depends on.`
      );
    }
    seenCaseNames.add(winner.productName);

    if (selection.decidedAtRung > 2) {
      pastTieBreak2.push({
        fdcId,
        chosenName: winner.productName,
        decidedAtRung: selection.decidedAtRung,
        groupSize: selection.groupSize,
        distinctNamesAfterRung2: selection.distinctNamesAfterRung2,
        textAmbiguous: selection.distinctNamesAfterRung2.length > 1,
      });
    }

    const occurrences = computeFoodLevelOccurrences(group, corpusFreq);
    const cooked = occurrences > 0;
    const evidenceClass = classifyEvidence(winner.productName, winner.fdcId, input.pins, input.rulings);
    evidenceClassCounts[evidenceClass]++;

    cases.push({
      name: winner.productName,
      kind: "positive",
      expected: {
        fdcId: Number(winner.fdcRef.fdc_id),
        description: winner.fdcRef.description ?? winner.productName,
        dataType: winner.fdcRef.data_type,
      },
      reason:
        `Dictionary-foods frame: distinct fdc_id ${fdcId} has ${group.length} dictionary entr${group.length === 1 ? "y" : "ies"}; ` +
        `representative dict key "${winner.key}" (product_name "${winner.productName}") chosen by tie-break rung ${selection.decidedAtRung} ` +
        "(1=fewest cart_modifiers, 2=shortest product_name, 3=highest per-entry corpus frequency, 4=lexicographic product_name, " +
        `5=lexicographic dict key); match_method "${winner.fdcRef.match_method ?? "?"}".`,
      evidenceClass,
      expectedSource: "dictionary-ratified",
      labelProvenance: "dictionary-candidate-unverified",
      resolverSource: winner.fdcRef.match_method ?? "unknown",
      occurrences,
      cooked,
    });

    fullTable.push({ productName: winner.productName, fdcId, dataType: winner.fdcRef.data_type, cooked, occurrences, evidenceClass });
  }

  cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  fullTable.sort((a, b) => (a.productName < b.productName ? -1 : a.productName > b.productName ? 1 : 0));
  pastTieBreak2.sort((a, b) => (a.chosenName < b.chosenName ? -1 : a.chosenName > b.chosenName ? 1 : 0));

  const caseNameSet = new Set(cases.map((c) => c.name));
  let nameCollisionDropped = 0;
  const excludedRows: ExcludedEvalCase[] = [];
  for (const ex of excludedRaw) {
    if (caseNameSet.has(ex.productName)) {
      nameCollisionDropped++;
      continue;
    }
    excludedRows.push({
      name: ex.productName,
      reason: excludedReasonText(ex),
      occurrences: corpusFreq.get(ex.key) ?? 0,
      packs: {},
    });
  }
  excludedRows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

  const cookedFoods = fullTable.filter((r) => r.cooked).length;
  const uncookedFoods = fullTable.length - cookedFoods;

  const fixture: EvalFixture = {
    provenance: {
      fixtureId: FIXTURE_ID,
      sourcePath: `recipe-app/${input.dictPath}`,
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
      },
      evidenceClassCounts,
      corpusPath: input.corpusPath,
      corpusRecipeCount: input.recipes.length,
      corpusIngredientLineCount: agg.corpusIngredientLineCount,
      corpusBlobSha256: input.corpusBlobSha256,
      dictionaryFoodsStats: {
        totalDictEntries: Object.keys(input.dict).length,
        preferredRefEntries: eligible.length,
        distinctPreferredFoods: cases.length,
        duplicateNameEntriesCollapsed: eligible.length - cases.length,
        noRefLegacy,
        noRefFlagged,
        noRefOther,
        nonPreferredType,
        cookedFoods,
        uncookedFoods,
        pastTieBreak2Count: pastTieBreak2.length,
        nameCollisionDropped,
      },
    },
    cases,
    excluded: excludedRows,
  };

  validateFixtureSchema(fixture);

  return {
    fixture,
    summary: {
      totalDictEntries: Object.keys(input.dict).length,
      preferredRefEntries: eligible.length,
      distinctPreferredFoods: cases.length,
      duplicateNameEntriesCollapsed: eligible.length - cases.length,
      noRefLegacy,
      noRefFlagged,
      noRefOther,
      nonPreferredType,
      cookedFoods,
      uncookedFoods,
      evidenceClassCounts,
      pastTieBreak2,
      nameCollisionDropped,
      corpusRecipeCount: input.recipes.length,
      corpusIngredientLineCount: agg.corpusIngredientLineCount,
      fullTable,
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

  const dictRaw = gitShow(args.recipeAppPath, resolvedCommit, args.dictPath);
  const dict = JSON.parse(dictRaw) as DictionaryV3;
  const pinsRaw = gitShow(args.recipeAppPath, resolvedCommit, "scripts/dict-pg/fdc-pins.json");
  const pins = JSON.parse(pinsRaw) as FdcPins;
  const rulingsRaw = gitShow(args.recipeAppPath, resolvedCommit, "scripts/dict-pg/identity-rulings.json");
  const rulings = JSON.parse(rulingsRaw) as IdentityRulings;

  const dictionaryBlobSha = gitRevParseBlob(args.recipeAppPath, resolvedCommit, args.dictPath);
  const assemblyScriptSha256 = createHash("sha256").update(readFileSync(__filename)).digest("hex");

  const { fixture, summary } = buildFixtureV3({
    dict,
    recipes,
    pins,
    rulings,
    date: args.date,
    commitArg: args.commit,
    commitResolved: resolvedCommit,
    dictionaryBlobSha,
    dictPath: args.dictPath,
    corpusPath: args.corpusPath,
    corpusBlobSha256,
    recipeAppPath: args.recipeAppPath,
    assemblyScriptSha256,
  });

  writeFileSync(args.outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`household-dictionary-foods-v3 assembled -> ${args.outPath}`);
  console.log("");
  console.log(`Total dictionary entries:    ${summary.totalDictEntries}`);
  console.log(`Preferred-ref entries:       ${summary.preferredRefEntries}`);
  console.log(`Distinct foods (cases):      ${summary.distinctPreferredFoods}`);
  console.log(`Duplicate-name collapsed:    ${summary.duplicateNameEntriesCollapsed}`);
  console.log(`Excluded — no_ref legacy:    ${summary.noRefLegacy}`);
  console.log(`Excluded — no_ref flagged:   ${summary.noRefFlagged}`);
  console.log(`Excluded — no_ref other:     ${summary.noRefOther}`);
  console.log(`Excluded — non_preferred:    ${summary.nonPreferredType}`);
  console.log(`Name-collision dropped:      ${summary.nameCollisionDropped}`);
  console.log("");
  console.log(`Cooked foods (occurrences>0): ${summary.cookedFoods}`);
  console.log(`Uncooked foods (occurrences=0): ${summary.uncookedFoods}`);
  console.log("");
  console.log("Evidence class counts:");
  for (const [cls, count] of Object.entries(summary.evidenceClassCounts)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log("");
  console.log(`Past tie-break rung 2 (needed rung 3/4/5 to decide): ${summary.pastTieBreak2.length}`);
  const textAmbiguous = summary.pastTieBreak2.filter((r) => r.textAmbiguous);
  console.log(`  of those, TEXT-AMBIGUOUS (2+ different candidate query strings tied): ${textAmbiguous.length}`);
  for (const row of textAmbiguous) {
    console.log(`    fdc_id ${row.fdcId}: chose "${row.chosenName}" (rung ${row.decidedAtRung}) among ${JSON.stringify(row.distinctNamesAfterRung2)}`);
  }
  console.log("");
  console.log(`corpusRecipeCount:          ${summary.corpusRecipeCount}`);
  console.log(`corpusIngredientLineCount:  ${summary.corpusIngredientLineCount}`);
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
