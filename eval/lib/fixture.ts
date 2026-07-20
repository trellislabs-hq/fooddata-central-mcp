/**
 * Module: eval fixture loader + schema validation
 * Purpose: Load an eval fixture (household-food-eval-v1.json — the adversarial
 *   stress corpus, a one-time snapshot derived from recipe-app's Thomas-ratified
 *   FDC identity pin corpus; household-representative-v1.json — the
 *   representative-traffic corpus, assembled from the four-cart recipe-pack
 *   battery, see eval/scripts/assemble-representative-fixture.ts; or
 *   household-representative-v2.json — the frequency-ranked corpus-frame
 *   fixture (top-1,000 most-recipe-frequent canonical entries across the
 *   FULL 935-recipe corpus), see
 *   eval/scripts/assemble-representative-fixture-v2.ts) and validate its
 *   shape before any case is run. Positive cases MUST carry a
 *   positive-integer `expected.fdcId` — the source pins file stores fdc_id as
 *   a STRING while FdcFood.fdcId (src/fdc-client.ts) is NUMERIC, so a
 *   coercion bug upstream in a (one-time, not re-run) derivation step would
 *   otherwise silently produce a fixture that can never score a hit. This
 *   module is the load-time gate against that class of bug.
 *
 * Major Sections:
 *   - Types: EvalCaseMeta (shared representative-fixture metadata: evidence
 *     class, resolver source, occurrence/pack weighting, v2's labelProvenance
 *     — undefined on the adversarial fixture's cases), PositiveEvalCase,
 *     NegativeEvalCase, ExcludedEvalCase (names/entries with no scoreable
 *     reference identity — never enters `cases`, never touches findFood(),
 *     carried for coverage reporting only; occurrences/packs stay REQUIRED,
 *     unchanged from v1 — v2's corpus-frame excluded rows supply an explicit
 *     empty packs:{} rather than loosening the shared type), EvalFixture
 *     (provenance gained v2-only corpus* fields —
 *     corpusPath/corpusRecipeCount/corpusIngredientLineCount/
 *     corpusBlobSha256 — all optional, jump-1778 P1v2)
 *   - loadFixture() — reads + JSON.parses the committed fixture file
 *   - validateFixtureSchema() — throws a single Error listing every
 *     violation found (not just the first) so a bad derivation run is easy
 *     to fully diagnose in one pass. Validates `cases` strictly; validates
 *     `excluded` (if present) loosely (name + reason only — it never reaches
 *     the scoring path).
 *
 * Dependencies: node:fs, node:path, node:url
 * State: Stateless — pure read + validate functions.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "fixtures",
  "household-food-eval-v1.json"
);

export type PreferredDataType = "Foundation" | "SR Legacy" | "Survey (FNDDS)";

/**
 * Per-case evidence tier for a curated reference identity (spec
 * `spec_findfood_representative_eval_v1_2026-07-19.md` S2/C2): `human_pin` —
 * an explicit fdc-pins.json ruling; `human_ruling` — an identity-rulings.json
 * "keep" decision; `automated_screened` — cascade-produced, screen-passed,
 * no individual human adjudication. NEVER call the full curated set
 * "human-verified" in public copy — only the human_pin/human_ruling strata
 * carry direct human review.
 */
export type EvidenceClass = "human_pin" | "human_ruling" | "automated_screened";

/**
 * Metadata carried ONLY by representative-fixture cases (assembled from the
 * recipe-pack battery) — always undefined on the adversarial fixture's hand-
 * curated cases. Optional throughout so the two fixtures share one schema
 * without either one faking data the other doesn't have.
 */
