/**
 * Module: search-result projection (cache size budget)
 * Purpose: Shrink a live FdcSearchResult into the minimal shape the eval
 *   harness needs to commit as a fixture-format cache (raw responses run
 *   ~25-52MB across the whole corpus; a projected 10-food response is a
 *   couple KB). The projection MUST be byte-faithful for the fields
 *   findFood()/formatFoodSummary()/formatKeyNutrients() (src/find-food.ts,
 *   src/format.ts) actually consume — see eval/run.test.ts's "projection
 *   faithfulness" self-test, which is the enforcement mechanism for that
 *   claim (compares real vs projected `findFood().text` byte-for-byte).
 *
 * Major Sections:
 *   - PRIORITY_* — duplicated (NOT imported — format.ts doesn't export
 *     these) copy of src/format.ts's formatKeyNutrients() priority-nutrient
 *     matching. Kept in sync manually; if format.ts's priority set changes
 *     without a matching update here, eval/run.test.ts's projection
 *     faithfulness self-test will fail — that test is the contract, not
 *     this comment.
 *   - projectNutrients() — replicates formatKeyNutrients()'s exact
 *     found-vs-fallback branching so a projected nutrient list renders
 *     identically to the full list it was derived from.
 *   - projectFood() / projectFoods() — trims an FdcFood to the fields
 *     find-food.ts's pipeline + format.ts's renderers read: fdcId,
 *     description, dataType, brandOwner, brandName (formatFoodSummary
 *     prefers brandName over brandOwner when both are present), and the
 *     projected foodNutrients.
 *
 * Dependencies: ../../src/fdc-client.js (FdcFood, FdcNutrient types only)
 * State: Stateless — pure functions.
 */

import type { FdcFood, FdcNutrient } from "../../src/fdc-client.js";

// ─── Duplicated priority-nutrient logic (see module header) ──────────────────

const PRIORITY_NUMBERS = new Set(["208", "203", "204", "205", "307", "291", "269"]);
const PRIORITY_IDS = new Set([208, 203, 204, 205, 307, 291, 269]);
const PRIORITY_NAMES = new Set([
  "Energy",
  "Protein",
  "Total lipid (fat)",
  "Carbohydrate, by difference",
  "Sodium, Na",
  "Fiber, total dietary",
  "Sugars, Total",
]);

/** Mirrors format.ts resolveNutrient() — three FDC nutrient shapes -> one tuple. */
function resolveNutrient(n: FdcNutrient): {
  id: number | undefined;
  name: string;
  number: string;
  value: number | undefined;
} {
  if (n.nutrient) {
    return { id: n.nutrient.id, name: n.nutrient.name, number: n.nutrient.number, value: n.amount };
  }
  if (n.nutrientId !== undefined || n.nutrientName !== undefined) {
    return {
      id: n.nutrientId,
      name: n.nutrientName ?? "Unknown",
      number: n.nutrientNumber ?? "",
      value: n.value ?? n.amount,
    };
  }
  return { id: undefined, name: n.name ?? "Unknown", number: n.number ?? "", value: n.amount ?? n.value };
}

function isPriorityWithValue(n: FdcNutrient): boolean {
  const { id, name, number, value } = resolveNutrient(n);
  const isPriority = PRIORITY_NUMBERS.has(number) || (id !== undefined && PRIORITY_IDS.has(id)) || PRIORITY_NAMES.has(name);
  return isPriority && value !== undefined;
}

/**
 * Replicates formatKeyNutrients()'s branch selection exactly:
 *   - If any nutrient is priority+has-a-value, keep ALL such nutrients (in
 *     original relative order — formatKeyNutrients() does its own
 *     order-preserving dedup, which is idempotent over this subset).
 *   - Otherwise (found.length would be 0 in the original), keep the first 5
 *     nutrients verbatim — the exact fallback slice formatKeyNutrients()
 *     takes when nothing priority-matches.
 * This equivalence is what makes the projection byte-faithful; see the
 * module header and eval/run.test.ts.
 */
export function projectNutrients(nutrients: FdcNutrient[] | undefined): FdcNutrient[] | undefined {
  if (!nutrients || nutrients.length === 0) return nutrients;
  const priorityFiltered = nutrients.filter(isPriorityWithValue);
  if (priorityFiltered.length > 0) return priorityFiltered;
  return nutrients.slice(0, 5);
}

/** Fields find-food.ts's pipeline + format.ts's renderers actually read. */
export interface ProjectedFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  foodNutrients?: FdcNutrient[];
}

export function projectFood(food: FdcFood): ProjectedFood {
  const projected: ProjectedFood = {
    fdcId: food.fdcId,
    description: food.description,
  };
  if (food.dataType !== undefined) projected.dataType = food.dataType;
  if (food.brandOwner !== undefined) projected.brandOwner = food.brandOwner;
  if (food.brandName !== undefined) projected.brandName = food.brandName;
  const nutrients = projectNutrients(food.foodNutrients);
  if (nutrients !== undefined) projected.foodNutrients = nutrients;
  return projected;
}

export function projectFoods(foods: FdcFood[]): ProjectedFood[] {
  return foods.map(projectFood);
}
