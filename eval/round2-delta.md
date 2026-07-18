# find_food round-2 relevance floor — delta report (jump-1773)

Status: **COMPLETE — measured live 2026-07-18.** The Builder's two structural findings
(preserved below as the decision record) were resolved by CoS: finding 1 by a one-time
live recording run extending the committed cache (105 → post-round-2 coverage; replay is
deterministic again at 96/96, zero uncached); finding 2 by REVISING Rule-1 to the
last-non-neutral-head-in-gate form (the first-significant-token requirement was
falsified by the corpus — see finding 2 and the revision note in `src/relevance.ts`).

## FINAL RESULTS (live 2026-07-18, replay-reproduced bit-identical)

| Metric | Round-1 baseline | Round-2 | Delta |
|---|---|---|---|
| negative-honesty | 9.7% (3/31) | **29.0% (9/31)** | **3.0x** |
| top-1 (positives) | 10.8% (7/65) | 12.3% (8/65) | +1 hit (promotion) |
| top-4 (positives) | 26.2% (17/65) | 24.6% (16/65) | −1 (the accepted spring class) |
| latency p50 / p95 | ~390 / ~605 ms | 386 / 783 ms | flat |

Row-level: **zero baseline hits lost**; +1 near→hit promotion (`low sodium beef
broth`); exactly one near→miss (`mixed spring greens` — the design's named accepted
regression); **all 9 honest results are REFUSALS (best undefined)** — zero via Branded
rescue; negative-row Branded-rescue count 0 → 0.

