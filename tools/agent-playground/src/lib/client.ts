import { hc } from "hono/client";
import type { Router } from "./server/router.ts";

/** Typed Hono RPC client for the playground API. */
export type Client = ReturnType<typeof makeClient>;

/**
 * Creates a typed Hono RPC client for the playground API.
 * @param customFetch - Fetch implementation (use SvelteKit's `fetch` in load functions)
 */
export function makeClient(customFetch: typeof globalThis.fetch) {
  return hc<Router>("/", { fetch: customFetch });
}

let browserClient: ReturnType<typeof makeClient> | undefined;

/** Singleton client for browser-side use. */
export function getClient() {
  if (!browserClient) {
    browserClient = makeClient(globalThis.fetch);
  }
  return browserClient;
}
