/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { AgentResult, SessionContext, SessionSupervisor } from "../session-supervisor.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { AtlasMemoryConfig } from "../memory-config.ts";
import type { IWorkspaceSignal } from "../../types/core.ts";
import {
  ATLAS_MESSAGE_TYPES,
  AtlasMessageEnvelope,
  createErrorResponse,
  createSessionCompleteMessage,
  createSessionProgressMessage,
  createSessionStatusMessage,
  isSessionExecuteMessage,
  isSessionInitializeMessage,
  isSessionInvokeAgentMessage,
  type MessageSource,
  SessionExecutePayload,
  SessionInitializePayload,
  SessionInvokeAgentPayload,
  SessionStatusPayload,
  validateEnvelope,
} from "../utils/message-envelope.ts";

interface SessionConfig {
  sessionId: string;
  workspaceId?: string;
  memoryConfig: AtlasMemoryConfig;
  signal?: IWorkspaceSignal;
  payload?: Record<string, unknown>;
}

// Envelope-based message handling
type SessionWorkerMessage =
  | AtlasMessageEnvelope<SessionInitializePayload>
  | AtlasMessageEnvelope<SessionExecutePayload>
  | AtlasMessageEnvelope<SessionInvokeAgentPayload>
  | AtlasMessageEnvelope<SessionStatusPayload>
  | AtlasMessageEnvelope<Record<string, unknown>>; // For getStatus which has no specific payload

class SessionSupervisorWorker extends BaseWorker {
  private supervisor: SessionSupervisor | null = null;
  private sessionId: string | null = null;

  constructor() {
    super(crypto.randomUUID().slice(0, 8), "session-supervisor");
  }

  // deno-lint-ignore require-await
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

