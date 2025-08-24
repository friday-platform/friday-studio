import { createAgent } from "@atlas/agent-sdk";
import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { BundledAgentAdapter } from "../../src/agent-loader/adapters/bundled-adapter.ts";
import { SystemAgentAdapter } from "../../src/agent-loader/adapters/system-adapter.ts";
import { AgentLoader } from "../../src/agent-loader/loader.ts";
import { AgentRegistry } from "../../src/agent-loader/registry.ts";

describe("Agent Loader Architecture", () => {
  describe("AgentLoader", () => {
    it("should initialize with default options", () => {
      const loader = new AgentLoader();
      const stats = loader.getCacheStats();

      assertEquals(stats.enabled, true);
      assertEquals(stats.maxSize, 100);
      assertEquals(stats.size, 0);
    });

    it.skip("should add and remove adapters", () => {
      // TODO: Enable when system agents are ported to SDK
      const loader = new AgentLoader();
      const adapter = new SystemAgentAdapter();

      loader.addAdapter(adapter);
      assertEquals(loader.getAdapters().length, 1);

      const removed = loader.removeAdapter("system-agent-adapter");
      assertEquals(removed, true);
      assertEquals(loader.getAdapters().length, 0);
    });

    it.skip("should list agents from multiple adapters", async () => {
      // TODO: Enable when system agents are ported to SDK
      const loader = new AgentLoader();

      // Add system and bundled adapters
      loader.addAdapter(new SystemAgentAdapter());
      loader.addAdapter(new BundledAgentAdapter());

      const agents = await loader.listAgents();

      // Should have system agents (conversation, fact-extractor)
      // and bundled agents (slack, github)
      const agentIds = agents.map((a) => a.id);
      assertExists(agentIds.find((id) => id === "conversation"));
      assertExists(agentIds.find((id) => id === "fact-extractor"));
      assertExists(agentIds.find((id) => id === "slack"));
      assertExists(agentIds.find((id) => id === "github"));
    });
  });

  describe("AgentRegistry", () => {
    it.skip("should create registry for system workspaces (all agents)", async () => {
      // TODO: Enable when system agents are ported to SDK
      const registry = new AgentRegistry({ includeSystemAgents: true });
      await registry.initialize();

      const agents = await registry.listAgents();

      // Should also include bundled agents
      const bundledAgents = agents.filter((a) => a.id === "slack" || a.id === "github");
      assertEquals(bundledAgents.length > 0, true);
    });

    it("should register SDK agents dynamically", async () => {
      const registry = new AgentRegistry();
      await registry.initialize();

      // Create and register a test SDK agent
      const testAgent = createAgent({
        id: "test-agent",
        version: "1.0.0",
        description: "Test agent for unit tests",
        expertise: {
          domains: ["testing"],
          capabilities: ["unit testing"],
          examples: ["run tests"],
        },
        handler: async (_prompt, _context) => {
          return await Promise.resolve({ message: "Test response" });
        },
      });

      registry.registerAgent(testAgent);

      // Should be able to get the agent
      const retrieved = await registry.getAgent("test-agent");
      assertExists(retrieved);
      assertEquals(retrieved.metadata.id, "test-agent");
    });
  });

  describe("Adapter Integration", () => {
    it("should handle missing agents gracefully", async () => {
      const loader = new AgentLoader();
      loader.addAdapter(new BundledAgentAdapter());

      try {
        await loader.loadAgent("non-existent-agent");
        throw new Error("Should have thrown error");
      } catch (error) {
        assertEquals(error instanceof Error && error.message.includes("Agent not found"), true);
      }
    });
  });
});
