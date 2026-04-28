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
  headers.delete("content-length");

  // Buffer the request body for methods that carry one. Streaming with
  // `duplex: "half"` races the response: when the daemon short-circuits
  // (e.g. 401 from requireUser before consuming the body) the in-flight
  // body sender can error with `TypeError: fetch failed`, swallowing the
  // upstream's real status code. Buffering eliminates the race so the
  // browser sees the actual status and the user gets a useful message.
  let body: BodyInit | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = new Uint8Array(await request.arrayBuffer());
  }

  let res: Response;
  try {
    res = await fetch(target, { method: request.method, headers, body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: `daemon proxy fetch failed: ${message}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

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
