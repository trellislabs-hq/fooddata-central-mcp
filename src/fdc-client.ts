/**
 * Module: FDC Client
 * Purpose: Typed HTTP client wrapping the USDA FoodData Central REST API.
 *   Handles authentication (API key via X-Api-Key header — never a URL query
 *   param, so it can't leak into logs/proxies/history), error categorization,
 *   response-shape validation, and rate limit awareness. All methods throw
 *   FdcError on non-OK responses.
 *
 * Major Sections:
 *   - Type definitions (API response shapes)
 *   - FdcError / FdcResponseShapeError classes
 *   - FdcClient class with five endpoint methods (search, get, batch get,
 *     list) plus request hardening (timeout, 429 Retry-After, 404->abridged
 *     fallback for getFood, batch response-shape normalization for getFoods)
 *
 * Dependencies: Native fetch (Node 18+)
 * State: Stateless — no caching, no connection pooling
 */

// ─── Type Definitions ────────────────────────────────────────────────────────

export type FdcDataType =
  | "Foundation"
  | "SR Legacy"
  | "Survey (FNDDS)"
  | "Branded";

export type FdcSortBy =
  | "dataType.keyword"
  | "lowercaseDescription.keyword"
  | "fdcId"
  | "publishedDate";

export type FdcSortOrder = "asc" | "desc";

export type FdcFormat = "abridged" | "full";

/**
 * FDC returns two different nutrient object shapes depending on the endpoint and format:
 *
 * Abridged format (GET /food/{id}?format=abridged):
 *   { name, number, amount, unitName, derivationCode, derivationDescription }
 *
 * Full format (GET /food/{id}?format=full):
 *   { type, nutrient: { id, number, name, rank, unitName }, amount, foodNutrientDerivation }
 *
 * Search results (/foods/search) use yet another shape:
 *   { nutrientId, nutrientName, unitName, value }
 *
 * The FdcNutrient interface is a union of all known field names across these shapes.
 */
export interface FdcNutrient {
  // Search result shape
  nutrientId?: number;
  nutrientName?: string;
  nutrientNumber?: string;
  value?: number;
  // Abridged format shape (flat)
  name?: string;
  number?: string;
  amount?: number;
  unitName?: string;
  // Full format shape (nested nutrient sub-object)
  nutrient?: {
    id: number;
    name: string;
    number: string;
    unitName: string;
    rank: number;
  };
}

export interface FdcFood {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  foodNutrients?: FdcNutrient[];
  publishedDate?: string;
  score?: number;
}

export interface FdcSearchResult {
  totalHits: number;
  currentPage: number;
  totalPages: number;
  foods: FdcFood[];
}

export interface FdcSearchParams {
  query: string;
  dataType?: FdcDataType | FdcDataType[];
  pageSize?: number;
  pageNumber?: number;
  sortBy?: FdcSortBy;
  sortOrder?: FdcSortOrder;
  brandOwner?: string;
  nutrients?: number[];
}

export interface FdcGetFoodParams {
  fdcId: number;
  format?: FdcFormat;
  nutrients?: number[];
}

export interface FdcGetFoodsParams {
  fdcIds: number[];
  format?: FdcFormat;
  nutrients?: number[];
}

export interface FdcListParams {
  dataType?: FdcDataType | FdcDataType[];
  pageSize?: number;
  pageNumber?: number;
  sortBy?: FdcSortBy;
  sortOrder?: FdcSortOrder;
}

// ─── Error Class ─────────────────────────────────────────────────────────────

export class FdcError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    message: string,
    public readonly isRateLimit: boolean = false
  ) {
    super(message);
    this.name = "FdcError";
  }
}

/**
 * Thrown when FDC's batch endpoint (/foods) returns a JSON body that is
 * neither an array of foods nor the known zero-resolve `{}` shape (observed
 * live: FDC returns a literal empty object when NONE of the requested IDs
 * resolve to a food, instead of an empty array). The message describes the
 * expected-vs-received shape only — never response body contents, never the
 * API key.
 */
export class FdcResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FdcResponseShapeError";
  }
}

// ─── FDC Client ───────────────────────────────────────────────────────────────

export class FdcClient {
  private readonly baseUrl = "https://api.nal.usda.gov/fdc/v1";
  private readonly apiKey: string;
  /** Fetch timeout for every FDC request (AbortController-driven). */
  private readonly timeoutMs = 10_000;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Replace every occurrence of the API key in a string. Redaction-only —
   * no truncation — so callers can compose it safely.
   */
  private redactKey(text: string): string {
    if (!this.apiKey) return text;
    return text.split(this.apiKey).join("[redacted]");
  }

  /**
   * Redact the API key from any externally sourced text (response bodies,
   * status text, network-layer error messages) before it can reach an error
   * message an MCP user sees. Upstream bodies are hostile input for secrecy
   * purposes — a proxy or the API itself echoing credentials must never
   * propagate them. Redaction happens BEFORE truncation: truncating first
   * could split a key occurrence across the boundary and leak its prefix.
   * The length bound keeps a huge body from flooding the error.
   */
  private sanitize(text: string): string {
    const redacted = this.redactKey(text);
    return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
  }

