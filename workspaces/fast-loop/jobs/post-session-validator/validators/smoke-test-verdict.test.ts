import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateSmokeResponse, validateSmokeTest } from "./smoke-test.ts";

describe("evaluateSmokeResponse", () => {
  it("500 status is a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      500,
      '{"error":"Internal server error"}',
    );

    expect(result.passed).toBe(false);
    expect(result.status).toBe(500);
    expect(result.failureReason).toContain("500");
    expect(result.failureReason).toContain("server error");
  });

  it("502 status is a failure", () => {
    const result = evaluateSmokeResponse("/api/chat", "POST", 502, "Bad Gateway");

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("502");
  });

  it("400 status (schema rejection) is NOT a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      400,
      '{"error":"Validation failed: expected string"}',
    );

    expect(result.passed).toBe(true);
    expect(result.status).toBe(400);
  });

  it("401 status (auth) is NOT a failure", () => {
    const result = evaluateSmokeResponse("/api/chat", "POST", 401, '{"error":"Unauthorized"}');

    expect(result.passed).toBe(true);
  });

  it("403 status (auth) is NOT a failure", () => {
    const result = evaluateSmokeResponse("/api/chat", "POST", 403, '{"error":"Forbidden"}');

    expect(result.passed).toBe(true);
  });

  it("200 with clean response is a pass", () => {
    const result = evaluateSmokeResponse("/api/chat", "POST", 200, '{"id":"chat-1","status":"ok"}');

    expect(result.passed).toBe(true);
    expect(result.status).toBe(200);
  });

  it("200 with 'TypeValidationError' in body IS a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      200,
      '{"name":"AI_TypeValidationError","message":"Type validation failed"}',
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("TypeValidationError");
    expect(result.failureReason).toContain("200");
  });

  it("200 with 'ZodError' in body IS a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      200,
      '{"name":"ZodError","issues":[{"code":"invalid_type"}]}',
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("ZodError");
  });

  it("200 with 'Internal server error' in body IS a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      200,
      '{"error":"Internal server error"}',
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("Internal server error");
  });

  it("200 with stack trace in body IS a failure", () => {
    const result = evaluateSmokeResponse(
      "/api/chat",
      "POST",
      200,
      "Error: something broke\n    at Object.handler (/app/routes/chat.ts:42:10)\n    at dispatch (hono.ts:100:5)",
    );

    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("stack trace");
  });

  it("truncates body snippet to 500 chars", () => {
    const longBody = "x".repeat(1000);
    const result = evaluateSmokeResponse("/api/chat", "POST", 200, longBody);

    expect(result.bodySnippet.length).toBe(500);
    expect(result.passed).toBe(true);
  });
});

describe("validateSmokeTest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns ok when no route files changed", async () => {
    const result = await validateSmokeTest(
      ["packages/core/mod.ts", "apps/atlasd/src/atlas-daemon.ts"],
      { platformUrl: "http://test:8080" },
    );

    expect(result.validator).toBe("smoke-test");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no route files changed");
    expect(result.evidence).toHaveLength(0);
  });

  it("returns failure when endpoint returns 500", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"error":"Internal server error"}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await validateSmokeTest(["apps/atlasd/routes/chat.ts"], {
      platformUrl: "http://test:8080",
    });

    expect(result.validator).toBe("smoke-test");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence[0]).toContain("/api/chat");
    expect(result.evidence[0]).toContain("500");
  });

  it("returns ok when endpoint returns 400 (schema rejection)", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"error":"Validation failed"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await validateSmokeTest(["apps/atlasd/routes/chat.ts"], {
      platformUrl: "http://test:8080",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("passed");
  });

  it("returns ok when endpoint returns 401 (auth)", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"error":"Unauthorized"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await validateSmokeTest(["apps/atlasd/routes/global-chat.ts"], {
      platformUrl: "http://test:8080",
    });

    expect(result.ok).toBe(true);
  });

  it("returns failure when body contains TypeValidationError with status 200", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response('{"name":"AI_TypeValidationError","message":"bad type"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await validateSmokeTest(["apps/atlasd/routes/chat.ts"], {
      platformUrl: "http://test:8080",
    });

    expect(result.ok).toBe(false);
    expect(result.evidence[0]).toContain("TypeValidationError");
  });

  it("tests multiple endpoints when multiple route files changed", async () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();

    // First call: chat returns 500
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":"Internal server error"}', { status: 500 }),
    );
    // Second call: global-chat returns 200
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    globalThis.fetch = mockFetch;

    const result = await validateSmokeTest(
      ["apps/atlasd/routes/chat.ts", "apps/atlasd/routes/global-chat.ts"],
      { platformUrl: "http://test:8080" },
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("1/2");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toContain("/api/chat");
  });

  it("handles connection refused gracefully (daemon not running)", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));

    const result = await validateSmokeTest(["apps/atlasd/routes/chat.ts"], {
      platformUrl: "http://test:8080",
    });

    // Connection refused means daemon is down — don't block the session
    expect(result.ok).toBe(true);
  });

  it("returns failure on non-connection fetch errors", async () => {
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("AbortError: signal timed out"));

    const result = await validateSmokeTest(["apps/atlasd/routes/chat.ts"], {
      platformUrl: "http://test:8080",
    });

    expect(result.ok).toBe(false);
    expect(result.evidence[0]).toContain("timed out");
  });
});
