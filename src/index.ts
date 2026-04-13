#!/usr/bin/env node
/**
 * Module: FoodData Central MCP Server
 * Purpose: Exposes USDA FoodData Central as MCP tools so Claude (and other
 *   MCP clients) can search and retrieve food nutrition data.
 *
 * Major Sections:
 *   - Environment validation (FDC_API_KEY check)
 *   - Output formatters (LLM-readable text, not raw JSON dumps)
 *   - Tool registrations (search_foods, get_food, get_foods, list_foods)
 *   - Transport connection (stdio)
 *
 * Dependencies:
 *   - @modelcontextprotocol/sdk ^1.29.0
 *   - zod ^3.24.0
 *   - ./fdc-client.ts (FdcClient, FdcError, types)
 *
 * State: Stateless — each tool call is an independent HTTP request to FDC.
 *   API key is read once at startup and fails fast if missing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FdcClient, FdcError, type FdcFood, type FdcNutrient, type FdcListParams } from "./fdc-client.js";

// ─── Environment Validation ──────────────────────────────────────────────────

const apiKey = process.env.FDC_API_KEY;
if (!apiKey) {
  // Write to stderr so the MCP Inspector can display it without corrupting stdio protocol
  process.stderr.write(
    "ERROR: FDC_API_KEY environment variable is not set.\n" +
    "Get a free key at https://fdc.nal.usda.gov/api-guide\n" +
    "Or use DEMO_KEY for testing (30 requests/hour limit).\n"
  );
  process.exit(1);
}

const client = new FdcClient(apiKey);

// ─── Output Formatters ───────────────────────────────────────────────────────

/**
 * Normalize the three different nutrient object shapes the FDC API returns
 * into a consistent { name, number, unit, value } tuple.
 *
 * Shapes handled:
 *   1. Search results:  { nutrientId, nutrientName, unitName, value }
 *   2. Abridged format: { name, number, amount, unitName }  (flat)
 *   3. Full format:     { nutrient: { id, number, name, unitName }, amount }  (nested)
 */
function resolveNutrient(n: FdcNutrient): {
  id: number | undefined;
  name: string;
  number: string;
  unit: string;
  value: number | undefined;
} {
  // Full format: nested nutrient sub-object
  if (n.nutrient) {
    return {
      id: n.nutrient.id,
      name: n.nutrient.name,
      number: n.nutrient.number,
      unit: n.nutrient.unitName,
      value: n.amount,
    };
  }
  // Search result shape: nutrientId / nutrientName
  if (n.nutrientId !== undefined || n.nutrientName !== undefined) {
    return {
      id: n.nutrientId,
      name: n.nutrientName ?? "Unknown",
      number: n.nutrientNumber ?? "",
      unit: n.unitName ?? "",
      value: n.value ?? n.amount,
    };
  }
  // Abridged format: flat name/number/amount/unitName
  return {
    id: undefined,
    name: n.name ?? "Unknown",
    number: n.number ?? "",
    unit: n.unitName ?? "",
    value: n.amount ?? n.value,
  };
}

/**
 * Extract key nutrients from a food's nutrient list.
 * Returns a readable string like "Energy: 402 KCAL | Protein: 24.9 G | ..."
 *
 * Priority nutrient numbers (USDA standard): 208=Energy, 203=Protein,
 * 204=Total Fat, 205=Carbs, 307=Sodium, 291=Fiber, 269=Sugars
 */
function formatKeyNutrients(nutrients: FdcNutrient[] | undefined): string {
  if (!nutrients || nutrients.length === 0) return "No nutrient data available";

  // Key nutrient numbers we always want to surface (if present)
  const priorityNumbers = new Set(["208", "203", "204", "205", "307", "291", "269"]);
  const priorityIds = new Set([208, 203, 204, 205, 307, 291, 269]);
  const priorityNames = new Set([
    "Energy", "Protein", "Total lipid (fat)", "Carbohydrate, by difference",
    "Sodium, Na", "Fiber, total dietary", "Sugars, Total"
  ]);

  const found: string[] = [];
  const seen = new Set<string>();

  for (const n of nutrients) {
    const { id, name, number, unit, value } = resolveNutrient(n);
    const isPriority =
      priorityNumbers.has(number) ||
      (id !== undefined && priorityIds.has(id)) ||
      priorityNames.has(name);

    // Deduplicate by nutrient number (or name if number unavailable)
    const dedupeKey = number || name;
    if (isPriority && value !== undefined && !seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      const shortName = name
        .replace(", by difference", "")
        .replace(", total dietary", "");
      found.push(`${shortName}: ${value} ${unit}`);
    }
  }

  if (found.length === 0) {
    // Fall back to first 5 nutrients if none match our priority list
    const fallback = nutrients.slice(0, 5).map((n) => {
      const { name, unit, value } = resolveNutrient(n);
      return `${name}: ${value ?? "?"} ${unit}`;
    });
    return fallback.join(" | ") || "No nutrient data";
  }

  return found.join(" | ");
}

