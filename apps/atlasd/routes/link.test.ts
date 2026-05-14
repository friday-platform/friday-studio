import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("daemon /api/link proxy: X-Forwarded-* forwarding", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.FRIDAY_ENV = "dev";
    process.env.LINK_SERVICE_URL = "http://link.local:3100";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LINK_SERVICE_URL;
  });

  it("preserves incoming X-Forwarded-Host/Proto and appends /api/link to the prefix", async () => {
    // Fresh import so the LINK_SERVICE_URL env we set in beforeEach is picked
    // up (the route resolves it at module load).
    const { linkRoutes } = await import("./link.ts?fresh-forwarded-headers");
    const res = await linkRoutes.request(
      "http://127.0.0.1:8080/api/link/v1/oauth/authorize/google-calendar",
      {
        method: "GET",
        headers: {
          "X-Forwarded-Host": "localhost:5200",
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Prefix": "/api/daemon",
        },
      },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("x-forwarded-host")).toBe("localhost:5200");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    // Concatenated: playground prefix + this proxy's own prefix.
    expect(forwarded.headers.get("x-forwarded-prefix")).toBe("/api/daemon/api/link");
  });

  it("falls back to the daemon's own host when no forwarded headers are present", async () => {
    const { linkRoutes } = await import("./link.ts?fresh-no-forwarded");
    const res = await linkRoutes.request(
      "https://127.0.0.1:8080/api/link/v1/oauth/authorize/google-calendar",
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get("x-forwarded-host")).toBe("127.0.0.1:8080");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwarded.headers.get("x-forwarded-prefix")).toBe("/api/link");
  });
});
