import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./atlasd-types.gen.d.ts";
import { getAtlasDaemonUrl } from "./utils.ts";

/**
 * Create a typed Atlas daemon API client
 * Returns the bare openapi-fetch client with full type safety
 */
export function createAtlasClient(config: ClientOptions = {}) {
  const baseUrl = config.baseUrl || getAtlasDaemonUrl();

  return createClient<paths>({ baseUrl, headers: config.headers, ...config });
}

export type AtlasClient = ReturnType<typeof createAtlasClient>;
