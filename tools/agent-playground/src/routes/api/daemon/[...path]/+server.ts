import type { RequestHandler } from "@sveltejs/kit";
import { DAEMON_BASE_URL } from "$lib/daemon-url";

/**
 * Proxy all HTTP methods to the local daemon.
 * Strips the `/api/daemon` prefix and forwards the rest of the path.
 * SSE responses (`text/event-stream`) are passed through without buffering.
 */
const handler: RequestHandler = async ({ params, request }) => {
  const path = params.path ?? "";
  const target = new URL(`/${path}`, DAEMON_BASE_URL);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const res = await fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error -- Node/Deno support duplex for streaming request bodies
    duplex: "half",
  });

  // SSE: pass through the readable stream without buffering
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    return new Response(res.body, { status: res.status, headers: res.headers });
  }

  // Strip content-encoding — fetch() already decompresses the body,
  // so forwarding the header causes the browser to double-decompress.
  const responseHeaders = new Headers(res.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  return new Response(res.body, { status: res.status, headers: responseHeaders });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
