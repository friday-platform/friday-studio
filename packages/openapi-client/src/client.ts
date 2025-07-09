import createClient from "openapi-fetch";
import type { paths } from "./atlasd-types.gen.d.ts";

export interface AtlasClientConfig {
  baseUrl?: string;
  headers?: Record<string, string>;
  // Additional fetch options
  fetchOptions?: RequestInit;
}

/**
 * Create a typed Atlas daemon API client
 * Returns the bare openapi-fetch client with full type safety
 */
export function createAtlasClient(config: AtlasClientConfig = {}) {
  const baseUrl = config.baseUrl || "http://localhost:8080";

  return createClient<paths>({
    baseUrl,
    headers: config.headers,
    ...config.fetchOptions,
  });
}

export type AtlasClient = ReturnType<typeof createAtlasClient>;
