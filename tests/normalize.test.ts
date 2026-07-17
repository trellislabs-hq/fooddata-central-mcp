/**
 * Module: normalize.test.ts
 * Purpose: Unit tests for src/normalize.ts — the normalization cascade,
 *   SAFE_PREP_WORDS stripping, and the food-identity alias table.
 * Dependencies: node:test, node:assert, ../src/normalize.ts
 * State: All inputs are synthetic (labeled) unless noted otherwise.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalize, dictionaryLookup, buildCandidateQueries, FOOD_ALIASES, SAFE_PREP_WORDS } from "../src/normalize.js";

describe("normalize()", () => {
  test("lowercases and trims (synthetic)", () => {
    assert.equal(normalize("  Cheddar Cheese  "), "cheddar cheese");
  });

  test("collapses internal whitespace (synthetic)", () => {
    assert.equal(normalize("cheddar    cheese"), "cheddar cheese");
  });

  test("normalizes hyphens to spaces (synthetic)", () => {
    // Trailing plural-s strip only applies after a true consonant class
    // ([bcdfghjklmnpqrtvwxyz]); "tomatoes" ends in "oes" so it is untouched.
    assert.equal(normalize("fire-roasted tomatoes"), "fire roasted tomatoes");
  });

  test("strips basic trailing plural after a consonant (synthetic)", () => {
    assert.equal(normalize("carrots"), "carrot");
    assert.equal(normalize("mushrooms"), "mushroom");
  });

  test("does NOT strip plural after a vowel or another s (synthetic)", () => {
    // hummus / couscous already end in "us"/"ous" — the regex only strips
    // after a true consonant class, so trailing "...us" is preserved.
    assert.equal(normalize("hummus"), "hummus");
    assert.equal(normalize("couscous"), "couscous");
  });

  test("does NOT strip plural when the stem would drop below 3 chars (jump-1760 honorific guard)", () => {
    // Unguarded, "mrs." became "mr." and "Mrs. Dash seasoning" searched as
    // "mr. dash seasoning" — exact-matching "MR. GOODBAR". Same guard class
    // as relevance.ts wordInSet.
    assert.equal(normalize("Mrs. Dash seasoning"), "mrs. dash seasoning");
    // Real short plurals with 3-char stems still strip.
    assert.equal(normalize("ribs"), "rib");
  });
});

describe("dictionaryLookup() cascade (synthetic)", () => {
  const known = new Set(["mushroom", "onion", "red pepper", "chile de arbol"]);

  test("exact match", () => {
    const result = dictionaryLookup("onion", known);
    assert.deepEqual(result, { matchedKey: "onion", method: "exact" });
  });

  test("plural -es fallback", () => {
    // "potatoes" -> strip "es" -> "potato" is not in `known`; use a case that is:
    const known2 = new Set(["tomato"]);
    const result = dictionaryLookup("tomatoes", known2);
    assert.deepEqual(result, { matchedKey: "tomato", method: "plural_es" });
  });

  test("plural -s fallback", () => {
    const result = dictionaryLookup("mushrooms", known);
    assert.deepEqual(result, { matchedKey: "mushroom", method: "plural_s" });
  });

  test("plural add -s fallback (singular key known only in plural form)", () => {
    const known2 = new Set(["onions"]);
    const result = dictionaryLookup("onion", known2);
    assert.deepEqual(result, { matchedKey: "onions", method: "plural_add_s" });
  });

  test("SAFE prep-word stripping resolves to known key", () => {
    const result = dictionaryLookup("sliced mushroom", known);
    assert.deepEqual(result, { matchedKey: "mushroom", method: "prep_strip" });
  });

  test("SAFE prep-word stripping handles multiple leading prep words", () => {
    const result = dictionaryLookup("finely chopped onion", known);
    assert.deepEqual(result, { matchedKey: "onion", method: "prep_strip" });
  });

  test("NEVER-strip words are not treated as safe prep words: roasted", () => {
    // "roasted red pepper" must NOT strip to "red pepper" via the prep cascade
    // (roasted red pepper is a materially different product/food).
    // "roasted" is not in SAFE_PREP_WORDS, so the prep-strip loop breaks
    // immediately; drop-last-word then tries "roasted red" (not known either),
    // so the full cascade returns null — "roasted" is never stripped.
    const result = dictionaryLookup("roasted red pepper", known);
    assert.equal(result, null);
  });

  test("NEVER-strip words explicitly excluded from SAFE_PREP_WORDS: fresh/frozen/dried/boneless/ground", () => {
    for (const word of ["fresh", "frozen", "dried", "boneless", "skinless", "whole", "ground", "cooked", "uncooked", "raw", "canned", "toasted", "boiled"]) {
      assert.equal(SAFE_PREP_WORDS.has(word), false, `"${word}" must NOT be a safe prep word`);
    }
  });

  test("fresh + known food does not strip 'fresh' via prep cascade", () => {
    const known2 = new Set(["mozzarella"]);
    const result = dictionaryLookup("fresh mozzarella", known2);
    assert.equal(result, null, "fresh mozzarella must not resolve to mozzarella via prep-strip");
  });

  test("drop-last-word fallback", () => {
    const known2 = new Set(["red pepper"]);
    const result = dictionaryLookup("red pepper flakes", known2);
    assert.deepEqual(result, { matchedKey: "red pepper", method: "drop_last" });
  });

  test("or-split fallback", () => {
    const known2 = new Set(["butter"]);
    const result = dictionaryLookup("margarine or butter", known2);
    assert.deepEqual(result, { matchedKey: "butter", method: "or_split" });
  });

  test("returns null when nothing matches", () => {
    const result = dictionaryLookup("xyzzy nonfood", known);
    assert.equal(result, null);
  });

  test("returns null for empty key", () => {
    assert.equal(dictionaryLookup("", known), null);
  });
});

describe("FOOD_ALIASES table", () => {
  test("includes paneer -> paneer cheese", () => {
    assert.ok(FOOD_ALIASES["paneer"].includes("paneer cheese"));
  });

  test("includes dashi -> dashi powder", () => {
    assert.ok(FOOD_ALIASES["dashi"].includes("dashi powder"));
  });

  test("includes ricotta cheese -> ricotta", () => {
    assert.ok(FOOD_ALIASES["ricotta cheese"].includes("ricotta"));
  });

  test("EXCLUDES tri-tip (Kroger-shelf routing, out of scope)", () => {
    assert.equal(FOOD_ALIASES["tri-tip"], undefined);
    assert.equal(FOOD_ALIASES["tri-tip roast"], undefined);
  });

  test("EXCLUDES other shelf-routing entries", () => {
    for (const excluded of ["pork shoulder", "chuck roast", "lamb shoulder", "flank steak", "baby potatoes", "blue diamond almonds"]) {
      assert.equal(FOOD_ALIASES[excluded], undefined, `"${excluded}" must not be in the food-identity alias table`);
    }
  });
});

describe("buildCandidateQueries()", () => {
  test("normalized input is always first candidate", () => {
    const candidates = buildCandidateQueries("Cheddar Cheese");
    assert.equal(candidates[0], "cheddar cheese");
  });

  test("alias resolves via exact match on normalized input", () => {
    const candidates = buildCandidateQueries("paneer");
    assert.deepEqual(candidates, ["paneer", "paneer cheese", "indian cheese"]);
  });

  test("alias resolves via exact match for the singular alias entry", () => {
    // "enoki mushroom" is itself a FOOD_ALIASES key (exact match, no plural
    // cascade needed) — the singular and plural forms are both listed as
    // separate alias entries.
    const candidates = buildCandidateQueries("enoki mushroom");
    assert.deepEqual(candidates, ["enoki mushroom", "enoki", "mushrooms"]);
  });

  test("non-aliased food returns only the normalized term", () => {
    const candidates = buildCandidateQueries("broccoli");
    assert.deepEqual(candidates, ["broccoli"]);
  });
});
