import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkRoutes } from "./link.ts";

describe("daemon /api/link proxy: X-Forwarded-* forwarding", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let originalFridayEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalFridayEnv = process.env.FRIDAY_ENV;
    fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    process.env.FRIDAY_ENV = "dev";
    process.env.LINK_SERVICE_URL = "http://link.local:3100";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalFridayEnv === undefined) {
      delete process.env.FRIDAY_ENV;
    } else {
      process.env.FRIDAY_ENV = originalFridayEnv;
    }
    delete process.env.LINK_SERVICE_URL;
  });

  it("preserves incoming X-Forwarded-Host/Proto and appends /api/link to the prefix", async () => {
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
    expect(fetchMock).toHaveBeenCalledOnce();
    const forwarded = fetchMock.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-forwarded-host")).toBe("localhost:5200");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    // Concatenated: playground prefix + this proxy's own prefix.
    expect(forwarded.headers.get("x-forwarded-prefix")).toBe("/api/daemon/api/link");
  });

  it("falls back to the daemon's own host when no forwarded headers are present", async () => {
    const res = await linkRoutes.request(
      "https://127.0.0.1:8080/api/link/v1/oauth/authorize/google-calendar",
      { method: "GET" },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const forwarded = fetchMock.mock.calls[0][0] as Request;
    expect(forwarded.headers.get("x-forwarded-host")).toBe("127.0.0.1:8080");
    expect(forwarded.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwarded.headers.get("x-forwarded-prefix")).toBe("/api/link");
  });
});
