/**
 * Task execution tool - Production implementation
 *
 * This tool:
 * 1. Takes a user intent
 * 2. Uses enhanced planning LLM to select agents and identify MCP needs
 * 3. Generates FSM definition from plan
 * 4. Executes via FSM engine with isolated MCP access
 * 5. Returns results
 *
 * Feature flag: USE_FSM_EXECUTION (default: true)
 * - true: Enhanced planning + FSM execution with isolated MCPs
 * - false: Simple planning + sequential loop (MVP fallback)
 */
import { env } from "node:process";
import type { ArtifactRef } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig } from "@atlas/config";
import { AgentOrchestrator, GlobalMCPServerPool } from "@atlas/core";
import { GlobalMCPToolProvider, type MCPToolProvider } from "@atlas/fsm-engine";
import { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";
import { getAgentCatalog } from "./catalog.ts";
import { extractArtifactsFromOutput } from "./extract-artifacts.ts";
import { executeTaskViaFSMDirect } from "./fsm-executor-direct.ts";
import { generateTaskFSM } from "./fsm-generator.ts";
import { planTask, planTaskEnhanced } from "./planner.ts";

// Feature flag for FSM execution (can be controlled via env var)
const USE_FSM_EXECUTION = env.USE_FSM_EXECUTION !== "false"; // default true

/**
 * Result type for do_task execution.
 * Exported for direct invocation from evals.
 */
export interface DoTaskResult {
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

/**
 * Generate concise summary for task artifact.
 */
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

/**
 * Store task execution result as artifact.
 */
async function storeTaskArtifact(
  data: { intent: string; plan: unknown; results: unknown; success: boolean; mode: "fsm" | "mvp" },
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
          data: JSON.stringify(
            {
              intent: data.intent,
              plan: data.plan,
              results: data.results,
              success: data.success,
              mode: data.mode,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
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

export function registerDoTaskTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "do_task",
    {
      description:
        "Execute a ONE-OFF task using appropriate agents. Best practice: Check <available_workspaces> first - " +
        "if a workspace can handle the task, prefer atlas_workspace_signal_trigger instead. " +
        "This tool is for ad-hoc tasks that aren't covered by your configured automations.",
      inputSchema: {
        intent: z
          .string()
          .describe(
            "What the user wants to accomplish. Be specific and include relevant details " +
              "(e.g., 'check my calendar for today' not just 'calendar')",
          ),
        streamId: z.string().describe("Stream ID from the conversation session"),
        sessionId: z.string().optional().describe("Session ID (optional)"),
        workspaceId: z.string().optional().describe("Workspace ID (optional)"),
        userId: z.string().optional().describe("User ID (optional)"),
      },
    },
    async ({ intent, streamId, sessionId, workspaceId, userId }) => {
      ctx.logger.info("do_task called", {
        intent,
        streamId,
        executionMode: USE_FSM_EXECUTION ? "FSM" : "MVP",
      });

      try {
        // 1. Get available agents
        const catalog = await getAgentCatalog();
        ctx.logger.debug("Agent catalog loaded", { agentCount: catalog.length });

        const effectiveWorkspaceId = workspaceId || "atlas-conversation";
        const effectiveSessionId = sessionId || `task-${Date.now()}`;

        // Branch based on execution mode
        if (USE_FSM_EXECUTION) {
          // FSM EXECUTION PATH
          return await executeFSMPath(
            intent,
            catalog,
            { streamId, sessionId: effectiveSessionId, workspaceId: effectiveWorkspaceId, userId },
            ctx,
          );
        } else {
          // MVP FALLBACK PATH (simple sequential loop)
          return await executeMVPPath(
            intent,
            catalog,
            { streamId, sessionId: effectiveSessionId, workspaceId: effectiveWorkspaceId, userId },
            ctx,
          );
        }
      } catch (error) {
        ctx.logger.error("do_task failed with exception", { error });
        return createErrorResponse(
          `Task execution failed: ${error instanceof Error ? error.message : String(error)}`,
          { intent },
        );
      }
    },
  );
}

/**
 * FSM execution path with enhanced planning and isolated MCP access.
 * Returns DoTaskResult directly for eval invocation.
 */
async function executeFSMPathDirect(
  intent: string,
  catalog: Awaited<ReturnType<typeof getAgentCatalog>>,
  context: {
    streamId: string;
    sessionId: string;
    workspaceId: string;
    userId?: string;
    daemonUrl?: string;
  },
  logger: Logger,
): Promise<DoTaskResult> {
  // 1. Enhanced planning with MCP selection
  const planResult = await planTaskEnhanced(intent, catalog);

  if (!planResult.success) {
    logger.warn("Enhanced planning failed", { reason: planResult.reason });
    return { success: false, error: `Unable to plan task: ${planResult.reason}` };
  }

  const plan = planResult.plan;
  logger.info("Task planned (enhanced)", {
    stepCount: plan.steps.length,
    needsCount: plan.needs.length,
    mcpServerCount: plan.mcpServers.length,
  });

  // 2. Generate FSM from enhanced plan
  const fsmResult = await generateTaskFSM(plan, intent);

  if (!fsmResult.ok) {
    logger.error("FSM generation failed", { error: fsmResult.error });
    return {
      success: false,
      error: `FSM generation failed: ${fsmResult.error.message}`,
      plan: {
        steps: plan.steps.map((s) => ({
          agentId: s.agentId,
          description: s.description,
          executionType: s.executionType,
        })),
        mcpServers: plan.mcpServers.map((s) => s.id),
      },
    };
  }

  const fsmDefinition = fsmResult.data;
  logger.info("FSM generated", { stateCount: fsmDefinition.states.length });

  // 3. Create MCP tool provider if plan requires MCP servers
  let mcpToolProvider: MCPToolProvider | undefined;
  let mcpServerPool: GlobalMCPServerPool | undefined;

  if (plan.mcpServers.length > 0) {
    // Convert MCPServerResult[] to Record<string, MCPServerConfig>
    const mcpServerConfigs: Record<string, MCPServerConfig> = {};
    for (const server of plan.mcpServers) {
      mcpServerConfigs[server.id] = server.config;
    }

    // Create isolated pool for this task
    mcpServerPool = new GlobalMCPServerPool(logger.child({ component: "TaskMCPPool" }));

    mcpToolProvider = new GlobalMCPToolProvider(
      mcpServerPool,
      context.workspaceId,
      mcpServerConfigs,
      logger.child({ component: "TaskMCPProvider" }),
    );

    logger.info("Created MCP tool provider for task", {
      serverCount: plan.mcpServers.length,
      serverIds: Object.keys(mcpServerConfigs),
    });
  }

  try {
    // 4. Execute FSM with MCP provider
    const executionResult = await executeTaskViaFSMDirect(fsmDefinition, plan.steps, {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      streamId: context.streamId,
      userId: context.userId,
      daemonUrl: context.daemonUrl,
      mcpToolProvider,
    });

    // 5. Return results
    // Extract artifacts from agent outputs
    const artifacts = executionResult.results
      .filter((r) => r.success && r.output)
      .flatMap((r) => extractArtifactsFromOutput(r.output));

    const success = executionResult.success;
    const summary = `Executed ${executionResult.results.length} step(s) via FSM`;

    // 6. Store task result as artifact
    const artifactId = await storeTaskArtifact(
      { intent, plan: plan.steps, results: executionResult.results, success, mode: "fsm" },
      context,
      logger,
    );

    if (success) {
      logger.info("Task completed successfully (FSM)", {
        intent,
        stepCount: executionResult.results.length,
        artifactId,
      });
      return {
        success: true,
        summary,
        plan: {
          steps: plan.steps.map((s) => ({
            agentId: s.agentId,
            description: s.description,
            executionType: s.executionType,
          })),
          mcpServers: plan.mcpServers.map((s) => s.id),
        },
        results: executionResult.results,
        artifactId,
        artifacts,
      };
    } else {
      const failedStep = executionResult.results.find((r) => !r.success);
      logger.warn("Task failed (FSM)", {
        intent,
        failedStep: failedStep?.step,
        error: failedStep?.error,
      });
      return {
        success: false,
        summary,
        plan: {
          steps: plan.steps.map((s) => ({
            agentId: s.agentId,
            description: s.description,
            executionType: s.executionType,
          })),
          mcpServers: plan.mcpServers.map((s) => s.id),
        },
        results: executionResult.results,
        error: `Task failed at step ${failedStep?.step}: ${failedStep?.error || "unknown error"}`,
        artifacts,
      };
    }
  } finally {
    // Cleanup MCP pool if we created one
    if (mcpServerPool) {
      await mcpServerPool.dispose();
    }
  }
}

/**
 * FSM execution path wrapper for MCP tool registration.
 * Calls executeFSMPathDirect and wraps result in MCP response format.
 */
async function executeFSMPath(
  intent: string,
  catalog: Awaited<ReturnType<typeof getAgentCatalog>>,
  context: { streamId: string; sessionId: string; workspaceId: string; userId?: string },
  ctx: ToolContext,
) {
  const result = await executeFSMPathDirect(
    intent,
    catalog,
    { ...context, daemonUrl: ctx.daemonUrl },
    ctx.logger,
  );

  if (result.success) {
    return createSuccessResponse(result);
  } else {
    return createErrorResponse(result.error || "Task execution failed", result);
  }
}

/**
 * MVP fallback path with simple sequential execution
 */
async function executeMVPPath(
  intent: string,
  catalog: Awaited<ReturnType<typeof getAgentCatalog>>,
  context: { streamId: string; sessionId: string; workspaceId: string; userId?: string },
  ctx: ToolContext,
) {
  // 2. Plan which agents to use (LLM call)
  const planResult = await planTask(intent, catalog);

  if (!planResult.success) {
    ctx.logger.warn("Planning failed", { reason: planResult.reason });
    return createErrorResponse(`Unable to plan task: ${planResult.reason}`, {
      intent,
      reason: planResult.reason,
    });
  }

  const plan = planResult.plan;
  ctx.logger.info("Task planned (MVP)", {
    stepCount: plan.steps.length,
    agents: plan.steps.map((s) => s.agentId),
  });

  // 3. Execute agents sequentially (simple loop - MVP fallback)
  ctx.logger.info("Executing task sequentially (MVP)", {
    stepCount: plan.steps.length,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
  });

  // Create orchestrator for this task
  const agentsServerUrl = ctx.daemonUrl || "http://localhost:8080";
  const orchestrator = new AgentOrchestrator(
    {
      agentsServerUrl: `${agentsServerUrl}/agents`,
      mcpServerPool: undefined, // Agents will fetch MCP config from workspace
      daemonUrl: ctx.daemonUrl,
      requestTimeoutMs: 300000,
    },
    ctx.logger.child({ component: "TaskOrchestrator" }),
  );

  try {
    // Execute each step sequentially
    const results = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step) continue;
      ctx.logger.info("Executing step", {
        step: i,
        agentId: step.agentId,
        description: step.description,
      });

      try {
        const result = await orchestrator.executeAgent(step.agentId, step.description, {
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          streamId: context.streamId,
          userId: context.userId,
          additionalContext: { taskIntent: intent, stepNumber: i },
        });

        ctx.logger.info("Step completed", {
          step: i,
          agentId: step.agentId,
          hasError: !!result.error,
        });

        results.push({ step: i, agent: step.agentId, success: !result.error, output: result });

        // Stop on first error (no retry in MVP)
        if (result.error) {
          ctx.logger.warn("Step failed, stopping execution", {
            step: i,
            agentId: step.agentId,
            error: result.error,
          });
          break;
        }
      } catch (error) {
        ctx.logger.error("Step execution threw exception", {
          step: i,
          agentId: step.agentId,
          error,
        });
        results.push({
          step: i,
          agent: step.agentId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        break; // Stop on exception
      }
    }

    // Return results
    // Extract artifacts from agent outputs
    const artifacts = results
      .filter((r) => r.success && r.output)
      .flatMap((r) => extractArtifactsFromOutput(r.output));

    const success = results.every((r) => r.success);
    const summary = `Executed ${results.length} of ${plan.steps.length} step(s) (MVP): ${plan.steps
      .slice(0, results.length)
      .map((s) => s.agentId)
      .join(" → ")}`;

    // Store task result as artifact (both success and failure)
    const artifactId = await storeTaskArtifact(
      { intent, plan: plan.steps, results, success, mode: "mvp" },
      context,
      ctx.logger,
    );

    if (success) {
      ctx.logger.info("Task completed successfully (MVP)", { intent, stepCount: results.length });
      return createSuccessResponse({
        success: true,
        summary,
        plan: plan.steps.map((s) => ({ agent: s.agentId, description: s.description })),
        results: results,
        artifactId,
        artifacts,
      });
    } else {
      const failedStep = results.find((r) => !r.success);
      ctx.logger.warn("Task failed (MVP)", {
        intent,
        failedStep: failedStep?.step,
        error: failedStep?.error,
      });
      return createErrorResponse(
        `Task failed at step ${failedStep?.step} (${failedStep?.agent}): ${failedStep?.error || "unknown error"}`,
        {
          summary,
          plan: plan.steps.map((s) => ({ agent: s.agentId, description: s.description })),
          results: results,
          artifactId,
          artifacts,
        },
      );
    }
  } finally {
    // Always cleanup orchestrator
    await orchestrator.shutdown();
  }
}
