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
import { truncateUnicode } from "@atlas/utils";
import {
  type Agent,
  type BlueprintResult,
  buildBlueprint,
  buildFSMFromPlan,
  type ClassifiedDAGStep,
  ClassifiedDAGStepSchema,
  type CredentialBinding,
  PipelineError,
} from "@atlas/workspace-builder";
import type { UIMessageStreamWriter } from "ai";
import { jsonSchema, tool } from "ai";
import type { MCPServerResult } from "../../../fsm-workspace-creator/enrichers/mcp-servers.ts";
import { executeTaskViaFSMDirect } from "./ephemeral-executor.ts";
import { extractArtifactsFromOutput, sanitizeAgentOutput } from "./extract-artifacts.ts";
import { generateFriendlyDescriptions } from "./friendly-descriptions.ts";
import type {
  EnhancedTaskPlan,
  EnhancedTaskStep,
  TaskExecutionContext,
  TaskProgressEvent,
} from "./types.ts";

/**
 * Strip UUIDs from user-facing progress messages.
 * Artifact IDs are internal identifiers that should never be shown to users.
 */
function stripUUIDs(text: string): string {
  return text
    .replace(/\s*\(?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
      return stripUUIDs(event.description);
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
    return `Task: ${truncateUnicode(intent, 60, "...")} (${stepCount} steps, ${success ? "ok" : "failed"})`;
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
        title: `Task: ${truncateUnicode(data.intent, 80, "...")}`,
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
 * Build MCP server configs from blueprint agents using the MCP server registry.
 * Applies credential bindings from the pipeline's credential resolution step.
 */
function buildMCPServerConfigs(agents: Agent[], bindings: CredentialBinding[]): MCPServerResult[] {
  const seen = new Set<string>();
  const results: MCPServerResult[] = [];

  for (const agent of agents) {
    if (!agent.mcpServers) continue;
    for (const { serverId } of agent.mcpServers) {
      if (seen.has(serverId)) continue;
      seen.add(serverId);
      const serverMeta = mcpServersRegistry.servers[serverId];
      if (!serverMeta) continue;
      const config = structuredClone(serverMeta.configTemplate);
      // Apply credential bindings to env entries
      if (config.env) {
        for (const binding of bindings) {
          if (binding.targetType !== "mcp" || binding.targetId !== serverId) continue;
          config.env[binding.field] = {
            from: "link" as const,
            id: binding.credentialId,
            key: binding.key,
          };
        }
      }
      results.push({ id: serverId, config });
    }
  }

  return results;
}

/**
 * Convert BlueprintResult into the EnhancedTaskPlan shape the existing
 * executor pipeline expects. Bridges new planner → old executor.
 *
 * Classified steps carry metadata from stampExecutionTypes():
 * - agentId resolved to bundledId for bundled agents
 * - executionType set to "bundled" or "llm"
 */
function blueprintToTaskPlan(
  result: BlueprintResult,
  classifiedSteps: ClassifiedDAGStep[],
  friendlyDescriptions: string[],
): EnhancedTaskPlan {
  const { blueprint } = result;
  const agentMap = new Map(blueprint.agents.map((a) => [a.id, a]));

  const steps: EnhancedTaskStep[] = classifiedSteps.map((step, i) => {
    const agent = agentMap.get(step.agentId);
    return {
      agentId: step.agentId,
      description: step.description,
      executionType: step.executionType === "llm" ? "llm" : "agent",
      needs: agent?.needs ?? [],
      friendlyDescription: friendlyDescriptions[i],
    };
  });

  // Aggregate needs
  const allNeeds = new Set<string>();
  for (const step of steps) {
    for (const need of step.needs) {
      allNeeds.add(need);
    }
  }

  const mcpServers = buildMCPServerConfigs(blueprint.agents, result.credentials.bindings);

  return { steps, needs: Array.from(allNeeds), mcpServers };
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
        // 1. Plan via shared workspace-builder pipeline
        emitProgress({ type: "planning" });

        let blueprintResult: BlueprintResult;
        try {
          blueprintResult = await buildBlueprint(intent, { mode: "task", logger, abortSignal });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          if (err instanceof PipelineError) {
            logger.error("Pipeline failed", { phase: err.phase, error: err.cause.message });
            return {
              success: false,
              error: `Planning failed at "${err.phase}": ${err.cause.message}`,
            };
          }
          throw err;
        }

        // Bail on blocking clarifications (ambiguous agents / no match)
        const blockingClarifications = blueprintResult.clarifications.filter(
          (c) => c.issue.type === "no-match",
        );
        if (blockingClarifications.length > 0) {
          const msgs = blockingClarifications.map(
            (c) => `Agent "${c.agentName}" need "${c.need}": no matching capability`,
          );
          return { success: false, error: `Cannot plan task: ${msgs.join("; ")}` };
        }

        // Bail on unresolved credentials
        if (blueprintResult.credentials.unresolved.length > 0) {
          const first = blueprintResult.credentials.unresolved[0];
          if (!first)
            return { success: false, error: "Cannot execute task: unresolved credentials" };
          return {
            success: false,
            error: `Cannot execute task: ${first.reason}. Provider '${first.provider}' requires credentials for field '${first.field}'.`,
          };
        }

        // Inject synthetic triggerSignalId for task-mode jobs
        for (const job of blueprintResult.blueprint.jobs) {
          job.triggerSignalId = "adhoc-trigger";
        }

        // Task mode produces one job — classify and compile it
        const rawJob = blueprintResult.blueprint.jobs[0];
        if (!rawJob) {
          return { success: false, error: "Pipeline produced no jobs" };
        }
        // Jobs carry classified steps at runtime (from stampExecutionTypes); parse to narrow the type
        const classifiedJob = {
          ...rawJob,
          steps: rawJob.steps.map((s) => ClassifiedDAGStepSchema.parse(s)),
        };

        // Generate friendly descriptions for progress UX
        const friendlyDescriptions = await generateFriendlyDescriptions(
          classifiedJob.steps.map((s) => ({ agentId: s.agentId, description: s.description })),
          intent,
          abortSignal,
        );

        // Convert to legacy plan format for executor
        const plan = blueprintToTaskPlan(
          blueprintResult,
          classifiedJob.steps,
          friendlyDescriptions,
        );
        const totalSteps = plan.steps.length;

        // 2. Compile FSM deterministically (no LLM, no retries)
        emitProgress({ type: "preparing", stepCount: totalSteps });

        const compiled = buildFSMFromPlan(classifiedJob);
        if (!compiled.success) {
          const errors = compiled.error.map((e) => `${e.type}: ${e.message}`).join("; ");
          return { success: false, error: `FSM compilation failed: ${errors}` };
        }
        // Compiler warnings are fatal — upstream gates should prevent them
        if (compiled.value.warnings.length > 0) {
          const warnings = compiled.value.warnings.map((w) => w.message).join("; ");
          logger.error("Compiler warnings (fatal)", { warnings: compiled.value.warnings });
          return { success: false, error: `FSM compilation produced warnings: ${warnings}` };
        }
        const fsmDefinition = compiled.value.fsm;

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

          const execResult = await executeTaskViaFSMDirect(fsmDefinition, plan.steps, {
            sessionId: context.sessionId,
            workspaceId: context.workspaceId,
            streamId: context.streamId,
            userId: context.userId,
            daemonUrl: context.daemonUrl,
            datetime: context.datetime,
            mcpServerPool,
            mcpToolProvider,
            onProgress: context.onProgress,
            abortSignal: context.abortSignal,
            intent,
            dagSteps: classifiedJob.steps,
            documentContracts: classifiedJob.documentContracts,
          });

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
