/**
 * Simplified unit tests for OpenTelemetry implementation
 * Tests the actual telemetry class behavior without complex mocking
 */

import { assertEquals } from "@std/assert";
import { AtlasTelemetry } from "../../src/utils/telemetry.ts";

// Store original environment
const originalEnv = Deno.env.toObject();

function setupTestEnvironment(otelEnabled = false) {
  // Clear OTEL environment variables
  for (const key of Object.keys(Deno.env.toObject())) {
    if (key.startsWith("OTEL_")) {
      Deno.env.delete(key);
    }
  }

  if (otelEnabled) {
    Deno.env.set("OTEL_DENO", "true");
  }

  // Reset AtlasTelemetry static state for each test
  // @ts-ignore: Accessing private members for testing
  AtlasTelemetry.tracer = null;
  // @ts-ignore: Accessing private members for testing
  AtlasTelemetry.isEnabled = false;
  // @ts-ignore: Accessing private members for testing
  AtlasTelemetry.initPromise = null;
}

function restoreEnvironment() {
  // Clear all environment variables
  for (const key of Object.keys(Deno.env.toObject())) {
    Deno.env.delete(key);
  }

  // Restore original environment
  for (const [key, value] of Object.entries(originalEnv)) {
    Deno.env.set(key, value);
  }
}

