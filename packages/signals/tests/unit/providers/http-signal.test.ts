/**
 * Tests for HTTP Signal Provider
 * TDD implementation - tests first, then implementation
 */

import { assertEquals } from "@std/assert";
import type { HTTPSignalConfig } from "../../../src/providers/http-signal.ts";
import { HTTPSignalProvider } from "../../../src/providers/http-signal.ts";

Deno.test("HTTPSignalProvider - initialization", async (t) => {
  await t.step("should initialize with valid HTTP config", () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);
    assertEquals(provider.getProviderId(), "test-http");
    assertEquals(provider.getProviderType(), "http");
  });

  await t.step("should require path in config", () => {
    const config = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http" as const,
      method: "POST" as const,
      // missing path
    };

    try {
      new HTTPSignalProvider(config as HTTPSignalConfig);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("path"), true);
    }
  });

  await t.step("should default to POST method", () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      // no method specified
    };

    const provider = new HTTPSignalProvider(config);
    assertEquals(provider.getMethod(), "POST");
  });

  await t.step("should support GET, POST, PUT, DELETE methods", () => {
    const methods = ["GET", "POST", "PUT", "DELETE"] as const;

    methods.forEach((method) => {
      const config: HTTPSignalConfig = {
        id: "test-http",
        description: "Test HTTP signal",
        provider: "http",
        path: "/test",
        method,
      };

      const provider = new HTTPSignalProvider(config);
      assertEquals(provider.getMethod(), method);
    });
  });

  await t.step("should reject invalid HTTP methods", () => {
    const config = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http" as const,
      path: "/test",
      method: "INVALID",
    };

    try {
      new HTTPSignalProvider(config as HTTPSignalConfig);
      throw new Error("Should have thrown validation error");
    } catch (error) {
      assertEquals(error.message.includes("method"), true);
    }
  });
});

Deno.test("HTTPSignalProvider - route registration", async (t) => {
  await t.step("should generate correct route pattern", () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/api/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);
    const route = provider.getRoutePattern();

    assertEquals(route.path, "/api/test");
    assertEquals(route.method, "POST");
    assertEquals(route.signalId, "test-http");
  });

  await t.step("should handle path with leading slash", () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "GET",
    };

    const provider = new HTTPSignalProvider(config);
    const route = provider.getRoutePattern();
    assertEquals(route.path, "/test");
  });

  await t.step("should add leading slash if missing", () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "test",
      method: "GET",
    };

    const provider = new HTTPSignalProvider(config);
    const route = provider.getRoutePattern();
    assertEquals(route.path, "/test");
  });
});

Deno.test("HTTPSignalProvider - signal processing", async (t) => {
  await t.step("should process valid HTTP request", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test data" }),
    });

    const signal = await provider.processRequest(mockRequest);

    assertEquals(signal.id, "test-http");
    assertEquals(signal.type, "http");
    assertEquals(signal.data.message, "test data");
    assertEquals(typeof signal.timestamp, "string");
  });

  await t.step("should handle request without body", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "GET",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test", { method: "GET" });

    const signal = await provider.processRequest(mockRequest);

    assertEquals(signal.id, "test-http");
    assertEquals(signal.type, "http");
    assertEquals(signal.data, {});
  });

  await t.step("should include query parameters", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "GET",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test?param1=value1&param2=value2", {
      method: "GET",
    });

    const signal = await provider.processRequest(mockRequest);

    assertEquals(signal.data.query.param1, "value1");
    assertEquals(signal.data.query.param2, "value2");
  });

  await t.step("should include request headers", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom-Header": "test-value" },
    });

    const signal = await provider.processRequest(mockRequest);

    assertEquals(signal.data.headers["content-type"], "application/json");
    assertEquals(signal.data.headers["x-custom-header"], "test-value");
  });
});

Deno.test("HTTPSignalProvider - error handling", async (t) => {
  await t.step("should handle malformed JSON", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json {",
    });

    const signal = await provider.processRequest(mockRequest);

    // Should still process but with raw body
    assertEquals(signal.id, "test-http");
    assertEquals(signal.data.body, "invalid json {");
  });

  await t.step("should handle empty request body", async () => {
    const config: HTTPSignalConfig = {
      id: "test-http",
      description: "Test HTTP signal",
      provider: "http",
      path: "/test",
      method: "POST",
    };

    const provider = new HTTPSignalProvider(config);

    const mockRequest = new Request("http://localhost:8080/test", { method: "POST" });

    const signal = await provider.processRequest(mockRequest);

    assertEquals(signal.id, "test-http");
    assertEquals(signal.data, {});
  });
});
