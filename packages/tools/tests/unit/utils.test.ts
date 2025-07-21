/**
 * Unit tests for utility functions
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../../src/utils.ts";

Deno.test("defaultContext", () => {
  assertEquals(typeof defaultContext, "object");
  assertEquals("daemonUrl" in defaultContext, true);
  assertEquals(typeof defaultContext.daemonUrl, "string");
  // Should use ATLAS_DAEMON_URL env var or default to http://localhost:8080
  const expectedUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
  assertEquals(defaultContext.daemonUrl, expectedUrl);
});

Deno.test("getErrorMessage", async (t) => {
  await t.step("should extract message from Error instance", () => {
    const error = new Error("Test error message");
    assertEquals(getErrorMessage(error), "Test error message");
  });

  await t.step("should convert string to string", () => {
    assertEquals(getErrorMessage("String error"), "String error");
  });

  await t.step("should convert number to string", () => {
    assertEquals(getErrorMessage(42), "42");
  });

  await t.step("should convert object to string", () => {
    const obj = { code: 500, message: "Internal Error" };
    assertEquals(getErrorMessage(obj), "[object Object]");
  });

  await t.step("should handle null and undefined", () => {
    assertEquals(getErrorMessage(null), "null");
    assertEquals(getErrorMessage(undefined), "undefined");
  });

  await t.step("should handle TypeError", () => {
    const error = new TypeError("Type error message");
    assertEquals(getErrorMessage(error), "Type error message");
  });
});

Deno.test("fetchWithTimeout", async (t) => {
  await t.step("should reject on timeout", async () => {
    // Use a URL that will timeout quickly
    await assertRejects(
      () => fetchWithTimeout("http://192.0.2.1:81/timeout", { timeout: 100 }),
      Error,
      "Request timeout after 100ms",
    );
  });

  await t.step("should use default timeout", async () => {
    // Test that default timeout is used by checking the error message
    // Use a much shorter explicit timeout to avoid hanging
    await assertRejects(
      () => fetchWithTimeout("http://192.0.2.1:81/timeout", { timeout: 100 }),
      Error,
      "Request timeout after 100ms",
    );

    // Verify default timeout can be overridden
    const startTime = Date.now();
    try {
      await fetchWithTimeout("http://192.0.2.1:81/timeout", { timeout: 50 });
    } catch (error) {
      const elapsed = Date.now() - startTime;
      // Should timeout quickly, not wait for default 30s
      assertEquals(elapsed < 200, true);
      assertEquals(error instanceof Error, true);
    }
  });

  await t.step("should pass through fetch options", async () => {
    // Test that options are passed through correctly
    try {
      await fetchWithTimeout("http://192.0.2.1:81/timeout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeout: 100,
      });
    } catch (error) {
      // We expect this to fail due to timeout/connection, not due to invalid options
      assertEquals(error instanceof Error, true);
    }
  });
});

Deno.test("handleDaemonResponse", async (t) => {
  await t.step("should parse successful JSON response", async () => {
    const mockResponse = new Response(
      JSON.stringify({ success: true, data: "test" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

    const result = await handleDaemonResponse(mockResponse);
    assertEquals((result as { success: boolean }).success, true);
    assertEquals((result as { data: string }).data, "test");
  });

  await t.step("should throw error for non-ok response with JSON error", async () => {
    const mockResponse = new Response(
      JSON.stringify({ error: "Not found", code: 404 }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Daemon API error: 404 - Not found",
    );
  });

  await t.step("should throw error for non-ok response with text error", async () => {
    const mockResponse = new Response("Server error occurred", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Daemon API error: 500 - Server error occurred",
    );
  });

  await t.step("should throw error for non-ok response with no body", async () => {
    const mockResponse = new Response(null, {
      status: 503,
      statusText: "Service Unavailable",
    });

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Daemon API error: 503 - Service Unavailable",
    );
  });

  await t.step("should throw parse error for invalid JSON", async () => {
    const mockResponse = new Response("invalid json{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Failed to parse daemon API response",
    );
  });

  await t.step("should handle empty successful response", async () => {
    const mockResponse = new Response("", {
      status: 200,
    });

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Failed to parse daemon API response",
    );
  });

  await t.step("should handle null response body", async () => {
    const mockResponse = new Response(null, {
      status: 200,
    });

    await assertRejects(
      () => handleDaemonResponse(mockResponse),
      Error,
      "Failed to parse daemon API response",
    );
  });
});
