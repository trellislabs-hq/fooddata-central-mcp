/**
 * Module: eval fixture loader + schema validation
 * Purpose: Load an eval fixture (household-food-eval-v1.json — the adversarial
 *   stress corpus, a one-time snapshot derived from recipe-app's Thomas-ratified
 *   FDC identity pin corpus; or household-representative-v1.json — the
 *   representative-traffic corpus, assembled from the four-cart recipe-pack
 *   battery, see eval/scripts/assemble-representative-fixture.ts) and validate
 *   its shape before any case is run. Positive cases MUST carry a
 *   positive-integer `expected.fdcId` — the source pins file stores fdc_id as
 *   a STRING while FdcFood.fdcId (src/fdc-client.ts) is NUMERIC, so a
 *   coercion bug upstream in a (one-time, not re-run) derivation step would
 *   otherwise silently produce a fixture that can never score a hit. This
 *   module is the load-time gate against that class of bug.
 *
 * Major Sections:
 *   - Types: EvalCaseMeta (shared representative-fixture metadata: evidence
 *     class, resolver source, occurrence/pack weighting — undefined on the
 *     adversarial fixture's cases), PositiveEvalCase, NegativeEvalCase,
 *     ExcludedEvalCase (names with no scoreable reference identity — never
 *     enters `cases`, never touches findFood(), carried for coverage
 *     reporting only), EvalFixture
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
  /** Where the expected answer itself came from (spec S6/S11 "resolver source"); representative-fixture cases carry the literal string "dictionary-ratified". */
  expectedSource?: string;
  /** Total occurrences of this name across the pack battery (within-pack duplicates included — see the fixture's own provenance for the exact rule). */
  occurrences?: number;
  /** Per-pack occurrence counts, e.g. {"pack-1": 2, "pack-3": 1}. Packs the name never appears in are simply absent (never zero-valued). */
  packs?: Record<string, number>;
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
  /** sha256 of each of the four pack-N.json snapshot files, keyed by pack id. */
  packSnapshotSha256?: Record<string, string>;
  /** Snapshot schemaVersion shared by all four pack files (assembly rejects a mismatch). */
  packSnapshotSchemaVersion?: number;
  /** recipe-app commit that PRODUCED the pack run (query-production) — differs from dictionaryCommit (label-production). */
  queryProductionCommit?: string;
  /** recipe-app commit the dictionary/pins/rulings were read from (label-production). */
  dictionaryCommit?: string;
  /** git BLOB hash (not a content sha256) of data/ingredient-dictionary.base.json at dictionaryCommit — assembly reads via `git show`, never the working tree. */
  dictionaryBlobSha?: string;
  /** sha256 of this assembly script's own source at the time it produced this fixture. */
  assemblyScriptSha256?: string;
  /** Coverage buckets over the 178-name universe: unresolved (names-index miss) + noRef (resolved, but the dictionary entry carries no fdc_ref) + eligible (scoreable, in `cases`). */
  coverage?: {
    uniqueNames: number;
    uniqueEligible: number;
    uniqueUnresolved: number;
    uniqueNoRef: number;
    weightedOccurrences: number;
    weightedEligible: number;
  };
  /** Counts of `cases` by evidenceClass — printed by the assembly script, echoed here for the README fill-in phase. */
  evidenceClassCounts?: Record<EvidenceClass, number>;
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
function validateMeta(label: string, c: { evidenceClass?: unknown; expectedSource?: unknown; occurrences?: unknown; packs?: unknown }, errors: string[]): void {
  if (c.evidenceClass !== undefined && !EVIDENCE_CLASSES.has(c.evidenceClass as EvidenceClass)) {
    errors.push(`${label}: evidenceClass must be one of human_pin | human_ruling | automated_screened, got ${JSON.stringify(c.evidenceClass)}`);
  }
  if (c.expectedSource !== undefined && (typeof c.expectedSource !== "string" || c.expectedSource.trim().length === 0)) {
    errors.push(`${label}: expectedSource must be a non-empty string when present, got ${JSON.stringify(c.expectedSource)}`);
  }
  if (c.occurrences !== undefined && (!Number.isInteger(c.occurrences) || (c.occurrences as number) <= 0)) {
    errors.push(`${label}: occurrences must be a positive integer when present, got ${JSON.stringify(c.occurrences)}`);
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
