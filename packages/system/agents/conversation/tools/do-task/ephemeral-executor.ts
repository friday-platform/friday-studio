/**
 * Ephemeral FSM executor - executes pre-compiled FSM definitions for ad-hoc tasks.
 * No workspace.yml, no daemon registration. Session history still persisted for debugging.
 */

import { AgentOrchestrator, type GlobalMCPServerPool } from "@atlas/core";
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
import type { DAGStep, DocumentContract } from "@atlas/workspace-builder";
import type { DatetimeContext, EnhancedTaskStep, TaskProgressEvent } from "./types.ts";

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
  /** DAG steps for state name → step index mapping */
  dagSteps?: DAGStep[];
  /** Document contracts for result collection by document ID */
  documentContracts?: DocumentContract[];
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
  let engine: ReturnType<typeof createEngine> | undefined;
  let currentStepIndex = 0;

  try {
    // 1. Create in-memory document store for FSM
    const docStore = new InMemoryDocumentStore();
    const scope = { workspaceId: context.workspaceId };

    // 2. Build step lookup keyed by executionRef (matches action.agentId at runtime)
    const stepByExecutionRef = new Map<string, { index: number; step: EnhancedTaskStep }>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step) {
        stepByExecutionRef.set(step.executionRef, { index: i, step });
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

      const stepInfo = stepByExecutionRef.get(agentId);

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
    engine = createEngine(fsmDefinition, {
      documentStore: docStore,
      llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-6"),
      scope,
      agentExecutor,
      mcpToolProvider: context.mcpToolProvider,
      validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
    });

    await engine.initialize();
    logger.debug("FSM engine initialized");

    // 6. Execute FSM by sending trigger signal
    const triggerSignalType = "adhoc-trigger";

    // Build state-to-step lookup using DAG step IDs (state "step_retrieve_users" → index 0)
    // The compiler generates state names as `step_${normalize(dagStep.id)}` where normalize replaces - with _
    const stateToStepIndex = new Map<string, number>();
    if (context.dagSteps) {
      for (let i = 0; i < context.dagSteps.length; i++) {
        const dagStep = context.dagSteps[i];
        if (dagStep) {
          stateToStepIndex.set(`step_${dagStep.id.replace(/-/g, "_")}`, i);
        }
      }
    } else {
      // Fallback for callers that don't pass dagSteps
      for (let i = 0; i < steps.length; i++) {
        stateToStepIndex.set(`step_${i}`, i);
      }
    }

    // Handle FSM events for LLM actions (agent actions already handled by agentExecutor)
    const onEvent = (event: FSMEvent) => {
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

    // 7. Collect results from FSM results accumulator
    const engineResults = engine.results;
    logger.debug("FSM execution completed", {
      resultKeys: Object.keys(engineResults),
      documentCount: engine.documents.length,
    });

    // Build step → documentId lookup from contracts
    const stepDocumentId = new Map<string, string>();
    if (context.documentContracts) {
      for (const contract of context.documentContracts) {
        stepDocumentId.set(contract.producerStepId, contract.documentId);
      }
    }

    const results = [];
    const dagSteps = context.dagSteps ?? [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step) continue;
      const executionRef = step.executionRef;

      // Look up the document ID from the contract for this step
      const dagStep = dagSteps[i];
      const docId = dagStep ? stepDocumentId.get(dagStep.id) : undefined;

      // Try results accumulator first (keyed by documentId from contract)
      const resultData = docId ? engineResults[docId] : undefined;

      if (resultData) {
        results.push({
          step: i,
          agent: executionRef,
          success: !("error" in resultData && resultData.error),
          output: resultData,
        });
      } else {
        // Fallback: scan engine documents for any matching result
        const fallbackDoc = engine.documents.find(
          (d) => d.id === docId || d.id === `${executionRef.replaceAll("-", "_")}_result`,
        );
        if (fallbackDoc) {
          const output =
            typeof fallbackDoc.data === "object" && fallbackDoc.data !== null
              ? fallbackDoc.data
              : {};
          results.push({
            step: i,
            agent: executionRef,
            success: !("error" in output && output.error),
            output,
          });
        } else {
          logger.warn("No result found for step", {
            step: i,
            executionRef,
            dagStepId: dagStep?.id,
            expectedDocId: docId,
            availableResultKeys: Object.keys(engineResults),
          });
          results.push({
            step: i,
            agent: executionRef,
            success: false,
            error: "No result found for step",
          });
        }
      }
    }

    const success = results.every((r) => r.success);
    logger.info("FSM execution completed", { success, stepCount: results.length });

    const execResult: ExecutionResult = { success, results };

    return execResult;
  } catch (error) {
    logger.error("FSM execution failed", { error, step: currentStepIndex });

    // Harvest results from steps that succeeded before the failure
    const partialResults: ExecutionResult["results"] = [];
    const engineResults = engine?.results ?? {};
    const dagSteps = context.dagSteps ?? [];
    const stepDocumentId = new Map<string, string>();
    if (context.documentContracts) {
      for (const contract of context.documentContracts) {
        stepDocumentId.set(contract.producerStepId, contract.documentId);
      }
    }

    for (let i = 0; i < currentStepIndex; i++) {
      const step = steps[i];
      if (!step) continue;
      const dagStep = dagSteps[i];
      const docId = dagStep ? stepDocumentId.get(dagStep.id) : undefined;
      const resultData = docId ? engineResults[docId] : undefined;

      if (resultData) {
        partialResults.push({
          step: i,
          agent: step.executionRef || `llm-step-${i}`,
          success: !("error" in resultData && resultData.error),
          output: resultData,
        });
      }
      // If no result data found, skip — step may not have committed
    }

    // Append the failed step
    partialResults.push({
      step: currentStepIndex,
      agent: steps[currentStepIndex]?.executionRef ?? "unknown",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });

    return { success: false, failedStep: currentStepIndex, results: partialResults };
  } finally {
    // Always cleanup orchestrator (MCP pool cleanup done by caller)
    if (orchestrator) {
      await orchestrator.shutdown();
    }
  }
}
