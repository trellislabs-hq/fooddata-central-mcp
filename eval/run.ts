/**
 * Module: find_food eval runner (CLI)
 * Purpose: The customer-shaped accuracy + latency measurement of find_food
 *   (src/find-food.ts), run against one of the FIXTURE_REGISTRY fixtures —
 *   "household" (the adversarial stress corpus, default, backward-compatible
 *   with pre-jump-1778 invocations) or "representative" (the household-
 *   representative-v1 corpus assembled from the four-cart recipe-pack
 *   battery — see eval/scripts/assemble-representative-fixture.ts). Each
 *   fixture is bound to its OWN cache file (eval/lib/cache.js's
 *   FIXTURE_REGISTRY-implied binding) so the two corpora never share or
 *   collide on cached responses. Two modes:
 *     - default (cached replay): serves searchFoods() calls exclusively
 *       from the bound fixture's committed eval/cache/ projection —
 *       deterministic, zero API budget, safe for CI.
 *     - --live: calls the real FDC API via FdcClient (FDC_API_KEY env var),
 *       recording every NEWLY-SEEN response into the cache for future replay
 *       runs (fill-missing-only — an entry the cache already has is served
 *       from disk, never re-fetched), and measuring per-case latency.
 *   A third flag, --published, switches the runner into STRICT mode: any
 *   uncached or errored row is a hard non-zero exit (vs. the default
 *   iteration-friendly 90%-coverage threshold) — see spec S8. Strict mode is
 *   the only mode a publishable headline number may be measured under.
 *   Usage: `node --import tsx eval/run.ts [--live] [--published] [--fixture=household|representative] [--run-id=<id>]`
 *
 * Major Sections:
 *   - MissingApiKeyError — thrown (never printing the key) when --live
 *     lacks FDC_API_KEY
 *   - FIXTURE_REGISTRY / resolveFixtureBinding() — the fixture <-> cache
 *     path binding --fixture selects between
 *   - runEval() — the testable core: load+validate fixture, dispatch to
 *     runLive()/runReplay(), attach fixture.excluded, return rows +
 *     aggregate + exit code. Pure w.r.t. process.exit/console — never calls
 *     either.
 *   - runLive() / runReplay() — the two searchFn-wiring + scoring loops
 *   - strictExitCode() — shared published-mode exit-code rule (spec S8: ANY
 *     uncached/errored row fails, no threshold)
 *   - buildManifest() / sha256File() / gitHeadSha() — CLI-only auditability
 *     manifest assembly (spec S9/S11): fixture/cache/code hashes, the
 *     dictionary blob hash ECHOED from the fixture's own provenance (never
 *     recomputed here), recording date, search-call count, latency-
 *     denominator policy, every exclusion + its reason, pack/evidenceClass
 *     rollups. Never throws — a manifest field that can't be computed comes
 *     back undefined rather than failing the run.
 *   - main() — CLI-only glue: argv parsing, results-file write, report
 *     printing, process.exit. Guarded so importing this module (tests) never
 *     triggers it.
 *
 * Dependencies: ../src/find-food.js, ../src/fdc-client.js, ./lib/fixture.js,
 *   ./lib/scoring.js, ./lib/cache.js, ./lib/search-fn.js, node:child_process
 *   (git HEAD, CLI-glue only), node:crypto (manifest hashing, CLI-glue only)
 * State: Reads the bound fixture file (read-only) and the bound cache file
 *   (read in replay mode, read+fill-missing-only-write in live mode). Writes
 *   eval/results/<runId>.json (gitignored) only from main(), never from
 *   runEval().
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FdcClient } from "../src/fdc-client.js";
import { findFood, type SearchFoodsFn } from "../src/find-food.js";
import {
  aggregateCacheBytes,
  CACHE_HARD_BYTES,
  CACHE_WARN_BYTES,
  checkCacheSizeBudget,
  DEFAULT_CACHE_PATH,
  loadCache,
  mergeCache,
  writeCache,
  type CacheEntry,
  type CacheFile,
  type CacheSizeStatus,
} from "./lib/cache.js";
import { DEFAULT_FIXTURE_PATH, loadFixture, validateFixtureSchema, type EvalCase, type EvalFixture, type ExcludedEvalCase } from "./lib/fixture.js";
import { computeAggregate, scoreCase, type AggregateReport, type CaseResult } from "./lib/scoring.js";
import { CacheMissError, makeRecordingSearchFn, makeReplaySearchFn } from "./lib/search-fn.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_DIR = path.join(__dirname, "results");

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "FDC_API_KEY is not set. --live mode requires a real (or DEMO_KEY) FoodData Central API key.\n" +
        "  Get a free key: https://fdc.nal.usda.gov/api-guide\n" +
        "  Then run:       FDC_API_KEY=your_key_here node --import tsx eval/run.ts --live\n" +
        "  (Or FDC_API_KEY=DEMO_KEY for a quick, rate-limited try — 30 req/hr.)"
    );
    this.name = "MissingApiKeyError";
  }
}

// ─── Fixture <-> cache binding ──────────────────────────────────────────────

export interface FixtureBinding {
  key: string;
  fixturePath: string;
  cachePath: string;
}

const REPRESENTATIVE_FIXTURE_PATH = path.join(__dirname, "fixtures", "household-representative-v1.json");
const REPRESENTATIVE_CACHE_PATH = path.join(__dirname, "cache", "representative-search-cache.json");

/**
 * Every fixture is bound to its OWN cache file (spec S8/S9's "separate
 * cache file" requirement) — --fixture=<key> resolves both paths together
 * so a caller can never accidentally pair one fixture with the other's
 * cache. "household" is the pre-jump-1778 default and stays wired to the
 * original DEFAULT_FIXTURE_PATH/DEFAULT_CACHE_PATH for backward
 * compatibility with existing invocations that pass no --fixture at all.
 */
