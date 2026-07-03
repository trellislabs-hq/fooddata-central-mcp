/**
 * Module: audit-pipeline
 * Purpose: Systematically evaluates how well every ingredient in the recipe-app
 *   dictionary maps to FDC (USDA FoodData Central) data. Produces a gap report
 *   covering FDC match quality, FoodPortion coverage, and cross-reference agreement
 *   between recipe-app conversion_data and FDC gram weights.
 *
 * Major Sections:
 *   - Config & setup (API key, paths, rate-limit constants)
 *   - API helpers (search, batch fetch, exponential backoff)
 *   - Match quality rating (EXACT / CLOSE / MISS heuristic — documented inline)
 *   - Pass 1: Search all entries, record top matches
 *   - Pass 2: Batch-fetch food details (FoodPortion data)
 *   - Pass 3: Cross-reference + summary generation
 *   - CLI entry point (--sample N, --resume)
 *
 * Dependencies: Native fetch (Node 18+), fs, path, readline
 * State: Writes incremental progress to audit-results/audit-raw.json after each batch.
 *        Reads that file on startup if --resume (default) to skip completed entries.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RECIPE_APP_DICT = path.resolve(
  __dirname,
  "../../../recipe-app/data/ingredient-dictionary.base.json"
);
const OUTPUT_DIR = path.join(__dirname, "audit-results");
const RAW_OUTPUT = path.join(OUTPUT_DIR, "audit-raw.json");
const SUMMARY_OUTPUT = path.join(OUTPUT_DIR, "audit-summary.txt");

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// 1,000 requests/hr = one request every 3.6 seconds.
// We use a slightly more conservative 3.7 seconds to give headroom.
const REQUEST_DELAY_MS = 3700;

// Batch size for POST /foods (FDC enforces 20-ID limit per batch)
const BATCH_SIZE = 20;

// Progress reporting interval
const PROGRESS_INTERVAL = 50;

// ─── Config Loading ───────────────────────────────────────────────────────────

function loadApiKey() {
  // Try .env first
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    const match = content.match(/^FDC_API_KEY\s*=\s*(.+)$/m);
    if (match) {
      return match[1].trim();
    }
  }

  // Fall back to ~/Projects/.mcp.json
  const mcpJson = path.resolve(process.env.HOME, "Projects/.mcp.json");
  if (fs.existsSync(mcpJson)) {
    try {
      const config = JSON.parse(fs.readFileSync(mcpJson, "utf8"));
      // Check common locations: top-level env, or nested under a server config
      if (config.env?.FDC_API_KEY) return config.env.FDC_API_KEY;
      for (const server of Object.values(config.mcpServers || {})) {
        if (server?.env?.FDC_API_KEY) return server.env.FDC_API_KEY;
      }
    } catch {
      // malformed JSON — fall through
    }
  }

  throw new Error(
    "FDC_API_KEY not found. Set it in .env (FDC_API_KEY=...) or in ~/Projects/.mcp.json"
  );
}

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let sample = null;
  // Resume is default-on unless explicitly disabled with --no-resume
  let resume = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sample" && args[i + 1]) {
      sample = parseInt(args[i + 1], 10);
      if (isNaN(sample) || sample < 1) {
        throw new Error("--sample must be a positive integer");
      }
      i++;
    } else if (args[i] === "--no-resume") {
      resume = false;
    } else if (args[i] === "--resume") {
      resume = true;
    }
  }

  return { sample, resume };
}

// ─── FDC API ──────────────────────────────────────────────────────────────────

const FDC_BASE = "https://api.nal.usda.gov/fdc/v1";

let apiCallsMade = 0;
let lastRequestTime = 0;

/**
 * Enforce rate limiting by waiting until at least REQUEST_DELAY_MS has elapsed
 * since the last API call. This keeps us under 1,000 requests/hr.
 */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS && lastRequestTime > 0) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP request with exponential backoff on 429 / 5xx errors.
 * Max 3 retries. Returns null on persistent failure (caller logs and continues).
 */
