/**
 * Module: get_foods reconciliation core
 * Purpose: Extracted, testable core for the get_foods tool handler
 *   (src/index.ts). Wraps FdcClient.getFoods with reconciliation against two
 *   live-corpus-proven FDC pathologies: (1) a literal `{}` response when
 *   ZERO requested IDs resolve, already normalized to `[]` by
 *   FdcClient.getFoods itself, and (2) silent omission of real matched IDs
 *   from mixed batches (~7% observed on a 1,604-ref live corpus). On any
 *   missing IDs, issues exactly ONE confirmation re-batch (same format and
 *   nutrients as the primary call, only fdcIds narrowed to the missing set)
 *   before reporting anything still missing.
 *
 * Major Sections:
 *   - GetFoodsArgs / ToolResult types
 *   - dedupeFoodsByFdcId() — merge helper, normalized-fdcId dedup
 *   - buildGetFoodsResult() — the extracted core; get_foods handler in
 *     src/index.ts calls this directly instead of client.getFoods()
 *
 * Dependencies: ./fdc-client.ts (FdcClient, FdcFood, FdcFormat), ./format.ts
 *   (formatFoodDetail, formatError)
 * State: Stateless — pure orchestration over the injected FdcClient. Never
 *   throws — all errors are caught and returned as an isError tool result,
 *   matching the contract every other tool handler in src/index.ts follows.
 */

import type { FdcClient, FdcFood, FdcFormat } from "./fdc-client.js";
import { formatFoodDetail, formatError } from "./format.js";

export interface GetFoodsArgs {
  fdcIds: number[];
  format?: FdcFormat;
  nutrients?: number[];
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/**
 * Deduplicate a list of foods by normalized (String()) fdcId, keeping the
 * first occurrence. Used to merge primary + recovered results — primary
 * results are listed first, so this naturally prefers the primary copy of
 * any food that (implausibly) appears in both batches.
 */
function dedupeFoodsByFdcId(foods: FdcFood[]): FdcFood[] {
  const seen = new Set<string>();
  const result: FdcFood[] = [];
  for (const food of foods) {
    const key = String(food.fdcId);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(food);
    }
  }
  return result;
}

/**
 * Reconciled batch lookup for the get_foods tool.
 *
 * Steps:
 *  1. Normalize requested IDs with String() and deduplicate in first-seen
 *     order — N-of-M reporting below is over UNIQUE requested ids.
 *  2. Call FdcClient.getFoods with the unique ids (the "primary" call).
 *  3. Diff unique-requested vs what FDC actually returned.
 *  4. If anything is missing, issue exactly ONE confirmation re-batch for
 *     only the missing ids, passing the SAME format/nutrients as the
 *     primary call.
 *  5. Merge (primary results then recovered results), deduplicating by
 *     normalized fdcId.
 *  6. If the merged result is empty, return a normal (non-error) friendly
 *     "no foods found" result. Otherwise format the batch, appending a
 *     still-missing note (first-requested order) if applicable — when
 *     nothing was ever missing, the response text is unchanged from the
 *     pre-reconciliation behavior.
 */
export async function buildGetFoodsResult(
  client: FdcClient,
  args: GetFoodsArgs
): Promise<ToolResult> {
  const format = args.format ?? "full";

  try {
    // Step 1: normalize + dedupe requested ids, first-seen order.
    const uniqueIds: number[] = [];
    const seenIds = new Set<string>();
    for (const id of args.fdcIds) {
      const key = String(id);
      if (!seenIds.has(key)) {
        seenIds.add(key);
        uniqueIds.push(id);
      }
    }

    // Step 2: primary call.
    const primaryFoods = await client.getFoods({
      fdcIds: uniqueIds,
      format,
      nutrients: args.nutrients,
    });

    // Step 3: diff.
    const primaryReturnedIds = new Set(primaryFoods.map((f) => String(f.fdcId)));
    const missingIds = uniqueIds.filter((id) => !primaryReturnedIds.has(String(id)));

    let allFoods = primaryFoods;

    // Step 4-5: confirmation re-batch + merge, only when something is missing.
    if (missingIds.length > 0) {
      const recoveredFoods = await client.getFoods({
        fdcIds: missingIds,
        format,
        nutrients: args.nutrients,
      });
      allFoods = dedupeFoodsByFdcId([...primaryFoods, ...recoveredFoods]);
    }

    // Still-missing ids, in first-requested order (first-seen order of uniqueIds).
    const finalReturnedIds = new Set(allFoods.map((f) => String(f.fdcId)));
    const stillMissingIds = uniqueIds.filter((id) => !finalReturnedIds.has(String(id)));

    // Step 6: build the response.
    if (allFoods.length === 0) {
      return {
        content: [{ type: "text", text: "No foods found for the requested IDs" }],
      };
    }

    const output = allFoods.map(formatFoodDetail).join("\n\n");
    const missingNote =
      stillMissingIds.length > 0
        ? `\n\nFDC did not return ${stillMissingIds.length} of ${uniqueIds.length} requested foods: ${stillMissingIds.join(", ")}`
        : "";

    return {
      content: [
        {
          type: "text",
          text: `Batch results for ${allFoods.length} food(s):\n\n${output}${missingNote}`,
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