Confident-wrong flips (6, by rule): `gluten free flour` + `gluten-free flour` (Rule-1
head gate — the corpus's two EXACT-rated highest-confidence errors), `whole grain
mustard` + `freeze dried strawberries` (Rule-1 head gate), `vegan cream cheese` +
`vegan fish sauce` (Rule-2 vegan-family guard).

Residual 22 confident-wrongs = the compound-name class (old bay, chipotle-in-adobo,
everything-bagel — need a modifier vocabulary or negative pins; ROUND-3 BACKLOG), the
paste/seasoning-vs-dish FORM class (curry pastes, garam masala → dish/soup landings —
the wiki's named FORM-guard mechanism, round 3), and spurious-token coincidences.
`candied ginger` note: its wrong landing ("Spices, ginger, ground") contains neither
'raw' nor 'fresh', so the simplified candied-guard does not fire — same FORM-class
backlog.

Scope cut (deliberate, per spec): gluten-free / freeze-dried / low-sodium /
no-salt-added carry-along markers NOT implemented — rejection vocabularies undefined;
the corpus's gluten-free and freeze-dried flips came from Rule-1's head gate instead.

The sections below are the Builder's original blocked-state report, preserved as the
decision record for the two findings.

## Structural finding 1 — round-2 negative fixes require new (uncached) Branded searches

**Root cause chain:**
- Symptom: replay eval goes from 96/96 scored, 0 uncached (baseline) to 56/96 scored, 40
  uncached after round-2 lands.
- Immediate cause: 17 of the 28 baseline confident-wrong negative rows, and 19 of the 48
  baseline positive-miss rows, hit `CacheMissError` during replay.
- That happens because: whenever Rule-1/Rule-2 reduce a query's preferred-type batch from
  "≥1 passing candidate" (round-1) to "0 passing candidates" (round-2), `find-food.ts`'s
  existing control flow (`if (foods.length === 0 || includeBranded)`) reacts exactly as
  designed — it proceeds to search Branded data for that query. That is correct,
  desired behavior for a real user. But the search-cache is a **frozen recording of
  round-1's decision tree**: round-1 never emptied these queries' preferred batches (that
  was precisely the bug being fixed), so it never recorded their Branded search. Replay
  mode can only serve calls that were previously recorded.
- Root cause: **achieving "honest" for any of the negative rows round-2 is designed to
  fix structurally requires visiting a code path (`searchFoods({dataType: "Branded"})`)
  that round-1's cache recording never exercised for that query.** This is not a bug in
  the round-2 implementation — it is an unavoidable consequence of the fix working as
  intended, colliding with a cache that can only replay what was already recorded.

**Evidence — of the 17 negative rows that go uncached, all 17 are legitimate Rule-1/
Rule-2 catches** (verified by direct evaluation of `passesHeadInGate`/
`passesCategoricalGuards` against each row's baseline confident-wrong candidate):

| Query | Rejected by | Baseline wrong candidate |
|---|---|---|
| old bay seasoning | Rule-1 (headFirst "old" not in gate) | Scallops, bay, Patagonian... |
| chipotle chiles in adobo | Rule-1 (headFirst "chipotle" not in gate) | Sauce, hot chile, sriracha |
| chipotle peppers in adobo | Rule-1 (headFirst "chipotle" not in gate) | Adobo, with noodles |
| gluten free flour / gluten-free flour | Rule-1 (headLast "flour" buried in segment 3) | Pasta, gluten-free, corn and rice flour, cooked |
| everything bagel seasoning | Rule-1 (headFirst "everything" not in gate) | Bagels, egg |
| freeze dried strawberries | Rule-1 (headLast "strawberries" not in gate) | Chives, freeze-dried |
| garam masala | Rule-1 (headFirst "garam" not in gate) | SMART SOUP, Indian Bean Masala |
| tandoori masala | Rule-1 (headFirst "tandoori" not in gate) | SMART SOUP, Indian Bean Masala |
| green curry paste / homemade green curry paste / red curry paste / yellow curry paste | Rule-1 (headFirst not in gate) | Beef curry |
| whole grain mustard | Rule-1 (headLast "mustard" not in gate) | Buckwheat, whole grain |
| candied ginger | Rule-2 candied guard ("raw" present) | Ginger root, raw |
| vegan cream cheese | Rule-2 vegan guard ("cheese"/"cream" present) | Cheese, cream |
| vegan fish sauce | Rule-2 vegan guard ("fish" present) | Sauce, fish, ready-to-serve |

This is 13 of the 28 confident-wrongs correctly rejected by Rule-1 and 3 by Rule-2 (16
distinct rows; some rows share a candidate) — a strong signal the rule LOGIC is correct
and matches the wiki's named target cases (old bay, both chipotle-in-adobo variants,
both gluten-free-flour variants, both vegan cases, candied ginger). The eval simply
**cannot prove they resolve to `honest` without a live/recording pass** to populate the
Branded (and in a few cases further alias-candidate) cache entries these rows now need.

**Recommendation:** CoS runs a live re-measure (or a narrower live recording limited to
the 17 newly-uncached negative queries + the newly-uncached positive queries below) to
backfill `eval/cache/search-cache.json`, then re-runs the replay to get the true
post-round-2 numbers. Per the dispatch's own CRITICAL WORKFLOW REQUIREMENT, this is
explicitly a CoS-run, post-merge step — but DONE WHEN's "96/96 scored, ZERO uncached"
bar cannot be met by the Builder without it, and no in-scope code change can avoid it
(short of not fixing the negatives at all, which defeats the point).

## Structural finding 2 — Rule-1's literal head definition breaks modifier-first HITS/NEARS

**Root cause chain:**
- Symptom: of the 7 baseline hit rows, only 3 remain hits after round-2; 2 become MISS,
  2 become uncached (see finding 1's mechanism). Of the 10 baseline near rows, 6 stay
  near, 2 become MISS, 2 become uncached.
- Immediate cause: `passesHeadInGate()`'s `headFirst` (first significant token, i.e.
  `getSignificantWords()` output with only `STOP_WORDS` removed) is a genuine prep/
  freshness modifier ("fresh", "dried", "french", "low") for several corpus queries, and
  that modifier does not appear in the correct candidate's segment 1/2 (e.g. "Kale, raw"
  never says "fresh").
- That happens because: neither `STOP_WORDS` nor `NEUTRAL_QUERY_WORDS` — the only two
  vocabularies the spec authorizes reusing — currently classify "fresh"/"dried"/"low"/
  "french" as non-identity-bearing. `getSignificantWords()` only strips articles/
  prepositions/generic food nouns; `isNeutralQueryWord()` only strips form/shape/category
  words. Prep-order modifiers are in neither set.
- Root cause: **round-1's own CLOSE tier deliberately tolerates a leading modifier not
  appearing in the description** (`rateMatchQuality`'s own CLOSE test: `"fresh ginger"`
  vs `"Ginger root, raw"` rates CLOSE, not miss — the code comment literally says "the
  right food shouldn't lose on a word the gates never needed"). Rule-1's headFirst
  requirement is structurally the opposite of that philosophy for any query whose first
  significant word is a real modifier rather than a distinguisher. `old bay seasoning`
  ("old" is a proper-noun co-identity word, not a modifier) and `fresh kale` ("fresh" is
  a modifier) are **indistinguishable using only STOP_WORDS/NEUTRAL_QUERY_WORDS** — both
  are 2-word, all-non-stopword, all-non-neutral queries. No formulation of "first
  significant token" using only the two authorized vocabularies can gate one and not the
  other.

**Evidence:**

| Query | Baseline | Round-2 | Correct candidate | Why rejected |
|---|---|---|---|---|
| fresh kale | hit | miss | Kale, raw | headFirst "fresh" not in gate |
| dried sage | hit | uncached | Spices, sage, ground | headFirst "dried" not in gate |
| low sodium chicken broth | hit | uncached | Soup, chicken broth, low sodium, canned | headFirst "low" not in gate |
| french lentils | hit | miss | Lentils, dry | headFirst "french" not in gate |
| dried parsley | near | miss | Parsley, freeze-dried | headFirst "dried" not in gate |
| mixed berries | near | miss | (alternate no longer surfaces) | headFirst "mixed" not in gate |
| low sodium beef broth | near | uncached | Soup, chicken broth, low sodium, canned | headFirst "low" not in gate |
| mixed spring greens | near | uncached | Mixed salad greens, raw | headLast "spring" not in gate (this one IS the wiki's named "single positive regression," but the OTHER 6 rows above are additional, undocumented regressions of the same class) |

Only `mixed spring greens` was named by the wiki/spec as an accepted −1 near
degradation. The other **7 rows** (2 hits→miss, 2 hits→uncached, 2 near→miss, 1
near→uncached, beyond the named one) are the same failure class but were not anticipated
in the wiki's "positive collateral check ... zero hit regressions" claim, and DONE WHEN's
"the SAME 7 hit rows remain hits, near→miss degradations ≤1 (only spring-mix permitted)"
bar is not met: only 3 of 7 hits remain hits, and there are 3 near→miss rows (`dried
parsley`, `mixed berries`, plus `mixed spring greens` counted separately once
finding 1's cache gap is resolved).

**Fix options for CoS decision** (none is a Builder-level default call):
1. Add a small, explicitly-scoped prep-modifier exception vocabulary (e.g. `fresh`,
   `dried`, `frozen`, `low`, `sodium`, `french`, `mixed`) that `headFirst` skips over —
   mirrors `normalize.ts`'s own `SAFE_PREP_WORDS` philosophy but is a genuinely NEW set,
   which the spec explicitly forbade inventing.
2. Restrict Rule-1's both-token requirement to queries with ≥3 significant words (2-word
   queries fall back to a headLast-only check) — reduces blast radius (fixes `fresh
   kale`, `dried sage`, `french lentils`) but does NOT fix `low sodium chicken/beef
   broth` (4 significant words) or `mixed spring greens`/`mixed berries`, and is itself
   an invented heuristic not in the literal spec text.
3. Accept the broader collateral (more than just spring-mix) and update DONE WHEN's
   hit-preservation bar accordingly.
4. Ship Rule-2 alone (drop Rule-1) pending a redesigned head definition — recovers 3
   Rule-2 catches (candied ginger, vegan cream cheese, vegan fish sauce) with zero
   positive-side cost, deferring the Rule-1 head redesign to a follow-up jump.

No option was selected without a CoS call — implementing 1 violates an explicit
constraint, 2 is a partial, unauthorized invention, 3/4 are scope/bar changes above
Builder authority.

## What changed (code, all committed)

- `src/relevance.ts`: added `passesHeadInGate()` (Rule-1), `passesCategoricalGuards()`
  (Rule-2), `VEGAN_FAMILY_MARKERS`, `ANIMAL_BASE_TERMS`, `CANDIED_FAMILY_MARKERS`,
  `CANDIED_CONTRADICTION_TERMS` — all exported, all pure, all reusing only
  `getSignificantWords`/`STOP_WORDS`/`isNeutralQueryWord`/`NEUTRAL_QUERY_WORDS`/
  `wordInSet`/`normalizeWords` per the spec's constraint.
- `src/find-food.ts`: `ratePassing()` now AND-layers `rateMatchQuality() !== 'miss'` AND
  `passesHeadInGate()` AND `passesCategoricalGuards()` — the single function both the
  preferred-type batch loop and the Branded batch loop call, so both flow through the
  identical combined floor (per spec constraint).
- No changes to `eval/fixtures/household-food-eval-v1.json`, `eval/cache/
  search-cache.json`, or `src/normalize.ts` (all frozen per constraints).

## Test coverage

- `tests/relevance.test.ts`: +28 tests — Rule-1 intended catches (old-bay,
  chipotle-in-adobo ×2, gluten-free-flour ×2, everything-bagel-seasoning), the
  spring-mix documented no-op, no-op rulings (no significant tokens / all-neutral / no
  description), the DOCUMENTED modifier-first regression cases (fresh kale, dried sage,
  low sodium chicken broth — asserted as `false` to document actual behavior, not to
  claim it's desired), Rule-2 vegan-family guard (incl. a beyond-segment-1/2
  full-description catch, hyphen/space marker equivalence, plant-based/meatless
  variants, no-marker no-op), Rule-2 candied-family guard, and the deliberate
  QUERY-side-vs-DESCRIPTION-side vocabulary asymmetry.
- `tests/find-food.test.ts`: +5 tests — end-to-end AND-layering through the full
  `findFood()` pipeline for Rule-1 (old-bay) and Rule-2 (vegan-cream-cheese) rejecting a
  round-1-CLOSE-passing candidate, round-1-honest-case preservation (unaffected by
  round-2), and a genuine EXACT match surviving all three layers unchanged.
- `npm test`: **144/145 pass.** The 1 failure is the PRE-EXISTING, read-only test
  `"a 'close' match gets an approximate-match note; matchQuality reflects it"`
  (`fresh ginger` vs `Ginger root, raw`) — this is finding 2's regression class hitting
  round-1's own CLOSE-tier documentation example directly. Not modified per the
  tests-are-read-only constraint.
- `npm run test:eval`: **24/25 pass.** The 1 failure
  (`"negative: confident_wrong when a preferred-type match lands"`) uses
  `"everything bagel seasoning"` vs `"Bagels, egg"` as its illustrative example for
  testing `scoreCase()`'s labeling logic — round-2 now correctly rejects this exact pair
  (see finding 1's table), so the scenario no longer produces a `confident_wrong`
  precondition. This is round-2 working as intended on a stale illustrative example, not
  a regression in `scoreCase()` itself; not modified per the same read-only conservatism
  (the file lives outside `tests/` but is treated the same way absent explicit
  authorization).
- `npx tsc --noEmit`: clean (exit 0).

## Replay results

Pre-change baseline (`eval/results/baseline-round2-pre.json`, committed): **96/96 scored,
0 uncached.** top-1 10.8% (7/65), top-4 26.2% (17/65), negative-honesty 9.7% (3/31).

Post-change replay against the SAME frozen cache (`eval/results/round2-check.json`,
committed): **56/96 scored, 40 uncached** (23 positive, 17 negative). Of what IS scored:
top-1 7.1% (3/42), top-4 21.4% (9/42), negative-honesty 21.4% (3/14) — **the negative-
honesty percentage increase is an artifact of the denominator shrinking from 31→14, not
actual improvement: zero rows scored `honest` that weren't already honest at baseline.**
The refusal-vs-Branded-rescue split cannot be computed yet for that reason — no negative
row scored `honest` via either path in this replay; all candidate flips are sitting in
`uncached` pending finding 1's resolution. `usedBranded` cannot yet be confirmed to hold
at zero on the negative rows scored `confident_wrong` (11 rows) since none of those went
through Branded — consistent with the "Branded-rescue count must not increase" DONE WHEN
bar, but not yet proof of the honesty target.

## Baseline-vs-round2 delta (all 96 rows)

### Positive rows (65) — baseline status -> round-2 (pre-cache-backfill) status

| name | baseline | round-2 |
|---|---|---|
| Blue Diamond Almonds | miss | uncached |
| Chang's Pad Thai dried rice sticks | miss | uncached |
| Oreos | miss | miss |
| Parmesan | miss | miss |
| almonds | miss | miss |
| anchovy paste | miss | miss |
| arborio rice | miss | uncached |
| basil leaves | miss | miss |
| basmati rice | miss | uncached |
| bay leaves | hit | hit |
| beansprout | miss | miss |
| beansprouts | miss | miss |
| berries | near | near |
| brown basmati rice | miss | miss |
| butter | miss | miss |
| chicken tenderloin | miss | miss |
| coriander | hit | hit |
| corn | miss | miss |
| dairy free butter | miss | uncached |
| dried parsley | near | miss |
| dried sage | hit | uncached |
| dry vermouth | miss | uncached |
| fire roasted tomatoes | miss | uncached |
| french lentils | hit | miss |
| fresh kale | hit | miss |
| fresh mint leaves | miss | miss |
| frozen blueberries | near | near |
| frozen peaches | near | near |
| frozen strawberries | near | near |
| green apple | miss | uncached |
| green chiles | miss | uncached |
| green chillies | miss | uncached |
| heirloom tomatoes | miss | uncached |
| jalapeño | miss | miss |
| jasmine rice | miss | uncached |
| lamb stewing meat | miss | uncached |
| lemongrass | miss | miss |
| lemons | miss | miss |
| long grain and wild rice mix | miss | uncached |
| low sodium beef broth | near | uncached |
| low sodium chicken broth | hit | uncached |
| marinara | miss | miss |
| milk | miss | miss |
| mint leaves | miss | miss |
| mixed berries | near | miss |
| mixed spring greens | near | uncached |
| no salt added black beans | miss | uncached |
| nori | miss | miss |
| nutmeg | near | near |
| oats | miss | miss |
| organic milk | miss | miss |
| organic sweet potatoes | miss | uncached |
| pineapple juice | miss | miss |
| poppy seeds | hit | hit |
| salmon fillets | miss | miss |
| skinless boneless salmon fillet | miss | miss |
| snow peas | miss | uncached |
| spring greens | miss | miss |
| sweet potatoes | miss | miss |
| tomatoes | miss | miss |
| walnuts | near | near |
| water | miss | miss |
| water chestnuts | miss | uncached |
| wheat berries | miss | uncached |
| white rice | miss | miss |

### Negative rows (31) — baseline status -> round-2 (pre-cache-backfill) status

| name | baseline | round-2 |
|---|---|---|
| Magic Green Sauce | confident_wrong | confident_wrong |
| Mrs. Dash seasoning | honest | honest |
| Thai green curry paste | confident_wrong | confident_wrong |
| Thai red curry paste | confident_wrong | confident_wrong |
| adobo seasoning | confident_wrong | confident_wrong |
| bone broth | confident_wrong | confident_wrong |
| candied ginger | confident_wrong | uncached |
| chipotle chiles in adobo | confident_wrong | uncached |
| chipotle peppers in adobo | confident_wrong | uncached |
| coconut aminos | confident_wrong | confident_wrong |
| everything bagel seasoning | confident_wrong | uncached |
| freeze dried strawberries | confident_wrong | uncached |
| garam masala | confident_wrong | uncached |
| gluten free flour | confident_wrong | uncached |
| gluten-free flour | confident_wrong | uncached |
| green curry paste | confident_wrong | uncached |
| homemade green curry paste | confident_wrong | uncached |
| ice cubes | honest | honest |
| lemongrass paste | confident_wrong | confident_wrong |
| low sodium vegetable broth | confident_wrong | confident_wrong |
| old bay seasoning | confident_wrong | uncached |
| protein of choice | honest | honest |
| red curry paste | confident_wrong | uncached |
| spring mix | confident_wrong | confident_wrong |
| tandoori masala | confident_wrong | uncached |
| thai green curry paste | confident_wrong | confident_wrong |
| vegan cream cheese | confident_wrong | uncached |
| vegan fish sauce | confident_wrong | uncached |
| vegetables of choice | confident_wrong | confident_wrong |
| whole grain mustard | confident_wrong | uncached |
| yellow curry paste | confident_wrong | uncached |

## Scope-cut note (per spec RULING)

gluten-free / freeze-dried / low-sodium / no-salt-added Rule-2 categorical guards are
**deliberately not implemented** — the spec ruled these out as undefined-rejection-
vocabulary, zero-corpus-impact scope cuts. Confirmed zero impact: none of the corpus's
`freeze dried strawberries`, `gluten free flour`, `gluten-free flour`, `low sodium
vegetable broth`, `low sodium beef broth`, `low sodium chicken broth`, `no salt added
black beans` rows needed a Rule-2 guard to resolve correctly — `freeze dried
strawberries` and the two `gluten(-)free flour` rows are Rule-1 catches (head-in-gate),
not Rule-2 candidates.

## Open questions for CoS

1. Should a live re-measure be run now to backfill the 40 uncached cache entries so the
   true post-round-2 numbers can be captured? (Recommended — this alone would likely
   resolve most of finding 1 and confirm/deny the magnitude of finding 2's positive
   cost once uncached rows resolve to real statuses.)
2. Which finding-2 fix option (1-4 above) should the Builder implement in a follow-up
   pass? Option 4 (ship Rule-2 alone, defer Rule-1) is the safest zero-positive-cost
   partial win available without a new decision; option 1 (small new prep-modifier
   vocabulary) most fully matches the spec's original design intent but requires
   explicit authorization to invent a new set.
3. Is `eval/run.test.ts`'s stale `"everything bagel seasoning"` illustrative example
   fair game for the Builder to swap for a non-colliding query/description pair in a
   follow-up pass, given it lives outside `tests/` and the fix doesn't touch
   `scoreCase()`'s actual logic?