async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await rateLimit();
      apiCallsMade++;
      const response = await fetch(url, options);

      if (response.ok) {
        return response.json();
      }

      const isRateLimit = response.status === 429;
      const isServerError = response.status >= 500;

      if ((isRateLimit || isServerError) && attempt < retries) {
        // Exponential backoff: 2s, 4s, 8s
        const backoffMs = 2000 * Math.pow(2, attempt);
        process.stderr.write(
          `\n  [RETRY ${attempt + 1}/${retries}] HTTP ${response.status} — waiting ${backoffMs / 1000}s\n`
        );
        await sleep(backoffMs);
        // Don't count the failed call against rate limits — reset timer
        lastRequestTime = 0;
        continue;
      }

      // Non-retryable error (400, 404, etc.)
      const bodyText = await response.text().catch(() => "");
      process.stderr.write(
        `\n  [ERROR] HTTP ${response.status} for ${url.substring(0, 80)}: ${bodyText.substring(0, 200)}\n`
      );
      return null;
    } catch (err) {
      if (attempt < retries) {
        const backoffMs = 2000 * Math.pow(2, attempt);
        process.stderr.write(
          `\n  [RETRY ${attempt + 1}/${retries}] Network error: ${err.message} — waiting ${backoffMs / 1000}s\n`
        );
        await sleep(backoffMs);
        lastRequestTime = 0;
        continue;
      }
      process.stderr.write(`\n  [FAIL] Giving up after ${retries} retries: ${err.message}\n`);
      return null;
    }
  }
  return null;
}

/**
 * POST /foods/search — returns top N matches for a query.
 */
async function searchFoods(apiKey, query, pageSize = 3) {
  const url = `${FDC_BASE}/foods/search?api_key=${apiKey}`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pageSize }),
  });
}

/**
 * POST /foods — batch fetch up to 20 foods with full detail (including foodPortions).
 */
async function getFoodsBatch(apiKey, fdcIds) {
  if (fdcIds.length === 0) return [];
  const url = `${FDC_BASE}/foods?api_key=${apiKey}`;
  const result = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fdcIds, format: "full" }),
  });
  return Array.isArray(result) ? result : [];
}

// ─── Match Quality Rating ─────────────────────────────────────────────────────

/**
 * Rate the quality of the top FDC search result against the dictionary product_name.
 *
 * Heuristic (approximate — designed to be fast and consistent, not perfect):
 *
 * Step 1: Normalize both strings — lowercase, strip punctuation, split on whitespace.
 * Step 2: Extract "significant words" from the query by removing common stop words
 *   (articles, prepositions, very generic food words like "product", "food").
 * Step 3: Check how many significant query words appear in the FDC description.
 *
 * Rating rules:
 *   EXACT  — ALL significant words from product_name appear in FDC description
 *            (FDC description clearly covers the queried ingredient)
 *   CLOSE  — The PRIMARY food word (first significant word) appears in FDC description,
 *            but not all modifiers match (right food, wrong form/prep/brand)
 *   MISS   — Primary food word is absent from FDC description (wrong food entirely)
 *
 * Why this approach: Exact string matching is too strict (FDC says "Flour, wheat,
 * all-purpose" not "all-purpose flour"). Token-set overlap catches content matches
 * regardless of word order while still penalizing truly wrong matches.
 *
 * Limitations: Brand-name ingredients often rate CLOSE even when the match is good
 * because FDC uses generic descriptions. Highly specific queries (e.g., "Diamond
 * Crystal kosher salt") will usually rate CLOSE at best. This is acceptable — the
 * summary report notes these as "close" not "exact" which is appropriate for brand items.
 */

// Stop words to ignore when computing significant query words
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "with", "for", "to", "by",
  "from", "on", "at", "as", "is", "be", "are", "was", "were",
  // Generic food qualifiers that don't narrow down what food it is
  "food", "product", "item", "ingredient", "raw", "prepared",
]);

function normalizeWords(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")   // strip punctuation
    .split(/\s+/)
    .filter((w) => w.length > 1);   // drop single-char tokens
}

function getSignificantWords(words) {
  return words.filter((w) => !STOP_WORDS.has(w));
}

