/**
 * Module: relevance.test.ts
 * Purpose: Unit tests for src/relevance.ts's rateMatchQuality() heuristic —
 *   the relevance floor find_food applies to every search batch (jump-1760).
 *   Covers the gate/identity/exact/close boundaries the heuristic's
 *   comments document as corpus-proven bug classes: neutral-word-only
 *   overlap, the segment-1/2 identity gate, deaccenting, plural tolerance,
 *   and comma-free ALL-CAPS Branded description behavior. Also covers
 *   round-3 (jump-1778 P5): passesDerivedProductGuard() and
 *   passesDishGuard() — see those describe blocks near the end of this file.
 * Dependencies: node:test, node:assert/strict, ../src/relevance.ts
 * State: Stateless — pure function tests, no fixtures/network.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  rateMatchQuality,
  normalizeWords,
  getSignificantWords,
  wordInSet,
  isNeutralQueryWord,
  STOP_WORDS,
  passesHeadInGate,
  passesCategoricalGuards,
  VEGAN_FAMILY_MARKERS,
  ANIMAL_BASE_TERMS,
  CANDIED_FAMILY_MARKERS,
  CANDIED_CONTRADICTION_TERMS,
  passesDerivedProductGuard,
  passesDishGuard,
  DERIVED_PRODUCT_HEADS,
  DISH_HEAD_NOUNS,
  BABYFOOD_MARKERS,
  COMPOSITE_DISH_MARKERS,
} from "../src/relevance.js";

describe("normalizeWords()", () => {
  test("lowercases, strips punctuation, splits on whitespace, drops single-char tokens", () => {
    assert.deepEqual(normalizeWords("Flour, Wheat, All-Purpose!"), ["flour", "wheat", "all", "purpose"]);
  });

  test("deaccents BEFORE the ascii filter — gruyère/jalapeño stay one word, not split on a dropped diacritic", () => {
    assert.deepEqual(normalizeWords("Gruyère"), ["gruyere"]);
    assert.deepEqual(normalizeWords("jalapeño"), ["jalapeno"]);
  });

  test("null/undefined/empty input yields an empty array", () => {
    assert.deepEqual(normalizeWords(undefined), []);
    assert.deepEqual(normalizeWords(null), []);
    assert.deepEqual(normalizeWords(""), []);
  });
});

describe("getSignificantWords() / STOP_WORDS", () => {
  test("filters stop words (articles, prepositions, generic food qualifiers)", () => {
    assert.deepEqual(getSignificantWords(["a", "raw", "chicken", "breast"]), ["chicken", "breast"]);
    assert.ok(STOP_WORDS.has("food"));
    assert.ok(STOP_WORDS.has("product"));
  });
});

describe("wordInSet() — plural-tolerant set membership", () => {
  test("exact match", () => {
    assert.ok(wordInSet("cheese", new Set(["cheese"])));
  });

  test("query word plural (+s), set holds the singular", () => {
    assert.ok(wordInSet("tortillas", new Set(["tortilla"])));
  });

  test("query word plural (+es), set holds the singular", () => {
    assert.ok(wordInSet("boxes", new Set(["box"])));
  });

  test("query word singular, set holds the plural (+s)", () => {
    assert.ok(wordInSet("bagel", new Set(["bagels"])), "'bagel' must match a set containing 'bagels'");
  });

  test("query word singular, set holds the plural (+es)", () => {
    assert.ok(wordInSet("box", new Set(["boxes"])));
  });

  test("non-match returns false", () => {
    assert.ok(!wordInSet("cheese", new Set(["milk"])));
  });

  test("jump-1760 F1 guard: a 2-char resulting STEM does not qualify — 'mrs' does not strip to match a set containing 'mr'", () => {
    assert.ok(!wordInSet("mrs", new Set(["mr"])), "the honorific false-match this guard exists to kill");
  });

  test("jump-1760 F1 guard: a 2-char BASE word does not qualify for the additive (+s) direction either", () => {
    assert.ok(!wordInSet("mr", new Set(["mrs"])));
  });

  test("jump-1760 F1 guard boundary: a 3-char resulting stem still qualifies ('peas' -> 'pea')", () => {
    assert.ok(wordInSet("peas", new Set(["pea"])), "real food plurals at the 3-char boundary must still match");
  });

  test("jump-1760 F1 guard boundary: a 3-char base word still qualifies for the additive direction ('pea' + 's')", () => {
    assert.ok(wordInSet("pea", new Set(["peas"])));
  });
});

describe("isNeutralQueryWord() / NEUTRAL_QUERY_WORDS", () => {
  test("form/shape/category words are neutral", () => {
    assert.ok(isNeutralQueryWord("powder"));
    assert.ok(isNeutralQueryWord("broth"));
    assert.ok(isNeutralQueryWord("cheese"));
  });

  test("plural-tolerant: a word whose base form is listed but plural form isn't still resolves neutral", () => {
    // 'broth'/'extract' are listed singular-only — the plural must still
    // resolve via NEUTRAL_QUERY_WORDS.has(word.slice(0,-1)).
    assert.ok(isNeutralQueryWord("broths"));
    assert.ok(isNeutralQueryWord("extracts"));
  });

  test("food-as-such words are deliberately NOT neutral", () => {
    for (const w of ["salt", "sugar", "oil", "flour", "rice", "pepper", "wine", "juice", "butter", "cream"]) {
      assert.ok(!isNeutralQueryWord(w), `'${w}' must not be neutral`);
    }
  });
});

describe("rateMatchQuality() — EXACT", () => {
  test("all significant query words present (plural-tolerant), word order irrelevant", () => {
    assert.equal(rateMatchQuality("cheddar cheese", "Cheese, cheddar"), "exact");
    assert.equal(rateMatchQuality("flour tortillas", "Tortilla, wheat flour"), "exact");
  });

  test("deaccented query/description still match exactly (gruyère/jalapeño)", () => {
    assert.equal(rateMatchQuality("gruyère cheese", "Cheese, gruyere"), "exact");
    assert.equal(rateMatchQuality("jalapeño peppers", "Peppers, jalapeno, raw"), "exact");
  });

  test("comma-free ALL-CAPS Branded description: normalizeWords lowercases, one giant segment", () => {
    // Documented, not accidental (jump-1760 spec CONTEXT): a comma-free
    // Branded description has no segment split, so the gate, identity, and
    // exact-match checks all evaluate against the same single word set —
    // which makes 'close'/'exact' easier to reach than a comma-headed FDC
    // taxonomy description. This is the mechanism the Branded-rescue path
    // relies on ("OLD BAY SEASONING" resolving for "old bay seasoning").
    assert.equal(rateMatchQuality("old bay seasoning", "OLD BAY SEASONING"), "exact");
  });
});

describe("rateMatchQuality() — CLOSE", () => {
  test("modifier-first query names: right food family, wrong form/prep", () => {
    // 'fresh' is the modifier, 'ginger' is the identity word — the gate and
    // identity checks pass on 'ginger', but 'fresh' never appears.
    assert.equal(rateMatchQuality("fresh ginger", "Ginger root, raw"), "close");
  });

  test("segment-2 variety match without full modifier coverage", () => {
    assert.equal(rateMatchQuality("everything bagel seasoning", "Bagels, egg"), "close");
  });
});

describe("rateMatchQuality() — MISS: neutral-word-only overlap (P1e)", () => {
  test("'beef broth' vs an unrelated broth misses — 'broth' alone can't establish identity", () => {
    assert.equal(rateMatchQuality("beef broth", "Fish broth, cubed"), "miss");
  });

  test("'garlic powder' vs an unrelated powder misses — 'powder' alone can't establish identity", () => {
    assert.equal(rateMatchQuality("garlic powder", "Baobab powder"), "miss");
  });

  test("a query of ONLY neutral words is degenerate — neutrality doesn't force a miss when it's all there is", () => {
    // 'milk' alone: significant=['milk'], neutral, but nonNeutral is empty
    // so the identity gate is skipped entirely (not vacuously failed).
    assert.notEqual(rateMatchQuality("milk", "Milk, whole, 3.25% milkfat"), "miss");
  });
});

describe("rateMatchQuality() — MISS: segment-1/2 identity gate", () => {
  test("query word only in a trailing segment (modifier noise on the wrong food) misses", () => {
    assert.equal(rateMatchQuality("diced ham", "Tomatoes, canned, diced"), "miss");
  });

  test("completely unrelated foods miss (the 'old bay seasoning' -> SCALLOPS baseline failure)", () => {
    assert.equal(rateMatchQuality("old bay seasoning", "Scallops, raw"), "miss");
  });

  test("'mrs dash' vs an unrelated candy bar misses (the 'Mrs. Dash' -> MR. GOODBAR baseline failure)", () => {
    assert.equal(rateMatchQuality("mrs dash", "Candy bar, milk chocolate"), "miss");
  });
});

describe("rateMatchQuality() — MISS: jump-1760 F1 honorific false-match guard", () => {
  test("'mrs dash seasoning' vs 'Candies, MR. GOODBAR Chocolate Bar' rates MISS (the exact motivating confident-wrong case — before the F1 guard, 'mrs' stripped to 'mr' and matched the description's segment-2 'mr' token, rating this CLOSE)", () => {
    assert.equal(rateMatchQuality("mrs dash seasoning", "Candies, MR. GOODBAR Chocolate Bar"), "miss");
  });

  test("real food plurals are unaffected by the guard — 'peas' vs 'Peas, green, raw' still rates exact/close as before", () => {
    assert.notEqual(rateMatchQuality("peas", "Peas, green, raw"), "miss");
  });

  test("real food plurals still tolerate a singular/plural mismatch at the 3-char stem boundary ('pea' <-> 'peas')", () => {
    assert.equal(rateMatchQuality("green pea", "Peas, green, raw"), "exact");
  });
});

describe("rateMatchQuality() — MISS: no description", () => {
  test("undefined/empty description is always a miss", () => {
    assert.equal(rateMatchQuality("anything", undefined), "miss");
    assert.equal(rateMatchQuality("anything", ""), "miss");
  });
});

// ─── jump-1773 round-2 Rule-1: passesHeadInGate() ──────────────────────────
//
// CoS REVISION (jump-1773, see eval/round2-delta.md): head = the LAST
// non-neutral token only, gated to description segment 1/2. The wiki's
// two-token formulation (also requiring the FIRST significant token) was
// falsified by the corpus replay: 7 positive rows ("fresh kale", "dried
// sage", "low sodium chicken broth", "french lentils", ...) carry a genuine
// prep/freshness/variety modifier first, which the CORRECT description
// never contains — and no rule over the two authorized vocabularies can
// separate those from the distinguisher-first compounds the first-token
// check aimed at ("old bay" vs "fresh kale" are structurally identical).
// The last-token gate keeps the gluten-free-flour-class catches at zero
// positive cost; compound-name catches (old bay, chipotle-in-adobo,
// everything-bagel) are ROUND-3 BACKLOG — they need a modifier vocabulary
// or negative pins, and their tests below document the accepted pass-through.
describe("passesHeadInGate() — Rule-1: intended catches (last-non-neutral head in segment 1/2)", () => {
  test("EXACT-rated highest-confidence error: 'gluten free flour' vs gluten-free pasta rejects — 'flour' (the head) is buried in segment 3, not segment 1/2", () => {
    assert.equal(
      passesHeadInGate("gluten free flour", "Pasta, gluten-free, corn and rice flour, cooked"),
      false
    );
    assert.equal(
      passesHeadInGate("gluten-free flour", "Pasta, gluten-free, corn and rice flour, cooked"),
      false
    );
  });

  test("'X in Y' prep phrase with an unrelated landing still rejects: 'chipotle chiles in adobo' vs a sriracha description — 'adobo' (the head) is nowhere in segment 1/2", () => {
    assert.equal(passesHeadInGate("chipotle chiles in adobo", "Sauce, hot chile, sriracha"), false);
  });

  test("modifier-first positives PASS (the class that falsified the two-token head): 'fresh kale' vs 'Kale, raw' and 'low sodium chicken broth' vs its correct low-sodium landing", () => {
    assert.equal(passesHeadInGate("fresh kale", "Kale, raw"), true);
    assert.equal(passesHeadInGate("low sodium chicken broth", "Soup, chicken broth, low sodium, canned"), true);
  });

  test("a genuinely well-covered head passes: 'old bay seasoning' vs a comma-free ALL-CAPS Branded description", () => {
    assert.equal(passesHeadInGate("old bay seasoning", "OLD BAY SEASONING"), true);
  });
});

describe("passesHeadInGate() — Rule-1: ROUND-3 BACKLOG (compound-name classes the last-token head cannot catch, DOCUMENTED)", () => {
  test("'old bay seasoning' vs bay scallops PASSES the gate ('bay' covers the head) — compound-name catch deferred to round 3 (modifier vocabulary or negative pin)", () => {
    assert.equal(
      passesHeadInGate("old bay seasoning", "Scallops, bay, Patagonian, frozen, wild caught"),
      true
    );
  });

  test("'chipotle peppers in adobo' vs 'Adobo, with noodles' PASSES the gate ('adobo' covers the head) — deferred to round 3", () => {
    assert.equal(passesHeadInGate("chipotle peppers in adobo", "Adobo, with noodles"), true);
  });

  test("'everything bagel seasoning' vs 'Bagels, egg' PASSES the gate (plural-tolerant 'bagel' covers) — deferred to round 3; round-1 floor still rates it", () => {
    assert.equal(passesHeadInGate("everything bagel seasoning", "Bagels, egg"), true);
  });
});

describe("passesHeadInGate() — Rule-1: accepted known gap (spring-mix class, DELIBERATE)", () => {
  test("'spring mix' vs 'Wheat, hard red spring' PASSES (does not reject) — 'mix' is neutral so both head tokens collapse to the single token 'spring', which the wrong candidate happens to cover; round-1's own floor still governs this query and round-2 does not additionally fix it here", () => {
    assert.equal(passesHeadInGate("spring mix", "Wheat, hard red spring"), true);
  });
});

describe("passesHeadInGate() — Rule-1: no-op rulings", () => {
  test("a query with no significant tokens no-ops (passes) — round-1's own degenerate-case handling already governs it", () => {
    assert.equal(passesHeadInGate("the of and", "Anything, whatever"), true);
  });

  test("a query of only neutral words no-ops (passes) — e.g. 'milk' alone", () => {
    assert.equal(passesHeadInGate("milk", "Milk, whole, 3.25% milkfat"), true);
  });

  test("no description no-ops (passes) — round-1's own miss-on-no-description already governs it", () => {
    assert.equal(passesHeadInGate("anything", undefined), true);
    assert.equal(passesHeadInGate("anything", ""), true);
  });
});

describe("passesHeadInGate() — Rule-1: modifier-first corpus HITS survive the revised head (the class that falsified the two-token formulation)", () => {
  test("'dried sage' vs 'Spices, sage, ground' — a real corpus HIT — passes on the head 'sage'", () => {
    assert.equal(passesHeadInGate("dried sage", "Spices, sage, ground"), true);
  });

  test("'french lentils' vs 'Lentils, dry' — a real corpus HIT — passes on the head 'lentils'", () => {
    assert.equal(passesHeadInGate("french lentils", "Lentils, dry"), true);
  });
});

// ─── jump-1773 round-2 Rule-2: passesCategoricalGuards() ───────────────────

describe("passesCategoricalGuards() — vegan-family guard", () => {
  test("'vegan cream cheese' vs a dairy cream cheese description rejects (segment 1/2 animal term)", () => {
    assert.equal(passesCategoricalGuards("vegan cream cheese", "Cheese, cream"), false);
  });

  test("'vegan fish sauce' vs a real fish sauce description rejects (segment 2 animal term)", () => {
    assert.equal(passesCategoricalGuards("vegan fish sauce", "Sauce, fish, ready-to-serve"), false);
  });

  test("beyond-segment-1/2 catch: an animal-base term buried in a LATER segment is still caught (full-description scan, not just the gate window)", () => {
    assert.equal(
      passesCategoricalGuards(
        "vegan butter",
        "Spread, vegan, made with palm and canola oil, contains milk solids"
      ),
      false
    );
  });

  test("hyphenated and spaced marker forms both trigger the guard ('dairy-free' and 'dairy free' both tokenize to the same marker)", () => {
    assert.equal(passesCategoricalGuards("dairy-free cream cheese", "Cheese, cream"), false);
    assert.equal(passesCategoricalGuards("dairy free cream cheese", "Cheese, cream"), false);
  });

  test("'plant-based' and 'plant based' both trigger the guard", () => {
    assert.equal(passesCategoricalGuards("plant-based butter", "Butter, salted"), false);
    assert.equal(passesCategoricalGuards("plant based butter", "Butter, salted"), false);
  });

  test("'meatless' triggers the guard", () => {
    assert.equal(passesCategoricalGuards("meatless bacon", "Bacon, pork, cured, raw"), false);
  });

  test("a vegan-marker query against a description with NO animal-base term passes (a real vegan-labeled FDC entry that doesn't reuse the dairy noun in its own name)", () => {
    assert.equal(passesCategoricalGuards("vegan cream cheese", "Spread, cashew, dairy-free"), true);
  });

  test("no vegan marker in the query: an animal-term description passes through untouched (guard doesn't fire)", () => {
    assert.equal(passesCategoricalGuards("cream cheese", "Cheese, cream"), true);
  });

  test("SELF-DECLARATION exemption (Codex code-review catch): a description that itself says vegan/plant-based is NOT a dairy contradiction even when it reuses the animal noun — 'VEGAN CREAM CHEESE' must not be refused", () => {
    assert.equal(passesCategoricalGuards("vegan cream cheese", "VEGAN CREAM CHEESE"), true);
    assert.equal(passesCategoricalGuards("plant based chicken", "PLANT BASED CHICKEN"), true);
    assert.equal(passesCategoricalGuards("dairy free milk", "DAIRY FREE MILK"), true);
  });
});

describe("passesCategoricalGuards() — candied-family guard", () => {
  test("'candied ginger' vs 'Ginger root, raw' rejects (the motivating corpus case)", () => {
    assert.equal(passesCategoricalGuards("candied ginger", "Ginger root, raw"), false);
  });

  test("'crystallized ginger' vs a fresh-ginger description rejects", () => {
    assert.equal(passesCategoricalGuards("crystallized ginger", "Ginger root, fresh"), false);
  });

  test("a candied-marker query against a genuinely candied description passes", () => {
    assert.equal(passesCategoricalGuards("candied ginger", "Ginger, candied"), true);
  });

  test("SELF-DECLARATION exemption (Codex code-review catch): a candied description mentioning 'fresh' as provenance is NOT a plain-form contradiction — 'Candied ginger, made from fresh ginger' must not be refused", () => {
    assert.equal(passesCategoricalGuards("candied ginger", "Candied ginger, made from fresh ginger"), true);
  });

  test("no candied marker in the query: a raw/fresh description passes through untouched (guard doesn't fire)", () => {
    assert.equal(passesCategoricalGuards("ginger", "Ginger root, raw"), true);
  });
});

describe("passesCategoricalGuards() — no-op / safety", () => {
  test("no description no-ops (passes)", () => {
    assert.equal(passesCategoricalGuards("vegan cheese", undefined), true);
  });

  test("both concepts are independent — a query carrying both markers passes when the description contradicts neither", () => {
    assert.equal(passesCategoricalGuards("vegan candied ginger", "Ginger, candied"), true);
    assert.equal(passesCategoricalGuards("candied vegan walnuts", "Walnuts, candied, glazed"), true);
  });
});

describe("Rule-2 vocabularies — deliberate asymmetry documentation", () => {
  test("'milk'/'butter'/'cheese' are QUERY-side neutral (isNeutralQueryWord) but DESCRIPTION-side ANIMAL_BASE_TERMS — different lists, different purposes", () => {
    assert.ok(isNeutralQueryWord("milk"));
    assert.ok(ANIMAL_BASE_TERMS.has("milk"));
    assert.ok(isNeutralQueryWord("cheese"));
    assert.ok(ANIMAL_BASE_TERMS.has("cheese"));
  });

  test("marker vocabularies are exported as token-sequence arrays, not strings", () => {
    assert.ok(VEGAN_FAMILY_MARKERS.some((m) => m.join(" ") === "dairy free"));
    assert.ok(CANDIED_FAMILY_MARKERS.some((m) => m.join(" ") === "crystallized"));
    assert.ok(CANDIED_CONTRADICTION_TERMS.has("fresh"));
  });
});

// ─── jump-1778 P5 round-3: passesDerivedProductGuard() ─────────────────────
// Engineering eval of find_food over 585 real household-dictionary foods
// found the round-1/Rule-1/Rule-2 floor still passing a food's own
// manufactured derivative (oil/flour/juice/vinegar/...) for a query naming
// the base food itself. All corpus query/description pairs below are the
// REAL find_food picks from that eval (guard-error-corpus.json
// "derived_product") and the REAL find_food picks that already agreed with
// the dictionary (a cache-replay of the unmodified pre-guard pipeline
// against the same committed household-dictionary-foods-v3 fixture — see
// jump-1778 P5's dispatch report for the exact extraction method; the
// eng-report-baseline.json summary this replay reproduces only itemizes
// non-hit rows, so the hit rows were regenerated via computeCaseRecords()
// against the identical fixture+cache rather than hand-picked).

describe("passesDerivedProductGuard() — corpus TARGET catches (real derived_product errors, jump-1778 P5)", () => {
  const DERIVED_PRODUCT_ERROR_ROWS: Array<{ query: string; description: string }> = [
    { query: "corn", description: "Oil, corn" },
    { query: "almonds", description: "Almond butter" },
    { query: "cod fillets", description: "Fish oil, cod liver" },
    { query: "oats", description: "Oil, oat" },
    { query: "Yukon potatoes", description: "Flour, potato" },
    { query: "coconut", description: "Flour, coconut" },
    { query: "peanut sauce", description: "Oil, peanut" },
    { query: "orange", description: "Marmalade, orange" },
    { query: "nutmeg", description: "Oil, nutmeg butter" },
    { query: "salmon", description: "Fish oil, salmon" },
    { query: "lemon", description: "Lemon juice from concentrate, bottled, REAL LEMON" },
    { query: "shredded coconut", description: "Flour, coconut" },
    { query: "kalamata olives", description: "Oil, olive, extra light" },
    { query: "pomegranate", description: "Juice, pomegranate, from concentrate, shelf-stable" },
    { query: "apple cider", description: "Vinegar, cider" },
    { query: "dry mustard", description: "Oil, mustard" },
    { query: "salmon fillets", description: "Fish oil, salmon" },
    { query: "red wine", description: "Vinegar, red wine" },
    { query: "barley", description: "Flour, barley" },
    { query: "quinoa", description: "Flour, quinoa" },
    { query: "white rice", description: "Flour, rice, white, unenriched" },
    { query: "brown rice", description: "Flour, rice, brown" },
    { query: "peanuts", description: "Oil, peanut" },
  ];

  test(`rejects all ${DERIVED_PRODUCT_ERROR_ROWS.length} real derived_product corpus rows (>= 15 required)`, () => {
    assert.ok(DERIVED_PRODUCT_ERROR_ROWS.length >= 15);
    for (const { query, description } of DERIVED_PRODUCT_ERROR_ROWS) {
      assert.equal(
        passesDerivedProductGuard(query, description),
        false,
        `expected REJECT for query=${JSON.stringify(query)} desc=${JSON.stringify(description)}`
      );
    }
  });

  // NOT caught (documented, not a bug): "Beans, liquid from stewed kidney
  // beans" for query "kidney beans" — segment-1 is "Beans", which names no
  // DERIVED_PRODUCT_HEADS category; this shape (a "liquid from stewed X"
  // trailing modifier) is a different pattern than the oil/flour/juice/...
  // category-head class this guard targets.
});

describe("passesDerivedProductGuard() — SELF-DECLARATION exemption (mandatory)", () => {
  test("same-word self-declaration — the query naming the exact derivative term always passes", () => {
    assert.equal(passesDerivedProductGuard("olive oil", "Oil, olive"), true);
    assert.equal(passesDerivedProductGuard("coconut flour", "Flour, coconut"), true);
    assert.equal(passesDerivedProductGuard("orange juice", "Juice, orange"), true);
    assert.equal(passesDerivedProductGuard("butter", "Butter, stick, salted"), true);
    assert.equal(passesDerivedProductGuard("vinegar", "Vinegar, distilled"), true);
  });

  test("FAMILY-level self-declaration (deliberate broadening, corpus-verified zero-cost): the query need not use the SAME derivative word the description carries, only ANY DERIVED_PRODUCT_HEADS word — 'arrowroot starch' vs FDC's 'Arrowroot flour' is a real household-dictionary HIT", () => {
    assert.equal(passesDerivedProductGuard("arrowroot starch", "Arrowroot flour"), true);
  });

  test("family-level self-declaration also covers a MISMATCHED pair — a query asking for 'flour' still self-declares against an 'Oil' pick (any DERIVED_PRODUCT_HEADS word suffices, not just the one the description happens to carry)", () => {
    assert.equal(passesDerivedProductGuard("some flour product", "Oil, canola"), true);
  });
});

describe("passesDerivedProductGuard() — no-op / independence / safety", () => {
  test("plain, unrelated foods pass (segment-1 names no derived-product category)", () => {
    assert.equal(passesDerivedProductGuard("salmon", "Salmon, raw"), true);
    assert.equal(passesDerivedProductGuard("ground beef", "Beef, ground, raw"), true);
  });

  test("no description no-ops (passes)", () => {
    assert.equal(passesDerivedProductGuard("salmon", undefined), true);
    assert.equal(passesDerivedProductGuard("salmon", null), true);
    assert.equal(passesDerivedProductGuard("salmon", ""), true);
  });

  test("a prepared_dish-only row (no derived-product head in segment 1) is NOT rejected by this guard — independence from passesDishGuard", () => {
    assert.equal(passesDerivedProductGuard("turkey", "Bologna, turkey"), true);
  });

  test("DERIVED_PRODUCT_HEADS carries both singular and plural forms", () => {
    assert.ok(DERIVED_PRODUCT_HEADS.has("oil"));
    assert.ok(DERIVED_PRODUCT_HEADS.has("oils"));
    assert.ok(DERIVED_PRODUCT_HEADS.has("jelly"));
    assert.ok(DERIVED_PRODUCT_HEADS.has("jellies"));
  });
});

// ─── jump-1778 P5 round-3: passesDishGuard() ────────────────────────────────
// 47/585 cases (the LARGEST single error class in the eval) were a prepared
// dish, composite, or babyfood/toddler product returned for a plain
// base-ingredient query. Corpus rows below are the REAL find_food picks from
// that eval (guard-error-corpus.json "prepared_dish").

describe("passesDishGuard() — corpus TARGET catches (real prepared_dish errors, jump-1778 P5)", () => {
  const PREPARED_DISH_ERROR_ROWS: Array<{ query: string; description: string }> = [
    { query: "apple", description: "Croissants, apple" },
    { query: "macaroni", description: "Babyfood, macaroni and cheese, toddler" },
    { query: "tamarind puree", description: "Candies, Tamarind" },
    { query: "sweet potato puree", description: "Sweet potato tots" },
    { query: "canned corn", description: "Succotash, (corn and limas), canned, with cream style corn" },
    { query: "granola", description: "Cookie, granola" },
    { query: "turkey", description: "Bologna, turkey" },
    { query: "wine", description: "Wine spritzer" },
    { query: "mixed berries", description: "Babyfood, banana with mixed berries, strained" },
    { query: "chocolate buttercream", description: "CHOCOLATE WITH CHOCOLATE BUTTERCREAM CAKE, CHOCOLATE BUTTERCREAM" },
    { query: "cooked chicken", description: "Bratwurst, chicken, cooked" },
    { query: "green apple", description: "Croissants, apple" },
    { query: "peaches", description: "Pie, peach" },
    { query: "frozen corn", description: "Corn dogs, frozen, prepared" },
    { query: "shrimp", description: "Shrimp cocktail" },
    { query: "hamburger buns", description: "Hamburger, on white bun, 1 small patty" },
    { query: "chocolate chips", description: "Cookies, chocolate chip, dry mix" },
    { query: "port wine", description: "Wine spritzer" },
    { query: "sweet potatoes", description: "Sweet potato tots" },
    { query: "buttercream frosting", description: "Cake, cherry fudge with chocolate frosting" },
    { query: "mint", description: "Candy, mint" },
    { query: "black olives", description: "Olive loaf, pork" },
    { query: "whole wheat hamburger buns", description: "Hamburger, on wheat bun, 1 large patty" },
    { query: "Mexican-style corn", description: "Succotash, (corn and limas), canned, with cream style corn" },
  ];

  test(`rejects all ${PREPARED_DISH_ERROR_ROWS.length} real prepared_dish corpus rows (>= 20 required)`, () => {
    assert.ok(PREPARED_DISH_ERROR_ROWS.length >= 20);
    for (const { query, description } of PREPARED_DISH_ERROR_ROWS) {
      assert.equal(
        passesDishGuard(query, description),
        false,
        `expected REJECT for query=${JSON.stringify(query)} desc=${JSON.stringify(description)}`
      );
    }
  });

  // NOT caught (documented, not a bug — spec instructs conservatism): bare
  // modifier+food compounds with no explicit marker word, e.g. "steak" ->
  // "Pepper steak" or "rice" -> "Dirty rice". No marker vocabulary
  // distinguishes those from a legitimate "Grilled chicken"/"Basmati rice"
  // without a dish-name gazetteer; round-4 backlog.
});

describe("passesDishGuard() — SELF-DECLARATION exemption (mandatory)", () => {
  test("dish head-noun: a query naming the same dish word always passes", () => {
    assert.equal(passesDishGuard("shrimp cocktail", "Shrimp cocktail"), true);
    assert.equal(passesDishGuard("bologna", "Bologna, turkey"), true);
    assert.equal(passesDishGuard("cake", "Cake, yellow, commercially prepared, with icing or filling"), true);
  });

  test("babyfood/toddler/junior/strained/stage: a query naming the same marker passes", () => {
    assert.equal(passesDishGuard("strained peas babyfood", "Babyfood, peas, strained"), true);
    assert.equal(passesDishGuard("toddler mixed vegetables", "Babyfood, vegetables, toddler"), true);
  });

  test("composite 'on ... bun': a query naming both 'on' and 'bun' passes", () => {
    assert.equal(passesDishGuard("hot dog on a bun", "Hamburger, on white bun, 1 small patty"), true);
  });

  test("no dish/babyfood/composite marker anywhere: an unrelated description passes through untouched (guard doesn't fire)", () => {
    assert.equal(passesDishGuard("chicken breast", "Chicken, broiler or fryers, breast, skinless, boneless, raw"), true);
  });
});

describe("passesDishGuard() — segment-1 length cap (MAX_CATEGORY_SEGMENT_WORDS)", () => {
  test("a long, comma-free free-text segment-1 that merely CONTAINS a dish word as its first token is NOT treated as a self-declared category (the exact adversarial-fixture regression this cap fixes: 'chang's pad thai dried rice sticks' vs a Survey/FNDDS sentence beginning with 'Cake')", () => {
    assert.equal(
      passesDishGuard("chang's pad thai dried rice stick", "Cake made with glutinous rice and dried beans"),
      true
    );
  });

  test("a genuinely short dish category label still rejects even at 5 words (the corpus's own 'chocolate buttercream' catch, unaffected by the cap)", () => {
    assert.equal(
      passesDishGuard("chocolate buttercream", "CHOCOLATE WITH CHOCOLATE BUTTERCREAM CAKE, CHOCOLATE BUTTERCREAM"),
      false
    );
  });
});

describe("passesDishGuard() — no-op / independence / safety", () => {
  test("plain, unrelated foods pass (no dish/babyfood/composite marker in the description)", () => {
    assert.equal(passesDishGuard("salmon", "Salmon, raw"), true);
    assert.equal(passesDishGuard("ground beef", "Beef, ground, raw"), true);
  });

  test("no description no-ops (passes)", () => {
    assert.equal(passesDishGuard("turkey", undefined), true);
    assert.equal(passesDishGuard("turkey", null), true);
    assert.equal(passesDishGuard("turkey", ""), true);
  });

  test("a derived-product-only row (no dish/babyfood/composite marker) is NOT rejected by this guard — independence from passesDerivedProductGuard", () => {
    assert.equal(passesDishGuard("salmon", "Fish oil, salmon"), true);
  });

  test("marker vocabularies are exported with the documented shapes", () => {
    assert.ok(DISH_HEAD_NOUNS.has("candy"));
    assert.ok(DISH_HEAD_NOUNS.has("candies"));
    assert.ok(BABYFOOD_MARKERS.has("babyfood"));
    assert.ok(BABYFOOD_MARKERS.has("stage"));
    assert.ok(COMPOSITE_DISH_MARKERS.some((m) => m.join(" ") === "on bun"));
    assert.ok(COMPOSITE_DISH_MARKERS.some((m) => m.join(" ") === "corn dog"));
  });
});

describe("round-3 guards — INDEPENDENCE (a derived-product row need not trip the dish guard and vice-versa)", () => {
  test("'salmon' -> 'Fish oil, salmon' trips ONLY the derived-product guard", () => {
    assert.equal(passesDerivedProductGuard("salmon", "Fish oil, salmon"), false);
    assert.equal(passesDishGuard("salmon", "Fish oil, salmon"), true);
  });

  test("'turkey' -> 'Bologna, turkey' trips ONLY the dish guard", () => {
    assert.equal(passesDerivedProductGuard("turkey", "Bologna, turkey"), true);
    assert.equal(passesDishGuard("turkey", "Bologna, turkey"), false);
  });

  test("a plain food with neither marker passes both guards", () => {
    assert.equal(passesDerivedProductGuard("salmon", "Salmon, raw"), true);
    assert.equal(passesDishGuard("salmon", "Salmon, raw"), true);
    assert.equal(passesDerivedProductGuard("ground beef", "Beef, ground, raw"), true);
    assert.equal(passesDishGuard("ground beef", "Beef, ground, raw"), true);
  });
});

// ─── jump-1778 P5 round-3: REGRESSION SAFETY — real HIT descriptions ───────
// Every pair below is a REAL find_food pick that already agreed with the
// recipe-app dictionary candidate (a "hit" in eval terminology) before this
// round-3 change — reconstructed via a cache replay of the unmodified
// pre-guard pipeline (computeCaseRecords(), eval/scripts/
// dictionary-foods-engineering-report.ts) against the exact committed
// household-dictionary-foods-v3 fixture + cache the jump-1778 eval used.
// eng-report-baseline.json's own summary.buckets.hit count (334) matches
// this replay's hit count exactly, confirming the same underlying corpus.
// Every one of these MUST still pass BOTH new guards — a false reject here
// would turn a currently-correct answer into an honest-refusal regression.
describe("round-3 guards — REGRESSION SAFETY (real HIT descriptions, jump-1778 P5 baseline replay)", () => {
  const REAL_HIT_ROWS: Array<{ query: string; description: string }> = [
    { query: "Black Forest Ham", description: "Lunchmeat, ham, black forest, sliced" },
    { query: "Brussels sprouts", description: "Brussels sprouts, raw" },
    { query: "Caesar dressing", description: "Salad dressing, caesar dressing, regular" },
    { query: "Canadian bacon", description: "Canadian bacon, unprepared" },
    { query: "Cotija cheese", description: "Cheese, cotija, solid" },
    { query: "Dijon mustard", description: "Mustard, prepared, yellow" },
    { query: "English muffins", description: "Muffins, English, wheat" },
    { query: "Italian sausage", description: "Sausage, Italian, pork, mild, cooked, pan-fried" },
    { query: "Italian turkey sausage", description: "Sausage, Italian, turkey, smoked" },
    { query: "Merlot wine", description: "Alcoholic Beverage, wine, table, red, Merlot" },
    { query: "Mexican blend cheese", description: "Cheese, Mexican blend" },
    { query: "Napa cabbage", description: "Cabbage, napa, leaf, destemmed, raw" },
    { query: "Parmesan cheese", description: "Cheese, parmesan, grated" },
    { query: "Pecorino Romano", description: "Cheese, romano" },
    { query: "Swiss cheese", description: "Cheese, swiss" },
    { query: "Worcestershire sauce", description: "Sauce, worcestershire" },
    { query: "acorn squash", description: "Squash, winter, acorn, raw" },
    { query: "active dry yeast", description: "Leavening agents, yeast, baker's, active dry" },
    // Derivative-family self-declared HITs (exercise the derived-product
    // guard's self-declaration path against real data, including the
    // family-broadened 'arrowroot starch' case):
    { query: "all-purpose flour", description: "Flour, wheat, all-purpose, enriched, bleached" },
    { query: "almond butter", description: "Almond butter, creamy" },
    { query: "arrowroot starch", description: "Arrowroot flour" },
    { query: "coconut oil", description: "Oil, coconut" },
    { query: "lemon juice", description: "Lemon juice, raw" },
    { query: "oat flour", description: "Flour, oat, whole grain" },
    { query: "olive oil", description: "Oil, olive, extra light" },
    { query: "peanut butter", description: "Peanut butter, creamy" },
    { query: "sesame oil", description: "Oil, sesame, salad or cooking" },
    { query: "unsalted butter", description: "Butter, stick, unsalted" },
    { query: "vanilla extract", description: "Vanilla extract" },
  ];

  test(`all ${REAL_HIT_ROWS.length} real HIT rows pass BOTH round-3 guards (>= 20 required)`, () => {
    assert.ok(REAL_HIT_ROWS.length >= 20, "regression set must cover at least 20 real HIT descriptions");
    for (const { query, description } of REAL_HIT_ROWS) {
      assert.equal(
        passesDerivedProductGuard(query, description),
        true,
        `derived-product guard falsely rejected a real HIT: query=${JSON.stringify(query)} desc=${JSON.stringify(description)}`
      );
      assert.equal(
        passesDishGuard(query, description),
        true,
        `dish guard falsely rejected a real HIT: query=${JSON.stringify(query)} desc=${JSON.stringify(description)}`
      );
    }
  });

  // KNOWN ACCEPTED GAPS (documented in src/relevance.ts's own guard
  // comments, deliberately EXCLUDED from the must-pass set above — asserting
  // pass===true on these would be false): 'balsamic glaze' -> "Vinegar,
  // balsamic", 'cooking spray' -> "Oil, PAM cooking spray, original"
  // (derived-product guard); 'brownie mix' -> "Cookies, brownies, dry mix,
  // regular", 'sprinkles' -> "Candy, sprinkles", 'mini marshmallows' ->
  // "Candies, marshmallows", 'miniature peanut butter cups' -> "Candies,
  // REESE'S Peanut Butter Cups", 'semi-sweet chocolate' -> "Candies, sweet
  // chocolate" (dish guard). All 7 are real household-dictionary HITs this
  // round-3 floor would newly reject — see the guard functions' own
  // "KNOWN ACCEPTED GAP" comments for why no vocabulary-level fix separates
  // them from the real error rows without reopening a hole.
});
