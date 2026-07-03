/**
 * Module: Output Formatters
 * Purpose: Turns FDC API response shapes into LLM-readable text (not raw JSON
 *   dumps). Extracted from src/index.ts so find_food can reuse the same
 *   nutrient-summary and error-formatting logic as the original four tools.
 *
 * Major Sections:
 *   - resolveNutrient() — normalizes the three FDC nutrient object shapes
 *   - formatKeyNutrients() — extracts a scannable "Energy: X | Protein: Y" line
 *   - formatFoodSummary() — one-line summary for search/list results
 *   - formatFoodDetail() — full nutrient breakdown for get_food / get_foods
 *   - formatError() — wraps caught errors into a user-readable string
 *
 * Dependencies: ./fdc-client.ts (FdcError, FdcFood, FdcNutrient types)
 * State: Stateless — pure formatting functions.
 *
 * Note: this module is a lift-and-shift extraction from src/index.ts (no
 * behavior change) so text output for search_foods/get_food/get_foods/
 * list_foods remains byte-identical. find_food (src/index.ts) imports these
 * same functions rather than re-implementing nutrient formatting.
 */

import { FdcError, type FdcFood, type FdcNutrient } from "./fdc-client.js";

/**
 * Normalize the three different nutrient object shapes the FDC API returns
 * into a consistent { name, number, unit, value } tuple.
 *
 * Shapes handled:
 *   1. Search results:  { nutrientId, nutrientName, unitName, value }
 *   2. Abridged format: { name, number, amount, unitName }  (flat)
 *   3. Full format:     { nutrient: { id, number, name, unitName }, amount }  (nested)
 */
export function resolveNutrient(n: FdcNutrient): {
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
export function formatKeyNutrients(nutrients: FdcNutrient[] | undefined): string {
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
export function formatFoodSummary(food: FdcFood): string {
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
export function formatFoodDetail(food: FdcFood): string {
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
export function formatError(err: unknown): string {
  if (err instanceof FdcError) {
    return `FDC API Error (${err.statusCode}): ${err.message}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}
