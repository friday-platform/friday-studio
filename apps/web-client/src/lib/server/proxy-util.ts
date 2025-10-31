/**
 * Shared daemon proxy logic for dev and production
 */

const DEFAULT_DAEMON_URL = "http://127.0.0.1:8080";

/**
 * Proxy a request to the daemon
 */
export async function proxyToDaemon(
  prefix: string,
  path: string,
  url: URL,
  request: Request,
  daemonUrl = DEFAULT_DAEMON_URL,
): Promise<Response> {
  const targetUrl = `${daemonUrl}${prefix}/${path}${url.search}`;

  try {
    return await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-expect-error - duplex required for streaming
      duplex: "half",
    });
  } catch (error) {
    // Only log non-AbortError (AbortError = cancelled request during dev hot-reload)
    if (!(error instanceof Error && error.name === "AbortError")) {
      console.error(`Proxy error for ${targetUrl}:`, error);
    }
    return new Response(JSON.stringify({ error: "Proxy error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Check if request should be proxied to daemon
 */
export function shouldProxyToDaemon(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/health" || pathname.startsWith("/streams/");
}
