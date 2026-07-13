/**
 * Module: fdc-client.test.ts
 * Purpose: Unit tests for src/fdc-client.ts hardening — the get_food 404
 *   -> abridged fallback (recorded fixture proof), 429 Retry-After handling,
 *   and error mapping. All network calls are mocked; never hits the live API.
 * Dependencies: node:test, node:assert, ../src/fdc-client.ts, ./helpers/mock-fetch.ts
 * State: Uses recorded fixtures for the 404->abridged case (see
 *   tests/fixtures/README.md fact #3); synthetic responses elsewhere (labeled).
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FdcClient, FdcError, FdcResponseShapeError } from "../src/fdc-client.js";
import { loadFixture, jsonResponse, emptyResponse, installFetchMock } from "./helpers/mock-fetch.js";

// Distinct, obviously-fake key used throughout — never a real credential —
// so tests can grep for it in URLs/messages without any risk of matching
// real secret material.
const FAKE_KEY = "totally-fake-test-key-999";

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  if (restoreFetch) {
    restoreFetch();
    restoreFetch = null;
  }
});

describe("FdcClient.getFood — 404 -> abridged fallback (recorded fixture proof)", () => {
  test("falls back to abridged and reports usedFallback=true when full-format 404s", async () => {
    const abridgedFixture = loadFixture("food-328637.detail-abridged.json");

    restoreFetch = installFetchMock((url) => {
      if (url.includes("format=full") || !url.includes("format=")) {
        // Full format (default) 404s with an empty body — matches the
        // recorded live-API quirk documented in tests/fixtures/README.md.
        return emptyResponse(404);
      }
      if (url.includes("format=abridged")) {
        return jsonResponse(abridgedFixture);
      }
      throw new Error(`Unexpected URL in mock: ${url}`);
    });

    const client = new FdcClient("DEMO_KEY");
    const { food, usedFallback } = await client.getFood({ fdcId: 328637, format: "full" });

    assert.equal(usedFallback, true);
    assert.equal(food.fdcId, 328637);
    assert.equal(food.description, "Cheese, cheddar");
    assert.equal(food.dataType, "Foundation");
  });

  test("throws a re-search-suggesting error when BOTH full and abridged 404", async () => {
    restoreFetch = installFetchMock(() => emptyResponse(404));

    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFood({ fdcId: 999999999, format: "full" }),
      (err: unknown) => {
        assert.ok(err instanceof FdcError);
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /re-run(?:ning)? search_foods or find_food/i);
        assert.match(err.message, /superseded/i);
        return true;
      }
    );
  });

  test("does not retry with abridged when the caller explicitly requested abridged", async () => {
    let callCount = 0;
    restoreFetch = installFetchMock((url) => {
      callCount += 1;
      assert.ok(url.includes("format=abridged"));
      return emptyResponse(404);
    });

    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(() => client.getFood({ fdcId: 1, format: "abridged" }));
    assert.equal(callCount, 1, "abridged requests should not trigger a further fallback retry");
  });
});

describe("FdcClient — 429 Retry-After handling", () => {
  // Uses real (but tiny — 0s) Retry-After waits rather than mocked timers:
  // node:test's MockTimers replaces the global timer implementation used
  // internally by fetch/AbortController too, which caused real hangs when
  // combined with this client's abort-timeout setTimeout. A 0s Retry-After
  // keeps these tests fast without that interaction.
  test("retries once honoring Retry-After header, then succeeds", async () => {
    let callCount = 0;
    restoreFetch = installFetchMock(() => {
      callCount += 1;
      if (callCount === 1) {
        return emptyResponse(429, { "Retry-After": "0" });
      }
      return jsonResponse({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });
    });

    const client = new FdcClient("DEMO_KEY");
    const result = await client.searchFoods({ query: "test" });

    assert.equal(callCount, 2);
    assert.equal(result.totalHits, 0);
  });

  test("does not retry more than once on persistent 429", async () => {
    let callCount = 0;
    restoreFetch = installFetchMock(() => {
      callCount += 1;
      return emptyResponse(429, { "Retry-After": "0" });
    });

    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(() => client.searchFoods({ query: "test" }));

    assert.equal(callCount, 2, "should attempt once, retry once, then give up (2 total calls)");
  });
});

describe("FdcClient — error mapping", () => {
  test("maps 400 to a bad-request FdcError", async () => {
    restoreFetch = installFetchMock(() => new Response("bad query", { status: 400 }));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.searchFoods({ query: "test" }),
      (err: unknown) => {
        assert.ok(err instanceof FdcError);
        assert.equal(err.statusCode, 400);
        return true;
      }
    );
  });

  test("maps non-standard 5xx to a generic FdcError", async () => {
    restoreFetch = installFetchMock(() => new Response("server error", { status: 500 }));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.searchFoods({ query: "test" }),
      (err: unknown) => {
        assert.ok(err instanceof FdcError);
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });
});

describe("FdcClient — header-only API key transport", () => {
  test("never appends the API key to the request URL, across every endpoint", async () => {
    const capturedUrls: string[] = [];
    restoreFetch = installFetchMock((url) => {
      capturedUrls.push(url);
      return jsonResponse({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });
    });

    const client = new FdcClient(FAKE_KEY);
    await client.searchFoods({ query: "cheddar" }).catch(() => {});
    restoreFetch();

    restoreFetch = installFetchMock((url) => {
      capturedUrls.push(url);
      return jsonResponse({ fdcId: 1, description: "test" });
    });
    await client.getFood({ fdcId: 1 }).catch(() => {});
    restoreFetch();

    restoreFetch = installFetchMock((url) => {
      capturedUrls.push(url);
      return jsonResponse([]);
    });
    await client.getFoods({ fdcIds: [1] }).catch(() => {});
    restoreFetch();

    restoreFetch = installFetchMock((url) => {
      capturedUrls.push(url);
      return jsonResponse([]);
    });
    await client.listFoods().catch(() => {});

    assert.ok(capturedUrls.length > 0, "expected at least one captured URL");
    for (const url of capturedUrls) {
      assert.doesNotMatch(url, new RegExp(FAKE_KEY), `URL leaked the API key: ${url}`);
      assert.doesNotMatch(url, /api_key=/, `URL still uses the api_key query param: ${url}`);
    }
  });

  test("sends the API key via the X-Api-Key header on every request", async () => {
    const capturedHeaders: Headers[] = [];
    restoreFetch = installFetchMock((url, init) => {
      capturedHeaders.push(new Headers(init?.headers));
      return jsonResponse({ totalHits: 0, currentPage: 1, totalPages: 0, foods: [] });
    });

    const client = new FdcClient(FAKE_KEY);
    await client.searchFoods({ query: "cheddar" });

    assert.equal(capturedHeaders.length, 1);
    assert.equal(capturedHeaders[0].get("X-Api-Key"), FAKE_KEY);
  });

  test("never includes the API key in a thrown error message", async () => {
    restoreFetch = installFetchMock(() => new Response("upstream failure", { status: 500 }));
    const client = new FdcClient(FAKE_KEY);

    await assert.rejects(
      () => client.searchFoods({ query: "test" }),
      (err: unknown) => {
        assert.ok(err instanceof FdcError);
        assert.doesNotMatch(err.message, new RegExp(FAKE_KEY));
        return true;
      }
    );
  });
});

describe("FdcClient.getFoods — response shape validation", () => {
  test("coerces a zero-key {} response (FDC's zero-resolve pathology) to []", async () => {
    restoreFetch = installFetchMock(() => jsonResponse({}));
    const client = new FdcClient("DEMO_KEY");
    const foods = await client.getFoods({ fdcIds: [1, 2, 3] });
    assert.deepEqual(foods, []);
  });

  test("passes through a normal array response unchanged", async () => {
    const body = [
      { fdcId: 1, description: "Food One" },
      { fdcId: 2, description: "Food Two" },
    ];
    restoreFetch = installFetchMock(() => jsonResponse(body));
    const client = new FdcClient("DEMO_KEY");
    const foods = await client.getFoods({ fdcIds: [1, 2] });
    assert.deepEqual(foods, body);
  });

  test("throws FdcResponseShapeError for a null body", async () => {
    restoreFetch = installFetchMock(() => jsonResponse(null));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFoods({ fdcIds: [1] }),
      (err: unknown) => {
        assert.ok(err instanceof FdcResponseShapeError);
        assert.match(err.message, /expected an array/i);
        return true;
      }
    );
  });

  test("throws FdcResponseShapeError for a string body", async () => {
    restoreFetch = installFetchMock(() => jsonResponse("unexpected"));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFoods({ fdcIds: [1] }),
      (err: unknown) => err instanceof FdcResponseShapeError
    );
  });

  test("throws FdcResponseShapeError for a number body", async () => {
    restoreFetch = installFetchMock(() => jsonResponse(42));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFoods({ fdcIds: [1] }),
      (err: unknown) => err instanceof FdcResponseShapeError
    );
  });

  test("throws FdcResponseShapeError for a boolean body", async () => {
    restoreFetch = installFetchMock(() => jsonResponse(true));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFoods({ fdcIds: [1] }),
      (err: unknown) => err instanceof FdcResponseShapeError
    );
  });

  test("throws FdcResponseShapeError for a non-empty object body", async () => {
    restoreFetch = installFetchMock(() => jsonResponse({ error: "not an array" }));
    const client = new FdcClient("DEMO_KEY");
    await assert.rejects(
      () => client.getFoods({ fdcIds: [1] }),
      (err: unknown) => {
        assert.ok(err instanceof FdcResponseShapeError);
        // Message must describe shape only — never echo body contents.
        assert.doesNotMatch(err.message, /not an array/);
        return true;
      }
    );
  });
});
