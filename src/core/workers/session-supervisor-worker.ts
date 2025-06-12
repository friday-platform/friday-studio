/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import {
  AgentMetadata,
  AgentResult,
  JobSpecification,
  SessionContext,
  SessionSupervisor,
} from "../session-supervisor.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";
import type { IWorkspaceSignal } from "../../types/core.ts";
import { SessionIntent } from "../session.ts";

interface SessionConfig {
  sessionId: string;
  workspaceId?: string;
  memoryConfig: AtlasMemoryConfig;
  signal?: IWorkspaceSignal;
  payload?: Record<string, unknown>;
}

interface InitializeData {
  action: "initialize";
  intent?: SessionIntent;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  workspaceId: string;
  agents: AgentMetadata[];
  traceHeaders?: Record<string, string>;
  jobSpec?: JobSpecification;
  additionalPrompts?: {
    signal?: string;
    session?: string;
    evaluation?: string;
  };
}

interface ExecuteSessionData {
  action: "executeSession";
  traceHeaders?: Record<string, string>;
}

interface InvokeAgentData {
  action: "invokeAgent";
  agentId: string;
  input: Record<string, unknown>;
}

interface GetStatusData {
  action: "getStatus";
}

type SessionWorkerData = InitializeData | ExecuteSessionData | InvokeAgentData | GetStatusData;

class SessionSupervisorWorker extends BaseWorker {
  private supervisor: SessionSupervisor | null = null;
  private sessionId: string | null = null;

  constructor() {
    super(crypto.randomUUID().slice(0, 8), "session-supervisor");
  }

  protected async initialize(config: SessionConfig): Promise<void> {
    this.log("Session worker initializing with config:", {
      sessionId: config.sessionId,
      workspaceId: config.workspaceId,
      hasMemoryConfig: !!config.memoryConfig,
      configKeys: Object.keys(config),
    });

    this.sessionId = config.sessionId;
    // Store sessionId in context for logging
    Object.assign(this.context, { sessionId: config.sessionId });

    if (!config.memoryConfig) {
      throw new Error("SessionSupervisorWorker requires memoryConfig in config");
    }

    // Create the SessionSupervisor (intelligent agent) - this is the main bottleneck
    this.log("Creating SessionSupervisor...");
    this.supervisor = new SessionSupervisor(config.memoryConfig, config.workspaceId);
    this.log("SessionSupervisor created successfully");

    // Join session broadcast channel (async, non-blocking)
    this.actor.send({
      type: "JOIN_CHANNEL",
      channel: `session-${config.sessionId}`,
    });
  }

