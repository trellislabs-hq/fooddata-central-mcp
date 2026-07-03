# Changelog

All notable changes to this project are documented in this file.

## [1.1.1] — 2026-07-03

### Fixed

- **`find_food` data-type preference now survives FDC's relevance ranking.**
  The combined-type search ranks purely by text relevance, so a Survey (FNDDS)
  entry could outrank the canonical Foundation entry for the same food
  (observed live: "cheddar cheese" returned Survey 2705709 above Foundation
  328637). Results are now stable-sorted Foundation → SR Legacy → Survey →
  Branded before selection, with relevance breaking ties only within a tier.
- Server handshake (`serverInfo.version`) now reports the real package version
  (was hardcoded to 1.0.0).

## [1.1.0] — 2026-07-03

### Added

- **`find_food` tool** — resolves a food name to the best canonical FDC
  match plus up to 3 alternates, preferring Foundation and SR Legacy data
  over Branded manufacturer noise. Includes a normalization + food-identity
  alias cascade (plurals, safe prep-word stripping, and a small alias table
  for names like "paneer", "dashi", "nori") ported and adapted from the
  recipe-app project's ingredient-matching logic.
- Recorded golden fixtures (`tests/fixtures/`) documenting real FDC API
  behavior, including the cheddar-cheese search noise problem and a
  full-format-detail 404 quirk on certain Foundation records.

### Changed

- Output formatters (`resolveNutrient`, `formatKeyNutrients`,
  `formatFoodSummary`, `formatFoodDetail`, `formatError`) extracted from
  `src/index.ts` into `src/format.ts` for reuse by `find_food`. Text output
  for `search_foods`, `get_food`, `get_foods`, and `list_foods` is
  byte-identical to 1.0.0 (verified by regression tests).

### Fixed / Hardened

- All FDC API requests now enforce a 10s timeout via `AbortController`.
- HTTP 429 (rate limit) responses are retried once, honoring the
  `Retry-After` header when present.
- `get_food` now retries once with `format=abridged` when a full-format
  request 404s — some Foundation records (confirmed: FDC IDs 328637, 746767)
  return an empty-body 404 on full-format detail despite being fully
  searchable, while abridged format succeeds. The tool output notes when
  this fallback was used. If both formats 404, the error message suggests
  re-running `search_foods` or `find_food` (the ID may have been
  superseded).
- `search_foods` and `find_food` now validate against empty/whitespace-only
  queries, returning a readable error instead of a confusing API error.

### Notes

- MCP SDK dependency (`@modelcontextprotocol/sdk`) checked against the
  latest 1.x release (1.29.0) during this pass — already at latest, no
  version bump needed.

## [1.0.0]

- Initial release: `search_foods`, `get_food`, `get_foods`, `list_foods`
  tools wrapping the USDA FoodData Central API.