function rateMatchQuality(productName, fdcDescription) {
  if (!fdcDescription) return "miss";

  const queryWords = normalizeWords(productName);
  const descWords = new Set(normalizeWords(fdcDescription));
  const significant = getSignificantWords(queryWords);

  if (significant.length === 0) return "close"; // degenerate case

  // EXACT: all significant query words appear in FDC description
  const allMatch = significant.every((w) => descWords.has(w));
  if (allMatch) return "exact";

  // CLOSE vs MISS: does the primary food word (first significant word) appear?
  // The primary word is the most important identifier of what food this is.
  const primaryWord = significant[0];
  const primaryMatch = descWords.has(primaryWord);

  return primaryMatch ? "close" : "miss";
}

// ─── FoodPortion Extraction ───────────────────────────────────────────────────

/**
 * Extract household-measure portions from a full FDC food object.
 * FoodPortion objects vary in structure — we normalize to {measureUnit, gramWeight}.
 * Only portions with a gramWeight > 0 are included.
 */
function extractPortions(food) {
  const portions = food.foodPortions || [];
  return portions
    .map((p) => {
      // FDC portion shape: { id, measureUnit: {name}, gramWeight, amount, modifier, ... }
      // Some SR Legacy portions have a flat measureUnit string rather than an object.
      const measureUnit =
        typeof p.measureUnit === "object" && p.measureUnit !== null
          ? p.measureUnit.name || p.measureUnit.abbreviation || "unknown"
          : typeof p.measureUnit === "string"
          ? p.measureUnit
          : p.modifier || p.sequenceNumber?.toString() || "unknown";
      const gramWeight = typeof p.gramWeight === "number" ? p.gramWeight : null;
      const amount = typeof p.amount === "number" ? p.amount : 1;

      return { measureUnit, gramWeight, amount };
    })
    .filter((p) => p.gramWeight !== null && p.gramWeight > 0);
}

// ─── Cross-Reference ──────────────────────────────────────────────────────────

const OZ_TO_GRAMS = 28.3495;

/**
 * Compare recipe-app conversion_data (in oz) against FDC FoodPortion data (in grams).
 *
 * Matching logic:
 *   - cup_to_oz from recipe-app → convert to grams (× 28.35)
 *     → look for a FDC portion with measureUnit containing "cup"
 *   - tbsp_to_oz → look for FDC portion containing "tablespoon" or "tbsp"
 *   - tsp_to_oz → look for FDC portion containing "teaspoon" or "tsp"
 *
 * Agreement threshold: within 15% delta is AGREE, >15% is DIVERGE.
 * If no FDC portion matches the recipe-app measure, report NO_OVERLAP.
 */

// Map recipe-app conversion field names to FDC measure unit keyword patterns
const MEASURE_MAPPINGS = [
  { recipeField: "cup_to_oz", fdcKeywords: ["cup"] },
  { recipeField: "tbsp_to_oz", fdcKeywords: ["tablespoon", "tbsp"] },
  { recipeField: "tbsp_to_fl_oz", fdcKeywords: ["tablespoon", "tbsp"] },
  { recipeField: "tsp_to_oz", fdcKeywords: ["teaspoon", "tsp"] },
  { recipeField: "tsp_to_fl_oz", fdcKeywords: ["teaspoon", "tsp"] },
  { recipeField: "cup_to_fl_oz", fdcKeywords: ["cup"] },
];

function crossReference(conversionData, portions) {
  if (!conversionData || !portions || portions.length === 0) {
    return { status: "no_overlap", comparisons: [] };
  }

  const comparisons = [];

  for (const { recipeField, fdcKeywords } of MEASURE_MAPPINGS) {
    const recipeOz = conversionData[recipeField];
    if (!recipeOz || recipeOz <= 0) continue;

    // Convert recipe-app oz value to grams
    // Note: cup_to_fl_oz / tbsp_to_fl_oz are already in fluid oz (same conversion)
    const recipeGrams = recipeOz * OZ_TO_GRAMS;

    // Find the best FDC portion for this measure
    const matchingPortion = portions.find((p) => {
      const unitLower = (p.measureUnit || "").toLowerCase();
      return fdcKeywords.some((kw) => unitLower.includes(kw));
    });

    if (!matchingPortion) continue;

    // FDC gramWeight is for `amount` of the measure (usually 1 cup, 1 tbsp, etc.)
    // recipe-app's cup_to_oz is "how many oz per 1 cup", so both are per-unit
    const fdcGrams =
      matchingPortion.amount !== 1
        ? matchingPortion.gramWeight / matchingPortion.amount
        : matchingPortion.gramWeight;

    const deltaPct =
      Math.abs(recipeGrams - fdcGrams) / ((recipeGrams + fdcGrams) / 2) * 100;

    comparisons.push({
      measure: recipeField.replace("_to_oz", "").replace("_to_fl_oz", ""),
      recipe_app_grams: Math.round(recipeGrams * 10) / 10,
      fdc_grams: Math.round(fdcGrams * 10) / 10,
      delta_pct: Math.round(deltaPct * 10) / 10,
    });
  }

  if (comparisons.length === 0) {
    return { status: "no_overlap", comparisons: [] };
  }

  const maxDelta = Math.max(...comparisons.map((c) => c.delta_pct));
  const status = maxDelta <= 15 ? "agree" : "diverge";

  return { status, comparisons };
}

