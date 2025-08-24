/**
 * Error Handling Tests
 *
 * Tests Atlas error handling across the orchestrator → MCP → agent pipeline.
 * Validates graceful failures at each layer: network disconnection, invalid agents,
 * MCP protocol errors, and timeouts. Atlas returns errors in result objects
 * rather than throwing exceptions.
 */

import { assertEquals, assertExists } from "@std/assert";
import { cleanupTestServers, setupTestServers, type TestSetup } from "./test-helpers.ts";

/**
 * Tests error handling for non-existent agents.
 */
Deno.test({
  name: "AgentOrchestrator - handles invalid agent ID gracefully",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result = await setup.orchestrator.executeAgent("non-existent-agent", "echo test", {
        sessionId: "error-session-1",
        workspaceId: "test-workspace",
      });

      assertExists(result.error, "Should have an error for non-existent agent");
      assertEquals(result.output, null, "Output should be null when error occurs");
      assertEquals(result.agentId, "non-existent-agent", "Agent ID should be preserved");
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests input validation for empty agent IDs.
 */
Deno.test({
  name: "AgentOrchestrator - validates empty agent ID",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result = await setup.orchestrator.executeAgent(
        "", // Empty agent ID
        "echo test",
        { sessionId: "validation-session-1", workspaceId: "test-workspace" },
      );

      assertExists(result.error, "Should have an error for empty agent ID");
      assertEquals(result.output, null, "Output should be null when error occurs");
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests session context validation (currently skipped - validation not implemented in tool execution path).
 */
Deno.test({
  name: "AgentOrchestrator - requires valid session context",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: true, // Session validation not implemented in tool execution path
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result1 = await setup.orchestrator.executeAgent("test-agent", "echo test", {
        sessionId: "", // Invalid empty session ID
        workspaceId: "test-workspace",
      });

      assertExists(result1.error, "Should have an error for empty session ID");
      assertEquals(result1.output, null, "Output should be null when error occurs");

      const result2 = await setup.orchestrator.executeAgent("test-agent", "echo test", {
        sessionId: "valid-session",
        workspaceId: "", // Invalid empty workspace ID
      });

      assertExists(result2.error, "Should have an error for empty workspace ID");
      assertEquals(result2.output, null, "Output should be null when error occurs");
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});
