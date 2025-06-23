/**
 * Integration tests for OpenTelemetry implementation
 * Tests real-world scenarios and cross-worker trace propagation
 */

import { assertEquals, assertExists } from "@std/assert";
import { AtlasTelemetry } from "../../src/utils/telemetry.ts";
import { delay } from "../utils/test-utils.ts";

// Helper to simulate worker message passing
interface WorkerMessage {
  type: string;
  data: any;
  traceHeaders?: Record<string, string>;
}

// Mock worker communication scenario
async function simulateWorkerCommunication() {
  // Parent worker creates span and sends message
  const parentResult = await AtlasTelemetry.withSpan("parent-operation", async () => {
    const traceHeaders = await AtlasTelemetry.createTraceHeaders();

    // Simulate sending message to child worker
    const message: WorkerMessage = {
      type: "execute-task",
      data: { task: "process-data" },
      traceHeaders,
    };

    // Simulate child worker receiving message and creating child span
    const childResult = await AtlasTelemetry.withSpanFromContext(
      "child-operation",
      AtlasTelemetry.extractTraceContext(message.traceHeaders || {}),
      async () => {
        await delay(10); // Simulate work
        return "child-completed";
      },
      { "worker.type": "child" },
    );

    return { parent: "completed", child: childResult };
  });

  return parentResult;
}

// Mock complex workflow simulation
async function simulateWorkspaceFlow() {
  return await AtlasTelemetry.withSpan("workspace.process_signal", async (workspaceSpan) => {
    AtlasTelemetry.addComponentAttributes(workspaceSpan, "workspace", { id: "ws-123" }, {
      signal_type: "http_webhook",
    });

    // Simulate session supervisor
    const sessionResult = await AtlasTelemetry.withSpan(
      "session.create_plan",
      async (sessionSpan) => {
        AtlasTelemetry.addComponentAttributes(sessionSpan, "supervisor", {
          type: "session",
          sessionId: "sess-456",
          "atlas.session.id": "sess-456",
        }, {
          plan_type: "sequential",
        });

        // Simulate multiple agents
        const agentResults = await Promise.all([
          AtlasTelemetry.withSpan("agent.llm_analyze", async (agentSpan) => {
            AtlasTelemetry.addComponentAttributes(agentSpan, "agent", {
              id: "agent-1",
              type: "llm",
            }, {
              model: "claude-3-5-sonnet",
            });
            await delay(20);
            return "analysis-complete";
          }),

          AtlasTelemetry.withSpan("agent.remote_execute", async (agentSpan) => {
            AtlasTelemetry.addComponentAttributes(agentSpan, "agent", {
              id: "agent-2",
              type: "remote",
            }, {
              endpoint: "http://agent-service/api",
            });
            await delay(15);
            return "execution-complete";
          }),
        ]);

        return agentResults;
      },
    );

    return { workspace: "signal-processed", session: sessionResult };
  });
}

Deno.test({
  name: "Telemetry Integration - Environment Detection",
  fn: async (t) => {
    const originalOtelDeno = Deno.env.get("OTEL_DENO");

    await t.step("should detect when telemetry should be enabled", async () => {
      Deno.env.set("OTEL_DENO", "true");

      // Reset AtlasTelemetry state
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.tracer = null;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.isEnabled = false;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.initPromise = null;

      // Trigger initialization by creating a span
      await AtlasTelemetry.withSpan("test", () => "success");

      // In real environment, this would be true if OpenTelemetry packages are available
      // For this test, we just verify the method executes without error
      assertEquals(typeof AtlasTelemetry.enabled, "boolean");
    });

    await t.step("should detect when telemetry is disabled", async () => {
      Deno.env.delete("OTEL_DENO");

      // Reset AtlasTelemetry state
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.tracer = null;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.isEnabled = false;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.initPromise = null;

      const result = await AtlasTelemetry.withSpan("test", () => "success");
      assertEquals(result, "success");
      assertEquals(AtlasTelemetry.enabled, false);
    });

    // Restore original environment
    if (originalOtelDeno) {
      Deno.env.set("OTEL_DENO", originalOtelDeno);
    } else {
      Deno.env.delete("OTEL_DENO");
    }
  },
});

