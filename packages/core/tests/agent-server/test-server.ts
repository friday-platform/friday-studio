/**
 * Test MCP server that mocks daemon calls and removes timers.
 * Uses mock context builder to prevent HTTP calls during testing.
 */

import { AtlasAgentsMCPServer } from "../../src/agent-server/server.ts";
import type { AgentServerDependencies } from "../../src/agent-server/types.ts";
import { TestAgentExecutionManager } from "./test-agent-execution-manager.ts";
import { createMockContextBuilder } from "./test-helpers.ts";

export class TestAtlasAgentsMCPServer extends AtlasAgentsMCPServer {
  private testExecutionManager: TestAgentExecutionManager;

  constructor(deps: AgentServerDependencies & { disableTimeouts?: boolean }) {
    super(deps);

    // Replace execution manager with test version
    const mockContextBuilder = createMockContextBuilder();

    // Access private members without exposing internals
    const loadAgent = Reflect.get(this, "loadAgent").bind(this);
    const approvalQueue = Reflect.get(this, "approvalQueue");

    // Create test manager without state machine timers
    this.testExecutionManager = new TestAgentExecutionManager(
      (agentId: string) => loadAgent(agentId),
      mockContextBuilder,
      null, // sessionMemory
      approvalQueue,
      deps.logger,
    );

    // Inject test execution manager
    Reflect.set(this, "executionManager", this.testExecutionManager);
  }

  // Ensure all test agents shutdown cleanly
  override async stop(): Promise<void> {
    // Get execution status before shutdown
    const stats = this.testExecutionManager.getStats();

    // Stop all active agents immediately
    for (const agentId of Object.keys(stats.agentStates)) {
      this.testExecutionManager.unloadAgent(agentId);
    }

    // Complete server shutdown
    await super.stop();
  }
}