export interface EvalCaseMeta {
  /** Stratification tier for this row's reference identity — see EvidenceClass. */
  evidenceClass?: EvidenceClass;
  /** The constant answer-PROVENANCE tag (which corpus the expected answer was drawn from) — representative-fixture cases carry the literal string "dictionary-ratified". This is NOT the per-row resolver detail (see resolverSource below); a Codex jump-1778 fix-pass finding caught this field being mislabeled as spec S11's "resolver source" — it isn't, it's constant across every row and carries no per-row audit signal. */
  expectedSource?: string;
  /** Spec S11's actual "resolver source" per row: the dictionary entry's OWN fdc_ref.match_method (e.g. "exact" | "close" | "pinned") — how THAT identity was matched during recipe-app's dictionary-to-FDC enrichment, independent of evidenceClass (which is about human adjudication tier, not match mechanics). */
  resolverSource?: string;
  /** Total occurrences of this name across the pack battery (within-pack duplicates included — see the fixture's own provenance for the exact rule). On household-representative-v2 rows this is instead the DISTINCT-RECIPE count (a recipe using the same canonical entry twice counts once) — see that fixture's provenance.derivationRule for the exact rule; the field name is shared, the counting rule is fixture-specific. On household-dictionary-foods-v3 rows this is the FOOD-LEVEL distinct-recipe count: the SUM of the distinct-recipe count across EVERY dictionary name (base.json entry) that resolves to this case's shared fdc_id — legitimately 0 for a real dictionary food that never appears in the pinned corpus (see `cooked` below; jump-1778 P3 is why this field is allowed to be 0 at all — see validateMeta's own comment). */
  occurrences?: number;
  /** Per-pack occurrence counts, e.g. {"pack-1": 2, "pack-3": 1}. Packs the name never appears in are simply absent (never zero-valued). Undefined on fixtures with no pack concept (e.g. household-representative-v2, assembled from the full recipe corpus rather than a four-cart battery). */
  packs?: Record<string, number>;
  /**
   * v2 addition (household-representative-v2 only, jump-1778 P1v2): marks a
   * case's `expected` as a CANDIDATE label awaiting the separate, later
   * independent-judge + human-audit ground-truth pass (spec
   * spec_findfood_representative_eval_v1_2026-07-19.md "v2 GROUND TRUTH") —
   * NOT a final ratified identity. The literal value used today is
   * "dictionary-candidate-unverified". Undefined on v1 and the adversarial
   * fixture, whose `expected` values are NOT candidates awaiting further
   * adjudication. household-dictionary-foods-v3 also carries this tag — the
   * ground-truth caveat is identical (still cascade/dictionary-lineage
   * labels, not independently human-verified).
   */
  labelProvenance?: string;
  /**
   * household-dictionary-foods-v3 only (jump-1778 P3): true when this food's
   * `occurrences` (see above) is > 0 — i.e. it appears at least once in the
   * pinned recipe corpus under ANY of its dictionary names. false means a
   * real, distinct FDC food in the dictionary that this corpus never
   * actually cooks — reported honestly, never dropped. Undefined on every
   * other fixture (no "cooked" concept applies to a name-resolution frame).
   */
  cooked?: boolean;
}

export interface PositiveEvalCase extends EvalCaseMeta {
  name: string;
  kind: "positive";
  expected: {
    fdcId: number;
    description: string;
    dataType: PreferredDataType;
  };
  reason?: string;
}

export interface NegativeEvalCase extends EvalCaseMeta {
  name: string;
  kind: "negative";
  reason?: string;
}

export type EvalCase = PositiveEvalCase | NegativeEvalCase;

/**
 * A name with NO scoreable reference identity (failed names-index
 * resolution, or resolved but the dictionary entry carries no fdc_ref).
 * Never enters `cases`, never calls findFood() — carried purely so coverage
 * denominators (spec S4: "exclusions skew toward hard names — hiding them
 * would inflate accuracy") can be printed honestly.
 *
 * `occurrences`/`packs` stay REQUIRED (kept identical to v1 deliberately —
 * eval/lib/statistics.ts reads both unconditionally, and loosening them to
 * optional here would regress its own type-safety). household-representative-v2
 * (assembled from the full recipe corpus, which has no pack concept) always
 * supplies `occurrences` from its distinct-recipe tally and an EXPLICIT empty
 * `packs: {}` — an honest "this row has no pack attribution" value, not a
 * fabricated one; see that field's own doc comment ("packs the name never
 * appears in are simply absent").
 */
export interface ExcludedEvalCase {
  name: string;
  reason: string;
  occurrences: number;
  packs: Record<string, number>;
}