// ─── Progress Persistence ─────────────────────────────────────────────────────

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function loadExistingResults() {
  if (!fs.existsSync(RAW_OUTPUT)) return { metadata: {}, entries: {} };
  try {
    return JSON.parse(fs.readFileSync(RAW_OUTPUT, "utf8"));
  } catch {
    process.stderr.write("[WARN] Could not parse existing audit-raw.json — starting fresh\n");
    return { metadata: {}, entries: {} };
  }
}

function saveResults(metadata, entries) {
  ensureOutputDir();
  const data = { metadata, entries };
  fs.writeFileSync(RAW_OUTPUT, JSON.stringify(data, null, 2));
}

// ─── Summary Generation ───────────────────────────────────────────────────────

function generateSummary(metadata, entries) {
  const values = Object.values(entries);
  const total = values.length;

  // Dictionary overview
  const withConv = values.filter((e) => e.has_conversion_data).length;
  const withoutConv = total - withConv;

  // FDC matching
  const matchCounts = { exact: 0, close: 0, miss: 0, no_result: 0 };
  const dataTypeCounts = {};
  values.forEach((e) => {
    const q = e.fdc_search?.match_quality || "no_result";
    matchCounts[q] = (matchCounts[q] || 0) + 1;

    const dt = e.fdc_search?.top_matches?.[0]?.dataType || "none";
    dataTypeCounts[dt] = (dataTypeCounts[dt] || 0) + 1;
  });

  // FoodPortion coverage
  const withMatch = values.filter(
    (e) => e.fdc_search?.match_quality !== "miss" && e.fdc_search?.top_matches?.length > 0
  ).length;
  const withPortions = values.filter((e) => e.fdc_portions?.has_portions).length;
  const withMatchNoPortions = values.filter(
    (e) =>
      e.fdc_search?.match_quality !== "miss" &&
      e.fdc_search?.top_matches?.length > 0 &&
      !e.fdc_portions?.has_portions
  ).length;
  const noMatch = matchCounts.miss + (matchCounts.no_result || 0);

  // Cross-reference
  const xrefs = values.filter((e) => e.cross_reference?.status);
  const xrefCounts = { agree: 0, diverge: 0, no_overlap: 0 };
  xrefs.forEach((e) => {
    xrefCounts[e.cross_reference.status] =
      (xrefCounts[e.cross_reference.status] || 0) + 1;
  });

  // Top priority gaps — ingredients with miss/no_result or no portions, sorted by how common they are
  const gaps = values
    .filter(
      (e) =>
        e.fdc_search?.match_quality === "miss" ||
        !e.fdc_search?.top_matches?.length ||
        (e.fdc_search?.match_quality !== "miss" && !e.fdc_portions?.has_portions)
    )
    .map((e) => ({
      key: e._key,
      product_name: e.product_name,
      gap: !e.fdc_search?.top_matches?.length
        ? "no FDC result"
        : e.fdc_search?.match_quality === "miss"
        ? "FDC miss"
        : "no FoodPortion data",
    }))
    .slice(0, 30);

  // Divergent conversions
  const divergent = values
    .filter((e) => e.cross_reference?.status === "diverge")
    .map((e) => {
      const comps = e.cross_reference.comparisons || [];
      const maxDelta = comps.length
        ? Math.max(...comps.map((c) => c.delta_pct))
        : 0;
      return {
        key: e._key,
        product_name: e.product_name,
        max_delta_pct: maxDelta,
        comparisons: comps,
      };
    })
    .sort((a, b) => b.max_delta_pct - a.max_delta_pct)
    .slice(0, 30);

  const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "N/A");

  const lines = [
    `PIPELINE AUDIT REPORT — ${metadata.run_date || new Date().toISOString().slice(0, 10)}`,
    `=`.repeat(50),
    ``,
    `DICTIONARY OVERVIEW`,
    `  Total entries: ${total.toLocaleString()}`,
    `  With conversion_data: ${withConv.toLocaleString()} (${pct(withConv, total)})`,
    `  Without conversion_data: ${withoutConv.toLocaleString()} (${pct(withoutConv, total)})`,
    ``,
    `FDC MATCHING`,
    `  Exact match: ${matchCounts.exact.toLocaleString()} (${pct(matchCounts.exact, total)})`,
    `  Close match: ${matchCounts.close.toLocaleString()} (${pct(matchCounts.close, total)})`,
    `  Miss: ${matchCounts.miss.toLocaleString()} (${pct(matchCounts.miss, total)})`,
    `  No result: ${(matchCounts.no_result || 0).toLocaleString()} (${pct(matchCounts.no_result || 0, total)})`,
    ``,
    `  By data type of best match:`,
    ...Object.entries(dataTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([dt, count]) => `    ${dt}: ${count.toLocaleString()} (${pct(count, total)})`),
    ``,
    `FOOD PORTION COVERAGE`,
    `  Entries with FDC match + FoodPortion data: ${withPortions.toLocaleString()} (${pct(withPortions, total)})`,
    `  Entries with FDC match but NO FoodPortion: ${withMatchNoPortions.toLocaleString()} (${pct(withMatchNoPortions, total)})`,
    `  Entries with no FDC match: ${noMatch.toLocaleString()} (${pct(noMatch, total)})`,
    ``,
    `CROSS-REFERENCE (entries with both conversion_data AND FoodPortion)`,
    `  Agree (within 15%): ${xrefCounts.agree.toLocaleString()}`,
    `  Diverge (>15% delta): ${xrefCounts.diverge.toLocaleString()}`,
    `  No overlapping measures: ${xrefCounts.no_overlap.toLocaleString()}`,
    ``,
    `RUN METADATA`,
    `  Dictionary path: ${metadata.dictionary_path}`,
    `  API calls made: ${metadata.api_calls_made?.toLocaleString() || "unknown"}`,
    `  Duration: ${metadata.duration_minutes || "unknown"} minutes`,
    ``,
    `TOP PRIORITY GAPS (miss, no result, or no FoodPortion data)`,
    `  ${"Key".padEnd(35)} ${"Product Name".padEnd(35)} Gap`,
    `  ${"-".repeat(90)}`,
    ...gaps.map(
      (g) =>
        `  ${String(g.key).padEnd(35)} ${String(g.product_name || "").padEnd(35)} ${g.gap}`
    ),
    ``,
    `DIVERGENT CONVERSIONS (recipe-app vs FDC disagree > 15%)`,
    `  ${"Key".padEnd(35)} ${"Max Delta".padEnd(12)} Details`,
    `  ${"-".repeat(90)}`,
    ...divergent.map((d) => {
      const detail = d.comparisons
        .map(
          (c) => `${c.measure}: recipe=${c.recipe_app_grams}g fdc=${c.fdc_grams}g (${c.delta_pct}%)`
        )
        .join("; ");
      return `  ${String(d.key).padEnd(35)} ${String(d.max_delta_pct + "%").padEnd(12)} ${detail}`;
    }),
  ];

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { sample, resume } = parseArgs();
  const apiKey = loadApiKey();
  ensureOutputDir();

  // Load dictionary
  if (!fs.existsSync(RECIPE_APP_DICT)) {
    throw new Error(`Dictionary not found: ${RECIPE_APP_DICT}`);
  }
  const dictionary = JSON.parse(fs.readFileSync(RECIPE_APP_DICT, "utf8"));
  let allKeys = Object.keys(dictionary);
  if (sample) {
    allKeys = allKeys.slice(0, sample);
  }

  const startTime = Date.now();
  const runDate = new Date().toISOString().slice(0, 10);

  // Load existing results for resume
  let existing = { metadata: {}, entries: {} };
  if (resume && fs.existsSync(RAW_OUTPUT)) {
    existing = loadExistingResults();
    const completedCount = Object.keys(existing.entries).length;
    process.stderr.write(
      `[RESUME] Found ${completedCount} completed entries — skipping them\n`
    );
  }

  const entries = existing.entries || {};

  // ─── Pass 1: Search ─────────────────────────────────────────────────────────

  const toSearch = allKeys.filter((key) => {
    // Skip if already has fdc_search data from a prior run
    return !entries[key]?.fdc_search;
  });

  process.stderr.write(
    `\n[PASS 1] Searching ${toSearch.length} entries (${allKeys.length - toSearch.length} already done)\n`
  );

  const matchStats = { exact: 0, close: 0, miss: 0, no_result: 0 };

  for (let i = 0; i < toSearch.length; i++) {
    const key = toSearch[i];
    const dictEntry = dictionary[key];
    const productName = dictEntry.product_name || key;

    // Initialize entry record
    if (!entries[key]) {
      entries[key] = {
        _key: key,
        product_name: productName,
        category: dictEntry.category || null,
        has_conversion_data: !!dictEntry.conversion_data,
        conversion_fields: dictEntry.conversion_data
          ? Object.keys(dictEntry.conversion_data).filter(
              (f) => f !== "source" && f !== "learned_at" && f !== "type"
            )
          : [],
        conversion_data: dictEntry.conversion_data || null,
      };
    }

    // Search FDC
    const searchResult = await searchFoods(apiKey, productName, 3);

    if (!searchResult || !searchResult.foods || searchResult.foods.length === 0) {
      entries[key].fdc_search = {
        query: productName,
        top_matches: [],
        match_quality: "no_result",
      };
      matchStats.no_result++;
    } else {
      const topMatches = searchResult.foods.slice(0, 3).map((f) => ({
        fdcId: f.fdcId,
        description: f.description,
        dataType: f.dataType || "unknown",
        score: f.score || null,
      }));

      const matchQuality = rateMatchQuality(productName, topMatches[0].description);
      matchStats[matchQuality] = (matchStats[matchQuality] || 0) + 1;

      entries[key].fdc_search = {
        query: productName,
        top_matches: topMatches,
        match_quality: matchQuality,
      };
    }

    // Save progress every BATCH_SIZE entries
    if ((i + 1) % BATCH_SIZE === 0 || i === toSearch.length - 1) {
      const elapsed = (Date.now() - startTime) / 1000 / 60;
      const metadata = {
        run_date: runDate,
        dictionary_path: RECIPE_APP_DICT,
        total_entries: allKeys.length,
        completed: Object.keys(entries).length,
        pass1_completed: i + 1 + (allKeys.length - toSearch.length),
        api_calls_made: apiCallsMade,
        duration_minutes: Math.round(elapsed * 10) / 10,
      };
      saveResults(metadata, entries);
    }

    // Progress report every PROGRESS_INTERVAL entries
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === toSearch.length - 1) {
      const elapsed = (Date.now() - startTime) / 60000;
      const rate = (i + 1) / elapsed; // entries per minute
      const remaining = toSearch.length - i - 1;
      const etaMin = remaining > 0 && rate > 0 ? Math.round(remaining / rate) : 0;
      const totalDone = i + 1 + (allKeys.length - toSearch.length);
      process.stderr.write(
        `[PASS 1] Audited ${totalDone}/${allKeys.length} (${Math.round((totalDone / allKeys.length) * 100)}%)` +
          ` — ${matchStats.exact} exact, ${matchStats.close} close, ${matchStats.miss} miss, ${matchStats.no_result} no_result` +
          ` — ETA: ${etaMin} min\n`
      );
    }
  }

  process.stderr.write(`[PASS 1] Complete. ${apiCallsMade} API calls so far.\n\n`);

  // ─── Pass 2: Batch-fetch FoodPortion data ───────────────────────────────────

  // Collect fdcIds that need portion data fetched
  const needPortions = allKeys.filter(
    (key) =>
      entries[key]?.fdc_search?.top_matches?.length > 0 &&
      !entries[key].fdc_portions
  );

  // Build fdcId → key(s) map (multiple entries can share the same top match)
  const fdcIdToKeys = {};
  for (const key of needPortions) {
    const fdcId = entries[key].fdc_search.top_matches[0].fdcId;
    if (!fdcIdToKeys[fdcId]) fdcIdToKeys[fdcId] = [];
    fdcIdToKeys[fdcId].push(key);
  }

  const uniqueFdcIds = Object.keys(fdcIdToKeys).map(Number);
  const totalBatches = Math.ceil(uniqueFdcIds.length / BATCH_SIZE);

  process.stderr.write(
    `[PASS 2] Fetching food details for ${uniqueFdcIds.length} unique FDC IDs in ${totalBatches} batches\n`
  );

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchIds = uniqueFdcIds.slice(
      batchIdx * BATCH_SIZE,
      (batchIdx + 1) * BATCH_SIZE
    );

    const foods = await getFoodsBatch(apiKey, batchIds);

    // Index by fdcId
    const foodById = {};
    foods.forEach((f) => {
      if (f?.fdcId) foodById[f.fdcId] = f;
    });

    // Write portion data back to all keys that used this fdcId
    for (const fdcId of batchIds) {
      const food = foodById[fdcId];
      const keysForId = fdcIdToKeys[fdcId] || [];

      for (const key of keysForId) {
        if (!food) {
          entries[key].fdc_portions = { has_portions: false, portions: [] };
          continue;
        }

        const portions = extractPortions(food);
        entries[key].fdc_portions = {
          has_portions: portions.length > 0,
          portions,
        };
      }
    }

    // Save progress after each batch
    const elapsed = (Date.now() - startTime) / 1000 / 60;
    const metadata = {
      run_date: runDate,
      dictionary_path: RECIPE_APP_DICT,
      total_entries: allKeys.length,
      completed: Object.keys(entries).length,
      api_calls_made: apiCallsMade,
      duration_minutes: Math.round(elapsed * 10) / 10,
    };
    saveResults(metadata, entries);

    if ((batchIdx + 1) % 5 === 0 || batchIdx === totalBatches - 1) {
      process.stderr.write(
        `[PASS 2] Batch ${batchIdx + 1}/${totalBatches} — ${apiCallsMade} total API calls\n`
      );
    }
  }

  process.stderr.write(`[PASS 2] Complete.\n\n`);

  // ─── Pass 3: Cross-reference + summary ─────────────────────────────────────

  process.stderr.write(`[PASS 3] Cross-referencing conversion data vs FoodPortion...\n`);

  for (const key of allKeys) {
    const entry = entries[key];
    if (!entry) continue;

    // Only cross-reference if we have both conversion data and portion data
    if (entry.conversion_data && entry.fdc_portions?.has_portions) {
      entry.cross_reference = crossReference(
        entry.conversion_data,
        entry.fdc_portions.portions
      );
    } else if (!entry.cross_reference) {
      entry.cross_reference = null;
    }
  }

  // Final save with complete metadata
  const totalElapsed = (Date.now() - startTime) / 1000 / 60;
  const finalMetadata = {
    run_date: runDate,
    dictionary_path: RECIPE_APP_DICT,
    total_entries: allKeys.length,
    completed: Object.keys(entries).length,
    api_calls_made: apiCallsMade,
    duration_minutes: Math.round(totalElapsed * 10) / 10,
  };
  saveResults(finalMetadata, entries);

  // Generate and write summary
  const summary = generateSummary(finalMetadata, entries);
  fs.writeFileSync(SUMMARY_OUTPUT, summary);

  process.stderr.write(`[PASS 3] Complete.\n\n`);
  process.stderr.write(`Output written to:\n`);
  process.stderr.write(`  ${RAW_OUTPUT}\n`);
  process.stderr.write(`  ${SUMMARY_OUTPUT}\n\n`);

  // Print summary to stdout so it's visible
  process.stdout.write(summary + "\n");
}

main().catch((err) => {
  process.stderr.write(`\n[FATAL] ${err.message}\n${err.stack || ""}\n`);
  process.exit(1);
});