export const FIXTURE_REGISTRY: Readonly<Record<string, FixtureBinding>> = {
  household: { key: "household", fixturePath: DEFAULT_FIXTURE_PATH, cachePath: DEFAULT_CACHE_PATH },
  representative: { key: "representative", fixturePath: REPRESENTATIVE_FIXTURE_PATH, cachePath: REPRESENTATIVE_CACHE_PATH },
};

export function resolveFixtureBinding(key: string): FixtureBinding {
  const binding = FIXTURE_REGISTRY[key];
  if (!binding) {
    throw new Error(`Unknown --fixture "${key}". Valid values: ${Object.keys(FIXTURE_REGISTRY).join(", ")}.`);
  }
  return binding;
}

export interface RunOptions {
  live: boolean;
  fixturePath?: string;
  cachePath?: string;
  /** Published/strict mode (spec S8): ANY uncached or errored row is a hard failure. Default false (iteration-friendly coverage threshold). */
  strict?: boolean;
}

export interface RunOutcome {
  rows: CaseResult[];
  aggregate: AggregateReport;
  exitCode: number;
  cacheSizeStatus?: CacheSizeStatus;
  /** Names with no scoreable reference identity (fixture.excluded, pass-through) — [] when the fixture has none. */
  excluded: ExcludedEvalCase[];
  /** Live mode only: count of ACTUAL network searchFoods() calls made (fill-missing-only skips never increment this). */
  searchCallCount?: number;
}

/** Internal shape returned by runLive/runReplay before runEval attaches `excluded`. */
type RunOutcomeCore = Omit<RunOutcome, "excluded">;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copies representative-fixture metadata off a case def for the uncached/error CaseResult shapes constructed outside scoreCase(). */
function metaFrom(caseDef: EvalCase): Pick<CaseResult, "evidenceClass" | "expectedSource" | "occurrences" | "packs"> {
  return { evidenceClass: caseDef.evidenceClass, expectedSource: caseDef.expectedSource, occurrences: caseDef.occurrences, packs: caseDef.packs };
}

/** Published-mode exit rule (spec S8): zero tolerance — ANY uncached or errored row fails the run, no threshold. */
function strictExitCode(rows: CaseResult[]): number {
  return rows.some((r) => r.status === "uncached" || r.status === "error") ? 1 : 0;
}