export interface EvalFixtureProvenance {
  fixtureId: string;
  sourcePath: string;
  sourceRepoCommit: string;
  /** sha256 of the SOURCE fdc-pins.json file this fixture was derived from — not a hash of this fixture file itself. Adversarial fixture only. */
  sourcePinsSha256?: string;
  derivedAt: string;
  derivationRule: string;
  counts: { positive: number; negative: number; total: number };
  license: string;

  // ── Representative-fixture-only provenance (spec S9/S11) — all optional
  // so the adversarial fixture's provenance block is unaffected. Assembled
  // by eval/scripts/assemble-representative-fixture.ts; NEVER hand-edited.
  /** The recipe-app recipe-pack run id this fixture was assembled from. */
  packRunId?: string;
  /** sha256 of each of the four pack-N.json RUN SNAPSHOT files (runs/<runId>/pack-N.json — the pipeline's OUTPUT), keyed by pack id. */
  packSnapshotSha256?: Record<string, string>;
  /** sha256 of each of the four pack-N.json INPUT DEFINITION files (data/recipe-packs/pack-N.json — the recipe lists fed INTO the pipeline to produce the run snapshot), keyed by pack id. Distinct file set from packSnapshotSha256 — a jump-1778 fix-pass finding caught these being missing from provenance entirely. */
  packInputSha256?: Record<string, string>;
  /** Snapshot schemaVersion shared by all four pack files (assembly rejects a mismatch). */
  packSnapshotSchemaVersion?: number;
  /** recipe-app commit that PRODUCED the pack run (query-production) — differs from dictionaryCommit (label-production). Always the FULL 40-hex SHA. */
  queryProductionCommit?: string;
  /** recipe-app commit the dictionary/pins/rulings were read from (label-production). Always the FULL 40-hex SHA (resolved via `git rev-parse` — a jump-1778 fix-pass finding caught the short arg form "7e681cb" being stored here directly, which isn't stable/re-derivable on its own if the short form ever became ambiguous). */
  dictionaryCommit?: string;
  /** git BLOB hash (not a content sha256) of data/ingredient-dictionary.base.json at dictionaryCommit — assembly reads via `git show`, never the working tree. */
  dictionaryBlobSha?: string;
  /** sha256 of this assembly script's own source at the time it produced this fixture. */
  assemblyScriptSha256?: string;
  /** The exact CLI parameters the assembly run was invoked with — the other half of true re-derivability alongside the hashes above. */
  parameters?: {
    /** The --commit argument AS PASSED (may be a short ref like "7e681cb"). */
    commitArg: string;
    /** The same commit, resolved to its full 40-hex SHA — see dictionaryCommit. */
    commitResolved: string;
    /** v1 (four-cart pack battery) only — undefined for a corpus-frame assembly (household-representative-v2) which has no pack directory. */
    packDir?: string;
    recipeAppPath: string;
    /** The --date argument AS PASSED — this fixture's derivedAt. */
    date: string;
    /** household-representative-v2 only (jump-1778 P1v2): the --target-n the ranking was cut off at (spec: "top 1,000"). */
    targetN?: number;
    /** household-representative-v2 only: the ACTUAL number of cases produced — equals targetN unless fewer than targetN unique entries were eligible, in which case actualN < targetN and every eligible entry is included (spec: "if fewer unique resolvable exist, take all + report actual N prominently"). */
    actualN?: number;
  };
  /** Coverage buckets over the 178-name universe: unresolved (names-index miss) + noRef (resolved, has NO fdc_ref at all) + nonPreferredType (resolved, HAS an fdc_ref, but its data_type isn't Foundation/SR Legacy/Survey — a DISTINCT bucket from noRef, a jump-1778 fix-pass finding caught these being silently lumped together) + eligible (scoreable, in `cases`). On household-representative-v2 these are corpus-wide (over ALL distinct canonical entries the corpus resolves to, not just the top-1000 selected into `cases` — see uniqueEligibleSelected/weightedEligibleSelected below for the post-cutoff subset). */
  coverage?: {
    uniqueNames: number;
    uniqueEligible: number;
    uniqueUnresolved: number;
    uniqueNoRef: number;
    uniqueNonPreferredType: number;
    weightedOccurrences: number;
    weightedEligible: number;
    /** household-representative-v2 only: uniqueEligible narrowed to the entries that actually made the top-N frequency cutoff (== cases.length). Equals uniqueEligible whenever the corpus has <= targetN eligible entries. */
    uniqueEligibleSelected?: number;
    /** household-representative-v2 only: weightedEligible (distinct-recipe-occurrence sum) narrowed to the top-N selected entries — the descriptive "how much of the eligible corpus mass the published top-N actually covers" number. */
    weightedEligibleSelected?: number;
  };
  /** Counts of `cases` by evidenceClass — printed by the assembly script, echoed here for the README fill-in phase. */
  evidenceClassCounts?: Record<EvidenceClass, number>;