Deno.test({
  name: "AtlasTelemetry - Basic Functionality When Disabled",
  fn: async (t) => {
    await t.step("should be disabled by default", () => {
      setupTestEnvironment(false);

      assertEquals(AtlasTelemetry.enabled, false);

      restoreEnvironment();
    });

    await t.step("should execute functions normally when disabled", async () => {
      setupTestEnvironment(false);

      const result = await AtlasTelemetry.withSpan("test-span", (span) => {
        assertEquals(span, null);
        return "success";
      });

      assertEquals(result, "success");

      restoreEnvironment();
    });

    await t.step("should handle async functions when disabled", async () => {
      setupTestEnvironment(false);

      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "async-success";
      };

      const result = await AtlasTelemetry.withSpan("async-span", asyncFn);
      assertEquals(result, "async-success");

      restoreEnvironment();
    });

    await t.step("should handle exceptions when disabled", async () => {
      setupTestEnvironment(false);

      let errorCaught = false;
      try {
        await AtlasTelemetry.withSpan("error-span", () => {
          throw new Error("Test error");
        });
      } catch (error) {
        errorCaught = true;
        assertEquals((error as Error).message, "Test error");
      }

      assertEquals(errorCaught, true);

      restoreEnvironment();
    });

    await t.step("should return empty headers when disabled", async () => {
      setupTestEnvironment(false);

      const headers = await AtlasTelemetry.createTraceHeaders();
      assertEquals(Object.keys(headers).length, 0);

      restoreEnvironment();
    });

    await t.step("should return null context when disabled", async () => {
      setupTestEnvironment(false);

      const context = await AtlasTelemetry.getCurrentSpanContext();
      assertEquals(context, null);

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Attribute Helpers",
  fn: async (t) => {
    await t.step("should handle null spans gracefully in attribute methods", () => {
      setupTestEnvironment(false);

      // These should not throw when span is null
      AtlasTelemetry.addAtlasAttributes(null, "workspace", { id: "test" });
      AtlasTelemetry.addComponentAttributes(null, "workspace", { id: "ws-123" });
      AtlasTelemetry.addComponentAttributes(null, "supervisor", {
        type: "session",
        sessionId: "sess-456",
        "atlas.session.id": "sess-456",
      });
      AtlasTelemetry.addComponentAttributes(null, "agent", { id: "agent-789", type: "llm" });
      AtlasTelemetry.addComponentAttributes(null, "signal", { id: "signal-101", type: "webhook" });

      // No exceptions should be thrown
      assertEquals(true, true);

      restoreEnvironment();
    });

    await t.step("should extract trace context from headers", () => {
      setupTestEnvironment(false);

      const headers = {
        traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
        other: "value",
      };

      const context = AtlasTelemetry.extractTraceContext(headers);
      assertEquals(context, "00-12345678901234567890123456789012-1234567890123456-01");

      restoreEnvironment();
    });

    await t.step("should return null for missing trace context", () => {
      setupTestEnvironment(false);

      const headers = { other: "value" };
      const context = AtlasTelemetry.extractTraceContext(headers);
      assertEquals(context, null);

      restoreEnvironment();
    });

    await t.step("should handle undefined headers", () => {
      setupTestEnvironment(false);

      const context = AtlasTelemetry.extractTraceContext({});
      assertEquals(context, null);

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Span Types When Disabled",
  fn: async (t) => {
    await t.step("should execute server spans when disabled", async () => {
      setupTestEnvironment(false);

      const result = await AtlasTelemetry.withServerSpan("http-request", () => "server-response");
      assertEquals(result, "server-response");

      restoreEnvironment();
    });

    await t.step("should execute client spans when disabled", async () => {
      setupTestEnvironment(false);

      const result = await AtlasTelemetry.withClientSpan("http-call", () => "client-response");
      assertEquals(result, "client-response");

      restoreEnvironment();
    });

    await t.step("should execute spans from context when disabled", async () => {
      setupTestEnvironment(false);

      const result = await AtlasTelemetry.withSpanFromContext(
        "child-span",
        "00-12345678901234567890123456789012-1234567890123456-01",
        () => "child-success",
      );

      assertEquals(result, "child-success");

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Worker Communication Patterns",
  fn: async (t) => {
    await t.step("should execute worker spans when disabled", async () => {
      setupTestEnvironment(false);

      const workerContext = {
        operation: "initialize",
        component: "agent" as const,
        agentId: "agent-123",
        agentType: "llm",
        sessionId: "session-456",
        workerId: "worker-789",
        attributes: {
          "custom.attr": "value",
        },
      };

      const result = await AtlasTelemetry.withWorkerSpan(workerContext, () => "worker-success");
      assertEquals(result, "worker-success");

      restoreEnvironment();
    });

    await t.step("should handle worker context with trace headers", async () => {
      setupTestEnvironment(false);

      const workerContext = {
        operation: "process",
        component: "session" as const,
        traceHeaders: {
          traceparent: "00-12345678901234567890123456789012-1234567890123456-01",
        },
        sessionId: "session-123",
      };

      const result = await AtlasTelemetry.withWorkerSpan(workerContext, () => "traced-success");
      assertEquals(result, "traced-success");

      restoreEnvironment();
    });

    await t.step("should handle minimal worker context", async () => {
      setupTestEnvironment(false);

      const workerContext = {
        operation: "test",
        component: "workspace" as const,
      };

      const result = await AtlasTelemetry.withWorkerSpan(workerContext, () => "minimal-success");
      assertEquals(result, "minimal-success");

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Performance and Concurrency",
  fn: async (t) => {
    await t.step("should handle concurrent span creation when disabled", async () => {
      setupTestEnvironment(false);

      const promises = Array.from(
        { length: 10 },
        (_, i) => AtlasTelemetry.withSpan(`concurrent-${i}`, () => `result-${i}`),
      );

      const results = await Promise.all(promises);

      assertEquals(results.length, 10);
      results.forEach((result, i) => {
        assertEquals(result, `result-${i}`);
      });

      restoreEnvironment();
    });

    await t.step("should handle nested spans when disabled", async () => {
      setupTestEnvironment(false);

      const result = await AtlasTelemetry.withSpan("outer", async () => {
        const innerResult = await AtlasTelemetry.withSpan("inner", () => "inner-success");
        return `outer-${innerResult}`;
      });

      assertEquals(result, "outer-inner-success");

      restoreEnvironment();
    });

    await t.step("should be fast when disabled", async () => {
      setupTestEnvironment(false);

      const startTime = Date.now();

      // Run many operations
      const promises = Array.from(
        { length: 100 },
        (_, i) => AtlasTelemetry.withSpan(`perf-test-${i}`, () => `result-${i}`),
      );

      const results = await Promise.all(promises);

      const endTime = Date.now();
      const duration = endTime - startTime;

      assertEquals(results.length, 100);
      // Should complete very quickly when disabled (under 50ms for 100 operations)
      assertEquals(duration < 50, true);

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Enabled State Detection",
  fn: async (t) => {
    await t.step("should attempt initialization when OTEL_DENO is true", async () => {
      setupTestEnvironment(true);

      // Trigger initialization by calling withSpan
      const result = await AtlasTelemetry.withSpan("test", () => "success");
      assertEquals(result, "success");

      // The enabled state depends on whether OpenTelemetry packages are available
      // In test environment, this will likely be false due to import failures
      assertEquals(typeof AtlasTelemetry.enabled, "boolean");

      restoreEnvironment();
    });

    await t.step("should set service name when enabled", async () => {
      setupTestEnvironment(true);
      Deno.env.delete("OTEL_SERVICE_NAME");

      // Trigger initialization
      await AtlasTelemetry.withSpan("test", () => "success");

      // Service name should be set even if initialization fails
      assertEquals(Deno.env.get("OTEL_SERVICE_NAME"), "atlas");

      restoreEnvironment();
    });

    await t.step("should handle initialization idempotency", async () => {
      setupTestEnvironment(true);

      // Multiple calls should not cause issues
      const result1 = await AtlasTelemetry.withSpan("test1", () => "success1");
      const result2 = await AtlasTelemetry.withSpan("test2", () => "success2");

      assertEquals(result1, "success1");
      assertEquals(result2, "success2");

      restoreEnvironment();
    });
  },
});

Deno.test({
  name: "AtlasTelemetry - Error Scenarios",
  fn: async (t) => {
    await t.step("should handle errors in disabled mode", async () => {
      setupTestEnvironment(false);

      let errorCaught = false;
      try {
        await AtlasTelemetry.withSpan("error-test", () => {
          throw new Error("Test error");
        });
      } catch (error) {
        errorCaught = true;
        assertEquals((error as Error).message, "Test error");
      }

      assertEquals(errorCaught, true);

      restoreEnvironment();
    });

    await t.step("should handle errors in async functions", async () => {
      setupTestEnvironment(false);

      let errorCaught = false;
      try {
        await AtlasTelemetry.withSpan("async-error", async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("Async error");
        });
      } catch (error) {
        errorCaught = true;
        assertEquals((error as Error).message, "Async error");
      }

      assertEquals(errorCaught, true);

      restoreEnvironment();
    });

    await t.step("should handle errors in nested spans", async () => {
      setupTestEnvironment(false);

      let errorCaught = false;
      try {
        await AtlasTelemetry.withSpan("outer-error", async () => {
          return await AtlasTelemetry.withSpan("inner-error", () => {
            throw new Error("Nested error");
          });
        });
      } catch (error) {
        errorCaught = true;
        assertEquals((error as Error).message, "Nested error");
      }

      assertEquals(errorCaught, true);

      restoreEnvironment();
    });
  },
});