async function runLive(cases: EvalCase[], cachePath: string, strict: boolean): Promise<RunOutcomeCore> {
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const client = new FdcClient(apiKey);
  const real = client.searchFoods.bind(client);
  const buffer = new Map<string, CacheEntry>();
  const existing = loadCache(cachePath);

  // Count only ACTUAL network calls (fill-missing-only skips inside
  // makeRecordingSearchFn never reach this wrapper's inner call) — spec S8's
  // "total API search-call count" language discipline: cases fan out to
  // multiple searchFoods() calls (aliases + preferred + Branded), so case
  // count is never equated with request count.
  let searchCallCount = 0;
  const countingReal: SearchFoodsFn = async (params) => {
    searchCallCount++;
    return real(params);
  };
  const recording = makeRecordingSearchFn(countingReal, buffer, existing);

  const rows: CaseResult[] = [];
  const latencies: number[] = [];

  for (const caseDef of cases) {
    const start = process.hrtime.bigint();
    try {
      const result = await findFood(recording, caseDef.name, { includeBranded: false });
      // Latency-denominator policy (spec S11): only a call that actually
      // completes contributes a latency sample — pushed here, inside the
      // try, BEFORE the catch below, so a thrown error never adds one.
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      rows.push(scoreCase(caseDef, result));
    } catch (err) {
      // No latency sample here (see policy above): a thrown error measures
      // how long it took to fail, not a real search latency, and would
      // skew p50/p95 for reasons unrelated to find_food's own performance.
      rows.push({ name: caseDef.name, kind: caseDef.kind, status: "error", errorMessage: errMessage(err), ...metaFrom(caseDef) });
    }
  }

  // Cache writes are buffered above and flushed here — AFTER every case's
  // latency timer has already stopped — so disk I/O never skews the numbers.
  const updates: CacheFile = {};
  for (const [key, entry] of buffer) updates[key] = entry;
  const merged = mergeCache(existing, updates);
  writeCache(merged, cachePath);
  // Budget is AGGREGATE across eval/cache/*.json (see cache.ts header),
  // never this single just-written file's byte count — a second fixture's
  // cache draws against the same ceiling.
  const cacheSizeStatus = checkCacheSizeBudget(aggregateCacheBytes());

  const aggregate = computeAggregate(rows, latencies);
  const errorRate = rows.length > 0 ? aggregate.counts.error / rows.length : 0;
  const exitCode = cacheSizeStatus.exceeded ? 1 : strict ? strictExitCode(rows) : errorRate > 0.1 ? 1 : 0;

  return { rows, aggregate, exitCode, cacheSizeStatus, searchCallCount };
}

async function runReplay(cases: EvalCase[], cachePath: string, strict: boolean): Promise<RunOutcomeCore> {
  const cache = loadCache(cachePath);
  const replay = makeReplaySearchFn(cache);

  const rows: CaseResult[] = [];
  for (const caseDef of cases) {
    try {
      const result = await findFood(replay, caseDef.name, { includeBranded: false });
      rows.push(scoreCase(caseDef, result));
    } catch (err) {
      if (err instanceof CacheMissError) {
        rows.push({ name: caseDef.name, kind: caseDef.kind, status: "uncached", errorMessage: err.message, ...metaFrom(caseDef) });
      } else {
        rows.push({ name: caseDef.name, kind: caseDef.kind, status: "error", errorMessage: errMessage(err), ...metaFrom(caseDef) });
      }
    }
  }

  const aggregate = computeAggregate(rows, "cached");
  // Coverage = the fraction of cases that actually got SCORED from cache.
  // Both uncached (no cache entry) AND error (e.g. a malformed cache entry)
  // cases failed to produce a scored result — either one left uncounted
  // here would let a thin-or-broken cache masquerade as full coverage and
  // exit 0 (the exact bug this replaced: an all-errors replay used to
  // report 100% coverage since only `uncached` was subtracted).
  const coverage = rows.length > 0 ? aggregate.scored.total / rows.length : 0;
  const exitCode = strict ? strictExitCode(rows) : coverage < 0.9 ? 1 : 0;

  return { rows, aggregate, exitCode };
}

/**
 * Core eval logic: load+validate the fixture, sort cases by name (byte-
 * stable output ordering), dispatch to live/replay, attach fixture.excluded.
 * Never touches process.exit or console — main() owns CLI/process concerns
 * so this stays directly unit-testable against temp fixture/cache paths.
 */
export async function runEval(options: RunOptions): Promise<RunOutcome> {
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE_PATH;
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const strict = options.strict ?? false;

  const fixture = loadFixture(fixturePath);
  validateFixtureSchema(fixture);
  const cases = [...fixture.cases].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const core = options.live ? await runLive(cases, cachePath, strict) : await runReplay(cases, cachePath, strict);
  return { ...core, excluded: fixture.excluded ?? [] };
}

