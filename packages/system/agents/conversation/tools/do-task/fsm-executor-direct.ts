/**
 * Direct FSM executor - executes pre-compiled FSM definitions
 * Used by FSM-based task execution path
 */

import {
  AgentOrchestrator,
  type GlobalMCPServerPool,
  mapFsmEventToSessionEvent,
  ReasoningResultStatus,
  SessionHistoryStorage,
} from "@atlas/core";
import { ChatStorage } from "@atlas/core/chat/storage";
import { InMemoryDocumentStore } from "@atlas/document-store";
import type {
  AgentAction,
  Context,
  FSMDefinition,
  FSMEvent,
  SignalWithContext,
} from "@atlas/fsm-engine";
import {
  AtlasLLMProviderAdapter,
  createEngine,
  expandArtifactRefsInDocuments,
  type MCPToolProvider,
} from "@atlas/fsm-engine";
import { createFSMOutputValidator, SupervisionLevel } from "@atlas/hallucination";
import { logger } from "@atlas/logger";
import type { EnhancedTaskStep } from "./planner.ts";
import type { DatetimeContext, TaskProgressEvent } from "./types.ts";

interface ExecutionContext {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  userId?: string;
  daemonUrl?: string;
  datetime?: DatetimeContext;
  mcpServerPool?: GlobalMCPServerPool;
  mcpToolProvider?: MCPToolProvider;
  onProgress?: (event: TaskProgressEvent) => void;
  abortSignal?: AbortSignal;
  /** Task intent for session history */
  intent?: string;
}

export interface ExecutionResult {
  success: boolean;
  failedStep?: number;
  error?: string;
  results: Array<{
    step: number;
    agent: string;
    success: boolean;
    output?: unknown;
    error?: string;
  }>;
}

/**
 * Execute task via pre-compiled FSM definition
 *
 * @param fsmDefinition - Already compiled FSM definition
 * @param steps - Task steps (for result mapping)
 * @param context - Execution context with session info and MCP pool
 * @returns Execution results for each step
 */
