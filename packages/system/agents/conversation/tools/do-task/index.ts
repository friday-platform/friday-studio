/**
 * do_task Tool - Direct tool with progress emission
 */
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig } from "@atlas/config";
import { GlobalMCPServerPool } from "@atlas/core";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
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
  checkEnvironmentReadiness,
  classifyAgents,
  generatePlan,
  PipelineError,
  resolveCredentials,
} from "@atlas/workspace-builder";
import type { UIMessageStreamWriter } from "ai";
import { jsonSchema, tool } from "ai";
import type { MCPServerResult } from "../../../fsm-workspace-creator/enrichers/mcp-servers.ts";
import { executeTaskViaFSMDirect } from "./ephemeral-executor.ts";
import { extractArtifactsFromOutput, sanitizeAgentOutput } from "./extract-artifacts.ts";
import {
  buildFastpathContract,
  buildFastpathDAGStep,
  buildFastpathFSM,
  buildFastpathStep,
  isFastpathEligible,
} from "./fastpath.ts";
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
  data: {
    intent: string;
    plan: unknown;
    results: unknown;
    success: boolean;
    timing?: { planningMs: number; executionMs: number; totalMs: number; fastpath: boolean };
  },
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
 *
 * @param agents - Blueprint agents with mcpServers references
 * @param bindings - Credential bindings to apply to server env entries
 * @param dynamicServers - Optional runtime-registered MCP servers from KV (not in the static registry)
 */