/**
 * Format a food item as a concise summary line for search/list results.
 * Keeps output scannable — one food per line.
 */
function formatFoodSummary(food: FdcFood): string {
  const parts = [
    `FDC ID: ${food.fdcId}`,
    `Name: ${food.description}`,
    `Type: ${food.dataType ?? "Unknown"}`,
  ];

  if (food.brandOwner || food.brandName) {
    parts.push(`Brand: ${food.brandName ?? food.brandOwner}`);
  }

  const nutrients = formatKeyNutrients(food.foodNutrients);
  if (nutrients !== "No nutrient data available" && nutrients !== "No nutrient data") {
    parts.push(`Nutrients: ${nutrients}`);
  }

  return parts.join(" | ");
}

/**
 * Format a single food's full nutrient breakdown for get_food / get_foods.
 * Groups nutrients into a readable block.
 */
function formatFoodDetail(food: FdcFood): string {
  const lines: string[] = [
    `=== ${food.description} ===`,
    `FDC ID: ${food.fdcId}`,
    `Data Type: ${food.dataType ?? "Unknown"}`,
  ];

  if (food.brandOwner) lines.push(`Brand Owner: ${food.brandOwner}`);
  if (food.brandName && food.brandName !== food.brandOwner) {
    lines.push(`Brand Name: ${food.brandName}`);
  }
  if (food.servingSize && food.servingSizeUnit) {
    lines.push(`Serving Size: ${food.servingSize} ${food.servingSizeUnit}`);
  }

  const nutrients = food.foodNutrients ?? [];
  if (nutrients.length > 0) {
    lines.push("");
    lines.push("--- Nutrients ---");

    for (const n of nutrients) {
      const { name, unit, value } = resolveNutrient(n);
      if (value !== undefined) {
        lines.push(`  ${name}: ${value} ${unit}`);
      }
    }
  } else {
    lines.push("No nutrient data available.");
  }

  return lines.join("\n");
}

/**
 * Wrap any caught error into a user-readable string.
 * FdcError gets a specialized message; other errors get generic treatment.
 */
