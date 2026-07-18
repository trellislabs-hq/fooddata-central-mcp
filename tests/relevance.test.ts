/**
 * Module: relevance.test.ts
 * Purpose: Unit tests for src/relevance.ts's rateMatchQuality() heuristic —
 *   the relevance floor find_food applies to every search batch (jump-1760).
 *   Covers the gate/identity/exact/close boundaries the heuristic's
 *   comments document as corpus-proven bug classes: neutral-word-only
 *   overlap, the segment-1/2 identity gate, deaccenting, plural tolerance,
 *   and comma-free ALL-CAPS Branded description behavior.
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
