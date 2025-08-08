/**
 * Tests the supervisor approval workflow - when agents request approval for risky operations,
 * they're suspended until a human supervisor makes an approval decision.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { AgentExecutionManager } from "../../src/agent-server/agent-execution-manager.ts";
import {
  type ApprovalDecision,
  createAgentExecutionMachine,
} from "../../src/agent-server/agent-execution-machine.ts";
import { createMockContextBuilder } from "./test-helpers.ts";
import { ApprovalQueueManager } from "../../src/agent-server/approval-queue-manager.ts";
import { createActor } from "xstate";
import {
  type AgentContext,
  type AgentSessionData,
  type AtlasAgent,
  AwaitingSupervisorDecision,
} from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";

Deno.env.set("DENO_TESTING", "true");

// Agent that throws AwaitingSupervisorDecision to simulate approval requests
class ApprovalRequestAgent implements AtlasAgent {
  metadata = {
    id: "approval-agent",
    name: "Approval Agent",
    version: "1.0.0",
    description: "Agent that requests approval",
    expertise: {
      domains: ["testing"],
      capabilities: ["approval"],
      examples: ["test approval"],
    },
  };

  shouldRequestApproval = false;
  executionCount = 0;

  execute(_prompt: string, context: AgentContext): Promise<unknown> {
    this.executionCount++;

    if (this.shouldRequestApproval) {
      // Simulate agent requesting supervisor approval for risky operation
      throw new AwaitingSupervisorDecision(
        "test-approval-id",
        {
          action: "dangerous_operation",
          risk_level: "high",
          context: {
            resource: "production_database",
            impact: "Potential data loss",
            reversible: false,
          },
          rationale: "Requested to drop production tables",
        },
        context.session.sessionId,
        this.metadata.id,
      );
    }

    return Promise.resolve({ result: "Executed without approval" });
  }

  get environmentConfig() {
    return undefined;
  }

  get mcpConfig() {
    return undefined;
  }

  get llmConfig() {
    return undefined;
  }
}

describe("Approval Queue Flow", () => {
  let approvalQueue: ApprovalQueueManager;
  let executionManager: AgentExecutionManager;
  let contextBuilder: ReturnType<typeof createMockContextBuilder>;
  let mockAgent: ApprovalRequestAgent;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
    approvalQueue = new ApprovalQueueManager(logger);
    contextBuilder = createMockContextBuilder();

    mockAgent = new ApprovalRequestAgent();

    const loadAgentFn = (agentId: string) => {
      if (agentId === "approval-agent") {
        return Promise.resolve(mockAgent);
      }
      return Promise.reject(new Error(`Agent not found: ${agentId}`));
    };

    executionManager = new AgentExecutionManager(
      loadAgentFn,
      contextBuilder,
      null, // No memory manager
      approvalQueue,
      logger,
    );
  });

  afterEach(async () => {
    executionManager.shutdown();
    approvalQueue.clearAll();
    // Give timers a chance to clear
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("should suspend agent execution and add to approval queue", async () => {
    mockAgent.shouldRequestApproval = true;

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    try {
      await executionManager.executeAgent(
        "approval-agent",
        "Do something dangerous",
        sessionData,
      );

      assert(false, "Expected AwaitingSupervisorDecision to be thrown");
    } catch (error) {
      // Verify the error was thrown
      assert(error instanceof AwaitingSupervisorDecision);
      if (error instanceof AwaitingSupervisorDecision) {
        assertEquals(error.approvalId, "test-approval-id");
        assertEquals(error.agentId, "approval-agent");

        // Verify agent execution was suspended and queued for approval
        const suspended = approvalQueue.getSuspendedExecution("test-approval-id");
        assertExists(suspended);
        assertEquals(suspended.agentId, "approval-agent");
        assertEquals(suspended.approvalRequest.action, "dangerous_operation");
        assertEquals(suspended.originalPrompt, "Do something dangerous");
      }
    }
  });

  it.skip("should resume suspended agent after supervisor approval", async () => {
    mockAgent.shouldRequestApproval = true;

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // First execution - trigger approval
    try {
      await executionManager.executeAgent(
        "approval-agent",
        "Do something dangerous",
        sessionData,
      );
    } catch (error) {
      assert(error instanceof AwaitingSupervisorDecision);
    }

    // Verify suspended
    assertEquals(approvalQueue.getAllSuspended().length, 1);

    // Resume with approval
    mockAgent.shouldRequestApproval = false; // Don't request approval on resume
    const decision: ApprovalDecision = {
      approved: true,
      reason: "Approved for testing",
    };

    const result = await executionManager.resumeAgentWithApproval("test-approval-id", decision);
    assertEquals(result, { result: "Executed without approval" });
    assertEquals(mockAgent.executionCount, 2); // Initial + resumed

    // Verify no longer suspended
    assertEquals(approvalQueue.getAllSuspended().length, 0);
  });

  it.skip("should handle supervisor rejection of approval request", async () => {
    mockAgent.shouldRequestApproval = true;

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // First execution - trigger approval
    try {
      await executionManager.executeAgent(
        "approval-agent",
        "Do something dangerous",
        sessionData,
      );
    } catch (error) {
      assert(error instanceof AwaitingSupervisorDecision);
    }

    // Resume with rejection
    mockAgent.shouldRequestApproval = false; // Don't request approval on resume
    const decision: ApprovalDecision = {
      approved: false,
      reason: "Too risky for production",
    };

    const result = await executionManager.resumeAgentWithApproval("test-approval-id", decision);

    // When not approved, agent should still execute but can check the decision
    assertExists(result);
  });

  it.skip("should handle multiple approval requests from same agent", async () => {
    let approvalCount = 0;

    // Custom agent that requests approval twice
    class MultiApprovalAgent extends ApprovalRequestAgent {
      override execute(_prompt: string, context: AgentContext): Promise<unknown> {
        approvalCount++;

        if (approvalCount <= 2) {
          throw new AwaitingSupervisorDecision(
            `approval-${approvalCount}`,
            {
              action: `operation_${approvalCount}`,
              risk_level: "medium",
              context: {},
              rationale: `Request ${approvalCount}`,
            },
            context.session.sessionId,
            this.metadata.id,
          );
        }

        return Promise.resolve({ result: "Completed after approvals" });
      }
    }

    const multiAgent = new MultiApprovalAgent();
    executionManager = new AgentExecutionManager(
      () => Promise.resolve(multiAgent),
      contextBuilder,
      null,
      approvalQueue,
      logger,
    );

    const sessionData: AgentSessionData = {
      sessionId: "test-session",
      workspaceId: "test-workspace",
    };

    // First execution - first approval
    try {
      await executionManager.executeAgent(
        "approval-agent",
        "Multi-step operation",
        sessionData,
      );
    } catch (error) {
      assert(error instanceof AwaitingSupervisorDecision);
      if (error instanceof AwaitingSupervisorDecision) {
        assertEquals(error.approvalId, "approval-1");
      }
    }

    // First approval
    try {
      await executionManager.resumeAgentWithApproval("approval-1", { approved: true });
    } catch (error) {
      // Should throw second approval request
      assert(error instanceof AwaitingSupervisorDecision);
      if (error instanceof AwaitingSupervisorDecision) {
        assertEquals(error.approvalId, "approval-2");
      }
    }

    // Second approval
    const result = await executionManager.resumeAgentWithApproval("approval-2", { approved: true });
    assertEquals(result, { result: "Completed after approvals" });
  });

  it("should track suspended agent statistics", () => {
    // Manually add some suspended agents
    const manager = new ApprovalQueueManager(logger);

    // Create mock actors
    const machine = createAgentExecutionMachine(
      () => Promise.resolve(mockAgent),
      contextBuilder,
      null,
      logger,
    );

    const actor1 = createActor(machine, { input: { agentId: "agent1" } });
    const actor2 = createActor(machine, { input: { agentId: "agent2" } });

    actor1.start();
    actor2.start();

    manager.suspendExecution(
      actor1,
      new AwaitingSupervisorDecision(
        "approval-1",
        { action: "op1", risk_level: "low", context: {}, rationale: "test" },
        "session-1",
        "agent1",
      ),
    );

    manager.suspendExecution(
      actor2,
      new AwaitingSupervisorDecision(
        "approval-2",
        { action: "op2", risk_level: "high", context: {}, rationale: "test" },
        "session-2",
        "agent1",
      ),
    );

    const stats = manager.getQueueStats();
    assertEquals(stats.totalPending, 2);
    assertEquals(stats.pendingByAgent["agent1"], 2);
    assertExists(stats.oldestPending);

    // Clean up - actors should be stopped when suspended
    // but let's make sure they're stopped
    actor1.stop();
    actor2.stop();
  });
});
