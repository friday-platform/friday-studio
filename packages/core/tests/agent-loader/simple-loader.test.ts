import { createAgent } from "@atlas/agent-sdk";
import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { SDKAgentAdapter } from "../../src/agent-loader/adapters/sdk-adapter.ts";
import { AgentLoader } from "../../src/agent-loader/loader.ts";

describe("Simple Agent Loader Test", () => {
  it("should work with SDK agents", async () => {
    const loader = new AgentLoader();
    const sdkAdapter = new SDKAgentAdapter();

    // Create a test SDK agent
    const testAgent = createAgent({
      id: "test-agent",
      version: "1.0.0",
      description: "Test agent",
      expertise: {
        domains: ["testing"],
        capabilities: ["run tests"],
        examples: ["test the system"],
      },
      handler: async (_prompt, _context) => {
        return await Promise.resolve({ message: "Test response" });
      },
    });

    // Register the agent
    sdkAdapter.registerAgent(testAgent);
    loader.addAdapter(sdkAdapter);

    // List agents
    const agents = await loader.listAgents();
    assertEquals(agents.length, 1);
    assertExists(agents[0]);
    assertEquals(agents[0].id, "test-agent");

    // Load agent
    const loaded = await loader.loadAgent("test-agent");
    assertExists(loaded);
    assertEquals(loaded.metadata.id, "test-agent");

    // Test caching
    const stats1 = loader.getCacheStats();
    assertEquals(stats1.size, 1);

    // Load again (should use cache)
    const loaded2 = await loader.loadAgent("test-agent");
    assertEquals(loaded, loaded2); // Same instance
  });
});
