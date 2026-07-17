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

describe("rateMatchQuality() — MISS: no description", () => {
  test("undefined/empty description is always a miss", () => {
    assert.equal(rateMatchQuality("anything", undefined), "miss");
    assert.equal(rateMatchQuality("anything", ""), "miss");
  });
});
