/**
 * Agent Execution Manager
 *
 * Orchestrates agent execution lifecycle using XState actors.
 * Creates and manages state machine instances for each agent,
 * handling execution requests and approval flows.
 *
 * Architecture:
 *   Session Supervisor
 *       ↓ (executes agents via)
 *   Agent Execution Manager <- YOU ARE HERE
 *       ↓ (creates/manages)
 *   Agent Execution Machines (XState actors)
 *       ↓ (when approval needed)
 *   Approval Queue Manager (stores suspended states)
 */

import { createActor } from "xstate";
import type { AgentContext, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { AwaitingSupervisorDecision } from "@atlas/agent-sdk";
import { CoALAMemoryManager } from "@atlas/memory";
import type { Logger } from "@atlas/logger";
import type { ApprovalQueueManager } from "./approval-queue-manager.ts";
import {
  type AgentExecutionMachineActor,
  type ApprovalDecision,
  createAgentExecutionMachine,
  type PrepareContextOutput,
} from "./agent-execution-machine.ts";

export type BuildAgentContext = (
  agent: AtlasAgent,
  sessionData: AgentSessionData,
  sessionMemory: CoALAMemoryManager | null,
  prompt: string,
  overrides?: Partial<AgentContext>,
) => Promise<PrepareContextOutput>;

/**
 * Manages the execution lifecycle of agents in the Atlas system.
 *
 * Responsibilities:
 * - Creates and manages XState actors for agent execution
 * - Handles lazy loading of agent code
 * - Coordinates with approval queue for human-in-the-loop flows
 * - Tracks active agent executions
 */
export class AgentExecutionManager {
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
    this.logger = logger.child({ component: "AgentExecutionManager" });
  }

  /**
   * Update the session memory used for future agent executions.
   * Clears any cached actors so new machines pick up the updated memory.
   */
  setSessionMemory(memory: CoALAMemoryManager): void {
    this.sessionMemory = memory;
    // Recreate machines with updated memory for future executions
    for (const [agentId, actor] of this.activeAgents) {
      try {
        actor.stop();
      } catch (error) {
        this.logger.error("Error stopping actor during memory update", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.activeAgents.clear();
    this.logger.info("AgentExecutionManager session memory updated; cleared active actors");
  }

  /**
   * Get or create an execution actor for the specified agent.
   * Actors are reused across executions for the same agent.
   */
  private getOrCreateExecutionActor(agentId: string): AgentExecutionMachineActor {
    if (!this.activeAgents.has(agentId)) {
      const machine = createAgentExecutionMachine(
        this.loadAgentFn,
        this.contextBuilder,
        this.sessionMemory,
        this.logger,
      );
      const actor = createActor(machine, {
        input: { agentId },
      });

      actor.start();
      this.activeAgents.set(agentId, actor);
    }

    return this.activeAgents.get(agentId)!;
  }

  /**
   * Execute an agent with the given prompt and session data.
   * Returns a promise that resolves with the execution result.
   *
   * @throws {AwaitingSupervisorDecision} When agent requests approval
   * @throws {Error} When execution fails
   */
  executeAgent(agentId: string, prompt: string, sessionData: AgentSessionData): Promise<unknown> {
    this.logger.info("Executing agent", { agentId, prompt, ...sessionData });
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
          // Agent is requesting supervisor approval
          const error = snapshot.context.error;
          if (error instanceof AwaitingSupervisorDecision && this.approvalQueue) {
            // Suspend the agent execution and add to approval queue
            this.approvalQueue.suspendExecution(actor, error);

            // Remove from active agents as it's now suspended
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

  /**
   * Resume a suspended agent execution with an approval decision.
   * Used when supervisor approves/denies an agent's request.
   */
  async resumeAgentWithApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<unknown> {
    if (!this.approvalQueue) {
      this.logger.error("No approval queue configured");
      return null;
    }

    // Restore the suspended actor from approval queue
    const actor = await this.approvalQueue.restoreAndResume(
      approvalId,
      decision,
      {
        loadAgentFn: this.loadAgentFn,
        contextBuilder: this.contextBuilder,
        sessionMemory: this.sessionMemory,
      },
    );

    if (!actor) {
      return null;
    }

    const agentId = actor.getSnapshot().context.agentId;

    // Add back to active agents
    this.activeAgents.set(agentId, actor);

    // Wait for completion
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
          // Another approval request - suspend again
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

  /**
   * Unload an agent, stopping its execution actor.
   * Used for cleanup or when agent is no longer needed.
   */
  unloadAgent(agentId: string): void {
    const actor = this.activeAgents.get(agentId);
    if (actor) {
      actor.send({ type: "UNLOAD" });
      actor.stop();
      this.activeAgents.delete(agentId);
    }
  }

  /**
   * Get the current state of an agent's execution.
   * Useful for monitoring and debugging.
   */
  getAgentState(agentId: string): string | undefined {
    const actor = this.activeAgents.get(agentId);
    return actor?.getSnapshot().value as string | undefined;
  }

  /**
   * Get statistics about active agent executions.
   */
  getStats(): {
    activeAgents: number;
    agentStates: Record<string, string>;
  } {
    const agentStates: Record<string, string> = {};

    for (const [agentId, actor] of this.activeAgents) {
      agentStates[agentId] = actor.getSnapshot().value as string;
    }

    return {
      activeAgents: this.activeAgents.size,
      agentStates,
    };
  }

  /**
   * Stop all active agent executions.
   * Called during shutdown.
   */
  shutdown(): void {
    for (const [, actor] of this.activeAgents) {
      actor.stop();
    }
    this.activeAgents.clear();
  }
}
