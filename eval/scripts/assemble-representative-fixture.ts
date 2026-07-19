/**
 * Module: household-representative-v1 fixture assembler (CLI)
 * Purpose: Derives eval/fixtures/household-representative-v1.json from the
 *   recipe-app four-cart recipe-pack battery + the recipe-app ingredient
 *   dictionary at a pinned commit — see spec_findfood_representative_eval_v1_
 *   2026-07-19.md (S1/S2/S5/S9) for the full methodology. A SCRIPT, not a
 *   hand-built file: re-derivable from the pack snapshots + dictionary at
 *   any SHA, byte-identical given the same --date. Makes ZERO network calls
 *   (reads the pack snapshots off local disk; reads recipe-app's dictionary/
 *   pins/rulings via `git -C <recipe-app> show <commit>:<path>` — NEVER the
 *   working tree, NEVER a cross-repo import).
 *
 * Algorithm (verified byte-for-byte against the spec's measured expectation
 * — 178 unique / 251 occurrences, 142 eligible / 30 unresolved / 6 no-ref,
 * evidence classes 30 human_pin / 8 human_ruling / 104 automated_screened):
 *   1. Read the four pack-N.json snapshots; reject any that isn't
 *      status:"complete", or whose runId/schemaVersion disagrees with its
 *      siblings.
 *   2. Extract result.items[].product_name per pack (the pipeline's
 *      aggregated shopping-list name, NOT _parseDetail.epkKey) — occurrence
 *      count = every item ROW bearing that name, across all four packs,
 *      INCLUDING within-pack duplicates (a handful exist: e.g. "chickpeas"
 *      appears twice in pack-1's own items[]).
 *   3. Determine the query-production commit: the recipe-app commit that
 *      was HEAD when the pack run STARTED (git log --before=<earliest pack
 *      timestamp>) — expected to differ from the dictionary/label commit.
 *   4. Read data/ingredient-dictionary.base.json, scripts/dict-pg/fdc-pins.json,
 *      and scripts/dict-pg/identity-rulings.json at the pinned dictionary
 *      commit (--commit, default 7e681cb) via git show.
 *   5. Build the SAME inverted name index recipe-app's own
 *      scripts/lib/ingredient-name-index.js builds (buildNameIndex +
 *      resolveName, ported here — base.json ONLY, no learned.json, per the
 *      jump-1778 dispatch instruction): names[] arrays -> lowercased name ->
 *      canonical dictionary key, with exact match then -es/-s plural
 *      fallback.
 *   6. Resolve each of the 178 unique names. A name that fails resolution,
 *      or resolves to an entry with no fdc_ref.fdc_id, becomes an EXCLUDED
 *      row (expected:null equivalent — excluded rows never enter `cases`).
 *      An eligible name becomes a POSITIVE case with expected = the
 *      resolved entry's fdc_ref.
 *   7. evidence_class per eligible row: human_pin if fdc-pins.json has a
 *      POSITIVE entry (fdc_id !== null) keyed by the resolved entry's OWN
 *      product_name; else human_ruling if "<product_name>|<fdc_id>" is a
 *      "keep" decision in identity-rulings.json; else automated_screened.
 *
 * Major Sections:
 *   - CLI arg parsing (--date REQUIRED, --commit, --recipe-app, --pack-dir, --out)
 *   - gitShow() / gitRevParse() / gitLogBefore() — recipe-app repo reads
 *   - buildNameIndex() / resolveName() — ported resolution algorithm
 *   - loadPacks() — reads + validates the four snapshot files
 *   - classify() — per-name eligible/excluded + evidence_class decision
 *   - main() — orchestrates, writes the fixture, prints the summary
 *
 * Dependencies: node:child_process (git shell-outs), node:crypto (sha256),
 *   node:fs, node:path, ../lib/fixture.js (types + validateFixtureSchema —
 *   the assembled fixture is validated before it's ever written)
 * State: Reads recipe-app on disk (pack snapshots) and via git show
 *   (dictionary/pins/rulings) — READ-ONLY, no writes to recipe-app. Writes
 *   ONE file: --out (default eval/fixtures/household-representative-v1.json).
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PACK_DIR = "/Users/thomasstewart/Projects/recipe-app/data/recipe-packs/runs/2026-07-17T03-12-09-887Z";
const DEFAULT_RECIPE_APP = "/Users/thomasstewart/Projects/recipe-app";
const DEFAULT_COMMIT = "7e681cb";
const DEFAULT_OUT = path.join(__dirname, "..", "fixtures", "household-representative-v1.json");
const FIXTURE_ID = "household-representative-v1";

const PREFERRED_DATA_TYPES = new Set<PreferredDataType>(["Foundation", "SR Legacy", "Survey (FNDDS)"]);

// ─── CLI args ────────────────────────────────────────────────────────────

interface Args {
  date: string;
  commit: string;
  recipeAppPath: string;
  packDir: string;
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
    packDir: get("--pack-dir") ?? DEFAULT_PACK_DIR,
    outPath: get("--out") ?? DEFAULT_OUT,
  };
}

// ─── recipe-app repo reads (git show — never the working tree) ───────────

function gitShow(repoPath: string, commit: string, filePath: string): string {
  return execFileSync("git", ["-C", repoPath, "show", `${commit}:${filePath}`], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitRevParseBlob(repoPath: string, commit: string, filePath: string): string {
  return execFileSync("git", ["-C", repoPath, "rev-parse", `${commit}:${filePath}`], { encoding: "utf-8" }).trim();
}

/** The commit that was HEAD immediately before `beforeIso` — used to find the query-production commit from the pack run's own timestamps. */
function gitLogBefore(repoPath: string, beforeIso: string): string {
  return execFileSync("git", ["-C", repoPath, "log", `--before=${beforeIso}`, "-1", "--format=%H"], { encoding: "utf-8" }).trim();
}