  /**
   * Recursively redact the API key from every string in a parsed response.
   * Successful FDC payloads are still externally sourced — a hostile or
   * compromised upstream echoing the credential inside food data (description,
   * brand, nutrient names, …) must never reach an MCP user via the formatters.
   * Applied once at the handleResponse seam so every tool (and any future
   * formatter) is covered. JSON.parse output is acyclic, so plain recursion
   * is safe.
   */
  private deepRedact(value: unknown): unknown {
    if (!this.apiKey) return value;
    if (typeof value === "string") return this.redactKey(value);
    if (Array.isArray(value)) return value.map((v) => this.deepRedact(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        // defineProperty (not out[k]=) so a hostile "__proto__" member becomes
        // an ordinary own property instead of mutating the prototype; the
        // member NAME is redacted too — JSON can carry the key anywhere.
        Object.defineProperty(out, this.redactKey(k), {
          value: this.deepRedact(v),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  /**
   * Build a URL from the given path and additional query parameters. The
   * API key is NEVER included here — it is sent via the X-Api-Key header
   * (see fetchWithTimeout) so it never appears in a request URL, and by
   * extension never leaks into access logs, proxies, or browser history.
   */
  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * fetch() wrapper enforcing a 10s timeout via AbortController, attaching
   * the API key via the X-Api-Key header on every request, and retrying
   * once on HTTP 429 honoring the Retry-After header (falls back to a fixed
   * 1s wait if the header is absent or unparsable). Never retries more than
   * once — a persistent 429 should surface to the caller.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    attempt = 0
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // API key transport: X-Api-Key header only (never a URL query param).
    const headers = new Headers(init.headers);
    headers.set("X-Api-Key", this.apiKey);

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new FdcError(
          0,
          "Timeout",
          `FDC API request timed out after ${this.timeoutMs / 1000}s.`
        );
      }
      // Network-layer errors are externally sourced text (proxies can echo
      // request headers) — sanitize before the message can reach an MCP user.
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw new FdcError(0, "Network error", `FDC API request failed: ${this.sanitize(rawMessage)}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429 && attempt === 0) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const waitMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
          ? retryAfterSeconds * 1000
          : 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.fetchWithTimeout(url, init, attempt + 1);
    }

    return response;
  }

  /**
   * Handle a fetch Response — throw FdcError on non-2xx status.
   * Rate limit responses (429) get flagged so callers can surface a helpful message.
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        // A malformed 2xx body is external text, and the parser error quotes a
        // TRUNCATED excerpt of it (e.g. `Unexpected token 'o', "totally-fak"...`)
        // — truncation can split the key so redaction cannot match. The only
        // safe message is a static one that carries zero upstream text.
        throw new FdcError(
          response.status,
          "Invalid JSON",
          "FDC API returned a malformed JSON body (not valid JSON)."
        );
      }
      return this.deepRedact(parsed) as T;
    }

    const isRateLimit = response.status === 429;
    // Body and status text are externally sourced — sanitize (redact the API
    // key, bound length) before they can appear in an error an MCP user sees.
    const bodyText = this.sanitize(await response.text().catch(() => ""));
    const statusText = this.sanitize(response.statusText);

    let message: string;
    if (isRateLimit) {
      message =
        "FDC API rate limit exceeded. DEMO_KEY allows 30 req/hr; register at https://fdc.nal.usda.gov/api-guide for 1000 req/hr.";
    } else if (response.status === 404) {
      message = `Food not found (HTTP 404). The FDC ID may not exist.`;
    } else if (response.status === 400) {
      message = `Bad request (HTTP 400): ${bodyText || "Check your query parameters."}`;
    } else {
      message = `FDC API error ${response.status} ${statusText}: ${bodyText}`;
    }

    throw new FdcError(response.status, statusText, message, isRateLimit);
  }

  /**
   * Search for foods by keyword/name.
   * Uses POST /foods/search for full parameter support.
   */
  async searchFoods(params: FdcSearchParams): Promise<FdcSearchResult> {
    const url = this.buildUrl("/foods/search");

    // Normalize dataType to array for the POST body
    const dataType = params.dataType
      ? Array.isArray(params.dataType)
        ? params.dataType
        : [params.dataType]
      : undefined;

    const body = {
      query: params.query,
      ...(dataType && { dataType }),
      ...(params.pageSize !== undefined && { pageSize: params.pageSize }),
      ...(params.pageNumber !== undefined && { pageNumber: params.pageNumber }),
      ...(params.sortBy && { sortBy: params.sortBy }),
      ...(params.sortOrder && { sortOrder: params.sortOrder }),
      ...(params.brandOwner && { brandOwner: params.brandOwner }),
      ...(params.nutrients && { nutrients: params.nutrients }),
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.handleResponse<FdcSearchResult>(response);
  }

  /**
   * Get full details (including all nutrients) for a single food by FDC ID.
   *
   * Hardening: some Foundation records 404 on full-format detail even though
   * the record exists and is searchable (observed for FDC IDs 328637 and
   * 746767 — confirmed with both DEMO_KEY and a registered key; see
   * tests/fixtures/README.md). When the caller requested (or defaulted to)
   * "full" format and the request 404s, this method retries ONCE with
   * format=abridged. `usedFallback` is set to true when that happened so
   * callers can note it in output. If both requests 404, the original
   * full-format error is thrown, with a message steering the caller to
   * re-run search_foods/find_food (the ID may have been superseded).
   */
  async getFood(
    params: FdcGetFoodParams
  ): Promise<{ food: FdcFood; usedFallback: boolean }> {
    const requestedFormat = params.format ?? "full";

    const fetchOnce = async (format: FdcFormat): Promise<Response> => {
      const queryParams: Record<string, string> = { format };
      const url = this.buildUrl(`/food/${params.fdcId}`, queryParams);

      // FDC GET endpoint expects repeated query params for nutrients: ?nutrients=208&nutrients=203
      const urlObj = new URL(url);
      if (params.nutrients?.length) {
        for (const n of params.nutrients) {
          urlObj.searchParams.append("nutrients", String(n));
        }
      }

      return this.fetchWithTimeout(urlObj.toString());
    };

    const response = await fetchOnce(requestedFormat);

    if (response.status === 404 && requestedFormat === "full") {
      const fallbackResponse = await fetchOnce("abridged");
      if (fallbackResponse.status === 404) {
        // Both formats 404 — surface the original 404 with better guidance.
        throw new FdcError(
          404,
          "Not Found",
          `Food not found (HTTP 404) for FDC ID ${params.fdcId}, even after retrying with abridged format. ` +
            `The ID may have been superseded or removed. Try re-running search_foods or find_food to get a current FDC ID.`
        );
      }
      // Any other fallback outcome (200, 429, 5xx) goes through the normal funnel so
      // a rate-limit or server error on the retry is never misreported as a 404.
      const food = await this.handleResponse<FdcFood>(fallbackResponse);
      return { food, usedFallback: true };
    }

    const food = await this.handleResponse<FdcFood>(response);
    return { food, usedFallback: false };
  }

  /**
   * Batch retrieval of up to 20 foods by FDC ID.
   *
   * Hardening: FDC's batch endpoint is proven (live-corpus, ~1,604 refs) to
   * return a literal `{}` — not `[]` — when ZERO of the requested IDs
   * resolve to a food. That shape is coerced to `[]` here so callers get a
   * consistent array contract. Any other non-array shape (null, string,
   * number, boolean, non-empty object) is a genuinely unexpected response
   * and throws FdcResponseShapeError rather than surfacing a confusing
   * downstream TypeError (e.g. `foods.map is not a function`).
   */
  async getFoods(params: FdcGetFoodsParams): Promise<FdcFood[]> {
    // FDC enforces a 20-ID batch limit
    if (params.fdcIds.length > 20) {
      throw new Error("Batch lookup is limited to 20 FDC IDs per request.");
    }

    const url = this.buildUrl("/foods");

    const body = {
      fdcIds: params.fdcIds,
      ...(params.format && { format: params.format }),
      ...(params.nutrients?.length && { nutrients: params.nutrients }),
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await this.handleResponse<unknown>(response);
    return this.normalizeFoodsResponse(data);
  }

  /**
   * Validate and normalize the batch endpoint's JSON body into an array of
   * foods. See getFoods() doc comment for the `{}` zero-resolve pathology
   * this guards against.
   */
  private normalizeFoodsResponse(data: unknown): FdcFood[] {
    if (Array.isArray(data)) {
      return data as FdcFood[];
    }

    if (
      data !== null &&
      typeof data === "object" &&
      Object.keys(data as Record<string, unknown>).length === 0
    ) {
      return [];
    }

    const receivedShape = data === null ? "null" : typeof data;
    throw new FdcResponseShapeError(
      `FDC batch endpoint (/foods) returned an unexpected response shape. ` +
        `Expected an array of foods (or an empty object when zero requested IDs resolve), ` +
        `but received: ${receivedShape}.`
    );
  }

  /**
   * Browse the full FoodData Central catalog with pagination.
   * Useful for exploring available foods by dataType.
   */
  async listFoods(params: FdcListParams = {}): Promise<FdcFood[]> {
    const url = this.buildUrl("/foods/list");

    // Normalize dataType to array for POST body
    const dataType = params.dataType
      ? Array.isArray(params.dataType)
        ? params.dataType
        : [params.dataType]
      : undefined;

    const body = {
      ...(dataType && { dataType }),
      ...(params.pageSize !== undefined && { pageSize: params.pageSize }),
      ...(params.pageNumber !== undefined && { pageNumber: params.pageNumber }),
      ...(params.sortBy && { sortBy: params.sortBy }),
      ...(params.sortOrder && { sortOrder: params.sortOrder }),
    };

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.handleResponse<FdcFood[]>(response);
  }
}