  protected async processTask(
    taskId: string,
    data: SessionWorkerData,
  ): Promise<Record<string, unknown>> {
    if (!this.supervisor) {
      throw new Error("Session supervisor not initialized");
    }

    switch (data.action) {
      case "initialize": {
        const initData = data as InitializeData;
        const {
          intent,
          signal,
          payload,
          workspaceId,
          agents,
          traceHeaders,
          jobSpec,
          additionalPrompts,
        } = initData;

        return await AtlasTelemetry.withWorkerSpan(
          {
            operation: "initialize",
            component: "session",
            traceHeaders,
            workerId: this.context.id,
            sessionId: this.sessionId!,
            workspaceId,
          },
          async (span) => {
            const sessionContext: SessionContext = {
              sessionId: this.sessionId!,
              workspaceId,
              signal,
              payload,
              availableAgents: agents,
              filteredMemory: [], // WorkspaceSupervisor would provide this
              jobSpec, // Job specification from WorkspaceSupervisor
              constraints: intent?.constraints,
              additionalPrompts,
            };

            await this.supervisor!.initializeSession(sessionContext);

            this.logger.info(`Session initialized with intent: ${intent?.id || "none"}`, {
              sessionId: this.sessionId!,
              intentId: intent?.id,
            });
            return { status: "initialized", intentId: intent?.id };
          },
        );
      }

      case "executeSession": {
        const executeData = data as ExecuteSessionData;
        const { traceHeaders } = executeData;

        return await AtlasTelemetry.withWorkerSpan(
          {
            operation: "executeSession",
            component: "session",
            traceHeaders,
            workerId: this.context.id,
            sessionId: this.sessionId!,
          },
          async (span) => {
            const sessionStartTime = Date.now();

            // Create execution plan using SessionSupervisor's intelligence
            const plan = await AtlasTelemetry.withSpan(
              "session.createExecutionPlan",
              async () => {
                return await this.supervisor!.createExecutionPlan();
              },
              { "session.id": this.sessionId! },
            );
            this.logger.info(`Execution plan created with ${plan.phases.length} phases`, {
              sessionId: this.sessionId!,
              phaseCount: plan.phases.length,
            });

            const results: { phaseId: string; phaseName: string; results: AgentResult[] }[] = [];

            // Execute each phase of the plan
            for (const [phaseIndex, phase] of plan.phases.entries()) {
              await AtlasTelemetry.withSpan(
                `session.executePhase.${phase.name}`,
                async (phaseSpan) => {
                  this.logger.info(`Executing phase: ${phase.name}`, {
                    sessionId: this.sessionId!,
                    phaseName: phase.name,
                    phaseId: phase.id,
                  });
                  phaseSpan?.setAttribute("phase.name", phase.name);
                  phaseSpan?.setAttribute("phase.strategy", phase.executionStrategy);

                  const phaseResults: AgentResult[] = [];

                  // Create trace headers for agent communication
                  const agentTraceHeaders = await AtlasTelemetry.createTraceHeaders();

                  // Execute agents in the phase based on strategy
                  if (phase.executionStrategy === "sequential") {
                    for (const [agentIndex, agentTask] of phase.agents.entries()) {
                      const result = await this.executeAgentTask(
                        agentTask,
                        phaseResults,
                        agentTraceHeaders,
                      );
                      phaseResults.push(result);

                      // Let supervisor evaluate progress
                      const evaluation = await this.supervisor!.evaluateProgress(
                        phaseResults,
                      );
                      if (evaluation.isComplete) {
                        this.log("Session evaluation determined completion", {
                          phase: phaseIndex + 1,
                          agent: agentIndex + 1,
                          reason: evaluation.feedback || "Goals satisfied",
                          agents_executed: phaseResults.length,
                        });
                        break;
                      }
                    }
                  } else {
                    // Parallel execution
                    const promises = phase.agents.map((agentTask) =>
                      this.executeAgentTask(agentTask, phaseResults, agentTraceHeaders)
                    );
                    const parallelResults = await Promise.all(promises);
                    phaseResults.push(...parallelResults);
                  }

                  results.push({
                    phaseId: phase.id,
                    phaseName: phase.name,
                    results: phaseResults,
                  });
                },
                { "phase.id": phase.id },
              );

              // Check if we should continue to next phase
              const evaluation = await this.supervisor!.evaluateProgress(
                results.flatMap((r) => r.results),
              );

              if (evaluation.isComplete) {
                break;
              } else if (evaluation.nextAction === "adapt") {
                // Supervisor could adapt the plan here
                this.log("Adapting execution plan based on results");
              }
            }

            // Get final execution summary
            const summary = this.supervisor!.getExecutionSummary();

            // Get LLM-generated session summary
            const sessionSummary = await this.supervisor!.generateSessionSummary(
              results,
            );

            // Log structured session results
            const sessionContext = this.supervisor!.getSessionContext();
            const timing = {
              total_duration: Date.now() - sessionStartTime,
              agent_executions: results.flatMap((r) => r.results).map((r) => ({
                agent: r.agentId,
                duration: r.duration,
                input_size: JSON.stringify(r.input).length,
                output_size: JSON.stringify(r.output).length,
              })),
            };

            this.log("Session completed", {
              sessionId: this.sessionId,
              signal: sessionContext?.signal.id,
              original_input: sessionContext?.payload,
              phases_executed: results.length,
              total_agents_invoked: results.flatMap((r) => r.results).length,
              status: summary.status,
              timing: timing,
              final_output: results[results.length - 1]
                ?.results[results[results.length - 1]?.results.length - 1]?.output,
            });

            this.log("AI Summary", { summary: sessionSummary });

            return {
              status: summary.status,
              results,
              plan: summary.plan,
              evaluation: await this.supervisor!.evaluateProgress(
                results.flatMap((r) => r.results),
              ),
              summary: sessionSummary,
            };
          },
        );
      }

      case "invokeAgent": {
        const invokeData = data as InvokeAgentData;
        const { agentId, input } = invokeData;
        return await this.invokeAgent(agentId, input, taskId);
      }

      case "getStatus": {
        const summary = this.supervisor?.getExecutionSummary();
        return {
          sessionId: this.sessionId,
          agentCount: 0,
          agents: [],
          executionStatus: summary?.status || "unknown",
        };
      }

      default:
        throw new Error(`Unknown task action: ${(data as any).action}`);
    }
  }

