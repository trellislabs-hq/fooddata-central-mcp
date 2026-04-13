/**
 * Module: FDC Client
 * Purpose: Typed HTTP client wrapping the USDA FoodData Central REST API.
 *   Handles authentication (API key as query param), error categorization,
 *   and rate limit awareness. All methods throw FdcError on non-OK responses.
 *
 * Major Sections:
 *   - Type definitions (API response shapes)
 *   - FdcError class
 *   - FdcClient class with four endpoint methods
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

// ─── FDC Client ───────────────────────────────────────────────────────────────

export class FdcClient {
  private readonly baseUrl = "https://api.nal.usda.gov/fdc/v1";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Build a URL with the API key and any additional query parameters.
   * API key is always appended as a query param (FDC's auth mechanism).
   */
  private buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Handle a fetch Response — throw FdcError on non-2xx status.
   * Rate limit responses (429) get flagged so callers can surface a helpful message.
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.json() as Promise<T>;
    }

    const isRateLimit = response.status === 429;
    const bodyText = await response.text().catch(() => "");

    let message: string;
    if (isRateLimit) {
      message =
        "FDC API rate limit exceeded. DEMO_KEY allows 30 req/hr; register at https://fdc.nal.usda.gov/api-guide for 1000 req/hr.";
    } else if (response.status === 404) {
      message = `Food not found (HTTP 404). The FDC ID may not exist.`;
    } else if (response.status === 400) {
      message = `Bad request (HTTP 400): ${bodyText || "Check your query parameters."}`;
    } else {
      message = `FDC API error ${response.status} ${response.statusText}: ${bodyText}`;
    }

    throw new FdcError(response.status, response.statusText, message, isRateLimit);
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.handleResponse<FdcSearchResult>(response);
  }

  /**
   * Get full details (including all nutrients) for a single food by FDC ID.
   */
  async getFood(params: FdcGetFoodParams): Promise<FdcFood> {
    const queryParams: Record<string, string> = {};
    if (params.format) queryParams["format"] = params.format;
    const url = this.buildUrl(`/food/${params.fdcId}`, queryParams);

    // FDC GET endpoint expects repeated query params for nutrients: ?nutrients=208&nutrients=203
    const urlObj = new URL(url);
    if (params.nutrients?.length) {
      for (const n of params.nutrients) {
        urlObj.searchParams.append("nutrients", String(n));
      }
    }

    const response = await fetch(urlObj.toString());
    return this.handleResponse<FdcFood>(response);
  }

  /**
   * Batch retrieval of up to 20 foods by FDC ID.
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.handleResponse<FdcFood[]>(response);
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

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.handleResponse<FdcFood[]>(response);
  }
}