  // ── household-representative-v2-only provenance (jump-1778 P1v2) — all
  // optional so v1 and the adversarial fixture's provenance blocks are
  // unaffected. Assembled by
  // eval/scripts/assemble-representative-fixture-v2.ts; NEVER hand-edited.
  /** Repo-relative path this fixture's corpus was read from, e.g. "recipe-app/data/shared-recipes.json". Read via `git show` at the pinned commit — never the working tree (the working copy is a prod-maintained, growing dev snapshot; the fixture must stay re-derivable from a fixed commit). */
  corpusPath?: string;
  /** Total recipe count in the corpus at the pinned commit (935 measured 2026-07-19). */
  corpusRecipeCount?: number;
  /** Total raw ingredient LINE count across every recipe's `ingredients` array (11,873 measured 2026-07-19) — the denominator for the corpus-wide coverage buckets, distinct from uniqueNames (which counts distinct RESOLVED-OR-NOT canonical/extracted keys, not raw lines). */
  corpusIngredientLineCount?: number;
  /** sha256 of the raw corpus file bytes at the pinned commit (content hash, NOT a git blob object hash — see dictionaryBlobSha for the git-blob-hash sibling). */
  corpusBlobSha256?: string;

  /**
   * household-dictionary-foods-v3-only provenance (jump-1778 P3) — all
   * optional so every other fixture's provenance block is unaffected.
   * Assembled by eval/scripts/assemble-dictionary-foods-fixture-v3.ts; NEVER
   * hand-edited. Unlike v1/v2 (frames over recipe-corpus NAMES and their
   * resolutions), this frame is over DISTINCT FDC FOODS in the recipe-app
   * dictionary itself — these counts describe dict-ENTRY coverage, not
   * name-resolution coverage, so they intentionally do not reuse the
   * `coverage` block above (whose fields are documented in terms of
   * corpus-name resolution).
   */
  dictionaryFoodsStats?: {
    /** Every base.json entry, preferred-ref or not (1,738 measured 2026-07-19). */
    totalDictEntries: number;
    /** Entries carrying an fdc_ref of a preferred data_type (Foundation | SR Legacy | Survey (FNDDS)) — pre-dedup, i.e. before collapsing cart/prep/phrasing variants into one representative per food (1,599 measured). */
    preferredRefEntries: number;
    /** Distinct fdc_id count among preferredRefEntries — equals cases.length (585 measured). */
    distinctPreferredFoods: number;
    /** preferredRefEntries - distinctPreferredFoods: cart/prep/phrasing variant entries collapsed into their food's single representative case (1,014 measured). */
    duplicateNameEntriesCollapsed: number;
    /** No fdc_ref at all, dictionary status "legacy" (83 measured). */
    noRefLegacy: number;
    /** No fdc_ref at all, dictionary status "flagged" (56 measured). */
    noRefFlagged: number;
    /** No fdc_ref at all, any OTHER status (0 measured on the pinned dictionary — a generic bucket kept for future data). */
    noRefOther: number;
    /** HAS an fdc_ref, but its data_type is not a preferred type (e.g. Branded) — 0 measured on the pinned dictionary (a generic bucket, distinct from the no-ref buckets — mirrors v1/v2's own non_preferred_type/no_ref split). */
    nonPreferredType: number;
    /** cases with occurrences > 0 (see EvalCaseMeta.cooked). */
    cookedFoods: number;
    /** cases with occurrences === 0 — a real dictionary food never cooked in this corpus, reported honestly, never dropped (~31 expected). */
    uncookedFoods: number;
    /** Count of fdc_id groups whose representative selection needed tie-break rung 3, 4, or the implicit rung-5 dict-key fallback — i.e. rung 1 (fewest cart_modifiers) + rung 2 (shortest product_name, token-count then char-length) alone did not leave exactly one candidate. See the assembly run's build report for the full per-fdc_id list (spot-review candidates). */
    pastTieBreak2Count: number;
    /** Excluded rows dropped by the defensive name-collision guard (an excluded entry's product_name collided with a case's chosen representative product_name) — 0 on the pinned dictionary; the guard exists for future data changes, see assemble-dictionary-foods-fixture-v3.ts's own header. */
    nameCollisionDropped: number;
  };
}

