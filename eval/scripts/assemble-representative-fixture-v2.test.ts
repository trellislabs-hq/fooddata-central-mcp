/**
 * Module: household-representative-v2 assembler self-tests
 * Purpose: Proves eval/scripts/assemble-representative-fixture-v2.ts's own
 *   machinery is correct, independent of a live git corpus fetch for most
 *   cases (the pure buildFixtureV2() core takes already-loaded synthetic
 *   recipes/dict/pins/rulings — no I/O). Covers the jump-1778 P1v2 DONE WHEN
 *   list explicitly:
 *     1. Within-recipe dedup (aggregateCorpus): a recipe using the same
 *        canonical entry twice (or the same unresolved key twice) counts as
 *        ONE occurrence, not two; two recipes each using it once sum to two.
 *     2. Top-N + tie ordering (rankEligible): occurrences DESC primary,
 *        product_name ASC tie-break, slice to targetN, and the "take all if
 *        fewer than targetN eligible exist" behavior.
 *     3. Coverage bucketing (classifyResolvedKey): the eligible/no_ref/
 *        non_preferred_type three-way split, mirroring v1's classifyName
 *        bucket split (non_preferred_type kept distinct from no_ref).
 *     4. Evidence-class id-binding: classifyEvidence is IMPORTED unchanged
 *        from the v1 assembler — this proves v2 WIRES it correctly
 *        end-to-end (the pin-binding guard: a pin under the right
 *        product_name but the WRONG fdc_id must not count as human_pin for
 *        THIS identity), not re-proving v1's own guard exhaustively (that's
 *        eval/run.test.ts's job).
 *     5. Byte-identical re-run: buildFixtureV2() called twice with
 *        byte-identical synthetic input (including the same --date) produces
 *        byte-identical JSON.stringify(fixture) output.
 *   Plus: the name-collision dedup guard (dedupeCandidatesByName — real-data
 *   necessity discovered while assembling the actual fixture: recipe-app's
 *   base dictionary carries ~400+ near-duplicate/shell canonical keys that
 *   share a product_name, see the Builder completion report), extractProductKey
 *   port sanity against known recipe-app parsing behavior, and the REAL
 *   committed household-representative-v2.json fixture's own schema +
 *   corpus-hash pinning + actualN/top-frequency-head sanity.
 *
 * Dependencies: node:test, node:assert/strict, node:path, node:url,
 *   ./assemble-representative-fixture-v2.js (module under test),
 *   ./assemble-representative-fixture.js (v1 — read-only reuse: buildNameIndex),
 *   ../lib/fixture.js (loadFixture, validateFixtureSchema)
 * State: Stateless — no filesystem writes; the "real fixture" tests read the
 *   already-committed eval/fixtures/household-representative-v2.json.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { buildNameIndex, type Dictionary, type FdcPins, type IdentityRulings } from "./assemble-representative-fixture.js";
import {
  aggregateCorpus,
  buildFixtureV2,
  canonicalize,
  classifyResolvedKey,
  dedupeCandidatesByName,
  extractProductKey,
  isQualifierOnlyKey,
  loadCorpusRecipes,
  normalize,
  parseFraction,
  rankEligible,
  unresolvedToExcluded,
  type BuildInputV2,
  type EligibleCandidateV2,
  type RecipeCorpusEntry,
} from "./assemble-representative-fixture-v2.js";
import { loadFixture, validateFixtureSchema } from "../lib/fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "household-representative-v2.json");

// A tiny synthetic dictionary covering every classification bucket, reused
// across most tests below.
function tinyDict(): Dictionary {
  return {
    garlic: { product_name: "Garlic", names: ["garlic", "garlic cloves", "clove garlic"], fdc_ref: { fdc_id: "1001", description: "Garlic, raw", data_type: "Foundation", match_method: "exact" } },
    onion: { product_name: "Onion", names: ["onion", "onions", "yellow onion"], fdc_ref: { fdc_id: "1002", description: "Onions, raw", data_type: "SR Legacy", match_method: "exact" } },
    "duplicate onion shell": { product_name: "Onion", names: ["duplicate onion shell"], fdc_ref: { fdc_id: "1003", description: "Onions, raw (dup)", data_type: "SR Legacy", match_method: "exact" } },
    "no ref item": { product_name: "No Ref Item", names: ["no ref item"] },
    "branded only item": { product_name: "Branded Only Item", names: ["branded only item"], fdc_ref: { fdc_id: "2001", description: "Branded Only Item Snack", data_type: "Branded", match_method: "close" } },
  };
}

function tinyPins(): FdcPins {
  return { Garlic: { fdc_id: "1001" } };
}

function tinyRulings(): IdentityRulings {
  return { decisions: { "Onion|1002": { ruling: "keep" } } };
}

// ─── 1. Within-recipe dedup (aggregateCorpus) ──────────────────────────────

describe("aggregateCorpus — within-recipe dedup", () => {
  test("a recipe using the same canonical entry twice counts as ONE occurrence", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [{ id: "r1", ingredients: ["2 cloves garlic, minced", "1 clove garlic cloves"] }];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.resolvedKeyRecipeCount.get("garlic"), 1, "two garlic lines in ONE recipe must dedupe to a single occurrence");
  });

  test("two recipes each using it once sum to two occurrences", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [
      { id: "r1", ingredients: ["1 clove garlic"] },
      { id: "r2", ingredients: ["3 cloves garlic"] },
    ];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.resolvedKeyRecipeCount.get("garlic"), 2);
  });

  test("the same UNRESOLVED extracted key repeated within one recipe also dedupes to one occurrence", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [{ id: "r1", ingredients: ["1 cup totally unknown junk food item", "2 cups totally unknown junk food item"] }];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.unresolvedKeyRecipeCount.size, 1);
    assert.equal([...agg.unresolvedKeyRecipeCount.values()][0], 1);
  });

  test("corpusIngredientLineCount counts every raw line (including duplicates that dedupe for occurrence purposes)", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [{ id: "r1", ingredients: ["1 clove garlic", "1 clove garlic", "1 onion"] }];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.corpusIngredientLineCount, 3, "line count is raw, NOT deduped — only the occurrence tally dedupes");
    assert.equal(agg.resolvedKeyRecipeCount.get("garlic"), 1);
    assert.equal(agg.resolvedKeyRecipeCount.get("onion"), 1);
  });

  test("non-string / empty ingredient lines are skipped and tallied as emptyKeyLineCount, never crash", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [{ id: "r1", ingredients: ["1 clove garlic", "", "   ", 42 as unknown as string] }];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.corpusIngredientLineCount, 4);
    assert.equal(agg.emptyKeyLineCount, 3);
  });

  test("a recipe with a non-array `ingredients` field contributes zero lines, never crashes", () => {
    const dict = tinyDict();
    const nameIndex = buildNameIndex(dict);
    const recipes: RecipeCorpusEntry[] = [{ id: "r1", ingredients: undefined }, { id: "r2", ingredients: ["1 onion"] }];
    const agg = aggregateCorpus(recipes, dict, nameIndex);
    assert.equal(agg.corpusIngredientLineCount, 1);
    assert.equal(agg.resolvedKeyRecipeCount.get("onion"), 1);
  });
});

// ─── 2. Top-N + tie ordering (rankEligible) ────────────────────────────────

describe("rankEligible — ranking and tie ordering", () => {
  function candidate(productName: string, occurrences: number, canonicalKey?: string): EligibleCandidateV2 {
    return {
      canonicalKey: canonicalKey ?? productName.toLowerCase(),
      productName,
      occurrences,
      fdcRef: { fdc_id: "1", data_type: "Foundation" },
      evidenceClass: "automated_screened",
    };
  }

  test("ranks strictly by occurrences DESC", () => {
    const ranked = rankEligible([candidate("low", 1), candidate("high", 100), candidate("mid", 50)], 10);
    assert.deepEqual(ranked.map((c) => c.productName), ["high", "mid", "low"]);
  });

  test("ties on occurrences break by product_name ASC", () => {
    const ranked = rankEligible([candidate("zebra", 10), candidate("apple", 10), candidate("mango", 10)], 10);
    assert.deepEqual(ranked.map((c) => c.productName), ["apple", "mango", "zebra"]);
  });

  test("slices to targetN when more eligible candidates exist than the target", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(`item${i}`, 10 - i));
    const ranked = rankEligible(candidates, 3);
    assert.equal(ranked.length, 3);
    assert.deepEqual(ranked.map((c) => c.productName), ["item0", "item1", "item2"]);
  });

  test("takes ALL candidates (no truncation) when fewer exist than targetN", () => {
    const candidates = [candidate("a", 5), candidate("b", 3)];
    const ranked = rankEligible(candidates, 1000);
    assert.equal(ranked.length, 2);
  });

  test("does not mutate the input array", () => {
    const candidates = [candidate("b", 1), candidate("a", 2)];
    const original = [...candidates];
    rankEligible(candidates, 10);
    assert.deepEqual(candidates, original);
  });
});

// ─── 3. Coverage bucketing (classifyResolvedKey) ───────────────────────────

describe("classifyResolvedKey — coverage bucketing", () => {
  test("eligible: fdc_ref present with a preferred data_type", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("garlic", 5, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.candidate.productName, "Garlic");
      assert.equal(result.candidate.occurrences, 5);
      assert.equal(result.candidate.fdcRef.fdc_id, "1001");
    }
  });

  test("no_ref: resolved entry carries no fdc_ref at all", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("no ref item", 3, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") {
      assert.equal(result.candidate.bucket, "no_ref");
      assert.equal(result.candidate.name, "No Ref Item");
    }
  });

  test("non_preferred_type: resolved entry HAS an fdc_ref but its data_type is Branded — distinct bucket from no_ref", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("branded only item", 2, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") {
      assert.equal(result.candidate.bucket, "non_preferred_type");
      assert.notEqual(result.candidate.bucket, "no_ref", "non_preferred_type must never be folded into no_ref");
    }
  });

  test("unresolvedToExcluded tags the unresolved bucket with the raw key as the name", () => {
    const excluded = unresolvedToExcluded("some parser tail junk", 7);
    assert.equal(excluded.bucket, "unresolved");
    assert.equal(excluded.name, "some parser tail junk");
    assert.equal(excluded.occurrences, 7);
    assert.match(excluded.reason, /parser-tail/);
  });
});

// ─── 4. Evidence-class id-binding (v1's classifyEvidence, wired through v2) ─

describe("evidence-class id-binding (imported classifyEvidence, wired through v2)", () => {
  test("human_pin: pin's fdc_id matches this row's resolved fdc_ref", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("garlic", 10, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") assert.equal(result.candidate.evidenceClass, "human_pin");
  });

  test("human_ruling: identity-rulings 'keep' decision for THIS product_name|fdc_id pair", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("onion", 10, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") assert.equal(result.candidate.evidenceClass, "human_ruling");
  });

  test("automated_screened: neither a matching pin nor a ruling", () => {
    const dict = tinyDict();
    const result = classifyResolvedKey("duplicate onion shell", 10, dict, tinyPins(), tinyRulings());
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") assert.equal(result.candidate.evidenceClass, "automated_screened");
  });

  test("PIN-BINDING GUARD: a pin under the right product_name but pointing at a DIFFERENT fdc_id must NOT count as human_pin here", () => {
    const dict: Dictionary = {
      garlic: { product_name: "Garlic", names: ["garlic"], fdc_ref: { fdc_id: "9999", description: "A different garlic record", data_type: "Foundation" } },
    };
    // tinyPins() pins "Garlic" -> fdc_id "1001", but this entry resolves to "9999".
    const result = classifyResolvedKey("garlic", 4, dict, tinyPins(), { decisions: {} });
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.candidate.evidenceClass, "automated_screened", "a pin bound to a DIFFERENT fdc_id must fall through, never silently inherit human_pin");
    }
  });
});

// ─── 5. Byte-identical re-run (buildFixtureV2, pure — no I/O) ─────────────

describe("buildFixtureV2 — byte-identical re-run", () => {
  function syntheticInput(): BuildInputV2 {
    return {
      recipes: [
        { id: "r1", ingredients: ["2 cloves garlic, minced", "1 onion, diced", "1 tsp no ref item"] },
        { id: "r2", ingredients: ["3 cloves garlic", "2 onions"] },
        { id: "r3", ingredients: ["1 cup totally unresolvable junk"] },
      ],
      dict: tinyDict(),
      pins: tinyPins(),
      rulings: tinyRulings(),
      targetN: 1000,
      date: "2026-07-19T00:00:00.000Z",
      commitArg: "deadbeef",
      commitResolved: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      dictionaryBlobSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      corpusPath: "data/shared-recipes.json",
      corpusBlobSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      recipeAppPath: "/fake/recipe-app",
      assemblyScriptSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    };
  }

  test("identical input (including identical --date) produces byte-identical JSON output", () => {
    const run1 = buildFixtureV2(syntheticInput());
    const run2 = buildFixtureV2(syntheticInput());
    assert.equal(JSON.stringify(run1.fixture), JSON.stringify(run2.fixture));
    assert.deepEqual(run1.summary, run2.summary);
  });

  test("the built fixture passes schema validation and carries the expected shape", () => {
    const { fixture, summary } = buildFixtureV2(syntheticInput());
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
    assert.equal(fixture.provenance.fixtureId, "household-representative-v2");
    assert.equal(fixture.provenance.corpusRecipeCount, 3);
    assert.equal(fixture.provenance.corpusIngredientLineCount, 6);
    assert.equal(fixture.provenance.parameters?.targetN, 1000);
    assert.equal(fixture.provenance.parameters?.actualN, fixture.cases.length);
    // garlic (2 recipes) and onion (2 recipes) are eligible; "no ref item" excluded (no_ref); the junk line unresolved.
    assert.equal(fixture.cases.length, 2);
    assert.equal(summary.uniqueEligibleTotal, 2);
    for (const c of fixture.cases) {
      assert.equal(c.kind, "positive");
      assert.equal((c as { labelProvenance?: string }).labelProvenance, "dictionary-candidate-unverified");
      assert.equal((c as { expectedSource?: string }).expectedSource, "dictionary-ratified");
    }
  });

  test("every eligible case appears in `cases` exactly once, and no name collides with `excluded`", () => {
    const { fixture } = buildFixtureV2(syntheticInput());
    const caseNames = new Set(fixture.cases.map((c) => c.name));
    assert.equal(caseNames.size, fixture.cases.length, "no duplicate case names");
    for (const x of fixture.excluded ?? []) {
      assert.ok(!caseNames.has(x.name), `excluded name "${x.name}" must not also appear in cases`);
    }
  });

  test("--target-n smaller than the eligible pool truncates cases and records actualN === targetN", () => {
    const input = syntheticInput();
    input.targetN = 1;
    const { fixture } = buildFixtureV2(input);
    assert.equal(fixture.cases.length, 1);
    assert.equal(fixture.provenance.parameters?.actualN, 1);
    // garlic (3 occurrences total across r1+r2... wait: distinct-recipe count, both recipes use garlic -> 2) vs onion (2) tie on name asc -> "Garlic" < "Onion".
    assert.equal(fixture.cases[0].name, "Garlic");
  });
});

// ─── 6. Name-collision dedup (dedupeCandidatesByName) ──────────────────────

describe("dedupeCandidatesByName — product_name collision guard", () => {
  test("two eligible candidates sharing a product_name: higher-occurrence wins, loser dropped", () => {
    const winner: EligibleCandidateV2 = { canonicalKey: "garlic", productName: "Garlic", occurrences: 100, fdcRef: { fdc_id: "1", data_type: "Foundation" }, evidenceClass: "human_pin" };
    const loser: EligibleCandidateV2 = { canonicalKey: "crushed garlic shell", productName: "Garlic", occurrences: 2, fdcRef: { fdc_id: "1", data_type: "Foundation" }, evidenceClass: "automated_screened" };
    const result = dedupeCandidatesByName([
      { name: "Garlic", occurrences: 100, priority: 0, ref: { kind: "eligible", c: winner } },
      { name: "Garlic", occurrences: 2, priority: 0, ref: { kind: "eligible", c: loser } },
    ]);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.eligible[0].canonicalKey, "garlic");
    assert.equal(result.droppedCount, 1);
  });

  test("eligible always outranks excluded on a name collision, regardless of occurrence count", () => {
    const eligible: EligibleCandidateV2 = { canonicalKey: "x", productName: "Same Name", occurrences: 1, fdcRef: { fdc_id: "1", data_type: "Foundation" }, evidenceClass: "automated_screened" };
    const result = dedupeCandidatesByName([
      { name: "Same Name", occurrences: 1, priority: 0, ref: { kind: "eligible", c: eligible } },
      { name: "Same Name", occurrences: 500, priority: 1, ref: { kind: "excluded", c: { name: "Same Name", bucket: "no_ref", occurrences: 500, reason: "x" } } },
    ]);
    assert.equal(result.eligible.length, 1);
    assert.equal(result.excluded.length, 0);
    assert.equal(result.droppedCount, 1);
  });

  test("no collision -> nothing dropped", () => {
    const a: EligibleCandidateV2 = { canonicalKey: "a", productName: "A", occurrences: 1, fdcRef: { fdc_id: "1", data_type: "Foundation" }, evidenceClass: "automated_screened" };
    const b: EligibleCandidateV2 = { canonicalKey: "b", productName: "B", occurrences: 1, fdcRef: { fdc_id: "2", data_type: "Foundation" }, evidenceClass: "automated_screened" };
    const result = dedupeCandidatesByName([
      { name: "A", occurrences: 1, priority: 0, ref: { kind: "eligible", c: a } },
      { name: "B", occurrences: 1, priority: 0, ref: { kind: "eligible", c: b } },
    ]);
    assert.equal(result.eligible.length, 2);
    assert.equal(result.droppedCount, 0);
  });
});

// ─── 7. extractProductKey port sanity ──────────────────────────────────────

describe("extractProductKey — ported parser sanity", () => {
  test("strips quantity, unit, and post-comma prep, then resolves via the name index", () => {
    const dict: Dictionary = { "yellow onion": { product_name: "Yellow Onion", names: ["yellow onion", "yellow onions"] } };
    const nameIndex = buildNameIndex(dict);
    const { key, qty, unit } = extractProductKey("4 large yellow onions, thinly sliced", nameIndex);
    assert.equal(key, "yellow onion", "size descriptor 'large' stripped, plural falls back via nameIndex -s stripping");
    assert.equal(qty, 4);
    assert.equal(unit, null);
  });

  test("a qualifier-only residue (e.g. a truncated 'large') never resolves through canonicalize, even if a same-named dict entry exists", () => {
    const dict: Dictionary = { large: { product_name: "Should Never Resolve", names: ["large"] } };
    const nameIndex = buildNameIndex(dict);
    const { key } = extractProductKey("1 cup large, unsweetened coconut flakes", nameIndex);
    assert.equal(key, "large", "PREP_COMMA truncates to bare 'large'");
    assert.equal(isQualifierOnlyKey(key), true, "the qualifier guard must recognize this as junk regardless of what a bare dict[key] lookup would find");
  });

  test("unresolvable text passes through canonicalize() lowercased, unchanged (never undefined)", () => {
    const nameIndex = new Map<string, string>();
    const { key } = extractProductKey("2 cups Totally Unknown Product XYZ", nameIndex);
    assert.equal(key, "totally unknown product xyz");
  });

  test("normalize() lowercases, collapses whitespace, and strips a non-frozen leading 'fresh'", () => {
    assert.equal(normalize("  Fresh   Ginger  "), "ginger");
    // "peas" ends in vowel+s ("as") — the plural-strip regex only fires after
    // a CONSONANT+s (breasts -> breast), so "peas" stays "peas" (same class
    // as "tomatoes" staying unstripped per the source's own comment).
    assert.equal(normalize("Fresh Frozen Peas"), "fresh frozen peas");
  });

  test("canonicalize() passthrough matches production ingredient-name-index.js semantics: hit -> canonical key, miss -> lowercased input", () => {
    const dict: Dictionary = { garlic: { product_name: "Garlic", names: ["garlic", "garlic cloves"] } };
    const nameIndex = buildNameIndex(dict);
    assert.equal(canonicalize("Garlic Cloves", nameIndex), "garlic");
    assert.equal(canonicalize("Something Else Entirely", nameIndex), "something else entirely");
  });

  test("parseFraction handles unicode fractions, mixed numbers, and ranges (take-higher)", () => {
    assert.equal(parseFraction("½"), 0.5);
    assert.equal(parseFraction("1 1/2"), 1.5);
    assert.equal(parseFraction("2-3"), 3);
    assert.equal(parseFraction(null), null);
  });
});

// ─── 8. loadCorpusRecipes ───────────────────────────────────────────────────

describe("loadCorpusRecipes", () => {
  test("parses a valid recipe array", () => {
    const recipes = loadCorpusRecipes(JSON.stringify([{ id: "r1", ingredients: ["1 onion"] }]));
    assert.equal(recipes.length, 1);
  });

  test("rejects a non-array JSON payload", () => {
    assert.throws(() => loadCorpusRecipes(JSON.stringify({ not: "an array" })), /JSON array/);
  });
});

// ─── 9. The REAL committed household-representative-v2 fixture ────────────

describe("committed household-representative-v2.json — schema + provenance sanity", () => {
  test("passes schema validation", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
  });

  test("every case is positive, carries labelProvenance:'dictionary-candidate-unverified', and occurrences is a positive integer", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    assert.ok(fixture.cases.length > 0);
    for (const c of fixture.cases) {
      assert.equal(c.kind, "positive");
      assert.equal((c as { labelProvenance?: string }).labelProvenance, "dictionary-candidate-unverified");
      assert.ok(Number.isInteger((c as { occurrences?: number }).occurrences) && (c as { occurrences: number }).occurrences > 0);
    }
  });

  test("cases are sorted by occurrences DESC (the ranking's own invariant holds in the committed file)", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    const occurrences = fixture.cases.map((c) => (c as { occurrences?: number }).occurrences ?? 0);
    for (let i = 1; i < occurrences.length; i++) {
      assert.ok(occurrences[i - 1] >= occurrences[i], `case[${i}] occurrences (${occurrences[i]}) must not exceed case[${i - 1}] (${occurrences[i - 1]})`);
    }
  });

  test("provenance.parameters.actualN matches cases.length, and is reported prominently even when below targetN", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    assert.equal(fixture.provenance.parameters?.actualN, fixture.cases.length);
    assert.equal(fixture.provenance.counts.positive, fixture.cases.length);
    assert.equal(fixture.provenance.counts.total, fixture.cases.length);
  });

  test("corpus provenance matches the pinned commit's known, independently-verified values", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    assert.equal(fixture.provenance.corpusRecipeCount, 935, "935 recipes measured independently via `git show 7e681cb:data/shared-recipes.json | python3 -c \"len(json.load(...))\"`");
    assert.equal(fixture.provenance.corpusIngredientLineCount, 11873, "11,873 raw ingredient lines — matches the spec's own MEASURED value");
    assert.equal(
      fixture.provenance.corpusBlobSha256,
      "9079fcd4cc4258d8311592581b3b18fbee954b851f562e37929c2e64e2ac824f",
      "sha256 computed independently via `git show 7e681cb:data/shared-recipes.json | shasum -a 256` — pins this fixture to the exact corpus bytes"
    );
    assert.equal(fixture.provenance.dictionaryCommit, "7e681cbcd652c0d43fc2e3d681eb5d31ca0e98f5", "full 40-hex SHA, resolved via git rev-parse, not the short arg form");
  });

  test("the top of the frequency ranking is dominated by real pantry staples (sanity, not a hard regression pin)", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    const top10Names = fixture.cases.slice(0, 10).map((c) => c.name.toLowerCase());
    const staples = ["salt", "garlic", "black pepper", "olive oil", "extra-virgin olive oil", "lemon juice", "carrots", "eggs", "water", "red onions"];
    for (const staple of staples) {
      assert.ok(top10Names.includes(staple), `expected "${staple}" in the top-10 frequency head, got ${JSON.stringify(top10Names)}`);
    }
  });

  test("no name appears in both cases and excluded (schema invariant re-checked directly against the real file)", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    const caseNames = new Set(fixture.cases.map((c) => c.name));
    for (const x of fixture.excluded ?? []) {
      assert.ok(!caseNames.has(x.name));
    }
  });

  test("every excluded row carries a bucket-identifiable reason (unresolved / no_ref / non_preferred_type)", () => {
    const fixture = loadFixture(V2_FIXTURE_PATH);
    assert.ok((fixture.excluded ?? []).length > 0);
    for (const x of fixture.excluded ?? []) {
      assert.ok(/parser-tail|no fdc_ref|not one of Foundation/.test(x.reason), `unrecognized exclusion reason shape: "${x.reason}"`);
    }
  });
});
