/**
 * @atlas/oapi-client - Type-safe client for the Atlas daemon API
 * @module
 */

// Re-export types for direct usage
export type { components, paths } from "./src/atlasd-types.gen.d.ts";
export { type AtlasClient, createAtlasClient } from "./src/client.ts";

// Default client instance for common use cases
import { createAtlasClient } from "./src/client.ts";
export const defaultClient = createAtlasClient();