  protected async cleanup(): Promise<void> {
    this.log("Cleaning up session supervisor...");
    this.supervisor = null;
    this.sessionId = null;
  }

  private async executeAgentTask(
    agentTask: {
      agentId: string;
      task: string;
      inputSource?: string;
      dependencies?: string[];
    },
    previousResults: AgentResult[],
    traceHeaders?: Record<string, string>,
  ): Promise<AgentResult> {
    const { agentId, task, inputSource, dependencies } = agentTask;
    const startTime = Date.now();

    // Resolve input based on inputSource
    let input = this.supervisor?.getSessionContext()?.payload;

    if (inputSource === "previous" && previousResults.length > 0) {
      // Use the output from the last result
      input = previousResults[previousResults.length - 1].output;
    } else if (inputSource === "combined") {
      // Combine multiple inputs
      input = {
        original: this.supervisor?.getSessionContext()?.payload,
        previous: previousResults.map((r) => ({
          agentId: r.agentId,
          output: r.output,
        })),
      };
    } else if (dependencies && dependencies.length > 0) {
      // Use specific dependency output
      const lastDep = dependencies[dependencies.length - 1];
      const depResult = previousResults.find((r) => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output;
      }
    }

    // Execute agent through AgentSupervisor (supervised execution)
    const output = await AtlasTelemetry.withWorkerSpan(
      {
        operation: "executeAgentSupervised",
        component: "session",
        traceHeaders,
        workerId: this.context.id,
        sessionId: this.sessionId!,
        agentId,
      },
      async (span) => {
        return await this.invokeAgent(agentId, input, crypto.randomUUID(), traceHeaders);
      },
    );

    return {
      agentId,
      task,
      input,
      output,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  private getAgentType(agentId: string): string {
    // Extract agent type from ID or use a mapping
    // For now, use simple heuristics
    if (agentId.includes("mishearing")) return "mishearing";
    if (agentId.includes("embellishment")) return "embellishment";
    if (agentId.includes("reinterpretation")) return "reinterpretation";
    if (agentId.includes("telephone")) return "telephone";
    if (agentId.includes("claude")) return "claude";
    return "echo"; // default
  }

  private async invokeAgent(
    agentId: string,
    input: Record<string, unknown>,
    taskId: string,
    traceHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    // Use AgentSupervisor for supervised execution instead of direct agent workers
    if (!this.supervisor) {
      throw new Error("SessionSupervisor not initialized");
    }

    const task = {
      agentId,
      task: `Process input: ${JSON.stringify(input)}`,
      inputSource: "signal" as const,
      dependencies: [],
    };

    try {
      // Execute through SessionSupervisor which uses AgentSupervisor
      const result = await this.supervisor.executeAgent(agentId, task, input);
      return result.output;
    } catch (error) {
      this.log(`Error executing agent ${agentId}: ${error}`);
      throw error;
    }
  }

  // Handle broadcast messages in the session
  protected override handleBroadcast(channel: string, data: Record<string, unknown>): void {
    switch (data.type) {
      case "agentMessage":
        this.log(`Agent ${data.from} broadcast: ${data.message}`);

        // Forward to parent
        self.postMessage({
          type: "sessionBroadcast",
          data,
        });
        break;

      case "supervisorCommand":
        this.log(`Supervisor command:`, data);
        // Handle supervisor coordination commands
        break;

      default:
        this.log(`Unknown broadcast type: ${data.type}`);
    }
  }
}

// Create and start the worker
new SessionSupervisorWorker();
