/**
 * ACP Client using openapi-fetch
 *
 * This provides a type-safe ACP client using openapi-fetch with our generated types
 * for maximum type safety and excellent Deno compatibility.
 */

import createClient from "npm:openapi-fetch";
import type { paths } from "./types.gen.ts";

// Re-export convenient type aliases for the client
export type {
  ACPAgent,
  ACPAgentName,
  ACPError,
  ACPEvent,
  ACPMessage,
  ACPMessagePart,
  ACPRun,
  ACPRunCreateRequest,
  ACPRunId,
  ACPRunMode,
  ACPRunStatus,
  ACPSessionId,
} from "./index.ts";

export interface ACPClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * Create a type-safe ACP client using openapi-fetch
 *
 * @param config Client configuration including baseUrl and optional headers
 * @returns Type-safe ACP client with full OpenAPI spec compliance
 *
 * @example
 * ```typescript
 * const client = createACPClient({
 *   baseUrl: "https://api.example.com",
 *   headers: {
 *     "Authorization": "Bearer token123"
 *   }
 * });
 *
 * // All methods are fully type-safe
 * const agents = await client.GET("/agents");
 * const agent = await client.GET("/agents/{name}", {
 *   params: { path: { name: "chat" } }
 * });
 * const run = await client.POST("/runs", {
 *   body: {
 *     agent_name: "chat",
 *     input: [{ parts: [{ content_type: "text/plain", content: "Hello" }], role: "user" }]
 *   }
 * });
 * ```
 */
export function createACPClient(config: ACPClientConfig) {
  return createClient<paths>({
    baseUrl: config.baseUrl,
    headers: config.headers,
    fetch: config.fetch,
  });
}

// Type for the client instance
export type ACPClient = ReturnType<typeof createACPClient>;
