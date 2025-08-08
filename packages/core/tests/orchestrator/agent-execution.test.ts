/**
 * Agent Execution Tests
 *
 * Tests Atlas agent execution pipeline via MCP tool calls. This is the core Atlas
 * interaction: orchestrator invokes agents through MCP tools, session context flows
 * through the call stack, and responses are parsed back to typed objects.
 */

import { assertEquals, assertExists, assertObjectMatch } from "@std/assert";
import { cleanupTestServers, setupTestServers, type TestSetup } from "./test-helpers.ts";
import type { AgentResult } from "../../src/orchestrator/agent-orchestrator.ts";

/**
 * Core Atlas agent execution - tests orchestrator → MCP → agent → response flow.
 * Validates session context propagation and MCP response parsing.
 */
Deno.test({
  name: "AgentOrchestrator - executes echo command via MCP",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      // Execute agent with echo command
      const result: AgentResult = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo Hello from orchestrator test!",
        {
          sessionId: "test-session-123",
          workspaceId: "test-workspace",
          userId: "test-user",
        },
      );

      assertExists(result, "Result should exist");
      assertEquals(result.agentId, "test-agent", "Agent ID should match");
      assertExists(result.output, "Output should exist");
      assertEquals(result.error, undefined, "Should not have an error");

      assertObjectMatch(result.output, {
        type: "echo",
        message: "Hello from orchestrator test!",
        sessionId: "test-session-123",
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests MCP transport with complex data types (numbers, nested objects).
 */
Deno.test({
  name: "AgentOrchestrator - executes calculation command with correct types",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result: AgentResult = await setup.orchestrator.executeAgent(
        "test-agent",
        "calculate 42 + 58",
        {
          sessionId: "test-session-456",
          workspaceId: "test-workspace",
          userId: "test-user",
        },
      );

      assertExists(result);
      assertEquals(result.agentId, "test-agent");
      assertExists(result.output);
      assertEquals(result.error, undefined, "Should not have an error");

      assertObjectMatch(result.output, {
        type: "calculation",
        expression: "42 + 58",
        result: 100,
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests agent-level error handling (unrecognized commands).
 */
Deno.test({
  name: "AgentOrchestrator - handles unknown commands gracefully",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result: AgentResult = await setup.orchestrator.executeAgent(
        "test-agent",
        "do something unknown",
        {
          sessionId: "test-session-789",
          workspaceId: "test-workspace",
          userId: "test-user",
        },
      );

      assertExists(result);
      assertEquals(result.agentId, "test-agent");
      assertExists(result.output);
      assertEquals(result.error, undefined, "Should not have a system error");

      assertObjectMatch(result.output, {
        type: "unknown",
        message: "I don't understand that request",
        prompt: "do something unknown",
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests session context variations (optional userId, different session IDs).
 */
Deno.test({
  name: "AgentOrchestrator - propagates various session contexts correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result1 = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo test with user",
        {
          sessionId: "session-with-user",
          workspaceId: "workspace-1",
          userId: "user-123",
        },
      );

      assertObjectMatch(result1, {
        output: {
          type: "echo",
          sessionId: "session-with-user",
        },
      });

      const result2 = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo test without user",
        {
          sessionId: "session-no-user",
          workspaceId: "workspace-2",
          // userId omitted
        },
      );

      assertObjectMatch(result2, {
        output: {
          type: "echo",
          sessionId: "session-no-user",
        },
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests execution timing metadata (duration, timestamps).
 */
Deno.test({
  name: "AgentOrchestrator - tracks execution duration correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const startTime = Date.now();

      const result = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo timing test",
        {
          sessionId: "timing-session",
          workspaceId: "test-workspace",
        },
      );

      const endTime = Date.now();
      const totalDuration = endTime - startTime;

      assertExists(result.duration, "Duration should be tracked");
      assertEquals(typeof result.duration, "number", "Duration should be a number");
      assertEquals(result.duration > 0, true, "Duration should be positive");
      assertEquals(
        result.duration <= totalDuration,
        true,
        "Tracked duration should not exceed total time",
      );

      assertExists(result.timestamp, "Timestamp should exist");
      const timestamp = new Date(result.timestamp);
      assertEquals(
        isNaN(timestamp.getTime()),
        false,
        "Timestamp should be valid ISO string",
      );
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});
