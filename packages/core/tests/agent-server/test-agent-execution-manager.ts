/**
 * Test execution manager that removes state machine timers for deterministic testing.
 */

import type { AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { AwaitingSupervisorDecision } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { CoALAMemoryManager } from "@atlas/memory";
import { createActor } from "xstate";
import type {
  AgentExecutionMachineActor,
  ApprovalDecision,
} from "../../src/agent-server/agent-execution-machine.ts";
import type { BuildAgentContext } from "../../src/agent-server/agent-execution-manager.ts";
import type { ApprovalQueueManager } from "../../src/agent-server/approval-queue-manager.ts";
import { createTestAgentExecutionMachine } from "./test-execution-machine.ts";

// Test execution manager with deterministic state machines
export class TestAgentExecutionManager {
  private activeAgents = new Map<string, AgentExecutionMachineActor>();
  private loadAgentFn: (agentId: string) => Promise<AtlasAgent>;
  private contextBuilder: BuildAgentContext;
  private sessionMemory: CoALAMemoryManager | null;
  private approvalQueue?: ApprovalQueueManager;
  private logger: Logger;

  constructor(
    loadAgentFn: (agentId: string) => Promise<AtlasAgent>,
    contextBuilder: BuildAgentContext,
    sessionMemory: CoALAMemoryManager | null = null,
    approvalQueue: ApprovalQueueManager,
    logger: Logger,
  ) {
    this.loadAgentFn = loadAgentFn;
    this.contextBuilder = contextBuilder;
    this.sessionMemory = sessionMemory;
    this.approvalQueue = approvalQueue;
    this.logger = logger;
  }

  // Creates test execution actors without auto-transition timers
  private getOrCreateExecutionActor(agentId: string): AgentExecutionMachineActor {
    if (!this.activeAgents.has(agentId)) {
      const machine = createTestAgentExecutionMachine(
        this.loadAgentFn,
        this.contextBuilder,
        this.sessionMemory,
        this.logger,
      );
      const actor = createActor(machine, { input: { agentId } });

      actor.start();
      this.activeAgents.set(agentId, actor);
    }

    return this.activeAgents.get(agentId)!;
  }

  // Execute agent and handle approval workflow
  executeAgent(agentId: string, prompt: string, sessionData: AgentSessionData): Promise<unknown> {
    const actor = this.getOrCreateExecutionActor(agentId);

    return new Promise((resolve, reject) => {
      const subscription = actor.subscribe((snapshot) => {
        const state = snapshot.value;

        if (state === "completed" && snapshot.context.result) {
          subscription.unsubscribe();
          resolve(snapshot.context.result);
        } else if (state === "failed" && snapshot.context.error) {
          subscription.unsubscribe();
          reject(snapshot.context.error);
        } else if (state === "awaiting") {
          // Handle approval request by suspending execution
          const error = snapshot.context.error;
          if (error instanceof AwaitingSupervisorDecision && this.approvalQueue) {
            // Move to approval queue and wait for supervisor decision
            this.approvalQueue.suspendExecution(actor, error);

            // Remove from active list since it's suspended
            this.activeAgents.delete(agentId);

            subscription.unsubscribe();
            reject(error); // Propagate to supervisor
          }
        }
      });

      // Start execution
      actor.send({ type: "EXECUTE", prompt, sessionData });
    });
  }

  // Resume suspended agent with supervisor approval decision
  async resumeAgentWithApproval(approvalId: string, decision: ApprovalDecision): Promise<unknown> {
    if (!this.approvalQueue) {
      this.logger.error("No approval queue configured");
      return null;
    }

    // Get suspended actor and restore with approval decision
    const actor = await this.approvalQueue.restoreAndResume(approvalId, decision, {
      loadAgentFn: this.loadAgentFn,
      contextBuilder: this.contextBuilder,
      sessionMemory: this.sessionMemory,
    });

    if (!actor) {
      return null;
    }

    const agentId = actor.getSnapshot().context.agentId;

    // Re-activate the resumed agent
    this.activeAgents.set(agentId, actor);

    // Wait for resumed execution to complete
    return new Promise((resolve, reject) => {
      const subscription = actor.subscribe((snapshot) => {
        const state = snapshot.value;

        if (state === "completed" && snapshot.context.result) {
          subscription.unsubscribe();
          this.activeAgents.delete(agentId);
          resolve(snapshot.context.result);
        } else if (state === "failed" && snapshot.context.error) {
          subscription.unsubscribe();
          this.activeAgents.delete(agentId);
          reject(snapshot.context.error);
        } else if (state === "awaiting") {
          // Agent requesting approval again - re-suspend
          const error = snapshot.context.error;
          if (error instanceof AwaitingSupervisorDecision && this.approvalQueue) {
            this.approvalQueue.suspendExecution(actor, error);
            this.activeAgents.delete(agentId);
            subscription.unsubscribe();
            reject(error);
          }
        }
      });
    });
  }

  // Stop agent execution and cleanup
  unloadAgent(agentId: string): void {
    const actor = this.activeAgents.get(agentId);
    if (actor) {
      actor.send({ type: "UNLOAD" });
      actor.stop();
      this.activeAgents.delete(agentId);
    }
  }

  // Get current state machine state for agent
  getAgentState(agentId: string): string | undefined {
    const actor = this.activeAgents.get(agentId);
    const value = actor?.getSnapshot().value;
    return typeof value === "string" ? value : undefined;
  }

  // Get execution statistics for monitoring
  getStats(): { activeAgents: number; agentStates: Record<string, string> } {
    const agentStates: Record<string, string> = {};

    for (const [agentId, actor] of this.activeAgents) {
      const value = actor.getSnapshot().value;
      if (typeof value === "string") {
        agentStates[agentId] = value;
      }
    }

    return { activeAgents: this.activeAgents.size, agentStates };
  }

  // Shutdown all active agents
  shutdown(): void {
    for (const [, actor] of this.activeAgents) {
      actor.stop();
    }
    this.activeAgents.clear();
  }
}
