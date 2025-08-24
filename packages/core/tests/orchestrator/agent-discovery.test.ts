/**
 * Agent Discovery Tests
 *
 * Tests Atlas agent discovery via MCP resources. In Atlas architecture, agents register
 * their capabilities with the agent server, which exposes them as MCP resources.
 * The orchestrator discovers available agents by listing these resources.
 */

import { assertEquals, assertExists } from "@std/assert";
import type { TestSetup } from "./test-helpers.ts";
import { cleanupTestServers, setupTestServers } from "./test-helpers.ts";

/**
 * Core agent discovery - tests MCP resource listing and metadata parsing.
 */
Deno.test({
  name: "AgentOrchestrator - discovers registered agents via MCP",
  // Disable resource leak detection for integration tests
  // MCP server and HTTP connections may not clean up synchronously
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const agents = await setup.orchestrator.discoverAgents();

      assertEquals(agents.length, 1, "Should discover exactly one test agent");

      const firstAgent = agents[0];
      assertExists(firstAgent, "First agent should exist");
      // assert on canonical ID and displayName rather than deprecated `name`
      assertEquals(firstAgent.id, "test-agent", "Agent id should match");
      assertEquals(firstAgent.displayName, "test-agent", "Agent displayName should match");
      assertExists(firstAgent.expertise, "Agent should have expertise");
      assertEquals(firstAgent.expertise.domains, ["testing"], "Agent domains should match");
      assertEquals(
        firstAgent.expertise.capabilities,
        ["echo messages", "simple calculations"],
        "Agent capabilities should be preserved",
      );
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});

/**
 * Tests agent discovery after orchestrator reconnection.
 */
Deno.test({
  name: "AgentOrchestrator - handles agent discovery after reconnection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let setup: TestSetup | null = null;

    try {
      setup = await setupTestServers();

      const agents1 = await setup.orchestrator.discoverAgents();
      assertEquals(agents1.length, 1, "Initial discovery should work");

      await setup.orchestrator.shutdown();

      await setup.orchestrator.initialize();

      const agents2 = await setup.orchestrator.discoverAgents();
      assertEquals(agents2.length, 1, "Discovery after reconnection should work");
      const firstAgentAfterReconnect = agents2[0];
      assertExists(firstAgentAfterReconnect, "Should have first agent after reconnect");
      assertEquals(firstAgentAfterReconnect.id, "test-agent", "Should discover the same agent");
      assertEquals(
        firstAgentAfterReconnect.displayName,
        "test-agent",
        "Should keep the same displayName",
      );
    } finally {
      if (setup) {
        await cleanupTestServers(setup);
      }
    }
  },
});
