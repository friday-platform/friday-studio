/**
 * SvelteKit API proxy to daemon
 * Proxies all /api/* requests to the daemon at http://127.0.0.1:8080
 * Runs server-side only (not in browser)
 */

import { proxyToDaemon } from "$lib/server/proxy";

type RequestEvent = { params: { path: string }; url: URL; request: Request };

type RequestHandler = (event: RequestEvent) => Promise<Response> | Response;

const createHandler = (_method: string): RequestHandler => {
  return async ({ params, url, request }: RequestEvent) => {
    return await proxyToDaemon("/api", params.path, url, request);
  };
};

export const GET = createHandler("GET");
export const POST = createHandler("POST");
export const PUT = createHandler("PUT");
export const DELETE = createHandler("DELETE");
export const PATCH = createHandler("PATCH");
