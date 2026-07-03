# Recorded FDC API fixtures

Real responses recorded live from `api.nal.usda.gov` on **2026-07-03** with `DEMO_KEY` (curl, HTTP/1.1). These are golden fixtures: do NOT regenerate casually, do NOT hand-edit, and never fabricate fixture data — record from the live API and note the date here.

| File | Endpoint | Status |
|---|---|---|
| `cheddar-cheese.search-all.json` | `GET /fdc/v1/foods/search?query=cheddar%20cheese&pageSize=10` | 200 |
| `cheddar-cheese.search-foundation.json` | same + `&dataType=Foundation` | 200 |
| `food-328637.detail-abridged.json` | `GET /fdc/v1/food/328637?format=abridged` | 200 |

## Observed facts these fixtures pin (as of 2026-07-03)

1. **The cheddar proof:** unfiltered search for "cheddar cheese" returns 64,784 hits with page 1 = ten near-identical Branded entries; the canonical answer is absent. Foundation-filtered search returns `328637 · Cheese, cheddar · Foundation` as result #1. This is the product's flagship demo.
2. **Search hits embed `foodNutrients`** — a nutrient summary can be built from the search response alone, with no follow-up detail call.
3. **The full-format detail quirk:** `GET /fdc/v1/food/328637` (default/`format=full`) returns **404 with an empty body** even though the record exists — `format=abridged` returns 200 with 105 nutrients. Same behavior observed for `746767` (Cheese, swiss, Foundation). Verified with both DEMO_KEY and a registered key. Some Foundation records are searchable but 404 on full-format detail; abridged works. Client code must fall back to abridged on a full-format 404 before reporting failure.
