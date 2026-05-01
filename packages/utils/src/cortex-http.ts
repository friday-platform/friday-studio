import process from "node:process";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface CortexRequestOptions {
  /** Parse response as JSON. Defaults to false (returns text). */
  parseJson?: boolean;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
}

/**
 * Get the FRIDAY_KEY from environment for Cortex authentication.
 * Throws if not available.
 */
export function getCortexAuthToken(): string {
  const token = process.env.FRIDAY_KEY;
  if (!token) {
    throw new Error("FRIDAY_KEY not available for Cortex authentication");
  }
  return token;
}

/**
 * Makes an authenticated HTTP request to a Cortex endpoint.
 *
 * Features:
 * - JWT authentication via FRIDAY_KEY
 * - Request timeout with AbortController
 * - Consistent error handling for 401, 404, 503
 * - Optional JSON parsing
 *
 * @param baseUrl - The Cortex service base URL (trailing slashes stripped)
 * @param method - HTTP method
 * @param endpoint - API endpoint path (e.g., "/objects")
 * @param body - Request body (strings sent as-is, objects JSON.stringify'd)
 * @param options - Request options
 * @returns Response data or null for 404
 */
export async function cortexRequest<T>(
  baseUrl: string,
  method: string,
  endpoint: string,
  body?: unknown,
  options: CortexRequestOptions = {},
): Promise<T | null> {
  const { parseJson = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getCortexAuthToken()}`,
      },
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });

    if (response.status === 401) {
      await response.text(); // Consume body to prevent resource leak
      throw new Error("Authentication failed: invalid FRIDAY_KEY");
    }

    if (response.status === 503) {
      await response.text(); // Consume body to prevent resource leak
      throw new Error("Cortex service unavailable");
    }

    if (response.status === 404) {
      await response.text(); // Consume body to prevent resource leak
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    if (parseJson) {
      return (await response.json()) as T;
    }
    return (await response.text()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
