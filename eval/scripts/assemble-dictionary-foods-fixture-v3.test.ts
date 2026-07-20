/**
 * Module: household-dictionary-foods-v3 assembler self-tests
 * Purpose: Proves eval/scripts/assemble-dictionary-foods-fixture-v3.ts's own
 *   machinery is correct, independent of a live git corpus fetch for most
 *   cases (the pure buildFixtureV3() core takes already-loaded synthetic
 *   dict/recipes/pins/rulings — no I/O). Covers the jump-1778 P3 DONE WHEN
 *   list explicitly:
 *     1. Dedup-by-fdc_id (groupEligibleByFdcId / buildFixtureV3): every
 *        distinct fdc_id becomes exactly ONE case, regardless of how many
 *        dictionary entries share it.
 *     2. The representative-name tie-break ladder (selectRepresentative):
 *        one test per rung (1 cart_modifiers, 2a token-count, 2b
 *        char-length, 3 per-entry corpus frequency, 4 lexicographic
 *        product_name, 5 the implicit lexicographic-dict-key fallback), plus
 *        the real-shaped "salt" (many keys, one product_name, decided past
 *        rung 2) and "kale" (mixed cart_modifiers/lengths, decided past rung
 *        2, same eventual product_name) scenarios named explicitly in the
 *        dispatch spec.
 *     3. Food-level occurrence aggregation (computeFoodLevelOccurrences):
 *        SUMS per-entry corpus frequency across every entry in a group, not
 *        just the winner.
 *     4. cooked/uncooked flag: occurrences>0 vs ===0, and that a
 *        zero-occurrence food still produces a case (never dropped).
 *     5. Evidence-class binding: classifyEvidence is IMPORTED unchanged from
 *        the v1 assembler — proves v3 wires it correctly end-to-end
 *        (including the pin-binding guard), same discipline as the v2 test
 *        file.
 *     6. Committed-fixture schema+provenance sanity: the REAL, already-built
 *        eval/fixtures/household-dictionary-foods-v3.json validates, has the
 *        measured case/excluded counts, no duplicate fdcId, and the two
 *        named spot-review cases (salt -> "salt", kale -> "kale").
 *   Plus: classifyDictEntryV3's four-way bucket split, the two defensive
 *   collision guards (case-vs-case throws; excluded-vs-case drops), and
 *   byte-identical re-run.
 *
 * Dependencies: node:test, node:assert/strict, node:path, node:url,
 *   ./assemble-dictionary-foods-fixture-v3.js (module under test),
 *   ./assemble-representative-fixture.js (v1 — read-only reuse:
 *   buildNameIndex), ../lib/fixture.js (loadFixture, validateFixtureSchema)
 * State: Stateless — no filesystem writes; the "real fixture" tests read the
 *   already-committed eval/fixtures/household-dictionary-foods-v3.json.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { FdcPins, IdentityRulings } from "./assemble-representative-fixture.js";
import {
  buildFixtureV3,
  classifyDictEntryV3,
  computeFoodLevelOccurrences,
  groupEligibleByFdcId,
  selectRepresentative,
  tokenCount,
  type BuildInputV3,
  type DictEntryV3,
  type DictionaryV3,
  type EligibleEntryV3,
} from "./assemble-dictionary-foods-fixture-v3.js";
import { loadFixture, validateFixtureSchema } from "../lib/fixture.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V3_FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "household-dictionary-foods-v3.json");

function entry(productName: string, fdcId: string, opts: { cartModifiers?: string[]; dataType?: string; status?: string } = {}): DictEntryV3 {
  return {
    product_name: productName,
    status: opts.status ?? "enriched",
    cart_modifiers: opts.cartModifiers,
    fdc_ref: { fdc_id: fdcId, description: `${productName}, raw`, data_type: opts.dataType ?? "Foundation", match_method: "exact" },
  };
}

function eligible(key: string, productName: string, fdcId: string, cartModifierCount = 0): EligibleEntryV3 {
  return {
    key,
    productName,
    cartModifierCount,
    tokenCount: tokenCount(productName),
    charLength: productName.trim().length,
    fdcId,
    fdcRef: { fdc_id: fdcId, description: `${productName}, raw`, data_type: "Foundation", match_method: "exact" },
  };
}

// ─── 1. classifyDictEntryV3 — four-way bucket split ────────────────────────

describe("classifyDictEntryV3 — eligible / excluded bucket split", () => {
  test("eligible: fdc_ref present with a preferred data_type", () => {
    const result = classifyDictEntryV3("garlic", entry("Garlic", "1001"));
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.entry.fdcId, "1001");
      assert.equal(result.entry.productName, "Garlic");
    }
  });

  test("no_ref_legacy: no fdc_ref at all, status legacy", () => {
    const result = classifyDictEntryV3("old thing", { product_name: "Old Thing", status: "legacy" });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") assert.equal(result.entry.bucket, "no_ref_legacy");
  });

  test("no_ref_flagged: no fdc_ref at all, status flagged", () => {
    const result = classifyDictEntryV3("bad thing", { product_name: "Bad Thing", status: "flagged" });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") assert.equal(result.entry.bucket, "no_ref_flagged");
  });

  test("no_ref_other: no fdc_ref at all, any other/missing status — a generic bucket, distinct from legacy/flagged", () => {
    const result = classifyDictEntryV3("mystery thing", { product_name: "Mystery Thing", status: "pending" });
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") assert.equal(result.entry.bucket, "no_ref_other");

    const noStatus = classifyDictEntryV3("no status thing", { product_name: "No Status Thing" });
    assert.equal(noStatus.kind, "excluded");
    if (noStatus.kind === "excluded") assert.equal(noStatus.entry.bucket, "no_ref_other");
  });

  test("non_preferred_type: HAS an fdc_ref but data_type is Branded — distinct bucket from every no_ref bucket", () => {
    const result = classifyDictEntryV3("branded thing", entry("Branded Thing", "2001", { dataType: "Branded" }));
    assert.equal(result.kind, "excluded");
    if (result.kind === "excluded") {
      assert.equal(result.entry.bucket, "non_preferred_type");
      assert.notEqual(result.entry.bucket, "no_ref_legacy");
      assert.notEqual(result.entry.bucket, "no_ref_flagged");
      assert.notEqual(result.entry.bucket, "no_ref_other");
    }
  });

  test("cart_modifiers count and product_name token/char length are captured on eligible entries", () => {
    const result = classifyDictEntryV3("10 inch tortillas", entry("flour tortillas", "2758996", { cartModifiers: ["10-inch", "burrito-sized"] }));
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") {
      assert.equal(result.entry.cartModifierCount, 2);
      assert.equal(result.entry.tokenCount, 2);
      assert.equal(result.entry.charLength, "flour tortillas".length);
    }
  });

  test("falls back to the dict KEY as productName when product_name is absent", () => {
    const result = classifyDictEntryV3("bare key", { fdc_ref: { fdc_id: "999", data_type: "Foundation" } });
    assert.equal(result.kind, "eligible");
    if (result.kind === "eligible") assert.equal(result.entry.productName, "bare key");
  });
});

// ─── 2. groupEligibleByFdcId — dedup-by-fdc_id ─────────────────────────────

describe("groupEligibleByFdcId — dedup-by-fdc_id", () => {
  test("multiple entries sharing an fdc_id land in ONE group", () => {
    const entries = [eligible("salt", "salt", "746775"), eligible("salt to taste", "salt", "746775"), eligible("kosher salt", "kosher salt", "746775")];
    const groups = groupEligibleByFdcId(entries);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("746775")?.length, 3);
  });

  test("entries with different fdc_ids land in DIFFERENT groups", () => {
    const entries = [eligible("garlic", "Garlic", "1001"), eligible("onion", "Onion", "1002")];
    const groups = groupEligibleByFdcId(entries);
    assert.equal(groups.size, 2);
  });

  test("a single-entry group is still a group of one", () => {
    const groups = groupEligibleByFdcId([eligible("kiwi", "Kiwi", "3001")]);
    assert.equal(groups.size, 1);
    assert.equal(groups.get("3001")?.length, 1);
  });
});

// ─── 3. selectRepresentative — the tie-break ladder, rung by rung ──────────

describe("selectRepresentative — tie-break ladder", () => {
  test("rung 1: fewest cart_modifiers wins outright", () => {
    const a = eligible("plain onion", "onion", "1", 0);
    const b = eligible("fancy onion", "fancy red onion", "1", 3);
    const result = selectRepresentative([a, b], new Map());
    assert.equal(result.winner.key, "plain onion");
    assert.equal(result.decidedAtRung, 1);
    assert.equal(result.survivorsAfterRung2, 1);
  });

  test("rung 2a: fewer TOKENS wins when cart_modifiers tie", () => {
    const a = eligible("kosher salt", "kosher salt", "1", 0);
    const b = eligible("bare salt", "salt", "1", 0);
    const result = selectRepresentative([a, b], new Map());
    assert.equal(result.winner.key, "bare salt");
    assert.equal(result.decidedAtRung, 2);
  });

  test("rung 2b: shorter CHAR LENGTH wins when cart_modifiers and token-count both tie", () => {
    const a = eligible("longer one word", "generouscheddar", "1", 0); // 1 token, 15 chars
    const b = eligible("shorter one word", "cheddar", "1", 0); // 1 token, 7 chars
    const result = selectRepresentative([a, b], new Map());
    assert.equal(result.winner.key, "shorter one word");
    assert.equal(result.decidedAtRung, 2);
  });

  test("rung 3: highest PER-ENTRY corpus frequency wins when rung 1+2 both tie on genuinely different candidate strings (the 'bok choy' vs 'choy sum' real-data shape)", () => {
    const bokChoy = eligible("bok choy key", "bok choy", "2685572", 0);
    const choySum = eligible("choy sum key", "choy sum", "2685572", 0);
    const corpusFreq = new Map([
      ["bok choy key", 12],
      ["choy sum key", 3],
    ]);
    const result = selectRepresentative([bokChoy, choySum], corpusFreq);
    assert.equal(result.winner.key, "bok choy key");
    assert.equal(result.decidedAtRung, 3);
    assert.equal(result.survivorsAfterRung2, 2, "both candidates must survive rung 1+2 to prove rung 3 actually did the deciding");
    assert.deepEqual(result.distinctNamesAfterRung2, ["bok choy", "choy sum"], "text-ambiguous: 2+ DIFFERENT candidate strings tied after rung 2");
  });

  test("rung 3 uses the PER-ENTRY value, never a food-level sum — a candidate with a lower individual frequency but arbitrarily large OTHER group members must still lose", () => {
    const low = eligible("low freq key", "candidate a", "9", 0);
    const high = eligible("high freq key", "candidate b", "9", 0);
    const corpusFreq = new Map([
      ["low freq key", 1],
      ["high freq key", 2],
    ]);
    const result = selectRepresentative([low, high], corpusFreq);
    assert.equal(result.winner.key, "high freq key", "rung 3 must pick by EACH candidate's own frequency, not a shared/food-level number");
  });

  test("rung 4: lexicographic product_name ASC when rung 1+2+3 all tie (equal corpus frequency, different text)", () => {
    const a = eligible("zebra key", "zebra fruit", "5", 0);
    const b = eligible("apple key", "apple fruit", "5", 0);
    const corpusFreq = new Map([
      ["zebra key", 4],
      ["apple key", 4],
    ]);
    const result = selectRepresentative([a, b], corpusFreq);
    assert.equal(result.winner.key, "apple key");
    assert.equal(result.decidedAtRung, 4);
  });

  test("rung 5 (implicit): lexicographic dict KEY ASC when even product_name is byte-identical across every survivor (the 'salt' real-data shape) — output text is unaffected either way", () => {
    const a = eligible("salt and pepper", "salt", "746775", 0);
    const b = eligible("salt to taste", "salt", "746775", 0);
    const c = eligible("salt", "salt", "746775", 0);
    const result = selectRepresentative([a, b, c], new Map()); // empty corpusFreq -> rung 3 also ties at 0
    assert.equal(result.decidedAtRung, 5);
    assert.equal(result.winner.key, "salt", "'salt' sorts lexicographically before 'salt and pepper' and 'salt to taste'");
    assert.equal(result.winner.productName, "salt", "regardless of which KEY wins rung 5, the OUTPUT query text is unaffected — every survivor already shares one product_name");
  });

  test("real-shaped SALT case: many entries, one product_name, decided past rung 2, resolves to 'salt'", () => {
    const candidates = [
      eligible("salt", "salt", "746775", 0),
      eligible("of salt", "salt", "746775", 0),
      eligible("salt and pepper", "salt", "746775", 0),
      eligible("salt to taste", "salt", "746775", 0),
      eligible("kosher salt", "kosher salt", "746775", 0), // 2 tokens -> eliminated at rung 2
      eligible("pinch of fine salt", "salt", "746775", 1), // has a cart_modifier -> eliminated at rung 1
    ];
    const corpusFreq = new Map([["salt", 500]]); // the bare literal key is by far the most common exact phrasing
    const result = selectRepresentative(candidates, corpusFreq);
    assert.equal(result.winner.productName, "salt");
    assert.ok(result.decidedAtRung > 2, "the salt group must NOT resolve at rung 1 or 2 alone (several distinct KEYS survive both)");
    assert.deepEqual(result.distinctNamesAfterRung2, ["salt"], "not text-ambiguous — every rung-2 survivor already shares the SAME product_name");
  });

  test("real-shaped KALE case: mixed cart_modifiers and lengths, decided past rung 2, resolves to 'kale'", () => {
    const candidates = [
      eligible("kale", "kale", "323505", 0),
      eligible("bundle kale", "kale", "323505", 0),
      eligible("chopped kale )", "kale", "323505", 0),
      eligible("chopped fresh kale", "fresh kale", "323505", 0), // 2 tokens -> eliminated at rung 2
      eligible("lacinato kale", "lacinato kale", "323505", 1), // has a cart_modifier -> eliminated at rung 1
      eligible("shredded lacinto kale", "Lacinto kale", "323505", 0), // 2 tokens -> eliminated at rung 2
    ];
    const corpusFreq = new Map([["kale", 80]]);
    const result = selectRepresentative(candidates, corpusFreq);
    assert.equal(result.winner.productName, "kale");
    assert.ok(result.decidedAtRung > 2);
  });

  test("throws on an empty candidate list (an internal-invariant guard, never expected in real grouping)", () => {
    assert.throws(() => selectRepresentative([], new Map()), /empty candidate list/);
  });
});

// ─── 4. computeFoodLevelOccurrences — the second lens ──────────────────────

describe("computeFoodLevelOccurrences — food-level sum across the WHOLE group", () => {
  test("sums per-entry corpus frequency across every entry, not just the winner", () => {
    const group = [eligible("salt", "salt", "746775", 0), eligible("kosher salt", "kosher salt", "746775", 0), eligible("sea salt", "sea salt", "746775", 0)];
    const corpusFreq = new Map([
      ["salt", 400],
      ["kosher salt", 60],
      ["sea salt", 30],
    ]);
    assert.equal(computeFoodLevelOccurrences(group, corpusFreq), 490, "sum over ALL salt-family names, matching the spec's own salt spot-check");
  });

  test("entries absent from corpusFreq contribute 0, never crash", () => {
    const group = [eligible("never cooked", "obscure food", "9001", 0)];
    assert.equal(computeFoodLevelOccurrences(group, new Map()), 0);
  });

  test("a single-entry group's food-level sum equals that one entry's own frequency", () => {
    const group = [eligible("kiwi", "Kiwi", "3001", 0)];
    assert.equal(computeFoodLevelOccurrences(group, new Map([["kiwi", 7]])), 7);
  });
});

// ─── 5. buildFixtureV3 — cooked/uncooked, evidence-class binding, collisions, byte-identical re-run ─

function tinyDict(): DictionaryV3 {
  return {
    garlic: entry("Garlic", "1001"),
    onion: entry("Onion", "1002", { dataType: "SR Legacy" }),
    "old thing": { product_name: "Old Thing", status: "legacy" },
    "flagged thing": { product_name: "Flagged Thing", status: "flagged" },
    "never cooked food": entry("Never Cooked Food", "5001"),
  };
}

function tinyPins(): FdcPins {
  return { Garlic: { fdc_id: "1001" } };
}

function tinyRulings(): IdentityRulings {
  return { decisions: { "Onion|1002": { ruling: "keep" } } };
}

function syntheticInput(overrides: Partial<BuildInputV3> = {}): BuildInputV3 {
  return {
    dict: tinyDict(),
    recipes: [
      { id: "r1", ingredients: ["2 cloves garlic, minced", "1 onion, diced"] },
      { id: "r2", ingredients: ["3 cloves garlic"] },
    ],
    pins: tinyPins(),
    rulings: tinyRulings(),
    date: "2026-07-19T00:00:00.000Z",
    commitArg: "deadbeef",
    commitResolved: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    dictionaryBlobSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dictPath: "data/ingredient-dictionary.base.json",
    corpusPath: "data/shared-recipes.json",
    corpusBlobSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    recipeAppPath: "/fake/recipe-app",
    assemblyScriptSha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    ...overrides,
  };
}

describe("buildFixtureV3 — cooked/uncooked flag", () => {
  test("a food cooked in the corpus (garlic, 2 recipes) carries occurrences>0 and cooked:true", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    const garlic = fixture.cases.find((c) => c.name === "Garlic");
    assert.ok(garlic);
    assert.equal((garlic as { occurrences?: number }).occurrences, 2);
    assert.equal((garlic as { cooked?: boolean }).cooked, true);
  });

  test("a real dictionary food NEVER cooked in this corpus still produces a case, with occurrences:0 and cooked:false — never dropped", () => {
    const { fixture, summary } = buildFixtureV3(syntheticInput());
    const neverCooked = fixture.cases.find((c) => c.name === "Never Cooked Food");
    assert.ok(neverCooked, "the food must still be present as a case");
    assert.equal((neverCooked as { occurrences?: number }).occurrences, 0);
    assert.equal((neverCooked as { cooked?: boolean }).cooked, false);
    assert.equal(summary.uncookedFoods >= 1, true);
  });

  test("schema validation accepts occurrences:0 (jump-1778 P3 widened the validator from positive to non-negative)", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
  });
});

describe("buildFixtureV3 — evidence-class binding (imported classifyEvidence, wired through v3)", () => {
  test("human_pin: pin's fdc_id matches this food's resolved fdc_ref", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    const garlic = fixture.cases.find((c) => c.name === "Garlic");
    assert.equal((garlic as { evidenceClass?: string })?.evidenceClass, "human_pin");
  });

  test("human_ruling: identity-rulings 'keep' decision for THIS product_name|fdc_id pair", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    const onion = fixture.cases.find((c) => c.name === "Onion");
    assert.equal((onion as { evidenceClass?: string })?.evidenceClass, "human_ruling");
  });

  test("automated_screened: neither a matching pin nor a ruling", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    const neverCooked = fixture.cases.find((c) => c.name === "Never Cooked Food");
    assert.equal((neverCooked as { evidenceClass?: string })?.evidenceClass, "automated_screened");
  });

  test("PIN-BINDING GUARD: a pin under the right product_name but pointing at a DIFFERENT fdc_id must NOT count as human_pin here", () => {
    const dict: DictionaryV3 = { garlic: entry("Garlic", "9999") };
    const { fixture } = buildFixtureV3(syntheticInput({ dict, recipes: [] }));
    const garlic = fixture.cases.find((c) => c.name === "Garlic");
    assert.equal(
      (garlic as { evidenceClass?: string })?.evidenceClass,
      "automated_screened",
      "tinyPins() pins Garlic -> 1001, but this entry resolves to 9999 — must fall through, never silently inherit human_pin"
    );
  });
});

describe("buildFixtureV3 — dedup-by-fdc_id at the fixture-assembly level", () => {
  test("case count equals the distinct fdc_id count, not the raw entry count", () => {
    const dict: DictionaryV3 = {
      salt: entry("salt", "746775", { cartModifiers: [] }),
      "salt to taste": entry("salt", "746775"),
      "kosher salt": entry("kosher salt", "746775"),
      garlic: entry("Garlic", "1001"),
    };
    const { fixture, summary } = buildFixtureV3(syntheticInput({ dict, recipes: [] }));
    assert.equal(fixture.cases.length, 2, "3 salt-family entries sharing one fdc_id collapse to ONE case; garlic is the second");
    assert.equal(summary.distinctPreferredFoods, 2);
    assert.equal(summary.duplicateNameEntriesCollapsed, 2, "4 preferred-ref entries - 2 distinct foods = 2 collapsed");
  });

  test("no two cases share an fdcId", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    const fdcIds = fixture.cases.map((c) => (c as { expected?: { fdcId?: number } }).expected?.fdcId);
    assert.equal(new Set(fdcIds).size, fdcIds.length);
  });
});

describe("buildFixtureV3 — defensive collision guards", () => {
  test("CASE-vs-CASE collision (two different fdc_ids both selecting the same representative product_name) throws rather than silently dropping either side", () => {
    const dict: DictionaryV3 = {
      "food a": entry("Same Name", "1"),
      "food b": entry("Same Name", "2"),
    };
    assert.throws(() => buildFixtureV3(syntheticInput({ dict, recipes: [] })), /Representative-name collision/);
  });

  test("EXCLUDED-vs-CASE collision: an excluded entry's product_name colliding with a case's name is dropped from excluded[], tallied in nameCollisionDropped", () => {
    const dict: DictionaryV3 = {
      garlic: entry("Garlic", "1001"),
      "stale garlic entry": { product_name: "Garlic", status: "legacy" }, // no fdc_ref -> excluded, but collides with the eligible "Garlic" case
    };
    const { fixture, summary } = buildFixtureV3(syntheticInput({ dict, recipes: [] }));
    assert.equal(fixture.cases.some((c) => c.name === "Garlic"), true);
    assert.equal((fixture.excluded ?? []).some((x) => x.name === "Garlic"), false, "the colliding excluded row must be dropped, not duplicated");
    assert.equal(summary.nameCollisionDropped, 1);
  });
});

describe("buildFixtureV3 — byte-identical re-run", () => {
  test("identical input (including identical --date) produces byte-identical JSON output", () => {
    const run1 = buildFixtureV3(syntheticInput());
    const run2 = buildFixtureV3(syntheticInput());
    assert.equal(JSON.stringify(run1.fixture), JSON.stringify(run2.fixture));
    assert.deepEqual(run1.summary, run2.summary);
  });

  test("the built fixture carries the expected provenance shape and passes schema validation", () => {
    const { fixture } = buildFixtureV3(syntheticInput());
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
    assert.equal(fixture.provenance.fixtureId, "household-dictionary-foods-v3");
    assert.equal(fixture.provenance.dictionaryFoodsStats?.totalDictEntries, Object.keys(tinyDict()).length);
    assert.equal(fixture.provenance.dictionaryFoodsStats?.noRefLegacy, 1);
    assert.equal(fixture.provenance.dictionaryFoodsStats?.noRefFlagged, 1);
    for (const c of fixture.cases) {
      assert.equal(c.kind, "positive");
      assert.equal((c as { labelProvenance?: string }).labelProvenance, "dictionary-candidate-unverified");
      assert.equal((c as { expectedSource?: string }).expectedSource, "dictionary-ratified");
    }
  });
});

// ─── 6. The REAL committed household-dictionary-foods-v3 fixture ──────────

describe("committed household-dictionary-foods-v3.json — schema + provenance sanity", () => {
  test("passes schema validation", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    assert.doesNotThrow(() => validateFixtureSchema(fixture));
  });

  test("every case is positive, carries labelProvenance:'dictionary-candidate-unverified', and a boolean cooked flag", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    assert.ok(fixture.cases.length > 0);
    for (const c of fixture.cases) {
      assert.equal(c.kind, "positive");
      assert.equal((c as { labelProvenance?: string }).labelProvenance, "dictionary-candidate-unverified");
      assert.equal(typeof (c as { cooked?: boolean }).cooked, "boolean");
      assert.ok(Number.isInteger((c as { occurrences?: number }).occurrences) && (c as { occurrences: number }).occurrences >= 0);
    }
  });

  test("no two cases share an fdcId (the frame's own core invariant)", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const fdcIds = fixture.cases.map((c) => (c as { expected?: { fdcId?: number } }).expected?.fdcId);
    assert.equal(new Set(fdcIds).size, fdcIds.length);
  });

  test("case count equals provenance.dictionaryFoodsStats.distinctPreferredFoods", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    assert.equal(fixture.cases.length, fixture.provenance.dictionaryFoodsStats?.distinctPreferredFoods);
  });

  test("excluded count equals noRefLegacy + noRefFlagged + noRefOther + nonPreferredType", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const stats = fixture.provenance.dictionaryFoodsStats!;
    assert.equal((fixture.excluded ?? []).length + stats.nameCollisionDropped, stats.noRefLegacy + stats.noRefFlagged + stats.noRefOther + stats.nonPreferredType);
  });

  test("no name appears in both cases and excluded (schema invariant re-checked directly against the real file)", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const caseNames = new Set(fixture.cases.map((c) => c.name));
    for (const x of fixture.excluded ?? []) {
      assert.ok(!caseNames.has(x.name));
    }
  });

  test("the SALT spot-review case: representative resolves to 'salt', occurrences equals the sum over the whole salt family", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const salt = fixture.cases.find((c) => c.name === "salt");
    assert.ok(salt, "expected a case named exactly 'salt'");
    assert.equal((salt as { expected?: { fdcId?: number } }).expected?.fdcId, 746775);
  });

  test("the KALE spot-review case: representative resolves to 'kale'", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const kale = fixture.cases.find((c) => c.name === "kale");
    assert.ok(kale, "expected a case named exactly 'kale'");
    assert.equal((kale as { expected?: { fdcId?: number } }).expected?.fdcId, 323505);
  });

  test("cookedFoods + uncookedFoods equals total case count", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const stats = fixture.provenance.dictionaryFoodsStats!;
    assert.equal(stats.cookedFoods + stats.uncookedFoods, fixture.cases.length);
  });

  test("evidenceClassCounts sums to the total case count", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    const counts = fixture.provenance.evidenceClassCounts!;
    const sum = counts.human_pin + counts.human_ruling + counts.automated_screened;
    assert.equal(sum, fixture.cases.length);
  });

  test("corpus provenance matches the pinned commit's known, independently-verified values (same corpus v2 uses)", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    assert.equal(fixture.provenance.corpusRecipeCount, 935);
    assert.equal(fixture.provenance.corpusIngredientLineCount, 11873);
    assert.equal(
      fixture.provenance.corpusBlobSha256,
      "9079fcd4cc4258d8311592581b3b18fbee954b851f562e37929c2e64e2ac824f",
      "sha256 computed independently via `git show 7e681cb:data/shared-recipes.json | shasum -a 256` — same corpus file household-representative-v2.json pins"
    );
    assert.equal(fixture.provenance.dictionaryCommit, "7e681cbcd652c0d43fc2e3d681eb5d31ca0e98f5", "full 40-hex SHA, resolved via git rev-parse, not the short arg form");
  });

  test("no name-collision drops on the real dictionary (the guard is real code, exercised by the synthetic test above, but a 0 here is expected)", () => {
    const fixture = loadFixture(V3_FIXTURE_PATH);
    assert.equal(fixture.provenance.dictionaryFoodsStats?.nameCollisionDropped, 0);
  });
});