export async function executeTaskViaFSMDirect(
  fsmDefinition: FSMDefinition,
  steps: EnhancedTaskStep[],
  context: ExecutionContext,
): Promise<ExecutionResult> {
  logger.info("Starting direct FSM execution", {
    fsmId: fsmDefinition.id,
    stepCount: steps.length,
    hasMCPPool: !!context.mcpServerPool,
  });

  // Check abort signal before starting
  if (context.abortSignal?.aborted) {
    return { success: false, error: "Task cancelled", results: [] };
  }

  let orchestrator: AgentOrchestrator | undefined;
  let currentStepIndex = 0;

  try {
    // 1. Create in-memory document store for FSM
    const docStore = new InMemoryDocumentStore();
    const scope = { workspaceId: context.workspaceId };

    // 2. Build stepByAgentId lookup
    const stepByAgentId = new Map<string, { index: number; step: EnhancedTaskStep }>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step) {
        const agentId = step.agentId || `llm-step-${i}`;
        stepByAgentId.set(agentId, { index: i, step });
      }
    }

    // 3. Create unique task session ID to isolate from parent conversation
    const taskSessionId = `${context.sessionId}-task-${crypto.randomUUID().slice(0, 8)}`;

    // 4. Create shared AgentOrchestrator with isolated MCP pool
    const agentsServerUrl = context.daemonUrl || "http://localhost:8080";
    orchestrator = new AgentOrchestrator(
      {
        agentsServerUrl: `${agentsServerUrl}/agents`,
        mcpServerPool: context.mcpServerPool, // Use isolated pool from task
        daemonUrl: context.daemonUrl,
        requestTimeoutMs: 300000,
      },
      logger.child({ component: "TaskFSMOrchestrator" }),
    );

    // 4. Create agent executor callback
    const agentExecutor = async (
      action: AgentAction,
      fsmContext: Context,
      signal: SignalWithContext,
    ) => {
      const agentId = action.agentId;

      // Check abort before each step
      if (context.abortSignal?.aborted) {
        throw new Error("Task cancelled");
      }

      const stepInfo = stepByAgentId.get(agentId);

      // Track current step for error reporting
      if (stepInfo) {
        currentStepIndex = stepInfo.index;
      }

      // Emit step-start progress
      if (stepInfo && context.onProgress) {
        context.onProgress({
          type: "step-start",
          stepIndex: stepInfo.index,
          totalSteps: steps.length,
          description: stepInfo.step.friendlyDescription || stepInfo.step.description,
        });
      }

      logger.debug("Executing agent via orchestrator", {
        agentId,
        documentCount: fsmContext.documents.length,
        state: fsmContext.state,
      });

      // Expand artifact refs to include actual content for downstream agents
      const expandedDocs = await expandArtifactRefsInDocuments(
        fsmContext.documents,
        context.abortSignal,
      );

      // Build context from expanded FSM documents
      const contextDocs = expandedDocs
        .map((doc) => `${doc.type}(${doc.id}): ${JSON.stringify(doc.data)}`)
        .join("\n");
      // Prompt precedence: action.prompt > step.description > fallback
      // Matches workspace-runtime.ts buildFinalAgentPrompt behavior
      const taskDescription = action.prompt || stepInfo?.step.description || "Execute task step";
      const datetimeSection = context.datetime
        ? `## Context Facts\n- Current Date: ${context.datetime.localDate}\n- Current Time: ${context.datetime.localTime} (${context.datetime.timezone})\n- Timestamp: ${context.datetime.timestamp}\n- Timezone Offset: ${context.datetime.timezoneOffset}\n\n`
        : "";
      const prompt = `${datetimeSection}Task: ${taskDescription}\n\nContext:\n${contextDocs}`;

      // Execute agent via orchestrator
      if (!orchestrator) {
        throw new Error("Orchestrator not initialized");
      }
      const result = await orchestrator.executeAgent(agentId, prompt, {
        sessionId: taskSessionId,
        workspaceId: context.workspaceId,
        streamId: context.streamId,
        userId: context.userId,
        onStreamEvent: signal._context?.onEvent
          ? (chunk) => {
              const callback = signal._context?.onEvent;
              if (callback) {
                callback(chunk as unknown as FSMEvent);
              }
            }
          : undefined,
        additionalContext: { documents: fsmContext.documents },
      });

      // Emit step-complete progress
      if (stepInfo && context.onProgress) {
        context.onProgress({
          type: "step-complete",
          stepIndex: stepInfo.index,
          success: result.ok,
        });
      }

      logger.debug("Agent execution completed", { agentId, ok: result.ok });
      return result;
    };

    // 5. Create FSM engine
    const engine = createEngine(fsmDefinition, {
      documentStore: docStore,
      llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-5"),
      scope,
      agentExecutor,
      mcpToolProvider: context.mcpToolProvider,
      validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
    });

    await engine.initialize();
    logger.debug("FSM engine initialized");

    // 6. Execute FSM by sending trigger signal
    const triggerSignalType = fsmDefinition.id.replace(/-fsm$/, "-trigger");

    // Build state-to-step lookup (state "step_0" → index 0)
    const stateToStepIndex = new Map<string, number>();
    for (let i = 0; i < steps.length; i++) {
      stateToStepIndex.set(`step_${i}`, i);
    }

    // Collect FSM events for session history persistence
    const collectedFsmEvents: FSMEvent[] = [];

    // Handle FSM events for LLM actions (agent actions already handled by agentExecutor)
    const onEvent = (event: FSMEvent) => {
      // Collect FSM events for session history persistence
      // Note: data-fsm-state-transition is no longer persisted
      if (
        event.type === "data-fsm-action-execution" ||
        event.type === "data-fsm-tool-call" ||
        event.type === "data-fsm-tool-result"
      ) {
        collectedFsmEvents.push(event);
      }

      // Handle progress events for LLM actions
      if (event.type === "data-fsm-action-execution" && event.data.actionType === "llm") {
        const stepIndex = stateToStepIndex.get(event.data.state);
        if (stepIndex === undefined) return;

        const step = steps[stepIndex];
        if (!step || !context.onProgress) return;

        if (event.data.status === "started") {
          context.onProgress({
            type: "step-start",
            stepIndex,
            totalSteps: steps.length,
            description: step.friendlyDescription || step.description,
          });
        } else if (event.data.status === "completed" || event.data.status === "failed") {
          context.onProgress({
            type: "step-complete",
            stepIndex,
            success: event.data.status === "completed",
          });
        }
      }
    };

    await engine.signal(
      { type: triggerSignalType },
      { sessionId: context.sessionId, workspaceId: context.workspaceId, onEvent },
    );

    // 7. Collect results from FSM documents
    logger.debug("FSM execution completed", {
      documentCount: engine.documents.length,
      documents: engine.documents.map((d) => ({
        type: d.type,
        id: d.id,
        dataKeys: typeof d.data === "object" && d.data !== null ? Object.keys(d.data) : [],
      })),
    });

    const results = [];

    // Map FSM documents to step results
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      const agentId = step.agentId || `llm-step-${i}`;

      // Look for result document for this step
      let found = false;
      let resultDoc = null;

      for (const doc of engine.documents) {
        if (
          typeof doc.data === "object" &&
          doc.data !== null &&
          doc.id === `${agentId.replaceAll("-", "_")}_result`
        ) {
          resultDoc = doc;
          found = true;
          break;
        }
      }

      if (found && resultDoc) {
        const output =
          typeof resultDoc.data === "object" && resultDoc.data !== null ? resultDoc.data : {};

        results.push({
          step: i,
          agent: agentId,
          success: !("error" in output && output.error),
          output,
        });
      } else {
        logger.warn("No result document found for step", {
          step: i,
          agentId,
          availableDocIds: engine.documents.map((d) => d.id),
        });
        results.push({
          step: i,
          agent: agentId,
          success: false,
          error: "No result found for step",
        });
      }
    }

    const success = results.every((r) => r.success);
    logger.info("FSM execution completed", { success, stepCount: results.length });

    const execResult: ExecutionResult = { success, results };

    // Persist session record and FSM events
    await persistTaskSession({
      taskSessionId,
      context,
      fsmDefinition,
      steps,
      collectedFsmEvents,
      execResult,
    });

    return execResult;
  } catch (error) {
    logger.error("FSM execution failed", { error, step: currentStepIndex });
    return {
      success: false,
      failedStep: currentStepIndex,
      results: [
        {
          step: currentStepIndex,
          agent: steps[currentStepIndex]?.agentId || "unknown",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  } finally {
    // Always cleanup orchestrator (MCP pool cleanup done by caller)
    if (orchestrator) {
      await orchestrator.shutdown();
    }
  }
}

/**
 * Persist task session record and FSM events to session history.
 * Non-blocking - logs warning on failure but doesn't throw.
 */
async function persistTaskSession(params: {
  taskSessionId: string;
  context: ExecutionContext;
  fsmDefinition: FSMDefinition;
  steps: EnhancedTaskStep[];
  collectedFsmEvents: FSMEvent[];
  execResult: ExecutionResult;
}): Promise<void> {
  const { taskSessionId, context, fsmDefinition, steps, collectedFsmEvents, execResult } = params;
  const success = execResult.success;

  try {
    // Fetch parent chat title
    let parentTitle: string | undefined;
    if (context.streamId) {
      try {
        const parentChatResult = await ChatStorage.getChat(context.streamId);
        if (parentChatResult.ok && parentChatResult.data) {
          parentTitle = parentChatResult.data.title;
        }
      } catch {
        // Parent chat might not exist - continue without title
      }
    }

    // Create session record with intent as title
    await SessionHistoryStorage.createSessionRecord({
      sessionId: taskSessionId,
      workspaceId: context.workspaceId,
      status: success ? ReasoningResultStatus.COMPLETED : ReasoningResultStatus.FAILED,
      signal: {
        id: "do-task",
        provider: { id: "conversation-agent", name: "Conversation Agent" },
        workspaceId: context.workspaceId,
      },
      signalPayload: { intent: context.intent },
      jobSpecificationId: fsmDefinition.id,
      availableAgents: steps.map((s) => s.agentId).filter((id): id is string => Boolean(id)),
      streamId: context.streamId,
      summary: context.intent?.slice(0, 200),
      title: context.intent?.slice(0, 60), // Use intent as title (truncated to 60 chars)
      parentStreamId: context.streamId,
      parentTitle,
      sessionType: "task",
    });

    // Persist FSM events
    const sortedEvents = [...collectedFsmEvents].sort(
      (a, b) => a.data.timestamp - b.data.timestamp,
    );
    for (const fsmEvent of sortedEvents) {
      const historyEvent = mapFsmEventToSessionEvent(fsmEvent);
      await SessionHistoryStorage.appendSessionEvent({
        sessionId: taskSessionId,
        emittedBy: "do-task",
        emittedAt: new Date(fsmEvent.data.timestamp).toISOString(),
        event: historyEvent,
      });
    }

    // DUAL-WRITE: output goes to both session-finish event and session metadata.
    // These are independent file writes; partial failure can cause divergence.
    // See workspace-runtime.ts persistSessionToHistory for the same pattern.
    await SessionHistoryStorage.appendSessionEvent({
      sessionId: taskSessionId,
      emittedBy: "do-task",
      event: {
        type: "session-finish" as const,
        data: {
          status: success ? ("completed" as const) : ("failed" as const),
          durationMs: 0, // Could calculate from collectedFsmEvents
          output: execResult.results,
        },
      },
    });

    // Mark session complete with output
    await SessionHistoryStorage.markSessionComplete(
      taskSessionId,
      success ? "completed" : "failed",
      new Date().toISOString(),
      { output: execResult.results },
    );

    logger.debug("Persisted task session", { taskSessionId, eventCount: sortedEvents.length });
  } catch (error) {
    logger.warn("Failed to persist task session", {
      taskSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't fail - task result is more important than persistence
  }
}