    return Promise.resolve();
  }

  protected async processTask(
    taskId: string,
    data: unknown,
  ): Promise<Record<string, unknown>> {
    try {
      // Validate incoming message as envelope
      const envelopeValidation = validateEnvelope(data);
      if (!envelopeValidation.success) {
        throw new Error(`Invalid message envelope: ${envelopeValidation.error.message}`);
      }

      const envelope = envelopeValidation.data as SessionWorkerMessage;
      if (!this.supervisor) {
        throw new Error("Session supervisor not initialized");
      }

      // Domain validation for session messages
      if (envelope.domain !== "session") {
        throw new Error(
          `Invalid domain "${envelope.domain}" for session worker. Expected "session"`,
        );
      }

      switch (envelope.type) {
        case ATLAS_MESSAGE_TYPES.SESSION.INITIALIZE: {
          if (!isSessionInitializeMessage(envelope)) {
            throw new Error("Invalid session initialize message format");
          }

          const {
            intent,
            signal,
            payload,
            workspaceId,
            agents,
            jobSpec,
            additionalPrompts,
          } = envelope.payload;

          return await AtlasTelemetry.withWorkerSpan(
            {
              operation: "initialize",
              component: "session",
              traceHeaders: envelope.traceHeaders,
              workerId: this.context.id,
              sessionId: this.sessionId!,
              workspaceId,
            },
            async (_span) => {
              const sessionContext: SessionContext = {
                sessionId: this.sessionId!,
                workspaceId,
                signal: signal as unknown as IWorkspaceSignal,
                payload,
                availableAgents:
                  agents as unknown as import("../session-supervisor.ts").AgentMetadata[],
                filteredMemory: [], // WorkspaceSupervisor would provide this
                jobSpec: jobSpec as unknown as
                  | import("../session-supervisor.ts").JobSpecification
                  | undefined,
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

        case ATLAS_MESSAGE_TYPES.SESSION.EXECUTE: {
          if (!isSessionExecuteMessage(envelope)) {
            throw new Error("Invalid session execute message format");
          }

          return await AtlasTelemetry.withWorkerSpan(
            {
              operation: "executeSession",
              component: "session",
              traceHeaders: envelope.traceHeaders,
              workerId: this.context.id,
              sessionId: this.sessionId!,
            },
            async (_span) => {
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
              const totalPhases = plan.phases.length;
              const totalAgents = plan.phases.reduce((sum, phase) => sum + phase.agents.length, 0);
              let agentsExecuted = 0;

              // Send initial progress update
              this.sendProgressUpdate(
                0,
                totalPhases,
                0,
                totalAgents,
                plan.phases[0]?.name,
                envelope.correlationId,
              );

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
                        agentsExecuted++;

                        // Send progress update after each agent
                        this.sendProgressUpdate(
                          phaseIndex,
                          totalPhases,
                          agentsExecuted,
                          totalAgents,
                          phase.name,
                          envelope.correlationId,
                        );

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
                      agentsExecuted += phase.agents.length;

                      // Send progress update after parallel execution
                      this.sendProgressUpdate(
                        phaseIndex,
                        totalPhases,
                        agentsExecuted,
                        totalAgents,
                        phase.name,
                        envelope.correlationId,
                      );
                    }

                    results.push({
                      phaseId: phase.id,
                      phaseName: phase.name,
                      results: phaseResults,
                    });
                  },
                  { "phase.id": phase.id },
                );

                // Send progress update after phase completion
                this.sendProgressUpdate(
                  phaseIndex + 1,
                  totalPhases,
                  agentsExecuted,
                  totalAgents,
                  plan.phases[phaseIndex + 1]?.name,
                  envelope.correlationId,
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

              // Extract semantic facts from signal and store in knowledge graph
              try {
                await this.supervisor!.extractAndStoreSemanticFacts();
                this.log("Semantic facts extracted and stored in knowledge graph");
              } catch (error) {
                this.log(`Warning: Failed to extract semantic facts: ${error}`);
              }

              // Generate and store working memory summary in episodic memory
              try {
                await this.supervisor!.generateWorkingMemorySummary();
                this.log("Working memory summary generated and stored in episodic memory");
              } catch (error) {
                this.log(`Warning: Failed to generate working memory summary: ${error}`);
              }

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
                sessionId: this.sessionId || undefined,
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

              // Send session completion message
              this.sendSessionComplete(
                envelope,
                results,
                summary,
                sessionSummary,
                Date.now() - sessionStartTime,
              );

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

        case ATLAS_MESSAGE_TYPES.SESSION.INVOKE_AGENT: {
          if (!isSessionInvokeAgentMessage(envelope)) {
            throw new Error("Invalid session invoke agent message format");
          }

          const { agentId, input } = envelope.payload;
          return await this.invokeAgent(agentId, input, taskId, envelope.traceHeaders);
        }

        case ATLAS_MESSAGE_TYPES.TASK.RESULT: {
          // Handle getStatus requests (they use task.result type for responses)
          const summary = this.supervisor?.getExecutionSummary();
          const sessionContext = this.supervisor?.getSessionContext();

          const statusPayload: SessionStatusPayload = {
            sessionId: this.sessionId!,
            agentCount: sessionContext?.availableAgents?.length || 0,
            agents: sessionContext?.availableAgents?.map((a) => a.id) || [],
            executionStatus: summary?.status || "unknown",
            currentPhase: summary?.plan?.phases?.[0]?.name,
            progress: summary?.plan
              ? {
                phasesCompleted: 0,
                totalPhases: summary.plan.phases?.length || 0,
                agentsExecuted: 0,
                totalAgents:
                  summary.plan.phases?.reduce((sum: number, phase: { agents?: unknown[] }) =>
                    sum + (phase.agents?.length || 0), 0) || 0,
              }
              : undefined,
          };

          // Create proper envelope response
          const source: MessageSource = {
            workerId: this.context.id,
            workerType: "session-supervisor",
            sessionId: this.sessionId!,
          };

          const statusMessage = createSessionStatusMessage(statusPayload, source, {
            correlationId: envelope.correlationId,
            traceHeaders: envelope.traceHeaders,
          });

          return statusMessage.payload;
        }

        default:
          throw new Error(`Unknown message type: ${envelope.type}`);
      }
    } catch (error) {
      // Create error response using envelope format
      if (data && typeof data === "object" && "id" in data && "source" in data) {
        const envelope = data as AtlasMessageEnvelope;
        const source: MessageSource = {
          workerId: this.context.id,
          workerType: "session-supervisor",
          sessionId: this.sessionId!,
        };

        const errorResponse = createErrorResponse(
          envelope,
          {
            code: "SESSION_ERROR",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            retryable: false,
          },
          source,
        );

        // Send error response back
        self.postMessage({
          type: "result",
          taskId,
          result: errorResponse.payload,
          error: errorResponse.error,
        });

        throw error;
      }

      throw error;
    }
  }

  // deno-lint-ignore require-await
  protected async cleanup(): Promise<void> {
    this.log("Cleaning up session supervisor...");
    this.supervisor = null;
    this.sessionId = null;
    return Promise.resolve();
  }

  /**
   * Send session completion message using envelope format
   */
  private sendSessionComplete(
    envelope: AtlasMessageEnvelope,
    results: { phaseId: string; phaseName: string; results: AgentResult[] }[],
    summary: { status?: string; plan?: { phases?: unknown[] } | null },
    sessionSummary: string,
    executionTimeMs: number,
  ): void {
    if (!this.sessionId) return;

    const source: MessageSource = {
      workerId: this.context.id,
      workerType: "session-supervisor",
      sessionId: this.sessionId,
    };

    const completePayload = {
      sessionId: this.sessionId,
      status: (summary.status || "completed") as "completed" | "failed" | "cancelled" | "timeout",
      results,
      ...(summary.plan && {
        plan: summary.plan as { 
          id: string; 
          phases: { 
            id: string; 
            name: string; 
            executionStrategy: "sequential" | "parallel"; 
            agents: Record<string, unknown>[];
          }[]
        }
      }),
      evaluation: {
        isComplete: true,
        nextAction: "complete" as const,
        feedback: "Session completed successfully",
      },
      summary: sessionSummary,
      executionTimeMs,
    };

    const completeMessage = createSessionCompleteMessage(
      envelope,
      completePayload,
      source,
    );

    // Send completion message as broadcast to inform all listeners
    self.postMessage({
      type: "broadcast",
      channel: `session-${this.sessionId}`,
      data: completeMessage,
    });

    this.logger.info("Session completion message sent", {
      sessionId: this.sessionId,
      status: summary.status,
      correlationId: envelope.correlationId,
      executionTimeMs,
    });
  }

  /**
   * Send progress update using envelope format
   */
  private sendProgressUpdate(
    phasesCompleted: number,
    totalPhases: number,
    agentsExecuted: number,
    totalAgents: number,
    currentPhase?: string,
    correlationId?: string,
  ): void {
    if (!this.sessionId) return;

    const source: MessageSource = {
      workerId: this.context.id,
      workerType: "session-supervisor",
      sessionId: this.sessionId,
    };

    const progressMessage = createSessionProgressMessage(
      this.sessionId,
      {
        phasesCompleted,
        totalPhases,
        agentsExecuted,
        totalAgents,
        currentPhase,
      },
      source,
      correlationId,
    );

    // Send progress update as broadcast
    self.postMessage({
      type: "broadcast",
      channel: `session-${this.sessionId}`,
      data: progressMessage,
    });

    this.logger.debug("Progress update sent", {
      sessionId: this.sessionId,
      phasesCompleted,
      totalPhases,
      agentsExecuted,
      totalAgents,
      currentPhase,
    });
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
      async (_span) => {
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
    _taskId: string,
    _traceHeaders?: Record<string, string>,
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
  protected override handleBroadcast(_channel: string, data: Record<string, unknown>): void {
    // Check if this is an envelope message
    const envelopeValidation = validateEnvelope(data);
    if (envelopeValidation.success) {
      const envelope = envelopeValidation.data;

      // Handle envelope-based messages
      switch (envelope.type) {
        case ATLAS_MESSAGE_TYPES.AGENT.LOG:
          this.logger.debug("Agent log received via broadcast", {
            sessionId: this.sessionId || undefined,
            agentId: envelope.source.workerId,
            messageType: envelope.type,
          });

          // Forward agent logs to parent with envelope format
          self.postMessage({
            type: "sessionBroadcast",
            data: envelope,
          });
          break;

        case ATLAS_MESSAGE_TYPES.TASK.PROGRESS:
          if (envelope.domain === "agent") {
            this.logger.debug("Agent progress received via broadcast", {
              sessionId: this.sessionId || undefined,
              agentId: envelope.source.workerId,
              correlationId: envelope.correlationId,
            });

            // Forward agent progress to parent
            self.postMessage({
              type: "sessionBroadcast",
              data: envelope,
            });
          }
          break;

        case ATLAS_MESSAGE_TYPES.SESSION.BROADCAST:
          this.logger.debug("Session broadcast message received", {
            sessionId: this.sessionId || undefined,
            source: envelope.source.workerId,
            correlationId: envelope.correlationId,
          });

          // Handle session-level broadcast messages
          self.postMessage({
            type: "sessionBroadcast",
            data: envelope,
          });
          break;

        default:
          this.logger.warn("Unknown envelope message type in broadcast", {
            sessionId: this.sessionId || undefined,
            messageType: envelope.type,
            domain: envelope.domain,
          });
      }
    } else {
      // Handle legacy message format
      switch (data.type) {
        case "agentMessage":
          this.log(`Agent ${data.from} broadcast: ${data.message}`);

          // Forward to parent (legacy format)
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
}

// Create and start the worker
new SessionSupervisorWorker();
