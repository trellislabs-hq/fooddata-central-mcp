/**
 * Module: find_food eval runner (CLI)
 * Purpose: The first customer-shaped accuracy + latency measurement of
 *   find_food (src/find-food.ts), run against the household-food-eval-v1
 *   fixture (a one-time snapshot of recipe-app's Thomas-ratified FDC
 *   identity pin corpus — see eval/fixtures/household-food-eval-v1.json's
 *   `provenance` block). Two modes:
 *     - default (cached replay): serves searchFoods() calls exclusively
 *       from the committed eval/cache/ projection — deterministic, zero API
 *       budget, safe for CI.
 *     - --live: calls the real FDC API via FdcClient (FDC_API_KEY env var),
 *       recording every response into the cache for future replay runs, and
 *       measuring per-case latency.
 *   Usage: `node --import tsx eval/run.ts [--live] [--run-id=<id>]`
 *
 * Major Sections:
 *   - MissingApiKeyError — thrown (never printing the key) when --live
 *     lacks FDC_API_KEY
 *   - runEval() — the testable core: load+validate fixture, dispatch to
 *     runLive()/runReplay(), return rows + aggregate + exit code. Pure
 *     w.r.t. process.exit/console — never calls either.
 *   - runLive() / runReplay() — the two searchFn-wiring + scoring loops
 *   - main() — CLI-only glue: argv parsing, results-file write, report
 *     printing, process.exit. Guarded so importing this module (tests) never
 *     triggers it.
 *
 * Dependencies: ../src/find-food.js, ../src/fdc-client.js, ./lib/fixture.js,
 *   ./lib/scoring.js, ./lib/cache.js, ./lib/search-fn.js
 * State: Reads eval/fixtures/household-food-eval-v1.json (read-only) and
 *   eval/cache/search-cache.json (read in replay mode, read+merge+write in
 *   live mode). Writes eval/results/<runId>.json (gitignored) only from
 *   main(), never from runEval().
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FdcClient } from "../src/fdc-client.js";
import { findFood } from "../src/find-food.js";
import {
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
import { DEFAULT_FIXTURE_PATH, loadFixture, validateFixtureSchema, type EvalCase } from "./lib/fixture.js";
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

export interface RunOptions {
  live: boolean;
  fixturePath?: string;
  cachePath?: string;
}

export interface RunOutcome {
  rows: CaseResult[];
  aggregate: AggregateReport;
  exitCode: number;
  cacheSizeStatus?: CacheSizeStatus;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runLive(cases: EvalCase[], cachePath: string): Promise<RunOutcome> {
  const apiKey = process.env.FDC_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  const client = new FdcClient(apiKey);
  const real = client.searchFoods.bind(client);
  const buffer = new Map<string, CacheEntry>();
  const recording = makeRecordingSearchFn(real, buffer);

  const rows: CaseResult[] = [];
  const latencies: number[] = [];

  for (const caseDef of cases) {
    const start = process.hrtime.bigint();
    try {
      const result = await findFood(recording, caseDef.name, { includeBranded: false });
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      rows.push(scoreCase(caseDef, result));
    } catch (err) {
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
      rows.push({ name: caseDef.name, kind: caseDef.kind, status: "error", errorMessage: errMessage(err) });
    }
  }

  // Cache writes are buffered above and flushed here — AFTER every case's
  // latency timer has already stopped — so disk I/O never skews the numbers.
  const existing = loadCache(cachePath);
  const updates: CacheFile = {};
  for (const [key, entry] of buffer) updates[key] = entry;
  const merged = mergeCache(existing, updates);
  const bytes = writeCache(merged, cachePath);
  const cacheSizeStatus = checkCacheSizeBudget(bytes);

  const aggregate = computeAggregate(rows, latencies);
  const errorRate = rows.length > 0 ? aggregate.counts.error / rows.length : 0;
  const exitCode = errorRate > 0.1 || cacheSizeStatus.exceeded ? 1 : 0;

  return { rows, aggregate, exitCode, cacheSizeStatus };
}

async function runReplay(cases: EvalCase[], cachePath: string): Promise<RunOutcome> {
  const cache = loadCache(cachePath);
  const replay = makeReplaySearchFn(cache);

  const rows: CaseResult[] = [];
  for (const caseDef of cases) {
    try {
      const result = await findFood(replay, caseDef.name, { includeBranded: false });
      rows.push(scoreCase(caseDef, result));
    } catch (err) {
      if (err instanceof CacheMissError) {
        rows.push({ name: caseDef.name, kind: caseDef.kind, status: "uncached", errorMessage: err.message });
      } else {
        rows.push({ name: caseDef.name, kind: caseDef.kind, status: "error", errorMessage: errMessage(err) });
      }
    }
  }

  const aggregate = computeAggregate(rows, "cached");
  const coverage = rows.length > 0 ? (rows.length - aggregate.counts.uncached) / rows.length : 0;
  const exitCode = coverage < 0.9 ? 1 : 0;

  return { rows, aggregate, exitCode };
}

/**
 * Core eval logic: load+validate the fixture, sort cases by name (byte-
 * stable output ordering), dispatch to live/replay. Never touches
 * process.exit or console — main() owns CLI/process concerns so this stays
 * directly unit-testable against temp fixture/cache paths.
 */
