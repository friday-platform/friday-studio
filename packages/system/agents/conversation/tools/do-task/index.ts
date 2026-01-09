/**
 * do_task Tool - Direct tool with progress emission
 */
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig } from "@atlas/config";
import { GlobalMCPServerPool } from "@atlas/core";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { GlobalMCPToolProvider } from "@atlas/fsm-engine";
import { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { UIMessageStreamWriter } from "ai";
import { jsonSchema, tool } from "ai";
import { fetchLinkSummary } from "../../link-context.ts";
import { getAgentCatalog } from "./catalog.ts";
import { extractArtifactsFromOutput, sanitizeAgentOutput } from "./extract-artifacts.ts";
import { executeTaskViaFSM } from "./fsm-executor.ts";
import { generateTaskFSM } from "./fsm-generator.ts";
import { planTaskEnhanced, type MCPContext } from "./planner.ts";
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
    output?: { ok: boolean; data?: { response?: string }; error?: unknown };
    error?: string;
  }>;
  error?: string;
  /** Artifacts created - call display_artifact for each id */
  artifacts?: Array<{ id: string; type: string; summary: string }>;
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
    datetime?: {
      timezone: string;
      timestamp: string;
      localDate: string;
      localTime: string;
      timezoneOffset: string;
    };
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

        // Build MCP context for URL domain matching
        const linkSummary = await fetchLinkSummary(logger);
        const connectedProviders = new Set(linkSummary?.credentials.map((c) => c.provider) ?? []);

        const mcpContext: MCPContext[] = Object.entries(mcpServersRegistry.servers).map(
          ([id, entry]) => ({
            id,
            urlDomains: entry.urlDomains ?? [],
            connected: connectedProviders.has(id),
          }),
        );

        const planResult = await planTaskEnhanced(intent, catalog, mcpContext, abortSignal);

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
        const mcpServerPool = new GlobalMCPServerPool(logger.child({ component: "TaskMCPPool" }));

        // Always create provider - GlobalMCPToolProvider auto-includes atlas-platform
        // for ambient tools (webfetch, artifacts) even when no explicit servers requested
        const mcpServerConfigs: Record<string, MCPServerConfig> = {};
        for (const server of plan.mcpServers) {
          mcpServerConfigs[server.id] = server.config;
        }

        const mcpToolProvider = new GlobalMCPToolProvider(
          mcpServerPool,
          session.workspaceId,
          mcpServerConfigs,
          logger.child({ component: "TaskMCPProvider" }),
        );

        try {
          // 4. Execute with progress callbacks
          const context: TaskExecutionContext = {
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            streamId: session.streamId,
            userId: session.userId,
            daemonUrl: session.daemonUrl,
            datetime: session.datetime,
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

          // 5. Extract artifacts from agent outputs
          const artifacts = execResult.results
            .filter((r) => r.success && r.output)
            .flatMap((r) => extractArtifactsFromOutput(r.output));

          // Sanitize results: strip artifactRef/artifactRefs, keep response text
          const sanitizedResults = execResult.results.map((r) => ({
            step: r.step,
            agent: r.agent,
            success: r.success,
            error: r.error,
            output: sanitizeAgentOutput(r.output),
          }));

          // 6. Store task artifact (for debugging/history, not shown to user)
          await storeTaskArtifact(
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
                mcpServers: plan.mcpServers.map((m) => m.id),
              },
              results: sanitizedResults,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
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
                mcpServers: plan.mcpServers.map((m) => m.id),
              },
              results: sanitizedResults,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
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
