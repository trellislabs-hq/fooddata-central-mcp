/**
 * Module: mock-fetch test helper
 * Purpose: Small helper for stubbing global fetch in tests against recorded
 *   fixtures (or synthetic responses for error/edge-case paths). Never makes
 *   a real network call.
 * Dependencies: node:fs, node:path
 * State: Stateless — each call returns a fresh handler; caller restores
 *   global.fetch in a `finally`/after-hook.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

export function loadFixture(filename: string): unknown {
  const raw = readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
  return JSON.parse(raw);
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

/**
 * Install a fetch mock backed by a queue of responses (or a function that
 * receives the request URL/init and returns a Response). Returns a restore
 * function; callers MUST call it (ideally in a try/finally) to avoid leaking
 * the mock into other tests.
 */
export function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): () => void {
  const original = global.fetch;
  global.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    global.fetch = original;
  };
}