export async function runEval(options: RunOptions): Promise<RunOutcome> {
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE_PATH;
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;

  const fixture = loadFixture(fixturePath);
  validateFixtureSchema(fixture);
  const cases = [...fixture.cases].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return options.live ? runLive(cases, cachePath) : runReplay(cases, cachePath);
}

// ─── CLI-only glue ─────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): { live: boolean; runId?: string } {
  const live = argv.includes("--live");
  const runIdArg = argv.find((a) => a.startsWith("--run-id="));
  return { live, runId: runIdArg ? runIdArg.slice("--run-id=".length) : undefined };
}

export function defaultRunId(live: boolean): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${iso}-${live ? "live" : "replay"}`;
}

function writeResultsFile(runId: string, live: boolean, rows: CaseResult[], aggregate: AggregateReport): string {
  mkdirSync(DEFAULT_RESULTS_DIR, { recursive: true });
  const filePath = path.join(DEFAULT_RESULTS_DIR, `${runId}.json`);
  const payload = {
    runId,
    mode: live ? "live" : "replay",
    generatedAt: new Date().toISOString(),
    aggregate,
    rows,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  return filePath;
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function printReport(runId: string, live: boolean, rows: CaseResult[], aggregate: AggregateReport, cacheSizeStatus?: CacheSizeStatus): void {
  const lines: string[] = [];
  lines.push(`find_food eval — run ${runId} (${live ? "live" : "cached replay"})`);
  lines.push(`Cases: ${aggregate.totals.total} (${aggregate.totals.positive} positive, ${aggregate.totals.negative} negative)`);
  lines.push("");
  lines.push(`top-1:              ${pct(aggregate.top1Pct)} (${aggregate.counts.hit}/${aggregate.totals.positive})`);
  lines.push(`top-4 (exposed):    ${pct(aggregate.top4Pct)} (${aggregate.counts.hit + aggregate.counts.near}/${aggregate.totals.positive})`);
  lines.push(`negative-honesty:   ${pct(aggregate.negativeHonestyPct)} (${aggregate.counts.honest}/${aggregate.totals.negative})`);
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
      lines.push(`ERROR: eval/cache/ is ${(cacheSizeStatus.bytes / 1024 / 1024).toFixed(2)}MB — exceeds the ${CACHE_HARD_BYTES / 1024 / 1024}MB hard budget.`);
    } else if (cacheSizeStatus.warn) {
      lines.push(`WARNING: eval/cache/ is ${(cacheSizeStatus.bytes / 1024 / 1024).toFixed(2)}MB — approaching the ${CACHE_HARD_BYTES / 1024 / 1024}MB hard budget (warn threshold ${CACHE_WARN_BYTES / 1024 / 1024}MB).`);
    }
  }

  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const { live, runId: runIdArg } = parseArgs(process.argv.slice(2));
  const runId = runIdArg ?? defaultRunId(live);

  let outcome: RunOutcome;
  try {
    outcome = await runEval({ live });
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

  const filePath = writeResultsFile(runId, live, outcome.rows, outcome.aggregate);
  printReport(runId, live, outcome.rows, outcome.aggregate, outcome.cacheSizeStatus);
  console.log(`\nFull results: ${filePath}`);

  process.exitCode = outcome.exitCode;
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
