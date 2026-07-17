# FoodData Central MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the USDA
[FoodData Central](https://fdc.nal.usda.gov/) database — search foods, look
up nutrient data by FDC ID, and find the canonical version of a food name
without wading through thousands of near-duplicate manufacturer entries.

Not affiliated with the USDA. Food composition data is public domain
(U.S. Government work); see [Attribution](#attribution--data-source) below.

## Quickstart

Add this to your MCP client config (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "fooddata-central": {
      "command": "npx",
      "args": ["-y", "@trellis-labs/fooddata-central-mcp"],
      "env": {
        "FDC_API_KEY": "YOUR_KEY_HERE"
      }
    }
  }
}
```

For Claude Desktop, this goes in `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows).

### Get an API key

Sign up for a free key at
[fdc.nal.usda.gov/api-guide](https://fdc.nal.usda.gov/api-guide) — takes about
a minute, no credit card. A registered key gets you 1,000 requests/hour.

**Don't want to sign up right now?** Use `FDC_API_KEY=DEMO_KEY` — USDA's
shared demo key works immediately with no signup, limited to 30 requests/hour.
Fine for trying the server out; get a real key before relying on it for
regular use.

## The cheddar problem (why find_food exists)

Search "cheddar cheese" directly against FDC's full catalog and you get
**64,784 hits**. Page 1 is ten near-identical Branded entries — different
grocery chains' private-label cheddar, none of them the food you actually
meant:

```
CHEDDAR CHEESE | Grafton Village Cheese Co, LLC
CHEDDAR CHEESE | Three Square Inc. (Crystal Farms)
CHEDDAR CHEESE | Weis Markets, Inc.
CHEDDAR CHEESE | Weis Markets, Inc.
CHEDDAR CHEESE | Weis Markets, Inc.
... (5 more brands, same product)
```

The canonical, lab-analyzed answer — `Cheese, cheddar` (FDC 328637,
Foundation) — is nowhere on that page.

`find_food("cheddar cheese")` returns it first:

```
Best match for "cheddar cheese":
FDC ID: 328637 | Name: Cheese, cheddar | Type: Foundation
Nutrient summary: Carbohydrate: 2.44 G | Energy: 408 KCAL | Protein: 23.3 G | ...
Use get_food(fdcId: 328637) for the full nutrient breakdown.

Alternates:
FDC ID: 746767 | Name: Cheese, swiss | Type: Foundation
...
```

It does this by preferring Foundation (USDA lab-analyzed) and SR Legacy
(classic reference) data over Branded (manufacturer-submitted) noise, and
only falling back to Branded results if nothing else matches or you
explicitly ask for it (`includeBranded: true`).

## Tools

### `find_food`

Find the best canonical match for a food name. This is the tool to reach for
first when you just want "the" answer for a food, not a list to sift
through.

- **Input:** `name` (string, required), `includeBranded` (boolean, optional,
  default `false`)
- **Output:** best match with FDC ID + key-nutrient summary, up to 3
  alternates, and a one-line note when normalization/aliasing or a Branded
  fallback was used.
- Handles plurals, common prep words ("sliced onion" → "onion"), and a small
  table of food-identity aliases for less common ingredient names (e.g.
  "paneer" → "paneer cheese", "nori" → "seaweed sheets").
- No LLM calls happen inside this tool — it's a search/ranking pipeline. The
  calling model (you) is the disambiguation layer if the top match still
  isn't quite right; use the alternates or `search_foods` for more control.

### `search_foods`

Search FDC by keyword. Full control over data type, brand owner, and
pagination — use this when you want to see the raw candidate list rather
than a single resolved answer.

- **Input:** `query` (required), `dataType`, `pageSize` (1-50, default 10),
  `pageNumber`, `brandOwner`.
- **Data type guidance:** prefer `Foundation` and `SR Legacy` over `Branded`
  unless you specifically need manufacturer nutrition-label data. `Survey
  (FNDDS)` covers dietary-survey composite foods (e.g. "chicken sandwich").

### `get_food`

Full nutrient breakdown for a single food by FDC ID.

- **Input:** `fdcId` (required), `format` (`full` default or `abridged`),
  `nutrients` (optional filter list).
- **Known FDC quirk:** some Foundation records (e.g. 328637, 746767) return
  HTTP 404 on full-format detail even though the record exists and is fully
  searchable — `abridged` format works fine for the same ID. This server
  automatically retries with `abridged` on a full-format 404 and notes it in
  the output; you don't need to handle this yourself.

### `get_foods`

Batch lookup of up to 20 foods by FDC ID in one call — more efficient than
repeated `get_food` calls.

### `list_foods`

Paginated browse of the full catalog by data type, without a search term.
Useful for exploring what's available rather than looking something specific
up.

## Privacy & data flow

Every tool call goes **directly from this server to `api.nal.usda.gov`**,
using the API key you provided. There is no intermediary service, no
telemetry, and no analytics in this package — your queries and your key
never pass through anything but your machine and USDA's API.

## Data accuracy & scope

- **Not nutrition or medical advice.** This server returns reference data
  from USDA FoodData Central. It's a lookup tool, not a substitute for
  professional dietary, medical, or allergen guidance — verify anything
  health-critical against the product label or a qualified professional.
- **Data quality varies by data type.** Foundation and SR Legacy records are
  USDA lab-analyzed reference values. Branded records are
  manufacturer-self-reported nutrition-label data — values can differ across
  product samples, reformulations, and FDC data releases, and upstream errors
  are passed through as-is.
- **Freshness and availability follow USDA.** Data currency tracks USDA's
  release cycle, and availability tracks the FDC API itself. The software is
  provided as-is under the [MIT license](#license), with best-effort
  support (below) and no SLA.

## Support

This is a best-effort, bootstrapped open source project. Bug reports and
feature requests are welcome via
[GitHub Issues](https://github.com/trellislabs-hq/fooddata-central-mcp/issues) —
no guaranteed response time, but real issues get looked at.

**Interested in a hosted version** (no local setup, managed API key, higher
rate limits)? Open a
[hosted-interest issue](https://github.com/trellislabs-hq/fooddata-central-mcp/issues/new?template=hosted-interest.md)
and tell us what you'd need.

## Attribution & data source

Nutrition data is sourced from the U.S. Department of Agriculture's
[FoodData Central](https://fdc.nal.usda.gov/), a public domain U.S.
Government resource. This project is an independent, unofficial client and
is **not affiliated with or endorsed by the USDA**.

## License

MIT — see [LICENSE](./LICENSE).
