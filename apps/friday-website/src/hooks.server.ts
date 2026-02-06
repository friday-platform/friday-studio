import process from "node:process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Handle, HandleServerError } from "@sveltejs/kit";
import { httpRequestDuration } from "$lib/server/metrics";

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

const COMPRESSIBLE_TYPES = ["text/html", "text/xml", "application/xml"];

async function compress(request: Request, response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!COMPRESSIBLE_TYPES.some((t) => contentType.includes(t))) return response;
  if (response.headers.has("content-encoding")) return response;

  const acceptEncoding = request.headers.get("accept-encoding") ?? "";
  const body = new Uint8Array(await response.arrayBuffer());

  if (body.length < 256) return response;

  let encoding: string;
  let compressed: Uint8Array<ArrayBuffer>;

  if (acceptEncoding.includes("br")) {
    compressed = Uint8Array.from(await brotliCompress(body));
    encoding = "br";
  } else if (acceptEncoding.includes("gzip")) {
    compressed = Uint8Array.from(await gzipCompress(body));
    encoding = "gzip";
  } else {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const headers = new Headers(response.headers);
  headers.set("content-encoding", encoding);
  headers.set("vary", "accept-encoding");
  headers.delete("content-length");

  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function log(level: "info" | "error", message: string, context: Record<string, unknown>) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    service: "friday-website",
    context,
  });
  process.stdout.write(entry + "\n");
}

export const handle: Handle = async ({ event, resolve }) => {
  const start = performance.now();
  const response = await resolve(event);
  const durationMs = performance.now() - start;
  const durationSec = durationMs / 1000;

  if (event.url.pathname !== "/metrics") {
    httpRequestDuration.observe(
      {
        method: event.request.method,
        route: event.route.id ?? "(unmatched)",
        status: String(response.status),
      },
      durationSec,
    );

    let ip: string | undefined;
    try {
      ip = event.getClientAddress();
    } catch {
      // adapter-node throws if address header is missing (e.g. health checks)
    }

    log(response.status >= 500 ? "error" : "info", "request", {
      method: event.request.method,
      path: event.url.pathname,
      status: response.status,
      duration: Math.round(durationMs),
      userAgent: event.request.headers.get("user-agent"),
      ip,
      ...(event.locals.error ? { error: event.locals.error, stack: event.locals.stack } : {}),
    });
  }

  return compress(event.request, response);
};

export const handleError: HandleServerError = ({ error, event, message }) => {
  // Stash error details on locals so the handle hook can include them in its
  // single structured log entry. handleError fires inside resolve(), before
  // handle's post-resolve logging runs. This avoids duplicate log lines.
  event.locals.error = error instanceof Error ? error.message : String(error);
  event.locals.stack = error instanceof Error ? error.stack : undefined;

  return { message };
};
