/**
 * Wrapper-specific tests for `buildHonoProxy` — the variant used by the
 * compiled `playground` binary (`static-server.ts`). Full header / redirect
 * / SSE coverage lives in `proxy.test.ts` (both wrappers share
 * `executeProxyFetch`). These tests pin only what the Hono wrapper adds:
 * prefix-stripping path construction and that OAuth-critical semantics
 * reach the upstream when invoked through this wrapper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHonoProxy } from "./proxy.ts";

describe("buildHonoProxy (compiled binary wrapper)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function call(prefix: string, upstream: string, label: string, url: string) {
    const handler = buildHonoProxy(prefix, upstream, label);
    const request = new Request(url, { method: "GET" });
    return handler({ req: { url: request.url, raw: request } });
  }

  it("strips the prefix from the path and forwards to the upstream", async () => {
    await call(
      "/api/daemon",
      "https://daemon.local:8080",
      "daemon",
      "https://localhost:5200/api/daemon/api/workspaces/x?foo=1",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const target = fetchMock.mock.calls[0][0] as URL;
    expect(target.toString()).toBe("https://daemon.local:8080/api/workspaces/x?foo=1");
  });

  it("delegates OAuth-critical semantics (X-Forwarded-* + redirect:manual) to executeProxyFetch", async () => {
    await call(
      "/api/daemon",
      "https://daemon.local:8080",
      "daemon",
      "https://localhost:5200/api/daemon/api/link/v1/oauth/authorize/google-calendar",
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Headers;
    expect(headers.get("x-forwarded-host")).toBe("localhost:5200");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("x-forwarded-prefix")).toBe("/api/daemon");
  });
});