export interface EvalFixture {
  provenance: EvalFixtureProvenance;
  cases: EvalCase[];
  /** Names excluded from `cases` for lack of a scoreable reference identity — see ExcludedEvalCase. Absent/empty on the adversarial fixture. */
  excluded?: ExcludedEvalCase[];
}

/** Read + JSON.parse the fixture file. Does NOT validate — call validateFixtureSchema() too. */
export function loadFixture(fixturePath: string = DEFAULT_FIXTURE_PATH): EvalFixture {
  const raw = readFileSync(fixturePath, "utf-8");
  return JSON.parse(raw) as EvalFixture;
}

const PREFERRED_DATA_TYPES = new Set<PreferredDataType>([
  "Foundation",
  "SR Legacy",
  "Survey (FNDDS)",
]);

const EVIDENCE_CLASSES = new Set<EvidenceClass>(["human_pin", "human_ruling", "automated_screened"]);

/** Shared meta-field validation for both case kinds and (loosely) excluded rows. Pushes onto `errors`, never throws directly. */
function validateMeta(label: string, c: { evidenceClass?: unknown; expectedSource?: unknown; resolverSource?: unknown; labelProvenance?: unknown; occurrences?: unknown; packs?: unknown; cooked?: unknown }, errors: string[]): void {
  if (c.evidenceClass !== undefined && !EVIDENCE_CLASSES.has(c.evidenceClass as EvidenceClass)) {
    errors.push(`${label}: evidenceClass must be one of human_pin | human_ruling | automated_screened, got ${JSON.stringify(c.evidenceClass)}`);
  }
  if (c.expectedSource !== undefined && (typeof c.expectedSource !== "string" || c.expectedSource.trim().length === 0)) {
    errors.push(`${label}: expectedSource must be a non-empty string when present, got ${JSON.stringify(c.expectedSource)}`);
  }
  if (c.resolverSource !== undefined && (typeof c.resolverSource !== "string" || c.resolverSource.trim().length === 0)) {
    errors.push(`${label}: resolverSource must be a non-empty string when present, got ${JSON.stringify(c.resolverSource)}`);
  }
  if (c.labelProvenance !== undefined && (typeof c.labelProvenance !== "string" || c.labelProvenance.trim().length === 0)) {
    errors.push(`${label}: labelProvenance must be a non-empty string when present, got ${JSON.stringify(c.labelProvenance)}`);
  }
  // jump-1778 P3: NON-NEGATIVE, not strictly positive — household-dictionary-
  // foods-v3 legitimately reports occurrences:0 for a real dictionary food
  // that never appears in the pinned corpus (see EvalCaseMeta.occurrences /
  // .cooked doc comments). v1/v2/adversarial never construct a 0-occurrence
  // row today, so this is a pure widening: nothing that validated before
  // stops validating now.
  if (c.occurrences !== undefined && (!Number.isInteger(c.occurrences) || (c.occurrences as number) < 0)) {
    errors.push(`${label}: occurrences must be a non-negative integer when present, got ${JSON.stringify(c.occurrences)}`);
  }
  if (c.cooked !== undefined && typeof c.cooked !== "boolean") {
    errors.push(`${label}: cooked must be a boolean when present, got ${JSON.stringify(c.cooked)}`);
  }
  if (c.packs !== undefined) {
    if (typeof c.packs !== "object" || c.packs === null || Array.isArray(c.packs)) {
      errors.push(`${label}: packs must be an object of packId -> positive integer when present`);
    } else {
      for (const [packId, count] of Object.entries(c.packs as Record<string, unknown>)) {
        if (!Number.isInteger(count) || (count as number) <= 0) {
          errors.push(`${label}: packs["${packId}"] must be a positive integer, got ${JSON.stringify(count)}`);
        }
      }
    }
  }
}

