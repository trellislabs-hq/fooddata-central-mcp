/**
 * Module: eval fixture loader + schema validation
 * Purpose: Load the household-food-eval-v1.json fixture (a one-time snapshot
 *   derived from recipe-app's Thomas-ratified FDC identity pin corpus — see
 *   the fixture's own `provenance` block for the derivation rule and source
 *   commit) and validate its shape before any case is run. Positive cases
 *   MUST carry a positive-integer `expected.fdcId` — the source pins file
 *   stores fdc_id as a STRING while FdcFood.fdcId (src/fdc-client.ts) is
 *   NUMERIC, so a coercion bug upstream in the (one-time, not re-run)
 *   derivation step would otherwise silently produce a fixture that can
 *   never score a hit. This module is the load-time gate against that class
 *   of bug.
 *
 * Major Sections:
 *   - Types: EvalCase, PositiveEvalCase, NegativeEvalCase, EvalFixture
 *   - loadFixture() — reads + JSON.parses the committed fixture file
 *   - validateFixtureSchema() — throws a single Error listing every
 *     violation found (not just the first) so a bad derivation run is easy
 *     to fully diagnose in one pass
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

export interface PositiveEvalCase {
  name: string;
  kind: "positive";
  expected: {
    fdcId: number;
    description: string;
    dataType: PreferredDataType;
  };
  reason?: string;
}

export interface NegativeEvalCase {
  name: string;
  kind: "negative";
  reason?: string;
}

export type EvalCase = PositiveEvalCase | NegativeEvalCase;

export interface EvalFixtureProvenance {
  fixtureId: string;
  sourcePath: string;
  sourceRepoCommit: string;
  fixtureSha256: string;
  derivedAt: string;
  derivationRule: string;
  counts: { positive: number; negative: number; total: number };
  license: string;
}

export interface EvalFixture {
  provenance: EvalFixtureProvenance;
  cases: EvalCase[];
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

  if (errors.length > 0) {
    throw new Error(`Fixture schema validation failed (${errors.length} problem(s)):\n  - ${errors.join("\n  - ")}`);
  }
}
