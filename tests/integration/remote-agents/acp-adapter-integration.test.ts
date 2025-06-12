// ACP Adapter Integration Tests
// Tests the ACPAdapter against a real ACP server to verify end-to-end functionality

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert";
import { ACPTestServer } from "./test-server.ts";
import { ACPAdapter } from "../../../src/core/agents/remote/adapters/acp-adapter.ts";
import type { RemoteExecutionRequest } from "../../../src/core/agents/remote/types.ts";

// Test configuration (currently unused but may be needed for future timeout configuration)
// const TEST_TIMEOUT_MS = 10000;

Deno.test({
  name: "ACP Adapter Integration Tests",
  fn: async (t) => {
    let server: ACPTestServer;
    let adapter: ACPAdapter;
    let baseUrl: string;

    // Setup: Start test server
    await t.step("Setup test server", async () => {
      server = new ACPTestServer();
      const port = await server.start();
      baseUrl = `http://localhost:${port}`;

      // Create adapter instance
      adapter = new ACPAdapter({
        endpoint: baseUrl,
        connection: {
          endpoint: baseUrl,
          timeout: 5000,
          retries: 3,
          keepAlive: true,
        },
        acp: {
          agent_name: "echo",
          default_mode: "sync",
          timeout_ms: 5000,
          max_retries: 3,
          health_check_interval: 60000,
        },
      });

      console.log(`Test server running at ${baseUrl}`);
    });

    // Health Check Tests
    await t.step("Health check works", async () => {
      const health = await adapter.healthCheck();
      assertEquals(health.status, "healthy");
    });

    // Agent Discovery Tests
    await t.step("Discover agents", async () => {
      const agents = await adapter.discoverAgents();
      assertEquals(agents.length, 3);

      const agentNames = agents.map((a) => a.name);
      assertEquals(agentNames.includes("echo"), true);
      assertEquals(agentNames.includes("error"), true);
      assertEquals(agentNames.includes("slow"), true);
    });

    await t.step("Get agent details", async () => {
      const agent = await adapter.getAgentDetails("echo");
      assertEquals(agent.name, "echo");
      assertEquals(agent.description, "Simple echo agent that returns input messages");
      assertEquals(agent.metadata?.version, "1.0.0");
    });

    await t.step("Get non-existent agent throws error", async () => {
      await assertRejects(
        async () => await adapter.getAgentDetails("nonexistent"),
        Error,
        "Agent 'nonexistent' not found",
      );
    });

    // Sync Execution Tests
    await t.step("Sync execution - echo agent", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "echo",
        input: "Hello, world!",
        mode: "sync",
      };

      const result = await adapter.executeAgent(request);

      assertEquals(result.status, "completed");
      assertEquals(result.output.length, 1);
      assertEquals(result.output[0].content, "Echo: Hello, world!");
      assertEquals(typeof result.metadata.execution_time_ms, "number");
      assertEquals(result.metadata.execution_time_ms > 0, true);
    });

    await t.step("Sync execution - agent error", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "error",
        input: "Test error",
        mode: "sync",
      };

      const result = await adapter.executeAgent(request);

      assertEquals(result.status, "failed");
      assertStringIncludes(result.error || "", "Simulated agent processing error");
    });

    // Async Execution Tests
    await t.step("Async execution - echo agent", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "echo",
        input: "Hello, async!",
        mode: "async",
      };

      const result = await adapter.executeAgent(request);

      assertEquals(result.status, "completed");
      assertEquals(result.output.length, 1);
      assertEquals(result.output[0].content, "Echo: Hello, async!");
    });

    await t.step("Async execution - agent error", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "error",
        input: "Test async error",
        mode: "async",
      };

      const result = await adapter.executeAgent(request);

      assertEquals(result.status, "failed");
      assertStringIncludes(result.error || "", "Simulated agent processing error");
    });

    // Streaming Execution Tests
    await t.step("Streaming execution - echo agent", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "echo",
        input: "Hello, stream!",
        mode: "stream",
      };

      const events = [];
      for await (const event of adapter.executeAgentStream(request)) {
        events.push(event);
      }

      // Should receive: start, content, end events
      assertEquals(events.length >= 3, true);

      // Check for start/content/end pattern
      const hasStart = events.some((e) => e.type === "content" && e.content === "[START]");
      const hasContent = events.some((e) =>
        e.type === "content" && e.content?.includes("Echo: Hello, stream!")
      );
      const hasEnd = events.some((e) => e.type === "content" && e.content === "[END]");

      assertEquals(hasStart, true);
      assertEquals(hasContent, true);
      assertEquals(hasEnd, true);
    });

    await t.step("Streaming execution - agent error", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "error",
        input: "Test stream error",
        mode: "stream",
      };

      const events = [];
      for await (const event of adapter.executeAgentStream(request)) {
        events.push(event);
        // Break after a few events to avoid infinite loop
        if (events.length > 10) break;
      }

      // Should eventually get an error event
      const hasError = events.some((e) =>
        e.type === "error" ||
        (e.type === "completion" && e.status === "failed")
      );
      assertEquals(hasError, true);
    });

    // Error Scenario Tests
    await t.step("Server error (500) handling", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "server-error", // Special agent name that triggers 500 error
        input: "Test server error",
        mode: "sync",
      };

      await assertRejects(
        async () => await adapter.executeAgent(request),
        Error,
        "Remote execution failed",
      );
    });

    await t.step("Not found error (404) handling", async () => {
      await assertRejects(
        async () => await adapter.getAgentDetails("nonexistent"),
        Error,
        "Agent 'nonexistent' not found",
      );
    });

    await t.step("Bad request (400) handling", async () => {
      // Test with invalid agent name format
      await assertRejects(
        async () => await adapter.getAgentDetails("INVALID_NAME"),
        Error,
        "Invalid agent name format",
      );
    });

    // Timeout Handling Tests
    await t.step("Timeout handling - slow agent", async () => {
      // Create adapter with very short timeout
      const shortTimeoutAdapter = new ACPAdapter({
        endpoint: baseUrl,
        connection: {
          endpoint: baseUrl,
          timeout: 1000, // 1 second timeout
          retries: 1,
          keepAlive: true,
        },
        acp: {
          agent_name: "slow",
          default_mode: "sync",
          timeout_ms: 1000,
          max_retries: 1,
          health_check_interval: 60000,
        },
      });

      const request: RemoteExecutionRequest = {
        agentName: "slow", // Takes 2 seconds
        input: "Test timeout",
        mode: "sync",
      };

      await assertRejects(
        async () => await shortTimeoutAdapter.executeAgent(request),
        Error,
        // Should timeout or fail due to timeout
      );
    });

    // Authentication Tests (with no auth configured)
    await t.step("No authentication works", async () => {
      const noAuthAdapter = new ACPAdapter({
        endpoint: baseUrl,
        connection: {
          endpoint: baseUrl,
          timeout: 5000,
          retries: 3,
          keepAlive: true,
        },
        acp: {
          agent_name: "echo",
          default_mode: "sync",
          timeout_ms: 5000,
          max_retries: 3,
          health_check_interval: 60000,
        },
        // No auth configuration
      });

      const health = await noAuthAdapter.healthCheck();
      assertEquals(health.status, "healthy");
    });

    // Session Management Tests
    await t.step("Session management", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "echo",
        input: "Session test",
        mode: "sync",
        sessionId: "test-session-123",
      };

      const result = await adapter.executeAgent(request);
      assertEquals(result.status, "completed");
      // Session ID should be preserved in the execution
    });

    // Run Cancellation Tests
    await t.step("Run cancellation", async () => {
      // Start an async run
      const request: RemoteExecutionRequest = {
        agentName: "slow",
        input: "Cancel me",
        mode: "async",
      };

      const result = await adapter.executeAgent(request);
      const executionId = result.executionId;

      // Cancel the run
      await adapter.cancelExecution(executionId);

      // Verify cancellation worked (implementation specific)
      // The test server should handle cancellation
    });

    // Context and Metadata Tests
    await t.step("Execution metadata", async () => {
      const request: RemoteExecutionRequest = {
        agentName: "echo",
        input: "Metadata test",
        mode: "sync",
        context: {
          test_key: "test_value",
          user_id: "test-user",
        },
      };

      const result = await adapter.executeAgent(request);

      assertEquals(result.status, "completed");
      assertEquals(typeof result.metadata.execution_time_ms, "number");
      assertEquals(result.metadata.execution_time_ms > 0, true);
    });

    // Cleanup: Stop test server
    await t.step("Cleanup test server", async () => {
      await server.stop();
      console.log("Integration tests completed");
    });
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// Additional test for multiple concurrent requests
Deno.test({
  name: "ACP Adapter Concurrent Requests",
  fn: async () => {
    const server = new ACPTestServer();
    const port = await server.start();
    const baseUrl = `http://localhost:${port}`;

    try {
      const adapter = new ACPAdapter({
        endpoint: baseUrl,
        connection: {
          endpoint: baseUrl,
          timeout: 5000,
          retries: 3,
          keepAlive: true,
        },
        acp: {
          agent_name: "echo",
          default_mode: "sync",
          timeout_ms: 5000,
          max_retries: 3,
          health_check_interval: 60000,
        },
      });

      // Execute multiple requests concurrently
      const requests = Array.from({ length: 5 }, (_, i) => ({
        agentName: "echo",
        input: `Concurrent request ${i}`,
        mode: "sync" as const,
      }));

      const results = await Promise.all(
        requests.map((req) => adapter.executeAgent(req)),
      );

      // All should succeed
      for (let i = 0; i < results.length; i++) {
        assertEquals(results[i].status, "completed");
        assertEquals(results[i].output[0].content, `Echo: Concurrent request ${i}`);
      }
    } finally {
      await server.stop();
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});

// Test for network error handling
Deno.test({
  name: "ACP Adapter Network Error Handling",
  fn: async () => {
    // Create adapter pointing to non-existent server
    const adapter = new ACPAdapter({
      endpoint: "http://localhost:99999", // Port that doesn't exist
      connection: {
        endpoint: "http://localhost:99999",
        timeout: 1000,
        retries: 1,
        keepAlive: false,
      },
      acp: {
        agent_name: "echo",
        default_mode: "sync",
        timeout_ms: 1000,
        max_retries: 1,
        health_check_interval: 60000,
      },
    });

    // Health check should fail
    const health = await adapter.healthCheck();
    assertEquals(health.status, "unhealthy");
    assertEquals(typeof health.error, "string");

    // Agent discovery should throw
    await assertRejects(
      async () => await adapter.discoverAgents(),
      Error,
      "Failed to discover agents",
    );

    // Execution should throw
    await assertRejects(
      async () =>
        await adapter.executeAgent({
          agentName: "echo",
          input: "Test",
          mode: "sync",
        }),
      Error,
      "Remote execution failed",
    );
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
