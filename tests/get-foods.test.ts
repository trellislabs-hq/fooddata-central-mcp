/**
 * Module: get-foods.test.ts
 * Purpose: Unit tests for src/get-foods.ts — the get_foods reconciliation
 *   core. Covers the {} zero-resolve confirmation re-batch, silent-omission
 *   recovery (merge order), still-missing reporting (first-requested
 *   order), duplicate-id dedup (N-of-M over unique ids), format/nutrients
 *   preservation across the confirmation re-batch, and the unchanged-on-
 *   full-success contract. All network calls are mocked; never hits the
 *   live API.
 * Dependencies: node:test, node:assert, ../src/fdc-client.ts,
 *   ../src/get-foods.ts, ../src/format.ts, ./helpers/mock-fetch.ts
 * State: All synthetic responses (no live-API fixtures needed here — the
 *   pathologies themselves are documented as live-corpus-proven in
 *   src/fdc-client.ts doc comments).
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FdcClient, type FdcFood } from "../src/fdc-client.js";
import { buildGetFoodsResult } from "../src/get-foods.js";
import { formatFoodDetail } from "../src/format.js";
import { jsonResponse, installFetchMock } from "./helpers/mock-fetch.js";

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

function food(fdcId: number): FdcFood {
  return { fdcId, description: `Food ${fdcId}`, dataType: "Foundation" };
}

function requestedBody(init?: RequestInit): { fdcIds: number[]; format?: string; nutrients?: number[] } {
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("buildGetFoodsResult — {} zero-resolve pathology", () => {
  test("issues exactly TWO batch calls (primary + one confirmation) then the friendly no-foods result", async () => {
    let callCount = 0;
    restoreFetch = installFetchMock(() => {
      callCount += 1;
      return jsonResponse({});
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await buildGetFoodsResult(client, { fdcIds: [1, 2, 3] });

    assert.equal(callCount, 2, "expected primary call + exactly one confirmation re-batch");
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].text, "No foods found for the requested IDs");
  });
});

describe("buildGetFoodsResult — transport contract on reconciliation batches", () => {
  test("both the primary batch and the confirmation re-batch use header-only key transport", async () => {
    const FAKE = "totally-fake-recon-key-42";
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    restoreFetch = installFetchMock((url, init) => {
      captured.push({ url, init });
      // Primary omits id 2; re-batch recovers nothing.
      return captured.length === 1 ? jsonResponse([food(1)]) : jsonResponse([]);
    });

    const client = new FdcClient(FAKE);
    await buildGetFoodsResult(client, { fdcIds: [1, 2] });

    assert.equal(captured.length, 2, "expected primary + one confirmation re-batch");
    for (const req of captured) {
      assert.doesNotMatch(req.url, new RegExp(FAKE), `URL leaked the key: ${req.url}`);
      assert.doesNotMatch(req.url, /api_key=/, `URL uses api_key param: ${req.url}`);
      const headers = new Headers(req.init?.headers);
      assert.equal(headers.get("X-Api-Key"), FAKE, `missing X-Api-Key on ${req.url}`);
      assert.equal(headers.get("Content-Type"), "application/json");
    }
  });
});

describe("buildGetFoodsResult — silent omission reconciliation", () => {
  test("recovers an omitted id via confirmation re-batch; merge order is primary then recovered", async () => {
    let callCount = 0;
    const requestedIds = [100, 200, 300];
    restoreFetch = installFetchMock((_url, init) => {
      callCount += 1;
      const body = requestedBody(init);
      if (callCount === 1) {
        assert.deepEqual(body.fdcIds, requestedIds);
        // FDC silently omits 200 from the mixed batch.
        return jsonResponse([food(100), food(300)]);
      }
      assert.deepEqual(body.fdcIds, [200]);
      return jsonResponse([food(200)]);
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await buildGetFoodsResult(client, { fdcIds: requestedIds });

    assert.equal(callCount, 2);
    assert.equal(result.isError, undefined);

    const expectedText =
      `Batch results for 3 food(s):\n\n` +
      [food(100), food(300), food(200)].map(formatFoodDetail).join("\n\n");
    assert.equal(result.content[0].text, expectedText);
    assert.doesNotMatch(result.content[0].text, /did not return/i);
  });

  test("reports still-missing ids in first-requested order when the confirmation re-batch doesn't recover them", async () => {
    let callCount = 0;
    const requestedIds = [10, 20, 30, 40];
    restoreFetch = installFetchMock((_url, init) => {
      callCount += 1;
      if (callCount === 1) {
        // 20 and 40 omitted from the primary batch.
        return jsonResponse([food(10), food(30)]);
      }
      const body = requestedBody(init);
      assert.deepEqual(body.fdcIds, [20, 40]);
      // Confirmation re-batch recovers 20 but still omits 40.
      return jsonResponse([food(20)]);
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await buildGetFoodsResult(client, { fdcIds: requestedIds });

    assert.equal(callCount, 2);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /FDC did not return 1 of 4 requested foods: 40/);
    assert.match(result.content[0].text, /Batch results for 3 food\(s\)/);
  });

  test("full success requires only ONE call and the response is unchanged", async () => {
    let callCount = 0;
    restoreFetch = installFetchMock(() => {
      callCount += 1;
      return jsonResponse([food(1), food(2)]);
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await buildGetFoodsResult(client, { fdcIds: [1, 2] });

    assert.equal(callCount, 1, "no confirmation re-batch should occur when nothing is missing");
    const expectedText =
      `Batch results for 2 food(s):\n\n` + [food(1), food(2)].map(formatFoodDetail).join("\n\n");
    assert.equal(result.content[0].text, expectedText);
  });

  test("deduplicates requested ids in first-seen order — re-batch never repeats ids, N-of-M is over unique ids", async () => {
    let callCount = 0;
    const calls: number[][] = [];
    restoreFetch = installFetchMock((_url, init) => {
      callCount += 1;
      const body = requestedBody(init);
      calls.push(body.fdcIds);
      if (callCount === 1) {
        // 2 and 3 omitted from the primary batch.
        return jsonResponse([food(1)]);
      }
      // Confirmation re-batch recovers 3 but still omits 2.
      return jsonResponse([food(3)]);
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await buildGetFoodsResult(client, { fdcIds: [1, 2, 3, 2, 1] });

    assert.equal(callCount, 2);
    assert.deepEqual(calls[0], [1, 2, 3], "primary call should be deduped, first-seen order");
    assert.deepEqual(calls[1], [2, 3], "confirmation re-batch should request only missing unique ids, no repeats");
    assert.match(result.content[0].text, /FDC did not return 1 of 3 requested foods: 2/);
  });

  test("confirmation re-batch preserves the same format and nutrients as the primary call", async () => {
    let callCount = 0;
    const bodies: Array<{ fdcIds: number[]; format?: string; nutrients?: number[] }> = [];
    restoreFetch = installFetchMock((_url, init) => {
      callCount += 1;
      bodies.push(requestedBody(init));
      if (callCount === 1) return jsonResponse([food(1)]);
      return jsonResponse([food(2)]);
    });

    const client = new FdcClient("DEMO_KEY");
    await buildGetFoodsResult(client, {
      fdcIds: [1, 2],
      format: "abridged",
      nutrients: [208, 203],
    });

    assert.equal(callCount, 2);
    assert.equal(bodies[0].format, "abridged");
    assert.deepEqual(bodies[0].nutrients, [208, 203]);
    assert.equal(bodies[1].format, "abridged");
    assert.deepEqual(bodies[1].nutrients, [208, 203]);
    assert.deepEqual(bodies[1].fdcIds, [2]);
  });
});
