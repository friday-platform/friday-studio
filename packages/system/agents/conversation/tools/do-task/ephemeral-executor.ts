/**
 * Ephemeral FSM executor - executes pre-compiled FSM definitions for ad-hoc tasks.
 * No workspace.yml, no daemon registration. Session history still persisted for debugging.
 */

import type { AtlasUIMessageChunk } from "@atlas/agent-sdk";
import {
  expandAgentActions,
  type MCPServerConfig,
  resolveRuntimeAgentId,
  type WorkspaceAgentConfig,
} from "@atlas/config";
import { AgentOrchestrator } from "@atlas/core";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
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
} from "@atlas/fsm-engine";
import { createFSMOutputValidator, SupervisionLevel } from "@atlas/hallucination";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { buildTemporalFacts, type PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import type { DAGStep, DocumentContract } from "@atlas/workspace-builder";
import type {
  DatetimeContext,
  EnhancedTaskStep,
  InnerToolCallEvent,
  TaskProgressEvent,
} from "./types.ts";

interface ExecutionContext {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  platformModels: PlatformModels;
  userId?: string;
  daemonUrl?: string;
  datetime?: DatetimeContext;
  mcpServerConfigs?: Record<string, MCPServerConfig>;
  onProgress?: (event: TaskProgressEvent) => void;
  /** Callback for forwarding inner agent tool calls to the parent stream */
  onInnerToolCall?: (event: InnerToolCallEvent) => void;
  abortSignal?: AbortSignal;
  /** Task intent for session history */
  intent?: string;
  /** DAG steps for state name → step index mapping */
  dagSteps?: DAGStep[];
  /** Document contracts for result collection by document ID */
  documentContracts?: DocumentContract[];
  /** Ledger adapter for resource tools in sub-tasks */
  resourceAdapter?: ResourceStorageAdapter;
  /** Artifact storage adapter for image context in sub-tasks */
  artifactStorage?: ArtifactStorageAdapter;
  /** Workspace agent configs for agent indirection (expansion + resolution) */
  workspaceAgents?: Record<string, WorkspaceAgentConfig>;
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
 * Build a handler that converts streaming tool chunks into InnerToolCallEvents.
 * Reusable across agent actions (via orchestrator) and LLM actions (via FSM engine).
 */
function buildToolChunkHandler(
  onInnerToolCall: (event: InnerToolCallEvent) => void,
): (chunk: AtlasUIMessageChunk) => void {
  // Track toolCallId → toolName + input so we can correlate output chunks
  const toolCallData = new Map<string, { toolName: string; input?: string }>();

  return (chunk: AtlasUIMessageChunk) => {
    if (chunk.type === "tool-input-available") {
      const inputStr = chunk.input != null ? JSON.stringify(chunk.input) : undefined;
      toolCallData.set(chunk.toolCallId, { toolName: chunk.toolName, input: inputStr });
      onInnerToolCall({ toolName: chunk.toolName, status: "started", input: inputStr });
    } else if (chunk.type === "tool-output-available") {
      const data = toolCallData.get(chunk.toolCallId);
      const toolName = data?.toolName ?? "unknown";
      toolCallData.delete(chunk.toolCallId);
      onInnerToolCall({
        toolName,
        status: "completed",
        input: data?.input,
        result:
          typeof chunk.output === "string"
            ? chunk.output
            : chunk.output != null
              ? JSON.stringify(chunk.output)
              : undefined,
      });
    } else if (chunk.type === "tool-output-error") {
      const data = toolCallData.get(chunk.toolCallId);
      const toolName = data?.toolName ?? "unknown";
      toolCallData.delete(chunk.toolCallId);
      onInnerToolCall({ toolName, status: "failed", input: data?.input, result: chunk.errorText });
    }
  };
}

/**
 * Build a stream event handler that forwards FSM events to the signal context
 * and intercepts tool-related chunks to emit inner tool call events.
 */
function buildStreamEventHandler(
  signal: SignalWithContext,
  onInnerToolCall?: (event: InnerToolCallEvent) => void,
): ((chunk: AtlasUIMessageChunk) => void) | undefined {
  const hasFSMCallback = !!signal._context?.onEvent;
  if (!hasFSMCallback && !onInnerToolCall) return undefined;

  const toolHandler = onInnerToolCall ? buildToolChunkHandler(onInnerToolCall) : undefined;

  return (chunk: AtlasUIMessageChunk) => {
    // Forward to FSM event handler (existing behavior)
    if (hasFSMCallback) {
      const callback = signal._context?.onEvent;
      if (callback) {
        callback(chunk as unknown as FSMEvent);
      }
    }

    // Intercept tool-related chunks and forward as inner tool call events
    if (toolHandler) {
      toolHandler(chunk);
    }
  };
}

/**
 * Execute task via pre-compiled FSM definition
 *
 * @param fsmDefinition - Already compiled FSM definition
 * @param steps - Task steps (for result mapping)
 * @param context - Execution context with session info and MCP server configs
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
    hasMCPConfigs: !!context.mcpServerConfigs,
  });

  if (context.abortSignal?.aborted) {
    return { success: false, error: "Task cancelled", results: [] };
  }

  let orchestrator: AgentOrchestrator | undefined;
  let engine: ReturnType<typeof createEngine> | undefined;
  let currentStepIndex = 0;

  try {
    const docStore = new InMemoryDocumentStore();
    const scope = { workspaceId: context.workspaceId };

    // Build step lookup keyed by executionRef (matches action.agentId at runtime)
    const stepByExecutionRef = new Map<string, { index: number; step: EnhancedTaskStep }>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step) {
        stepByExecutionRef.set(step.executionRef, { index: i, step });
      }
    }

    // Isolate from parent conversation to avoid session cross-talk
    const taskSessionId = `${context.sessionId}-task-${crypto.randomUUID().slice(0, 8)}`;

    const agentsServerUrl = context.daemonUrl || "http://localhost:8080";
    orchestrator = new AgentOrchestrator(
      {
        agentsServerUrl: `${agentsServerUrl}/agents`,
        daemonUrl: context.daemonUrl,
        requestTimeoutMs: 300000,
      },
      logger.child({ component: "TaskFSMOrchestrator" }),
    );

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
      const datetimeSection = context.datetime ? `${buildTemporalFacts(context.datetime)}\n\n` : "";
      const prompt = `${datetimeSection}Task: ${taskDescription}\n\nContext:\n${contextDocs}`;

      // Execute agent via orchestrator
      if (!orchestrator) {
        throw new Error("Orchestrator not initialized");
      }
      const agentConfig = context.workspaceAgents?.[agentId];
      const runtimeAgentId = resolveRuntimeAgentId(agentConfig, agentId);

      const onStreamEvent = buildStreamEventHandler(signal, context.onInnerToolCall);

      const result = await orchestrator.executeAgent(runtimeAgentId, prompt, {
        sessionId: taskSessionId,
        workspaceId: context.workspaceId,
        streamId: context.streamId,
        userId: context.userId,
        onStreamEvent,
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

    // Expand LLM workspace agents — converts type: agent → type: llm for LLM agents
    const expandedFSM = context.workspaceAgents
      ? expandAgentActions(fsmDefinition, context.workspaceAgents)
      : fsmDefinition;

    engine = createEngine(expandedFSM, {
      documentStore: docStore,
      llmProvider: new AtlasLLMProviderAdapter(context.platformModels.get("conversational")),
      scope,
      agentExecutor,
      mcpServerConfigs: context.mcpServerConfigs,
      validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
      resourceAdapter: context.resourceAdapter,
      artifactStorage: context.artifactStorage,
    });

    await engine.initialize();
    logger.debug("FSM engine initialized");

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

    // Build streaming handler for LLM actions (converts tool chunks to InnerToolCallEvents)
    const onStreamEvent = context.onInnerToolCall
      ? buildToolChunkHandler(context.onInnerToolCall)
      : undefined;

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

      // Forward FSM tool events as inner tool call events for UI transparency.
      // Skip when streaming is active — tool events already emitted in real-time via onStreamEvent.
      if (context.onInnerToolCall && !onStreamEvent) {
        if (event.type === "data-fsm-tool-call") {
          const toolCall = event.data.toolCall;
          if (toolCall.toolName !== "complete" && toolCall.toolName !== "failStep") {
            const inputStr = toolCall.input != null ? JSON.stringify(toolCall.input) : undefined;
            context.onInnerToolCall({
              toolName: toolCall.toolName,
              status: "started",
              input: inputStr,
            });
          }
        } else if (event.type === "data-fsm-tool-result") {
          const toolResult = event.data.toolResult;
          if (toolResult.toolName !== "complete" && toolResult.toolName !== "failStep") {
            const output = toolResult.output;
            const resultStr =
              typeof output === "string"
                ? output
                : output != null
                  ? JSON.stringify(output)
                  : undefined;
            context.onInnerToolCall({
              toolName: toolResult.toolName,
              status: "completed",
              result: resultStr,
            });
          }
        }
      }
    };

    await engine.signal(
      { type: triggerSignalType },
      { sessionId: context.sessionId, workspaceId: context.workspaceId, onEvent, onStreamEvent },
    );

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
    // Always cleanup orchestrator
    if (orchestrator) {
      await orchestrator.shutdown();
    }
  }
}
