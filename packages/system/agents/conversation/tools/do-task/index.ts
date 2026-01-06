/**
 * do_task Tool - Direct tool with progress emission
 */
import type { ArtifactRef } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig } from "@atlas/config";
import { GlobalMCPServerPool } from "@atlas/core";
import { GlobalMCPToolProvider, type MCPToolProvider } from "@atlas/fsm-engine";
import { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { jsonSchema, tool } from "ai";
import { getAgentCatalog } from "./catalog.ts";
import { extractArtifactsFromOutput } from "./extract-artifacts.ts";
import { executeTaskViaFSM } from "./fsm-executor.ts";
import { generateTaskFSM } from "./fsm-generator.ts";
import { planTaskEnhanced } from "./planner.ts";
import type { TaskExecutionContext, TaskProgressEvent } from "./types.ts";

/**
 * Format progress event for display.
 * Returns empty string for events that should be silent.
 */
function formatProgressMessage(event: TaskProgressEvent): string {
  switch (event.type) {
    case "planning":
      return "Planning...";
    case "preparing":
      return "Spinning up agents...";
    case "step-start":
      return event.description;
    case "step-complete":
      return "";
  }
}

interface DoTaskResult {
  success: boolean;
  summary?: string;
  plan?: {
    steps: Array<{ agentId?: string; description: string; executionType?: string }>;
    mcpServers: string[];
  };
  results?: Array<{
    step: number;
    agent: string;
    success: boolean;
    output?: unknown;
    error?: string;
  }>;
  error?: string;
  artifactId?: string;
  artifacts?: ArtifactRef[];
}

async function generateTaskSummary(
  intent: string,
  stepCount: number,
  success: boolean,
): Promise<string> {
  try {
    return await smallLLM({
      system: "Summarize task execution in 1 sentence, ≤100 chars. Be direct, no fluff.",
      prompt: `Intent: ${intent}\nSteps: ${stepCount}\nStatus: ${success ? "succeeded" : "failed"}`,
      maxOutputTokens: 50,
    });
  } catch {
    return `Task: ${intent.slice(0, 60)}... (${stepCount} steps, ${success ? "ok" : "failed"})`;
  }
}

async function storeTaskArtifact(
  data: { intent: string; plan: unknown; results: unknown; success: boolean },
  context: { workspaceId: string; streamId: string },
  logger: Logger,
): Promise<string> {
  const summary = await generateTaskSummary(
    data.intent,
    Array.isArray(data.results) ? data.results.length : 0,
    data.success,
  );

  const artifactResult = await parseResult(
    client.artifactsStorage.index.$post({
      json: {
        data: {
          type: "summary" as const,
          version: 1 as const,
          data: JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2),
        },
        title: `Task: ${data.intent.slice(0, 80)}${data.intent.length > 80 ? "..." : ""}`,
        summary,
        workspaceId: context.workspaceId,
        chatId: context.streamId,
      },
    }),
  );

  if (!artifactResult.ok) {
    logger.warn("Failed to store task artifact", { error: artifactResult.error });
    return `task-${Date.now()}`;
  }
  return artifactResult.data.artifact.id;
}

/**
 * Creates the do_task tool with writer closure access.
 */
export function createDoTaskTool(
  writer: UIMessageStreamWriter,
  session: {
    sessionId: string;
    workspaceId: string;
    streamId: string;
    userId?: string;
    daemonUrl?: string;
  },
  logger: Logger,
  abortSignal?: AbortSignal,
) {
  const emitProgress = (event: TaskProgressEvent) => {
    const content = formatProgressMessage(event);
    if (!content) return;

    writer.write({
      type: "data-tool-progress",
      data: {
        toolName: "do_task",
        content,
        ...(event.type === "step-start" && {
          stepIndex: event.stepIndex,
          totalSteps: event.totalSteps,
        }),
      },
    });
  };

  return tool({
    name: "do_task",
    description:
      "Execute a task using appropriate agents. Use for ad-hoc tasks " +
      "not covered by configured workspace automations.",
    inputSchema: jsonSchema<{ intent: string }>({
      type: "object",
      properties: {
        intent: { type: "string", description: "What the user wants to accomplish. Be specific." },
      },
      required: ["intent"],
    }),
    execute: async ({ intent }): Promise<DoTaskResult> => {
      if (abortSignal?.aborted) {
        return { success: false, error: "Task cancelled" };
      }

      logger.info("do_task executing", { intent });

      try {
        // 1. Planning
        emitProgress({ type: "planning" });
        const catalog = await getAgentCatalog();
        const planResult = await planTaskEnhanced(intent, catalog, abortSignal);

        if (!planResult.success) {
          return { success: false, error: planResult.reason };
        }

        const plan = planResult.plan;
        const totalSteps = plan.steps.length;

        // 2. Generate FSM
        emitProgress({ type: "preparing", stepCount: totalSteps });
        const fsmResult = await generateTaskFSM(plan, intent, abortSignal);

        if (!fsmResult.ok) {
          return { success: false, error: fsmResult.error.message };
        }

        // 3. Create MCP pool and provider
        // Always create the pool - bundled agents (like google-calendar) need it
        // for their embedded MCP configs even when plan.mcpServers is empty
        let mcpToolProvider: MCPToolProvider | undefined;
        const mcpServerPool = new GlobalMCPServerPool(logger.child({ component: "TaskMCPPool" }));

        if (plan.mcpServers.length > 0) {
          const mcpServerConfigs: Record<string, MCPServerConfig> = {};
          for (const server of plan.mcpServers) {
            mcpServerConfigs[server.id] = server.config;
          }

          mcpToolProvider = new GlobalMCPToolProvider(
            mcpServerPool,
            session.workspaceId,
            mcpServerConfigs,
            logger.child({ component: "TaskMCPProvider" }),
          );
        }

        try {
          // 4. Execute with progress callbacks
          const context: TaskExecutionContext = {
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            streamId: session.streamId,
            userId: session.userId,
            daemonUrl: session.daemonUrl,
            abortSignal,
            onProgress: emitProgress,
          };

          const execResult = await executeTaskViaFSM(
            fsmResult.data,
            plan.steps,
            context,
            mcpServerPool,
            mcpToolProvider,
          );

          // 5. Extract artifacts
          const artifacts = execResult.results
            .filter((r) => r.success && r.output)
            .flatMap((r) => extractArtifactsFromOutput(r.output));

          // 6. Store artifact
          const artifactId = await storeTaskArtifact(
            { intent, plan: plan.steps, results: execResult.results, success: execResult.success },
            { workspaceId: session.workspaceId, streamId: session.streamId },
            logger,
          );

          if (execResult.success) {
            return {
              success: true,
              summary: `Executed ${execResult.results.length} step(s)`,
              plan: {
                steps: plan.steps.map((s) => ({
                  agentId: s.agentId,
                  description: s.description,
                  executionType: s.executionType,
                })),
                mcpServers: plan.mcpServers.map((s) => s.id),
              },
              results: execResult.results,
              artifactId,
              artifacts,
            };
          } else {
            const failedStep = execResult.results.find((r) => !r.success);
            return {
              success: false,
              error: `Step ${failedStep?.step} failed: ${failedStep?.error || "unknown"}`,
              plan: {
                steps: plan.steps.map((s) => ({
                  agentId: s.agentId,
                  description: s.description,
                  executionType: s.executionType,
                })),
                mcpServers: plan.mcpServers.map((s) => s.id),
              },
              results: execResult.results,
              artifacts,
            };
          }
        } finally {
          await mcpServerPool.dispose();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("do_task failed", { error: message });
        return { success: false, error: message };
      }
    },
  });
}
