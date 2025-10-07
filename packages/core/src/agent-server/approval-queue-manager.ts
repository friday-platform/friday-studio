/**
 * Approval Queue Manager
 *
 * Manages a queue of agent executions that are suspended awaiting
 * supervisor approval. Uses XState's snapshot persistence to preserve
 * agent state while waiting for decisions.
 *
 * Architecture:
 *   Session Supervisor
 *       ↓ (executes agents via)
 *   Agent Execution Manager
 *       ↓ (creates/manages)
 *   Agent Execution Machines (XState actors)
 *       ↓ (when approval needed)
 *   Approval Queue Manager <- YOU ARE HERE
 */

import type {
  AgentContext,
  AgentSessionData,
  ApprovalRequest,
  AtlasAgent,
  AwaitingSupervisorDecision,
} from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { CoALAMemoryManager } from "@atlas/memory";
import { createActor, type Snapshot } from "xstate";
import {
  type AgentExecutionMachineActor,
  createAgentExecutionMachine,
} from "./agent-execution-machine.ts";

/**
 * Information about a suspended agent execution awaiting approval
 */
interface SuspendedExecution {
  approvalId: string;
  agentId: string;
  sessionId: string;
  /** XState persisted snapshot for state restoration */
  snapshot: Snapshot<unknown>;
  /** The approval request details */
  approvalRequest: ApprovalRequest;
  /** When the execution was suspended */
  suspendedAt: Date;
  /** Original prompt for context */
  originalPrompt: string;
}

/**
 * Supervisor's decision on an approval request
 */
interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /** Modified action to execute instead */
  modifiedAction?: string;
  /** Additional conditions or restrictions */
  conditions?: string[];
}

/**
 * Dependencies needed to restore a suspended execution
 */
interface RestoreDependencies {
  loadAgentFn: (id: string) => Promise<AtlasAgent>;
  contextBuilder: (
    agent: AtlasAgent,
    sessionData: AgentSessionData,
    sessionMemory: CoALAMemoryManager | null,
    prompt: string,
    overrides?: Partial<AgentContext>,
  ) => Promise<{ context: AgentContext; enrichedPrompt: string }>;
  sessionMemory: CoALAMemoryManager | null;
}

/**
 * Manages a queue of agent executions suspended for approval.
 *
 * When an agent requests supervisor approval during execution,
 * its state is captured and stored here until the supervisor
 * makes a decision.
 */
export class ApprovalQueueManager {
  private suspendedExecutions = new Map<string, SuspendedExecution>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Suspend an agent execution that's requesting approval.
   * Captures the current state for later restoration.
   */
  suspendExecution(actor: AgentExecutionMachineActor, error: AwaitingSupervisorDecision): void {
    // Capture the actor's state before stopping it
    const snapshot = actor.getPersistedSnapshot();
    const currentSnapshot = actor.getSnapshot();

    this.suspendedExecutions.set(error.approvalId, {
      approvalId: error.approvalId,
      agentId: error.agentId,
      sessionId: error.sessionId,
      snapshot,
      approvalRequest: error.request,
      suspendedAt: new Date(),
      originalPrompt: currentSnapshot.context.currentPrompt || "",
    });

    // Stop the actor - it's now suspended
    actor.stop();

    this.logger.info("Suspended agent", { agentId: error.agentId, approvalId: error.approvalId });
  }

  /**
   * Restore a suspended execution and resume with the supervisor's decision.
   * Returns the restored actor or null if not found.
   */
  restoreAndResume(
    approvalId: string,
    decision: ApprovalDecision,
    deps: RestoreDependencies,
  ): Promise<AgentExecutionMachineActor | null> {
    const suspended = this.suspendedExecutions.get(approvalId);
    if (!suspended) {
      this.logger.warn("No suspended execution found", { approvalId });
      return Promise.resolve(null);
    }

    this.logger.info("Resuming agent with decision", { agentId: suspended.agentId, decision });

    // Recreate the state machine and restore from snapshot
    const machine = createAgentExecutionMachine(
      deps.loadAgentFn,
      deps.contextBuilder,
      deps.sessionMemory,
      this.logger,
    );

    // @ts-expect-error - this code isn't in use.
    const actor = createActor(machine, { snapshot: suspended.snapshot });

    // Start the actor and send the approval decision
    actor.start();
    actor.send({ type: "RESUME_WITH_APPROVAL", approvalId, decision });

    // Remove from queue
    this.suspendedExecutions.delete(approvalId);

    return Promise.resolve(actor);
  }

  /**
   * Get all suspended executions.
   * Useful for monitoring and UI display.
   */
  getAllSuspended(): SuspendedExecution[] {
    return Array.from(this.suspendedExecutions.values());
  }

  /**
   * Get a specific suspended execution by approval ID.
   */
  getSuspendedExecution(approvalId: string): SuspendedExecution | undefined {
    return this.suspendedExecutions.get(approvalId);
  }

  /**
   * Check if an approval is pending.
   */
  hasApprovalPending(approvalId: string): boolean {
    return this.suspendedExecutions.has(approvalId);
  }

  /**
   * Cancel a suspended execution.
   * Used when user rejects or system performs cleanup.
   */
  cancelApproval(approvalId: string): boolean {
    const existed = this.suspendedExecutions.delete(approvalId);
    if (existed) {
      this.logger.info("Cancelled approval", { approvalId });
    }
    return existed;
  }

  /**
   * Get queue statistics for monitoring.
   */
  getQueueStats(): {
    totalPending: number;
    pendingByAgent: Record<string, number>;
    oldestPending: Date | null;
    averageWaitTime: number;
  } {
    const executions = this.getAllSuspended();
    const pendingByAgent: Record<string, number> = {};
    let oldestPending: Date | null = null;
    let totalWaitTime = 0;

    const now = new Date();

    for (const execution of executions) {
      // Count by agent
      pendingByAgent[execution.agentId] = (pendingByAgent[execution.agentId] || 0) + 1;

      // Track oldest
      if (!oldestPending || execution.suspendedAt < oldestPending) {
        oldestPending = execution.suspendedAt;
      }

      // Calculate wait time
      totalWaitTime += now.getTime() - execution.suspendedAt.getTime();
    }

    return {
      totalPending: executions.length,
      pendingByAgent,
      oldestPending,
      averageWaitTime: executions.length > 0 ? totalWaitTime / executions.length : 0,
    };
  }

  /**
   * Remove expired approvals based on age.
   * Returns the number of approvals removed.
   */
  cleanupExpiredApprovals(maxAgeMs: number = 3600000): number {
    // 1 hour default
    const now = Date.now();
    let removed = 0;

    for (const [approvalId, execution] of this.suspendedExecutions) {
      const age = now - execution.suspendedAt.getTime();
      if (age > maxAgeMs) {
        this.suspendedExecutions.delete(approvalId);
        removed++;
        this.logger.info("Expired approval", {
          approvalId,
          agentId: execution.agentId,
          ageSeconds: Math.round(age / 1000),
        });
      }
    }

    return removed;
  }

  /**
   * Clear all pending approvals.
   * Used during shutdown or emergency reset.
   */
  clearAll(): void {
    const count = this.suspendedExecutions.size;
    this.suspendedExecutions.clear();
    this.logger.info("Cleared pending approvals", { count });
  }
}
