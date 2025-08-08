/**
 * MCP Response Parsing Tests
 *
 * Tests the "crazy typescript" MCP response unwrapping logic. MCP wraps agent responses
 * in {content: [{type: "text", text: "JSON-string"}]} format. The orchestrator must
 * extract and parse this back to typed objects while preserving data types and metadata.
 */

import { assertEquals, assertExists, assertObjectMatch } from "@std/assert";
import { cleanupTestServers, setupTestServers, type TestSetup } from "./test-helpers.ts";

/**
 * Tests MCP response unwrapping: {content: [{type: "text", text: "JSON-string"}]} → parsed object.
 */
Deno.test({
  name: "AgentOrchestrator - parses MCP text content responses correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      // Execute a simple command
      const result = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo MCP parsing test",
        {
          sessionId: "parse-test-1",
          workspaceId: "test-workspace",
        },
      );

      assertExists(result.output);
      assertEquals(typeof result.output, "object", "Output should be parsed object, not string");

      assertObjectMatch(result.output, {
        type: "echo",
        message: "MCP parsing test",
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests data type preservation through MCP transport (numbers, objects, dates).
 */
Deno.test({
  name: "AgentOrchestrator - preserves data types through MCP parsing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const calcResult = await setup.orchestrator.executeAgent(
        "test-agent",
        "calculate 123 + 456",
        {
          sessionId: "type-test-1",
          workspaceId: "test-workspace",
        },
      );

      assertObjectMatch(calcResult, {
        output: {
          type: "calculation",
          result: 579,
          expression: "123 + 456",
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
 * Tests edge cases in MCP response parsing (empty messages, minimal objects).
 */
Deno.test({
  name: "AgentOrchestrator - handles edge cases in MCP responses",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const emptyResult = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo ", // Empty message after "echo"
        {
          sessionId: "edge-test-1",
          workspaceId: "test-workspace",
        },
      );

      assertObjectMatch(emptyResult, {
        output: {
          type: "echo",
          message: "No message to echo",
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
 * Tests MCP parsing of agent error responses.
 */
Deno.test({
  name: "AgentOrchestrator - parses agent error responses through MCP",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const result = await setup.orchestrator.executeAgent(
        "test-agent",
        "invalid command that agent doesn't understand",
        {
          sessionId: "error-test-1",
          workspaceId: "test-workspace",
        },
      );

      assertExists(result.output);
      assertEquals(result.error, undefined, "Agent-level errors shouldn't be system errors");

      assertObjectMatch(result.output, {
        type: "unknown",
        message: "I don't understand that request",
        prompt: "invalid command that agent doesn't understand",
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests orchestrator metadata addition without interfering with agent response.
 */
Deno.test({
  name: "AgentOrchestrator - adds execution metadata to parsed responses",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const beforeExecution = Date.now();

      const result = await setup.orchestrator.executeAgent(
        "test-agent",
        "echo metadata test",
        {
          sessionId: "metadata-test-1",
          workspaceId: "test-workspace",
        },
      );

      const afterExecution = Date.now();

      assertEquals(result.agentId, "test-agent", "Agent ID should be added");
      assertEquals(result.task, "echo metadata test", "Task should be recorded");
      assertExists(result.timestamp, "Execution timestamp should be added");
      assertExists(result.duration, "Execution duration should be measured");

      const timestamp = new Date(result.timestamp).getTime();
      assertEquals(
        timestamp >= beforeExecution && timestamp <= afterExecution,
        true,
        "Timestamp should be within execution window",
      );

      assertExists(result.output, "Agent output should be preserved");
      assertObjectMatch(result.output, {
        type: "echo",
      });
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});