/**
 * Validate fixture shape. Throws a single Error whose message enumerates
 * every violation found (case name + problem), so a bad derivation run
 * doesn't require fix-one/rerun/fix-next iteration to fully diagnose.
 */
export function validateFixtureSchema(fixture: EvalFixture): void {
  const errors: string[] = [];

  if (!fixture || typeof fixture !== "object") {
    throw new Error("Fixture is not an object.");
  }
  if (!Array.isArray(fixture.cases)) {
    throw new Error("Fixture.cases is not an array.");
  }

  const seenNames = new Set<string>();

  for (const [i, c] of fixture.cases.entries()) {
    const label = `case[${i}]${c && typeof c === "object" && "name" in c ? ` "${(c as EvalCase).name}"` : ""}`;

    if (!c || typeof c !== "object") {
      errors.push(`${label}: not an object`);
      continue;
    }
    if (typeof c.name !== "string" || c.name.trim().length === 0) {
      errors.push(`${label}: missing/empty "name"`);
    } else if (seenNames.has(c.name)) {
      errors.push(`${label}: duplicate case name "${c.name}"`);
    } else {
      seenNames.add(c.name);
    }

    if (c.kind !== "positive" && c.kind !== "negative") {
      errors.push(`${label}: "kind" must be "positive" or "negative", got ${JSON.stringify((c as { kind?: unknown }).kind)}`);
      continue;
    }

    validateMeta(label, c as EvalCaseMeta, errors);

    if (c.kind === "positive") {
      const expected = (c as PositiveEvalCase).expected;
      if (!expected || typeof expected !== "object") {
        errors.push(`${label}: positive case missing "expected"`);
        continue;
      }
      const { fdcId, description, dataType } = expected;
      if (!Number.isInteger(fdcId) || fdcId <= 0) {
        errors.push(`${label}: expected.fdcId must be a positive integer, got ${JSON.stringify(fdcId)}`);
      }
      if (typeof description !== "string" || description.trim().length === 0) {
        errors.push(`${label}: expected.description must be a non-empty string`);
      }
      if (!PREFERRED_DATA_TYPES.has(dataType)) {
        errors.push(`${label}: expected.dataType must be one of Foundation | SR Legacy | Survey (FNDDS), got ${JSON.stringify(dataType)}`);
      }
    } else {
      const expected = (c as unknown as { expected?: unknown }).expected;
      if (expected !== undefined) {
        errors.push(`${label}: negative case must not carry "expected" (got one)`);
      }
    }
  }

  if (fixture.excluded !== undefined) {
    if (!Array.isArray(fixture.excluded)) {
      errors.push(`excluded: must be an array when present`);
    } else {
      for (const [i, x] of fixture.excluded.entries()) {
        const label = `excluded[${i}]${x && typeof x === "object" && "name" in x ? ` "${(x as ExcludedEvalCase).name}"` : ""}`;
        if (!x || typeof x !== "object") {
          errors.push(`${label}: not an object`);
          continue;
        }
        if (typeof x.name !== "string" || x.name.trim().length === 0) {
          errors.push(`${label}: missing/empty "name"`);
        } else if (seenNames.has(x.name)) {
          errors.push(`${label}: name "${x.name}" also appears in cases[] — a name must be either scoreable or excluded, never both`);
        }
        if (typeof x.reason !== "string" || x.reason.trim().length === 0) {
          errors.push(`${label}: missing/empty "reason"`);
        }
        validateMeta(label, x as unknown as EvalCaseMeta, errors);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Fixture schema validation failed (${errors.length} problem(s)):\n  - ${errors.join("\n  - ")}`);
  }
}