export function buildMCPServerConfigs(
  agents: Agent[],
  bindings: CredentialBinding[],
  dynamicServers?: MCPServerMetadata[],
): MCPServerResult[] {
  const seen = new Set<string>();
  const results: MCPServerResult[] = [];

  const dynamicById = new Map<string, MCPServerMetadata>();
  for (const server of dynamicServers ?? []) {
    dynamicById.set(server.id, server);
  }

  for (const agent of agents) {
    if (!agent.mcpServers) continue;
    for (const { serverId } of agent.mcpServers) {
      if (seen.has(serverId)) continue;
      seen.add(serverId);
      const serverMeta = mcpServersRegistry.servers[serverId] ?? dynamicById.get(serverId);
      if (!serverMeta) continue;
      const config = structuredClone(serverMeta.configTemplate);
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
 * - agentId preserved as planner-assigned ID
 * - executionRef carries the bundled registry key (or agentId for LLM agents)
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
      executionRef: step.executionRef,
      description: step.description,
      executionType: step.executionType === "llm" ? "llm" : "agent",
      capabilities: agent?.capabilities ?? [],
      friendlyDescription: friendlyDescriptions[i],
    };
  });

  const allCapabilities = new Set<string>();
  for (const step of steps) {
    for (const capability of step.capabilities) {
      allCapabilities.add(capability);
    }
  }

  const mcpServers = buildMCPServerConfigs(
    blueprint.agents,
    result.credentials.bindings,
    result.dynamicServers,
  );

  return { steps, capabilities: Array.from(allCapabilities), mcpServers };
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
    description: `Execute a task end-to-end, including compound multi-step tasks. A planner internally orchestrates agents across services — never decompose a task into multiple do_task calls. One user goal = one do_task call, always.`,
    inputSchema: jsonSchema<{ intent: string }>({
      type: "object",
      properties: {
        intent: {
          type: "string",
          description: `The user's full goal as a single statement. Include all steps and services even if they seem sequential. Examples: 'Research TypeScript features and email a summary to the team', 'Check calendar for conflicts and post available slots to Slack'.`,
        },
      },
      required: ["intent"],
    }),
    execute: async ({ intent }): Promise<DoTaskResult> => {
      if (abortSignal?.aborted) {
        return { success: false, error: "Task cancelled" };
      }

      logger.info("do_task executing", { intent });
      const startMs = Date.now();

      try {
        emitProgress({ type: "planning" });

        const planResult = await generatePlan(intent, { mode: "task", abortSignal });

        // Reuse dynamic servers already fetched during planning (avoids redundant KV lookup)
        const dynamicServers = planResult.dynamicServers;

        const classifyResult = await classifyAgents(planResult.agents, { dynamicServers });
        const planMs = Date.now();

        if (isFastpathEligible(planResult, classifyResult)) {
          // ---------------------------------------------------------------
          // FASTPATH: single-agent dispatch
          // ---------------------------------------------------------------
          const agent = planResult.agents[0];
          if (!agent) throw new Error("Fastpath requires exactly one agent");

          logger.info("do-task fastpath: single-agent dispatch", {
            agentName: agent.name,
            executionType: agent.bundledId ? "bundled" : "llm",
            bundledId: agent.bundledId,
            mcpServers: agent.mcpServers?.map((s) => s.serverId),
          });

          // Resolve credentials if needed
          let credentialBindings: CredentialBinding[] = [];
          if (classifyResult.configRequirements.length > 0) {
            const credResult = await resolveCredentials(classifyResult.configRequirements);

            // Bail on unresolved credentials
            if (credResult.unresolved.length > 0) {
              const first = credResult.unresolved[0];
              const error = first
                ? `Cannot execute task: ${first.reason}. Provider '${first.provider}' requires credentials for field '${first.field}'.`
                : "Cannot execute task: unresolved credentials";
              logger.info("do_task completed", {
                durationMs: Date.now() - startMs,
                planningMs: planMs - startMs,
                executionMs: 0,
                fastpath: true,
                agentName: agent.name,
                executionType: agent.bundledId ? "bundled" : "llm",
                success: false,
                reason: "unresolved_credentials",
              });
              return { success: false, error };
            }
            credentialBindings = credResult.bindings;

            const readiness = checkEnvironmentReadiness(
              classifyResult.configRequirements,
              credentialBindings,
            );
            if (!readiness.ready) {
              const missing = readiness.checks
                .flatMap((c) => c.checks.filter((f) => f.status === "missing"))
                .map((f) => f.key);
              logger.info("do_task completed", {
                durationMs: Date.now() - startMs,
                planningMs: planMs - startMs,
                executionMs: 0,
                fastpath: true,
                agentName: agent.name,
                executionType: agent.bundledId ? "bundled" : "llm",
                success: false,
                reason: "environment_not_ready",
              });
              return {
                success: false,
                error: `Cannot execute task: missing configuration: ${missing.join(", ")}`,
              };
            }
          }

          // Build trivial FSM and executor data structures
          const dagStep = buildFastpathDAGStep(agent, intent);
          const fsmDefinition = buildFastpathFSM(agent, dagStep, intent, session.datetime);
          const fastpathStep = buildFastpathStep(agent, intent);
          const contract = buildFastpathContract(dagStep);
          const mcpServers = buildMCPServerConfigs([agent], credentialBindings, dynamicServers);

          emitProgress({ type: "preparing", stepCount: 1 });

          // Create MCP pool and provider
          const mcpServerPool = new GlobalMCPServerPool(logger.child({ component: "TaskMCPPool" }));
          const mcpServerConfigMap: Record<string, MCPServerConfig> = {};
          for (const server of mcpServers) {
            mcpServerConfigMap[server.id] = server.config;
          }
          const mcpToolProvider = new GlobalMCPToolProvider(
            mcpServerPool,
            session.workspaceId,
            mcpServerConfigMap,
            logger.child({ component: "TaskMCPProvider" }),
          );

          try {
            const execResult = await executeTaskViaFSMDirect(fsmDefinition, [fastpathStep], {
              sessionId: session.sessionId,
              workspaceId: session.workspaceId,
              streamId: session.streamId,
              userId: session.userId,
              daemonUrl: session.daemonUrl,
              datetime: session.datetime,
              mcpServerPool,
              mcpToolProvider,
              onProgress: emitProgress,
              abortSignal,
              intent,
              dagSteps: [dagStep],
              documentContracts: [contract],
            });

            const execMs = Date.now();
            const artifacts = execResult.results
              .filter((r) => r.success && r.output)
              .flatMap((r) => extractArtifactsFromOutput(r.output));
            const sanitizedResults = execResult.results.map((r) => ({
              step: r.step,
              agent: r.agent,
              success: r.success,
              error: r.error,
              output: sanitizeAgentOutput(r.output),
            }));

            const timing = {
              planningMs: planMs - startMs,
              executionMs: execMs - planMs,
              totalMs: execMs - startMs,
              fastpath: true,
            };

            logger.info("do_task completed", {
              durationMs: timing.totalMs,
              planningMs: timing.planningMs,
              executionMs: timing.executionMs,
              fastpath: true,
              agentName: agent.name,
              executionType: fastpathStep.executionType,
              success: execResult.success,
            });

            try {
              await storeTaskArtifact(
                {
                  intent,
                  plan: [fastpathStep],
                  results: execResult.results,
                  success: execResult.success,
                  timing,
                },
                { workspaceId: session.workspaceId, streamId: session.streamId },
                logger,
              );
            } catch (storeErr) {
              logger.warn("Failed to store task artifact (fastpath)", {
                error: storeErr instanceof Error ? storeErr.message : String(storeErr),
              });
            }

            const planInfo = {
              steps: [
                {
                  agentId: fastpathStep.agentId,
                  description: fastpathStep.description,
                  executionType: fastpathStep.executionType,
                },
              ],
              mcpServers: mcpServers.map((m) => m.id),
            };

            if (execResult.success) {
              return {
                success: true,
                summary: `Executed ${execResult.results.length} step(s)`,
                plan: planInfo,
                results: sanitizedResults,
                artifacts: artifacts.length > 0 ? artifacts : undefined,
              };
            }

            const failedStep = execResult.results.find((r) => !r.success);
            return {
              success: false,
              error: `Step ${failedStep?.step} failed: ${failedStep?.error || "unknown"}`,
              plan: planInfo,
              results: sanitizedResults,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
            };
          } finally {
            await mcpServerPool.dispose();
          }
        }

        // -----------------------------------------------------------------
        // FULL PIPELINE: multi-agent or ambiguous classification
        // -----------------------------------------------------------------
        logger.info("do-task fastpath: ineligible, using full pipeline", {
          agentCount: planResult.agents.length,
          hasClarifications: classifyResult.clarifications.length > 0,
        });

        let blueprintResult: BlueprintResult;
        try {
          blueprintResult = await buildBlueprint(intent, {
            mode: "task",
            logger,
            abortSignal,
            precomputed: {
              plan: planResult,
              classified: {
                clarifications: classifyResult.clarifications,
                configRequirements: classifyResult.configRequirements,
              },
            },
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          if (err instanceof PipelineError) {
            logger.error("Pipeline failed", { phase: err.phase, error: err.cause });
            return {
              success: false,
              error: `Planning failed at "${err.phase}": ${err.cause.message}`,
            };
          }
          throw err;
        }

        // Bail on blocking clarifications (unknown capability, mixed types, or multiple bundled)
        const blockingClarifications = blueprintResult.clarifications.filter(
          (c) =>
            c.issue.type === "unknown-capability" ||
            c.issue.type === "mixed-bundled-mcp" ||
            c.issue.type === "multiple-bundled",
        );
        if (blockingClarifications.length > 0) {
          const msgs = blockingClarifications.map(
            (c) => `Agent "${c.agentName}" capability "${c.capability}": no matching capability`,
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

        // Deterministic compilation — no LLM, no retries
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

        // Always create the pool - bundled agents (like google-calendar) need it
        // for their embedded MCP configs even when plan.mcpServers is empty
        const mcpServerPool = new GlobalMCPServerPool(logger.child({ component: "TaskMCPPool" }));
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

          const execMs = Date.now();
          const artifacts = execResult.results
            .filter((r) => r.success && r.output)
            .flatMap((r) => extractArtifactsFromOutput(r.output));
          const sanitizedResults = execResult.results.map((r) => ({
            step: r.step,
            agent: r.agent,
            success: r.success,
            error: r.error,
            output: sanitizeAgentOutput(r.output),
          }));

          const timing = {
            planningMs: planMs - startMs,
            executionMs: execMs - planMs,
            totalMs: execMs - startMs,
            fastpath: false,
          };

          logger.info("do_task completed", {
            durationMs: timing.totalMs,
            planningMs: timing.planningMs,
            executionMs: timing.executionMs,
            fastpath: false,
            agentName: planResult.agents[0]?.name,
            executionType: plan.steps[0]?.executionType,
            success: execResult.success,
          });

          try {
            await storeTaskArtifact(
              {
                intent,
                plan: plan.steps,
                results: execResult.results,
                success: execResult.success,
                timing,
              },
              { workspaceId: session.workspaceId, streamId: session.streamId },
              logger,
            );
          } catch (storeErr) {
            logger.warn("Failed to store task artifact (full pipeline)", {
              error: storeErr instanceof Error ? storeErr.message : String(storeErr),
            });
          }

          const planInfo = {
            steps: plan.steps.map((s) => ({
              agentId: s.agentId,
              description: s.description,
              executionType: s.executionType,
            })),
            mcpServers: plan.mcpServers.map((m) => m.id),
          };

          if (execResult.success) {
            return {
              success: true,
              summary: `Executed ${execResult.results.length} step(s)`,
              plan: planInfo,
              results: sanitizedResults,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
            };
          }

          const failedStep = execResult.results.find((r) => !r.success);
          return {
            success: false,
            error: `Step ${failedStep?.step} failed: ${failedStep?.error || "unknown"}`,
            plan: planInfo,
            results: sanitizedResults,
            artifacts: artifacts.length > 0 ? artifacts : undefined,
          };
        } finally {
          await mcpServerPool.dispose();
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof PipelineError) {
          logger.error("Pipeline failed", { phase: error.phase, error: error.cause });
          return {
            success: false,
            error: `Planning failed at "${error.phase}": ${error.cause.message}`,
          };
        }
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger.error("do_task failed", { error: errorObj });
        return { success: false, error: `Task failed: ${errorObj.message}` };
      }
    },
  });
}
