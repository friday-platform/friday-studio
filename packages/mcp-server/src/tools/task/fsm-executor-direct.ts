/**
 * Direct FSM executor - executes pre-compiled FSM definitions
 * Used by FSM-based task execution path
 */

import { AgentOrchestrator, type GlobalMCPServerPool } from "@atlas/core";
import { InMemoryDocumentStore } from "@atlas/document-store";
import type { Context, FSMEvent, SignalWithContext } from "@atlas/fsm-engine";
import { AtlasLLMProviderAdapter, createEngine, type MCPToolProvider } from "@atlas/fsm-engine";
import { logger } from "@atlas/logger";
import type { FSMDefinition } from "../../../../workspace-builder/types.ts";
import type { EnhancedTaskStep } from "./planner.ts";

interface ExecutionContext {
  sessionId: string;
  workspaceId: string;
  streamId: string;
  userId?: string;
  daemonUrl?: string;
  mcpServerPool?: GlobalMCPServerPool;
  mcpToolProvider?: MCPToolProvider;
}

interface ExecutionResult {
  success: boolean;
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

  let orchestrator: AgentOrchestrator | undefined;

  try {
    // 1. Create in-memory document store for FSM
    const docStore = new InMemoryDocumentStore();
    const scope = { workspaceId: context.workspaceId };

    // 2. Create shared AgentOrchestrator with isolated MCP pool
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

    // 3. Create agent executor callback
    const agentExecutor = async (
      agentId: string,
      fsmContext: Context,
      signal: SignalWithContext,
    ) => {
      logger.debug("Executing agent via orchestrator", {
        agentId,
        documentCount: fsmContext.documents.length,
        state: fsmContext.state,
      });

      // Build context from FSM documents
      const contextDocs = fsmContext.documents
        .map((doc) => `${doc.type}(${doc.id}): ${JSON.stringify(doc.data)}`)
        .join("\n");
      const prompt = `Execute task step\n\nContext:\n${contextDocs}`;

      // Execute agent via orchestrator
      if (!orchestrator) {
        throw new Error("Orchestrator not initialized");
      }
      const result = await orchestrator.executeAgent(agentId, prompt, {
        sessionId: context.sessionId,
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

      logger.debug("Agent execution completed", { agentId, success: !result.error });
      return result;
    };

    // 4. Create FSM engine
    const engine = createEngine(fsmDefinition, {
      documentStore: docStore,
      llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-5"),
      scope,
      agentExecutor,
      mcpToolProvider: context.mcpToolProvider,
    });

    await engine.initialize();
    logger.debug("FSM engine initialized");

    // 5. Execute FSM by sending trigger signal
    const triggerSignalType = fsmDefinition.id.replace(/-fsm$/, "-trigger");
    await engine.signal(
      { type: triggerSignalType },
      { sessionId: context.sessionId, workspaceId: context.workspaceId },
    );

    // 6. Collect results from FSM documents
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

    return { success, results };
  } catch (error) {
    logger.error("FSM execution failed", { error });
    return {
      success: false,
      results: [
        {
          step: 0,
          agent: steps[0]?.agentId || "unknown",
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