// ─── name index (ported from recipe-app scripts/lib/ingredient-name-index.js) ───

interface DictEntry {
  product_name?: string;
  names?: string[];
  fdc_ref?: { fdc_id?: string; description?: string; data_type?: string; match_method?: string };
}
type Dictionary = Record<string, DictEntry>;

/**
 * buildNameIndex(dict) — ported 1:1 from recipe-app's
 * scripts/lib/ingredient-name-index.js buildNameIndex(dict, learned), with
 * `learned` omitted per the jump-1778 dispatch instruction (base.json is the
 * sole source read via git show; the pack run's OWN learned-dictionary
 * fingerprint is a live runtime artifact, not something re-derivable at an
 * arbitrary pinned commit). Later writers win on a name collision — same
 * semantics as the original's Map.set order over Object.entries(dict).
 */
function buildNameIndex(dict: Dictionary): Map<string, string> {
  const nameIndex = new Map<string, string>();
  for (const [key, entry] of Object.entries(dict)) {
    const names = Array.isArray(entry.names) && entry.names.length > 0 ? entry.names : [key];
    for (const name of names) {
      nameIndex.set(name.toLowerCase(), key);
    }
  }
  return nameIndex;
}

/** resolveName(name, nameIndex) — ported 1:1 (exact match, then -es/-s plural fallback). Returns undefined on a full miss (strict — the production canonicalize() passthrough is NOT used here; an unresolved name must become an EXCLUDED row, never silently fall back to itself). */
function resolveName(name: string, nameIndex: Map<string, string>): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();

  const exact = nameIndex.get(lower);
  if (exact !== undefined) return exact;

  if (lower.endsWith("es")) {
    const stripped = lower.slice(0, -2);
    const hit = nameIndex.get(stripped);
    if (hit !== undefined) return hit;
  }
  if (lower.endsWith("s")) {
    const stripped = lower.slice(0, -1);
    const hit = nameIndex.get(stripped);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// ─── pack snapshot loading ─────────────────────────────────────────────────

interface PackItem {
  product_name: string;
  [key: string]: unknown;
}
interface PackSnapshot {
  schemaVersion: number;
  runId: string;
  packId: string;
  timestamp: string;
  status: string;
  result: { items: PackItem[] };
}

interface LoadedPack {
  packId: string;
  snapshot: PackSnapshot;
  raw: Buffer;
  sha256: string;
}

function loadPacks(packDir: string): LoadedPack[] {
  const packs: LoadedPack[] = [];
  for (let i = 1; i <= 4; i++) {
    const filePath = path.join(packDir, `pack-${i}.json`);
    const raw = readFileSync(filePath);
    const snapshot = JSON.parse(raw.toString("utf-8")) as PackSnapshot;
    if (snapshot.status !== "complete") {
      throw new Error(`${filePath}: status is "${snapshot.status}", not "complete" — assembly refuses to read from an incomplete/failed pack run.`);
    }
    packs.push({ packId: snapshot.packId ?? `pack-${i}`, snapshot, raw, sha256: createHash("sha256").update(raw).digest("hex") });
  }

  const runIds = new Set(packs.map((p) => p.snapshot.runId));
  if (runIds.size !== 1) {
    throw new Error(`Pack snapshots disagree on runId: ${[...runIds].join(", ")} — refusing to assemble from a mixed run.`);
  }
  const schemaVersions = new Set(packs.map((p) => p.snapshot.schemaVersion));
  if (schemaVersions.size !== 1) {
    throw new Error(`Pack snapshots disagree on schemaVersion: ${[...schemaVersions].join(", ")} — refusing to assemble from a mixed schema.`);
  }

  return packs;
}

// ─── classification ─────────────────────────────────────────────────────

interface NameStats {
  name: string;
  occurrences: number;
  packs: Record<string, number>;
}

function collectNameStats(packs: LoadedPack[]): Map<string, NameStats> {
  const stats = new Map<string, NameStats>();
  for (const pack of packs) {
    for (const item of pack.snapshot.result.items) {
      const name = item.product_name;
      let s = stats.get(name);
      if (!s) {
        s = { name, occurrences: 0, packs: {} };
        stats.set(name, s);
      }
      s.occurrences++;
      s.packs[pack.packId] = (s.packs[pack.packId] ?? 0) + 1;
    }
  }
  return stats;
}

type FdcPins = Record<string, { fdc_id: string | null } | undefined>;
type IdentityRulings = { decisions: Record<string, { ruling: string } | undefined> };

function classifyEvidence(productName: string, fdcId: string, pins: FdcPins, rulings: IdentityRulings): EvidenceClass {
  const pin = pins[productName];
  if (pin && pin.fdc_id !== null && pin.fdc_id !== undefined) return "human_pin";

  const rulingKey = `${productName}|${fdcId}`;
  const ruling = rulings.decisions[rulingKey];
  if (ruling && ruling.ruling === "keep") return "human_ruling";

  return "automated_screened";
}

// ─── main ────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const packs = loadPacks(args.packDir);
  const nameStats = collectNameStats(packs);
  const earliestTimestamp = packs.map((p) => p.snapshot.timestamp).sort()[0];

  const queryProductionCommit = gitLogBefore(args.recipeAppPath, earliestTimestamp);

  const dictRaw = gitShow(args.recipeAppPath, args.commit, "data/ingredient-dictionary.base.json");
  const dict = JSON.parse(dictRaw) as Dictionary;
  const pinsRaw = gitShow(args.recipeAppPath, args.commit, "scripts/dict-pg/fdc-pins.json");
  const pins = JSON.parse(pinsRaw) as FdcPins;
  const rulingsRaw = gitShow(args.recipeAppPath, args.commit, "scripts/dict-pg/identity-rulings.json");
  const rulings = JSON.parse(rulingsRaw) as IdentityRulings;

  const dictionaryBlobSha = gitRevParseBlob(args.recipeAppPath, args.commit, "data/ingredient-dictionary.base.json");
  const nameIndex = buildNameIndex(dict);

  const cases: PositiveEvalCase[] = [];
  const excluded: ExcludedEvalCase[] = [];
  const evidenceClassCounts: Record<EvidenceClass, number> = { human_pin: 0, human_ruling: 0, automated_screened: 0 };

  for (const name of [...nameStats.keys()].sort()) {
    const stats = nameStats.get(name)!;
    const canonicalKey = resolveName(name, nameIndex);

    if (canonicalKey === undefined) {
      excluded.push({ name, reason: "names-index resolution miss (no dictionary entry claims this name, incl. -s/-es plural fallback)", occurrences: stats.occurrences, packs: stats.packs });
      continue;
    }

    const entry = dict[canonicalKey];
    const fdcRef = entry?.fdc_ref;
    if (!fdcRef || !fdcRef.fdc_id) {
      excluded.push({ name, reason: `resolved to canonical entry "${canonicalKey}" but it carries no fdc_ref`, occurrences: stats.occurrences, packs: stats.packs });
      continue;
    }

    const dataType = fdcRef.data_type;
    if (!PREFERRED_DATA_TYPES.has(dataType as PreferredDataType)) {
      excluded.push({
        name,
        reason: `resolved to canonical entry "${canonicalKey}" but its fdc_ref.data_type ("${dataType}") is not one of Foundation | SR Legacy | Survey (FNDDS)`,
        occurrences: stats.occurrences,
        packs: stats.packs,
      });
      continue;
    }

    const productName = entry!.product_name ?? canonicalKey;
    const evidenceClass = classifyEvidence(productName, fdcRef.fdc_id, pins, rulings);
    evidenceClassCounts[evidenceClass]++;

    cases.push({
      name,
      kind: "positive",
      expected: { fdcId: Number(fdcRef.fdc_id), description: fdcRef.description ?? productName, dataType: dataType as PreferredDataType },
      reason: `Representative battery: canonical entry "${canonicalKey}" (product_name "${productName}"), match_method "${fdcRef.match_method ?? "?"}".`,
      evidenceClass,
      expectedSource: "dictionary-ratified",
      occurrences: stats.occurrences,
      packs: stats.packs,
    });
  }

  cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  excluded.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const uniqueNames = nameStats.size;
  const weightedOccurrences = [...nameStats.values()].reduce((sum, s) => sum + s.occurrences, 0);
  const weightedEligible = cases.reduce((sum, c) => sum + (c.occurrences ?? 0), 0);
  const uniqueUnresolved = excluded.filter((x) => x.reason.startsWith("names-index resolution miss")).length;
  const uniqueNoRef = excluded.length - uniqueUnresolved;

  const assemblyScriptSha256 = createHash("sha256").update(readFileSync(__filename)).digest("hex");

  const fixture: EvalFixture = {
    provenance: {
      fixtureId: FIXTURE_ID,
      sourcePath: "recipe-app/data/recipe-packs/runs/<runId>/pack-{1..4}.json",
      sourceRepoCommit: args.commit,
      derivedAt: args.date,
      derivationRule:
        "Assembled by eval/scripts/assemble-representative-fixture.ts from the four-cart recipe-pack battery's " +
        "aggregated shopping-list names (result.items[].product_name, occurrence-counted across all four packs " +
        "including within-pack duplicates). Each unique name is resolved through a port of recipe-app's own " +
        "scripts/lib/ingredient-name-index.js (buildNameIndex + resolveName, base.json only, exact match then " +
        "-es/-s plural fallback) to a canonical dictionary entry; the entry's fdc_ref becomes the case's expected " +
        "answer. Names that fail resolution, or resolve to an entry with no usable fdc_ref, are EXCLUDED (never " +
        "scored) and recorded with a reason for honest coverage reporting. evidence_class is human_pin (an " +
        "explicit fdc-pins.json ruling), human_ruling (an identity-rulings.json \"keep\" decision), or " +
        "automated_screened (cascade-produced, screen-passed, no individual human adjudication) — see spec " +
        "spec_findfood_representative_eval_v1_2026-07-19.md S2. This is a ONE-TIME SNAPSHOT — the eval harness " +
        "never re-reads the recipe-app repo at runtime; only this assembly script does, and only at assembly time.",
      counts: { positive: cases.length, negative: 0, total: cases.length },
      license:
        "FDC identifiers and food composition data are U.S. public domain (USDA FoodData Central, a U.S. Government work). " +
        "The recipe-pack battery and dictionary curation were authored by this project's maintainers and are released " +
        "under this repository's MIT license (see LICENSE).",
      packRunId: packs[0].snapshot.runId,
      packSnapshotSha256: Object.fromEntries(packs.map((p) => [p.packId, p.sha256])),
      packSnapshotSchemaVersion: packs[0].snapshot.schemaVersion,
      queryProductionCommit,
      dictionaryCommit: args.commit,
      dictionaryBlobSha,
      assemblyScriptSha256,
      coverage: {
        uniqueNames,
        uniqueEligible: cases.length,
        uniqueUnresolved,
        uniqueNoRef,
        weightedOccurrences,
        weightedEligible,
      },
      evidenceClassCounts,
    },
    cases,
    excluded,
  };

  validateFixtureSchema(fixture);

  writeFileSync(args.outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`household-representative-v1 assembled -> ${args.outPath}`);
  console.log("");
  console.log(`Unique names:        ${uniqueNames}`);
  console.log(`Total occurrences:   ${weightedOccurrences}`);
  console.log(`Eligible (cases):    ${cases.length} unique (${(100 * cases.length / uniqueNames).toFixed(1)}% unique) / ${weightedEligible} weighted (${(100 * weightedEligible / weightedOccurrences).toFixed(1)}% weighted)`);
  console.log(`Excluded:            ${excluded.length} unique (${uniqueUnresolved} unresolved, ${uniqueNoRef} no-fdc_ref-or-bad-type)`);
  console.log("");
  console.log("Evidence class counts (eligible cases only):");
  for (const [cls, count] of Object.entries(evidenceClassCounts)) {
    console.log(`  ${cls}: ${count}`);
  }
  console.log("");
  console.log("Per-pack item counts:");
  for (const pack of packs) {
    console.log(`  ${pack.packId}: ${pack.snapshot.result.items.length} items, sha256=${pack.sha256}`);
  }
  console.log("");
  console.log(`queryProductionCommit: ${queryProductionCommit}`);
  console.log(`dictionaryCommit:      ${args.commit}`);
  console.log(`dictionaryBlobSha:     ${dictionaryBlobSha}`);
  console.log(`assemblyScriptSha256:  ${assemblyScriptSha256}`);
}

const isMain = path.resolve(process.argv[1] ?? "") === __filename;
if (isMain) {
  main();
}