// ─── CLI-only glue ─────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { live: boolean; strict: boolean; fixtureKey: string; runId?: string } {
  const live = argv.includes("--live");
  const strict = argv.includes("--published");
  const runIdArg = argv.find((a) => a.startsWith("--run-id="));
  const fixtureArg = argv.find((a) => a.startsWith("--fixture="));
  return {
    live,
    strict,
    fixtureKey: fixtureArg ? fixtureArg.slice("--fixture=".length) : "household",
    runId: runIdArg ? runIdArg.slice("--run-id=".length) : undefined,
  };
}

export function defaultRunId(live: boolean): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${iso}-${live ? "live" : "replay"}`;
}

const LATENCY_DENOMINATOR_POLICY =
  "Latency p50/p95/max (live mode only) are computed over successfully-completed calls only. A case " +
  "whose findFood() call throws contributes NO latency sample — an error measures failure time, not " +
  "search latency, and including it would skew percentiles for reasons unrelated to find_food's " +
  "actual performance. Replay mode never reports latency (no network calls are made).";

function sha256File(filePath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

function gitHeadSha(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Auditability manifest (spec S11): per-run hashes for true re-derivability,
 * the exclusion list with reasons, and rollups already computed by
 * computeAggregate(). The dictionary blob hash is ECHOED from the fixture's
 * OWN provenance block (recorded once, at assembly time) — never recomputed
 * here, since this runner has no reason to talk to the recipe-app repo.
 * Never throws: every field degrades to undefined rather than failing the
 * CLI run over a best-effort audit field.
 */
function buildManifest(fixturePath: string, cachePath: string, fixture: EvalFixture, outcome: RunOutcome) {
  return {
    fixtureSha256: sha256File(fixturePath),
    cacheSha256: sha256File(cachePath),
    codeGitHead: gitHeadSha(),
    dictionaryBlobSha: fixture.provenance.dictionaryBlobSha,
    recordingDate: fixture.provenance.derivedAt,
    searchCallCount: outcome.searchCallCount ?? 0,
    latencyDenominatorPolicy: LATENCY_DENOMINATOR_POLICY,
    exclusions: outcome.excluded,
    rollups: outcome.aggregate.rollups,
  };
}

function writeResultsFile(runId: string, live: boolean, fixtureKey: string, binding: FixtureBinding, outcome: RunOutcome): string {
  mkdirSync(DEFAULT_RESULTS_DIR, { recursive: true });
  const filePath = path.join(DEFAULT_RESULTS_DIR, `${runId}.json`);
  const fixture = loadFixture(binding.fixturePath);
  const payload = {
    runId,
    fixture: fixtureKey,
    mode: live ? "live" : "replay",
    generatedAt: new Date().toISOString(),
    aggregate: outcome.aggregate,
    rows: outcome.rows,
    excluded: outcome.excluded,
    manifest: buildManifest(binding.fixturePath, binding.cachePath, fixture, outcome),
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return filePath;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function printReport(runId: string, live: boolean, fixtureKey: string, outcome: RunOutcome): void {
  const { aggregate, cacheSizeStatus, excluded } = outcome;
  const lines: string[] = [];
  lines.push(`find_food eval — run ${runId} (fixture: ${fixtureKey}, ${live ? "live" : "cached replay"})`);
  lines.push(`Cases: ${aggregate.totals.total} (${aggregate.totals.positive} positive, ${aggregate.totals.negative} negative)`);
  if (excluded.length > 0) {
    lines.push(`Excluded (no scoreable reference identity — see fixture provenance): ${excluded.length}`);
  }
  lines.push(
    `Scored: ${aggregate.scored.total} (${aggregate.scored.positive} positive, ${aggregate.scored.negative} negative) — ` +
      `unscored: ${aggregate.counts.uncached} uncached, ${aggregate.counts.error} errored ` +
      `(positive: ${aggregate.unscored.positive.uncached} uncached/${aggregate.unscored.positive.error} error; ` +
      `negative: ${aggregate.unscored.negative.uncached} uncached/${aggregate.unscored.negative.error} error)`
  );
  lines.push("");
  lines.push(`(percentages below are over SCORED cases only — uncached/errored cases are excluded from every denominator)`);

  const pm = aggregate.matrix.positive;
  lines.push(
    `positive matrix: hit=${pm.hit} near=${pm.near} near_branded=${pm.near_branded} miss=${pm.miss} ` +
      `labeled_branded_fallback=${pm.labeled_branded_fallback} refusal=${pm.refusal}`
  );
  lines.push(`  top-1:              ${pct(aggregate.top1Pct)}`);
  lines.push(`  top-4 (exposed):    ${pct(aggregate.top4Pct)}`);
  lines.push(`  false-refusal (on verified answers): ${pct(aggregate.positiveRefusalPct)}`);
  lines.push(`  labeled_branded_fallback (on verified answers): ${pct(aggregate.positiveLabeledBrandedFallbackPct)}`);

  const nm = aggregate.matrix.negative;
  lines.push(`negative matrix: refusal=${nm.refusal} labeled_branded_fallback=${nm.labeled_branded_fallback} confident_wrong=${nm.confident_wrong}`);
  lines.push(`  refusal:                  ${pct(aggregate.negativeRefusalPct)}`);
  lines.push(`  labeled_branded_fallback: ${pct(aggregate.negativeLabeledBrandedFallbackPct)}`);
  lines.push(`  confident_wrong:          ${pct(aggregate.negativeConfidentWrongPct)}`);
  lines.push("");
  lines.push(
    aggregate.latency === "cached"
      ? "latency: cached (replay mode — no network calls made)"
      : `latency (ms): p50=${aggregate.latency.p50.toFixed(1)} p95=${aggregate.latency.p95.toFixed(1)} max=${aggregate.latency.max.toFixed(1)}`
  );
  lines.push("");
  lines.push(`Method: ${aggregate.method}`);

  if (aggregate.failures.misses.length > 0) {
    lines.push("");
    lines.push(`Misses (${aggregate.failures.misses.length}):`);
    for (const row of aggregate.failures.misses) {
      lines.push(`  - "${row.name}" -> ${row.actual ? `${row.actual.description} (FDC ${row.actual.fdcId}, ${row.actual.dataType ?? "?"})` : "no match"}`);
    }
  }
  if (aggregate.failures.confidentWrong.length > 0) {
    lines.push("");
    lines.push(`Confident-wrong negatives (${aggregate.failures.confidentWrong.length}):`);
    for (const row of aggregate.failures.confidentWrong) {
      lines.push(`  - "${row.name}" -> ${row.actual ? `${row.actual.description} (FDC ${row.actual.fdcId}, ${row.actual.dataType ?? "?"})` : "?"}`);
    }
  }
  if (aggregate.failures.uncached.length > 0) {
    lines.push("");
    lines.push(`Uncached (${aggregate.failures.uncached.length}) — run with --live to populate:`);
    for (const row of aggregate.failures.uncached) lines.push(`  - "${row.name}"`);
  }
  if (aggregate.failures.errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${aggregate.failures.errors.length}):`);
    for (const row of aggregate.failures.errors) lines.push(`  - "${row.name}": ${row.errorMessage}`);
  }

  if (cacheSizeStatus) {
    lines.push("");
    if (cacheSizeStatus.exceeded) {
      lines.push(`ERROR: eval/cache/ is ${(cacheSizeStatus.bytes / 1024 / 1024).toFixed(2)}MB — exceeds the ${CACHE_HARD_BYTES / 1024 / 1024}MB aggregate hard budget.`);
    } else if (cacheSizeStatus.warn) {
      lines.push(`WARNING: eval/cache/ is ${(cacheSizeStatus.bytes / 1024 / 1024).toFixed(2)}MB — approaching the ${CACHE_HARD_BYTES / 1024 / 1024}MB aggregate hard budget (warn threshold ${CACHE_WARN_BYTES / 1024 / 1024}MB).`);
    }
  }

  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const { live, strict, fixtureKey, runId: runIdArg } = parseArgs(process.argv.slice(2));
  const runId = runIdArg ?? defaultRunId(live);

  let binding: FixtureBinding;
  try {
    binding = resolveFixtureBinding(fixtureKey);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    process.exitCode = 1;
    return;
  }

  let outcome: RunOutcome;
  try {
    outcome = await runEval({ live, strict, fixturePath: binding.fixturePath, cachePath: binding.cachePath });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`Eval run failed: ${errMessage(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const filePath = writeResultsFile(runId, live, fixtureKey, binding, outcome);
  printReport(runId, live, fixtureKey, outcome);
  console.log(`\nFull results: ${filePath}`);

  process.exitCode = outcome.exitCode;
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