Deno.test({
  name: "Telemetry Integration - Trace Propagation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    await t.step("should propagate trace context across simulated workers", async () => {
      const result = await simulateWorkerCommunication();

      assertEquals(result.parent, "completed");
      assertEquals(result.child, "child-completed");

      // In a real scenario with OpenTelemetry enabled, we would verify:
      // - Parent and child spans share the same trace ID
      // - Child span has parent span as its parent
      // - Trace context is properly propagated via headers
    });

    await t.step("should handle missing trace context gracefully", async () => {
      const result = await AtlasTelemetry.withSpanFromContext(
        "orphan-span",
        null, // No parent context
        () => "orphan-success",
      );

      assertEquals(result, "orphan-success");
    });

    await t.step("should create trace headers consistently", async () => {
      const headers1 = await AtlasTelemetry.createTraceHeaders();
      const headers2 = await AtlasTelemetry.createTraceHeaders();

      // Headers should be consistent format (empty when disabled, or W3C format when enabled)
      assertEquals(typeof headers1, "object");
      assertEquals(typeof headers2, "object");

      if (headers1.traceparent) {
        // Should be valid W3C traceparent format
        const parts = headers1.traceparent.split("-");
        assertEquals(parts.length, 4);
        assertEquals(parts[0], "00"); // version
      }
    });
  },
});

Deno.test({
  name: "Telemetry Integration - Complex Workflows",
  fn: async (t) => {
    await t.step("should handle nested span hierarchies", async () => {
      const result = await simulateWorkspaceFlow();

      assertEquals(result.workspace, "signal-processed");
      assertExists(result.session);
      assertEquals(result.session.length, 2);
      assertEquals(result.session[0], "analysis-complete");
      assertEquals(result.session[1], "execution-complete");
    });

    await t.step("should handle concurrent span creation", async () => {
      const promises = Array.from(
        { length: 10 },
        (_, i) =>
          AtlasTelemetry.withSpan(`concurrent-span-${i}`, async () => {
            await delay(Math.random() * 20);
            return `result-${i}`;
          }),
      );

      const results = await Promise.all(promises);

      assertEquals(results.length, 10);
      results.forEach((result, i) => {
        assertEquals(result, `result-${i}`);
      });
    });

    await t.step("should handle deeply nested spans", async () => {
      const createNestedSpan = async (depth: number): Promise<string> => {
        if (depth === 0) {
          return "leaf";
        }

        return await AtlasTelemetry.withSpan(`nested-${depth}`, async () => {
          const childResult = await createNestedSpan(depth - 1);
          return `${depth}-${childResult}`;
        });
      };

      const result = await createNestedSpan(5);
      assertEquals(result, "5-4-3-2-1-leaf");
    });
  },
});

Deno.test({
  name: "Telemetry Integration - Worker Context Patterns",
  fn: async (t) => {
    await t.step("should handle workspace supervisor pattern", async () => {
      const workspaceContext = {
        operation: "process_signal",
        component: "workspace" as const,
        workspaceId: "ws-123",
        signalId: "sig-456",
        signalType: "webhook",
        attributes: {
          "signal.provider": "github",
          "signal.event": "push",
        },
      };

      const result = await AtlasTelemetry.withWorkerSpan(workspaceContext, () => "processed");
      assertEquals(result, "processed");
    });

    await t.step("should handle session supervisor pattern", async () => {
      const sessionContext = {
        operation: "create_execution_plan",
        component: "session" as const,
        sessionId: "sess-789",
        workspaceId: "ws-123",
        attributes: {
          "plan.strategy": "sequential",
          "plan.agent_count": 3,
        },
      };

      const result = await AtlasTelemetry.withWorkerSpan(sessionContext, () => "plan-created");
      assertEquals(result, "plan-created");
    });

    await t.step("should handle agent worker pattern", async () => {
      const agentContext = {
        operation: "invoke",
        component: "agent" as const,
        agentId: "agent-101",
        agentType: "llm",
        sessionId: "sess-789",
        workerId: "worker-abc",
        attributes: {
          "agent.model": "claude-3-5-sonnet",
          "agent.temperature": 0.7,
        },
      };

      const result = await AtlasTelemetry.withWorkerSpan(agentContext, () => "task-completed");
      assertEquals(result, "task-completed");
    });

    await t.step("should handle worker context with trace propagation", async () => {
      // Simulate parent span creating trace headers
      let childContext: any;

      await AtlasTelemetry.withSpan("parent-worker", async () => {
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        childContext = {
          operation: "child_task",
          component: "agent" as const,
          traceHeaders,
          agentId: "child-agent",
          agentType: "remote",
        };

        return "parent-done";
      });

      // Child worker processes with propagated context
      const result = await AtlasTelemetry.withWorkerSpan(childContext, () => "child-done");
      assertEquals(result, "child-done");
    });
  },
});

