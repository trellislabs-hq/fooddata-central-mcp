#!/usr/bin/env node
/**
 * Module: FoodData Central MCP Server
 * Purpose: Exposes USDA FoodData Central as MCP tools so Claude (and other
 *   MCP clients) can search and retrieve food nutrition data.
 *
 * Major Sections:
 *   - Environment validation (FDC_API_KEY check)
 *   - Query validation helper (empty/whitespace guard)
 *   - Tool registrations (search_foods, get_food, get_foods, list_foods, find_food)
 *   - Transport connection (stdio)
 *
 * Dependencies:
 *   - @modelcontextprotocol/sdk ^1.29.0
 *   - zod ^3.24.0
 *   - ./fdc-client.ts (FdcClient, FdcError, types)
 *   - ./format.ts (output formatters — extracted here from a prior version
 *     of this file; text output for the four original tools is unchanged)
 *   - ./find-food.ts (find_food's search/dedup/formatting pipeline)
 *   - ./get-foods.ts (get_foods reconciliation core — extracted for
 *     testability; batch omission/zero-resolve reconciliation lives there)
 *
 * State: Stateless — each tool call is an independent HTTP request to FDC.
 *   API key is read once at startup and fails fast if missing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FdcClient, FdcError, type FdcListParams } from "./fdc-client.js";
import { formatFoodSummary, formatFoodDetail, formatError } from "./format.js";
import { findFood } from "./find-food.js";
import { buildGetFoodsResult } from "./get-foods.js";

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

// ─── Query Validation ─────────────────────────────────────────────────────────

/**
 * Returns a user-readable error message if `query` is empty/whitespace-only,
 * or null if the query is valid. Callers return this through the same
 * isError/formatError contract used for FDC API errors — never throw.
 */
function validateQuery(query: string): string | null {
  if (!query || query.trim().length === 0) {
    return "Query must not be empty. Provide a food name or search term.";
  }
  return null;
}

// ─── MCP Server Setup ─────────────────────────────────────────────────────────

const server = new McpServer({
  name: "fooddata-central-mcp",
  version: "1.3.0",
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
    const validationError = validateQuery(query);
    if (validationError) {
      return {
        content: [{ type: "text", text: validationError }],
        isError: true,
      };
    }
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
      const { food, usedFallback } = await client.getFood({
        fdcId,
        format: (format ?? "full") as "abridged" | "full",
        nutrients,
      });

      const detail = formatFoodDetail(food);
      const text = usedFallback
        ? `Note: full-format detail was unavailable for this FDC ID (HTTP 404); served abridged format instead.\n\n${detail}`
        : detail;

      return {
        content: [
          {
            type: "text",
            text,
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
    return buildGetFoodsResult(client, {
      fdcIds,
      format: (format ?? "full") as "abridged" | "full",
      nutrients,
    });
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

// ─── Tool: find_food ──────────────────────────────────────────────────────────

server.registerTool(
  "find_food",
  {
    title: "Find Food",
    description:
      "Find the best canonical match for a food name. Returns the top match with a " +
      "key-nutrient summary plus up to 3 alternates, preferring Foundation and SR Legacy " +
      "data over branded noise. Applies a relevance floor to every candidate — if nothing " +
      "FDC returns actually resembles the requested name, find_food honestly reports no " +
      "confident match instead of returning a nearest-neighbor guess, and lists a few " +
      "below-floor candidates for reference.",
    inputSchema: {
      name: z
        .string()
        .describe("Food name to look up (e.g. 'cheddar cheese', 'paneer', 'raw broccoli')"),
      includeBranded: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include manufacturer-submitted Branded foods in the search. Default false — " +
          "Branded is only searched when true, or automatically as a last resort if no " +
          "Foundation/SR Legacy/Survey match is found."
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ name, includeBranded }) => {
    const validationError = validateQuery(name);
    if (validationError) {
      return {
        content: [{ type: "text", text: validationError }],
        isError: true,
      };
    }

    try {
      const result = await findFood(client.searchFoods.bind(client), name, { includeBranded });

      return {
        content: [{ type: "text", text: result.text }],
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
