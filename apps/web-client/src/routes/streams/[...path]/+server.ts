/**
 * SvelteKit SSE streams proxy to daemon
 * Proxies all /streams/* requests to the daemon at http://127.0.0.1:8080
 * Runs server-side only (not in browser)
 */

import { proxyToDaemon } from "$lib/server/proxy";

type RequestEvent = { params: { path: string }; url: URL; request: Request };

export const GET = async ({ params, url, request }: RequestEvent): Promise<Response> => {
  return await proxyToDaemon("/streams", params.path, url, request);
};