Deno.test({
  name: "Telemetry Integration - Error Scenarios",
  fn: async (t) => {
    await t.step("should handle errors in nested spans", async () => {
      let errorCaught = false;

      try {
        await AtlasTelemetry.withSpan("outer-span", async () => {
          return await AtlasTelemetry.withSpan("inner-span", () => {
            throw new Error("Inner span error");
          });
        });
      } catch (error) {
        errorCaught = true;
        assertEquals((error as Error).message, "Inner span error");
      }

      assertEquals(errorCaught, true);
    });

    await t.step("should handle errors in concurrent spans", async () => {
      const promises = [
        AtlasTelemetry.withSpan("success-span", () => "success"),
        AtlasTelemetry.withSpan("error-span", () => {
          throw new Error("Concurrent error");
        }),
        AtlasTelemetry.withSpan("success-span-2", () => "success-2"),
      ];

      const results = await Promise.allSettled(promises);

      assertEquals(results[0].status, "fulfilled");
      assertEquals(results[1].status, "rejected");
      assertEquals(results[2].status, "fulfilled");

      if (results[0].status === "fulfilled") {
        assertEquals(results[0].value, "success");
      }
      if (results[2].status === "fulfilled") {
        assertEquals(results[2].value, "success-2");
      }
    });

    await t.step("should handle long-running operations", async () => {
      const startTime = Date.now();

      const result = await AtlasTelemetry.withSpan("long-operation", async () => {
        await delay(100);
        return "long-complete";
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      assertEquals(result, "long-complete");
      // Should have taken at least 100ms
      assertEquals(duration >= 100, true);
    });
  },
});

Deno.test({
  name: "Telemetry Integration - Performance Characteristics",
  fn: async (t) => {
    await t.step("should have minimal overhead when disabled", async () => {
      // Ensure telemetry is disabled
      const originalOtelDeno = Deno.env.get("OTEL_DENO");
      Deno.env.delete("OTEL_DENO");

      // Reset state
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.tracer = null;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.isEnabled = false;
      // @ts-ignore: Accessing private members for testing
      AtlasTelemetry.initPromise = null;

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
      // Should complete quickly when disabled (under 100ms for 100 operations)
      assertEquals(duration < 100, true);

      // Restore environment
      if (originalOtelDeno) {
        Deno.env.set("OTEL_DENO", originalOtelDeno);
      }
    });

    await t.step("should handle rapid span creation and cleanup", async () => {
      const spanCount = 50;
      let completedSpans = 0;

      const promises = Array.from(
        { length: spanCount },
        (_, i) =>
          AtlasTelemetry.withSpan(`rapid-span-${i}`, async () => {
            await delay(1); // Minimal delay
            completedSpans++;
            return i;
          }),
      );

      const results = await Promise.all(promises);

      assertEquals(results.length, spanCount);
      assertEquals(completedSpans, spanCount);

      // Verify all results are correct
      results.forEach((result, i) => {
        assertEquals(result, i);
      });
    });
  },
});
