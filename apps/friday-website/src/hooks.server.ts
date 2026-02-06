import process from "node:process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Handle, HandleServerError } from "@sveltejs/kit";
import { httpRequestDuration } from "$lib/server/metrics";

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

const COMPRESSIBLE_TYPES = [
  "text/html",
  "text/xml",
  "application/xml",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/json",
  "image/svg+xml",
];

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

function setSecurityHeaders(headers: Headers): void {
  // SvelteKit handles CSP for HTML via svelte.config.js (meta tags for prerendered,
  // nonce-based headers for SSR). Only add CSP for non-HTML responses.
  if (!headers.has("content-security-policy")) {
    const ct = headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) {
      headers.set("content-security-policy", CSP_HEADER);
    }
  }
  if (!headers.has("cross-origin-opener-policy")) {
    headers.set("cross-origin-opener-policy", "same-origin");
  }
  if (!headers.has("x-content-type-options")) {
    headers.set("x-content-type-options", "nosniff");
  }
  if (!headers.has("x-frame-options")) {
    headers.set("x-frame-options", "DENY");
  }
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("permissions-policy")) {
    headers.set(
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  }
}

function setCacheHeaders(response: Response): void {
  if (response.headers.has("cache-control")) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    response.headers.set("cache-control", "public, max-age=60, s-maxage=3600");
  }
}

// Runtime compression for dynamic responses (metrics, errors, etc.).
// Prerendered pages and static assets are served by sirv with pre-compressed
// .br/.gz files and bypass this hook entirely.
async function compress(request: Request, response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!COMPRESSIBLE_TYPES.some((t) => contentType.includes(t))) return response;
  if (response.headers.has("content-encoding")) return response;

  const acceptEncoding = request.headers.get("accept-encoding") ?? "";
  if (!acceptEncoding.includes("br") && !acceptEncoding.includes("gzip")) return response;

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length < 256) return response;

  let encoding: string;
  let compressed: Uint8Array<ArrayBuffer>;

  if (acceptEncoding.includes("br")) {
    compressed = Uint8Array.from(await brotliCompress(body));
    encoding = "br";
  } else {
    compressed = Uint8Array.from(await gzipCompress(body));
    encoding = "gzip";
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

  setSecurityHeaders(response.headers);
  setCacheHeaders(response);

  return compress(event.request, response);
};

export const handleError: HandleServerError = ({ error, event, message }) => {
  event.locals.error = error instanceof Error ? error.message : String(error);
  event.locals.stack = error instanceof Error ? error.stack : undefined;

  return { message };
};