function formatError(err: unknown): string {
  if (err instanceof FdcError) {
    return `FDC API Error (${err.statusCode}): ${err.message}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

// ─── MCP Server Setup ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "fooddata-central-mcp",
  version: "1.0.0",
});

// ─── Tool: search_foods ───────────────────────────────────────────────────────

server.registerTool(
  "search_foods",
  {
    title: "Search Foods",
    description:
      "Search the USDA FoodData Central database by keyword or food name. " +
      "Returns matching foods with FDC IDs, data types, and key nutrient values. " +
      "Use the returned FDC IDs with get_food for full nutrient details.",
    inputSchema: {
      query: z.string().describe(
        "Search terms (e.g. 'cheddar cheese', 'raw broccoli', 'whole wheat bread')"
      ),
      dataType: z
        .enum(["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"])
        .optional()
        .describe(
          "Filter by data source. Foundation=USDA lab-analyzed, SR Legacy=classic reference, " +
          "Branded=manufacturer data, Survey=dietary survey foods"
        ),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of results per page (1-50, default 10)"),
      pageNumber: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe("Page number for pagination (default 1)"),
      brandOwner: z
        .string()
        .optional()
        .describe("Filter branded foods by brand owner name (e.g. 'General Mills')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, dataType, pageSize, pageNumber, brandOwner }) => {
    try {
      const result = await client.searchFoods({
        query,
        dataType: dataType as Parameters<typeof client.searchFoods>[0]["dataType"],
        pageSize,
        pageNumber,
        brandOwner,
      });

      const { totalHits, currentPage, totalPages, foods } = result;

      if (!foods || foods.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No foods found matching "${query}".`,
            },
          ],
        };
      }

      const header =
        `Search results for "${query}" — ` +
        `${totalHits} total hits, page ${currentPage} of ${totalPages}\n\n`;

      const foodLines = foods.map(formatFoodSummary).join("\n");
      const footer =
        foods.length < totalHits
          ? `\n\nUse pageNumber to see more results, or get_food with an FDC ID for full nutrient details.`
          : `\n\nUse get_food with an FDC ID for full nutrient details.`;

      return {
        content: [
          {
            type: "text",
            text: header + foodLines + footer,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatError(err) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_food ───────────────────────────────────────────────────────────

server.registerTool(
  "get_food",
  {
    title: "Get Food Details",
    description:
      "Get full nutrient details for a single food by its FDC ID. " +
      "Returns a complete nutrient breakdown including macros, vitamins, and minerals. " +
      "FDC IDs can be found using search_foods.",
    inputSchema: {
      fdcId: z
        .number()
        .int()
        .positive()
        .describe("The FoodData Central ID of the food (e.g. 747447)"),
      format: z
        .enum(["abridged", "full"])
        .optional()
        .default("full")
        .describe(
          "Response format: 'full' returns all nutrients (default), " +
          "'abridged' returns a subset of key nutrients"
        ),
      nutrients: z
        .array(z.number().int())
        .optional()
        .describe(
          "Filter to specific nutrient numbers (e.g. [208, 203, 204] for energy, protein, fat). " +
          "Omit to get all nutrients."
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ fdcId, format, nutrients }) => {
    try {
      const food = await client.getFood({
        fdcId,
        format: (format ?? "full") as "abridged" | "full",
        nutrients,
      });

      return {
        content: [
          {
            type: "text",
            text: formatFoodDetail(food),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatError(err) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_foods ──────────────────────────────────────────────────────────

server.registerTool(
  "get_foods",
  {
    title: "Get Multiple Foods",
    description:
      "Batch lookup of up to 20 foods by FDC ID in a single API call. " +
      "More efficient than calling get_food repeatedly when you need details " +
      "for multiple foods. Returns full nutrient details for each food.",
    inputSchema: {
      fdcIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(20)
        .describe("Array of FDC IDs to look up (1-20 IDs)"),
      format: z
        .enum(["abridged", "full"])
        .optional()
        .default("full")
        .describe("Response format: 'full' (default) or 'abridged'"),
      nutrients: z
        .array(z.number().int())
        .optional()
        .describe("Filter to specific nutrient numbers. Omit to get all nutrients."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ fdcIds, format, nutrients }) => {
    try {
      const foods = await client.getFoods({
        fdcIds,
        format: (format ?? "full") as "abridged" | "full",
        nutrients,
      });

      if (!foods || foods.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No foods found for the provided FDC IDs.",
            },
          ],
        };
      }

      const output = foods.map(formatFoodDetail).join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Batch results for ${foods.length} food(s):\n\n${output}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatError(err) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: list_foods ─────────────────────────────────────────────────────────

server.registerTool(
  "list_foods",
  {
    title: "List Foods",
    description:
      "Browse the FoodData Central catalog with pagination. " +
      "Useful for exploring available foods by data type without a specific search term. " +
      "Returns FDC IDs and food names for use with get_food.",
    inputSchema: {
      dataType: z
        .enum(["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"])
        .optional()
        .describe("Filter by data source (omit to list all types)"),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(25)
        .describe("Number of results per page (1-200, default 25)"),
      pageNumber: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(1)
        .describe("Page number (default 1)"),
      sortBy: z
        .enum([
          "dataType.keyword",
          "lowercaseDescription.keyword",
          "fdcId",
          "publishedDate",
        ])
        .optional()
        .default("lowercaseDescription.keyword")
        .describe("Sort field (default: alphabetical by description)"),
      sortOrder: z
        .enum(["asc", "desc"])
        .optional()
        .default("asc")
        .describe("Sort direction (default: ascending)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ dataType, pageSize, pageNumber, sortBy, sortOrder }) => {
    try {
      const foods = await client.listFoods({
        dataType: dataType as FdcListParams["dataType"],
        pageSize,
        pageNumber,
        sortBy: sortBy as FdcListParams["sortBy"],
        sortOrder: sortOrder as "asc" | "desc",
      });

      if (!foods || foods.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No foods found for the given parameters.",
            },
          ],
        };
      }

      const filter = dataType ? ` (${dataType})` : "";
      const header = `Food catalog listing${filter} — page ${pageNumber}, ${foods.length} items:\n\n`;

      // List view is more compact than search — just ID, name, type
      const lines = foods.map(
        (f) =>
          `FDC ID: ${f.fdcId} | ${f.description}` +
          (f.dataType ? ` | ${f.dataType}` : "") +
          (f.brandOwner ? ` | ${f.brandOwner}` : "")
      );

      const footer = `\n\nUse get_food with an FDC ID for full nutrient details.`;

      return {
        content: [
          {
            type: "text",
            text: header + lines.join("\n") + footer,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: formatError(err) }],
        isError: true,
      };
    }
  }
);

// ─── Transport Connection ─────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
