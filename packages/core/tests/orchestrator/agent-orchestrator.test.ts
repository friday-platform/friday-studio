/**
 * @deprecated Test file for backwards compatibility with system agents.
 * Will be removed once all system agents are migrated to SDK.
 */

import { assertEquals, assertExists } from "@std/assert";
import { createLogger } from "@atlas/logger";
import { AgentOrchestrator } from "@atlas/core";
import { SystemAgentConfig } from "@atlas/config";

Deno.env.set("DENO_TESTING", "true");

/**
 * Tests system agent registration on orchestrator construction.
 */
Deno.test({
  name: "AgentOrchestrator - registers system agents on construction",
  fn: () => {
    const logger = createLogger({ component: "test" });

    // Create orchestrator with system agent config
    const systemAgents = new Map<string, SystemAgentConfig>();
    systemAgents.set("test-conversation", {
      type: "system",
      description: "Manages conversations",
      agent: "conversation-agent",
    });

    const orchestrator = new AgentOrchestrator({
      agentsServerUrl: "http://localhost:8082/mcp",
      systemAgents,
    }, logger);

    // @ts-ignore - accessing private property for testing
    const registeredSystemAgents = orchestrator.systemAgents;
    assertExists(registeredSystemAgents);
    assertEquals(registeredSystemAgents.size, 1);
    assertEquals(registeredSystemAgents.get("test-conversation")?.agent, "conversation-agent");
  },
});

/**
 * Tests registerSystemAgent method functionality.
 */
Deno.test({
  name: "AgentOrchestrator - registerSystemAgent method works correctly",
  fn: () => {
    const logger = createLogger({ component: "test" });

    // Create orchestrator with initial system agent config
    const systemAgents = new Map<string, SystemAgentConfig>();
    systemAgents.set("test-conversation", {
      type: "system",
      description: "Manages conversations",
      agent: "conversation-agent",
    });

    const orchestrator = new AgentOrchestrator({
      agentsServerUrl: "http://localhost:8082/mcp",
      systemAgents,
    }, logger);

    const newConfig: SystemAgentConfig = {
      type: "system",
      description: "Extracts facts from text",
      agent: "fact-extractor",
    };

    orchestrator.registerSystemAgent("test-fact", newConfig);

    // @ts-ignore - accessing private property for testing
    const registeredSystemAgents = orchestrator.systemAgents;
    assertEquals(registeredSystemAgents.size, 2);
    assertEquals(registeredSystemAgents.get("test-fact")?.agent, "fact-extractor");
  },
});
