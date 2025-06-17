import type {
  IAtlasScope,
  IWorkspace,
  IWorkspaceAgent,
  IWorkspaceSession,
  IWorkspaceSignal,
  IWorkspaceSupervisor,
} from "../types/core.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { Session, SessionIntent, SessionPlan } from "./session.ts";
import { assign, createActor, createMachine, fromPromise } from "xstate";
import type { AtlasMemoryConfig } from "./memory-config.ts";

// XState types for WorkspaceSupervisor FSM
interface SupervisorContext {
  currentSignal: IWorkspaceSignal | null;
  currentPayload: any;
  executionPlan: any;
  activeSessions: Map<string, IWorkspaceSession>;
  error: Error | null;
}

type SupervisorEvent =
  | { type: "SIGNAL_RECEIVED"; signal: IWorkspaceSignal; payload: any }
  | { type: "PLAN_GENERATED"; plan: any }
  | { type: "SESSION_SPAWNED"; session: IWorkspaceSession }
  | { type: "SESSION_COMPLETED"; sessionId: string; result: any }
  | { type: "SESSION_FAILED"; sessionId: string; error: Error }
  | { type: "ERROR"; error: Error }
  | { type: "RESET" };

// Create the supervisor state machine
function createSupervisorMachine(supervisor: WorkspaceSupervisor) {
  return createMachine({
    id: "workspaceSupervisor",
    initial: "idle",
    context: {
      currentSignal: null,
      currentPayload: null,
      executionPlan: null,
      activeSessions: new Map(),
      error: null,
    } as SupervisorContext,
    states: {
      idle: {
        on: {
          SIGNAL_RECEIVED: {
            target: "analyzing",
            actions: assign({
              currentSignal: ({ event }) => event.signal,
              currentPayload: ({ event }) => event.payload,
              error: () => null,
            }),
          },
        },
      },
      analyzing: {
        invoke: {
          id: "generatePlan",
          src: fromPromise(
            async (
              { input }: { input: { signal: IWorkspaceSignal; payload: any } },
            ) => {
              return supervisor.generateExecutionPlan(
                input.signal,
                input.payload,
              );
            },
          ),
          input: ({ context }) => ({
            signal: context.currentSignal!,
            payload: context.currentPayload,
          }),
          onDone: {
            target: "spawningSession",
            actions: assign({
              executionPlan: ({ event }) => event.output,
            }),
          },
          onError: {
            target: "error",
            actions: assign({
              error: ({ event }) => new Error(`Failed to generate plan: ${event.error}`),
            }),
          },
        },
      },
      spawningSession: {
        invoke: {
          id: "spawnSession",
          src: fromPromise(
            async (
              { input }: {
                input: { signal: IWorkspaceSignal; plan: any; payload: any };
              },
            ) => {
              // Create intent from signal and payload
              const intent = supervisor.createSessionIntent(
                input.signal,
                input.payload,
              );

              // Create session with intent
              const session = new Session(
                supervisor.id,
                {
                  triggers: [input.signal],
                  callback: (result: any) => Promise.resolve(),
                },
                supervisor.getWorkspaceAgents(),
                undefined, // workflows
                undefined, // sources
                intent,
              );

              supervisor.addSession(session);
              await supervisor.executeSessionPlan(
                session,
                input.plan,
                input.payload,
              );
              return session;
            },
          ),
          input: ({ context }) => ({
            signal: context.currentSignal!,
            plan: context.executionPlan,
            payload: context.currentPayload,
          }),
          onDone: {
            target: "coordinating",
            actions: assign({
              activeSessions: ({ context, event }) => {
                const sessions = new Map(context.activeSessions);
                sessions.set(event.output.id, event.output);
                return sessions;
              },
            }),
          },
          onError: {
            target: "error",
            actions: assign({
              error: ({ event }) => new Error(`Failed to spawn session: ${event.error}`),
            }),
          },
        },
      },
      coordinating: {
        on: {
          SIGNAL_RECEIVED: {
            target: "analyzing",
            actions: assign({
              currentSignal: ({ event }) => event.signal,
              currentPayload: ({ event }) => event.payload,
            }),
          },
          SESSION_COMPLETED: {
            actions: assign({
              activeSessions: ({ context, event }) => {
                const sessions = new Map(context.activeSessions);
                sessions.delete(event.sessionId);
                return sessions;
              },
            }),
          },
          SESSION_FAILED: {
            actions: [
              assign({
                activeSessions: ({ context, event }) => {
                  const sessions = new Map(context.activeSessions);
                  sessions.delete(event.sessionId);
                  return sessions;
                },
              }),
              ({ event }) => {
                console.log(
                  `Session ${event.sessionId} failed: ${event.error.message}`,
                );
              },
            ],
          },
        },
        always: {
          target: "idle",
          guard: ({ context }) => context.activeSessions.size === 0,
        },
      },
      error: {
        entry: ({ context }) => {
          console.log(`Supervisor error: ${context.error?.message}`);
        },
        on: {
          RESET: {
            target: "idle",
            actions: assign({
              error: () => null,
              currentSignal: () => null,
              currentPayload: () => null,
              executionPlan: () => null,
            }),
          },
        },
      },
    },
  });
}

export class WorkspaceSupervisor extends BaseAgent
  implements IWorkspaceSupervisor, IWorkspaceAgent {
  private workspace?: IWorkspace;
  private model: string;
  config: any;
  private mergedConfig: any; // Contains atlas.yml + workspace.yml + jobs
  private sessions: Map<string, IWorkspaceSession> = new Map();
  private stateMachine: ReturnType<typeof createSupervisorMachine>;
  private stateActor: any; // XState actor type

  constructor(workspaceId: string, config: any = {}) {
    // Provide default memoryConfig if not provided
    const defaultMemoryConfig: AtlasMemoryConfig = {
      default: {
        enabled: true,
        storage: "coala-local",
        cognitive_loop: true,
        retention: {
          max_age_days: 30,
          max_entries: 1000,
          cleanup_interval_hours: 24,
        },
      },
      agent: {
        enabled: true,
        scope: "agent",
        include_in_context: true,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 5,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 100 },
          episodic: { enabled: true, max_entries: 50 },
          semantic: { enabled: true, max_entries: 200 },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 15,
          past_successes: 10,
          past_failures: 10,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 200 },
          episodic: { enabled: true, max_entries: 100 },
          semantic: { enabled: true, max_entries: 300 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: true,
        context_limits: {
          relevant_memories: 20,
          past_successes: 15,
          past_failures: 15,
        },
        memory_types: {
          contextual: { enabled: true, max_entries: 500 },
          episodic: { enabled: true, max_entries: 200 },
          semantic: { enabled: true, max_entries: 1000 },
        },
      },
    };

    const memoryConfig = config.memoryConfig || defaultMemoryConfig;
    super(memoryConfig, workspaceId);
    this.config = config;
    // Store merged configuration if provided
    this.mergedConfig = config.workspaceSignals || config.jobs
      ? {
        workspace: {
          signals: config.workspaceSignals || {},
        },
        jobs: config.jobs || {},
      }
      : null;
    this.model = config.model || "claude-4-sonnet-20250514";

    // Set supervisor-specific prompts
    this.prompts = {
      system: config.prompts?.system ||
        `You are the WorkspaceSupervisor for an Atlas workspace. Your role is to:
1. Process incoming signals and create execution plans
2. Spawn and coordinate agents within sessions  
3. Manage inter-agent communication
4. Ensure proper isolation between sessions
5. Track progress and handle errors

You have access to the full workspace context and configuration. Create structured plans using Agentic Behavior Trees (ABT) to coordinate agent activities.`,
      user: config.prompts?.user || "",
    };

    // Initialize the state machine
    this.stateMachine = createSupervisorMachine(this);
    this.stateActor = createActor(this.stateMachine);

    // Subscribe to state changes for logging
    this.stateActor.subscribe((state: any) => {
      this.log(
        `State transition: ${state.value} | Active sessions: ${state.context.activeSessions.size}`,
      );
    });

    // Start the state machine
    this.stateActor.start();
  }

  // IAtlasAgent interface methods
  name(): string {
    return "WorkspaceSupervisor";
  }

  nickname(): string {
    return "Supervisor";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "anthropic";
  }

  purpose(): string {
    return "Manages workspace lifecycle, agent coordination, and signal processing";
  }

  override getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  override scope(): IAtlasScope {
    return this;
  }

  controls(): object {
    return {
      canSpawnSessions: true,
      canManageAgents: true,
      canProcessSignals: true,
      hasGlobalAccess: true,
      model: this.model,
    };
  }

  // IWorkspaceAgent interface methods
  status: string = "active";
  host: string = "local";

  override async invoke(message: string): Promise<string> {
    // Process supervisor-level commands
    if (message.startsWith("/")) {
      return this.processCommand(message);
    }

    // Use Claude to process the message
    const response = await this.generateLLM(
      this.model,
      this.prompts.system,
      message,
    );

    return response;
  }

  override async *invokeStream(message: string): AsyncIterableIterator<string> {
    // For commands, return immediately
    if (message.startsWith("/")) {
      yield this.processCommand(message);
      return;
    }

    // Use Claude to generate response
    const response = await this.generateLLM(
      this.model,
      this.prompts.system,
      message,
      true,
      { operation: "workspace_supervisor_response", workspaceId: this.id },
    );

    // Stream the response
    // Stream the response character by character
    for (let i = 0; i < response.length; i++) {
      yield response[i];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  setWorkspace(workspace: IWorkspace): void {
    this.workspace = workspace;
  }

  getWorkspaceAgents(): IWorkspaceAgent[] | undefined {
    return this.workspace?.agents ? Object.values(this.workspace.agents) : undefined;
  }

  // State machine integration methods
  getCurrentState(): string {
    return this.stateActor.getSnapshot().value as string;
  }

  getStateMachineContext(): SupervisorContext {
    return this.stateActor.getSnapshot().context;
  }

  isIdle(): boolean {
    return this.getCurrentState() === "idle";
  }

  isProcessingSignal(): boolean {
    const state = this.getCurrentState();
    return state === "analyzing" || state === "spawningSession";
  }

  hasActiveSessions(): boolean {
    return this.getStateMachineContext().activeSessions.size > 0;
  }

  canAcceptSignal(): boolean {
    const state = this.getCurrentState();
    return state === "idle" || state === "coordinating";
  }

  // IWorkspaceSupervisor specific methods
  async spawnSession(
    signal: IWorkspaceSignal,
    payload?: any,
  ): Promise<IWorkspaceSession> {
    this.log(
      `Processing signal: ${signal.id} with payload: ${JSON.stringify(payload || {})}`,
    );

    // Use empty object if no payload provided
    const signalPayload = payload || {};

    // Send signal to state machine
    this.stateActor.send({
      type: "SIGNAL_RECEIVED",
      signal,
      payload: signalPayload,
    });

    // Wait for the state machine to process the signal
    return new Promise((resolve, reject) => {
      const checkState = () => {
        const state = this.stateActor.getSnapshot();

        if (state.value === "coordinating") {
          // Session successfully spawned
          const sessions = Array.from(state.context.activeSessions.values());
          const latestSession = sessions[sessions.length - 1];
          if (latestSession) {
            resolve(latestSession as IWorkspaceSession);
          } else {
            reject(new Error("Session spawned but not found in context"));
          }
        } else if (state.value === "error") {
          // Error occurred
          reject(
            state.context.error ||
              new Error("Unknown error during session spawn"),
          );
        } else {
          // Still processing, check again
          setTimeout(checkState, 100);
        }
      };

      checkState();
    });
  }

  // Helper method to add session to internal tracking
  addSession(session: IWorkspaceSession): void {
    this.sessions.set(session.id, session);
  }

  // Create session intent from signal and payload
  // Create session intent (synchronous for backward compatibility)
  createSessionIntent(signal: IWorkspaceSignal, payload: any): SessionIntent {
    return {
      id: crypto.randomUUID(),
      signal: {
        type: signal.id,
        data: payload,
        metadata: {
          provider: signal.provider.name,
          timestamp: new Date().toISOString(),
        },
      },
      goals: this.inferGoalsFromSignal(signal, payload),
      constraints: {
        timeLimit: 300000, // 5 minutes default
      },
      suggestedAgents: this.workspace ? Object.keys(this.workspace.agents) : [],
      executionHints: {
        strategy: "iterative",
        parallelism: false,
        maxIterations: 3,
      },
      userPrompt: this.config.intentPrompt || "",
    };
  }

  // Analyze signal using LLM to create intelligent session intent
  async analyzeSignal(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<SessionIntent> {
    const startTime = Date.now();
    this.logger.debug(`[PERF] Starting analyzeSignal for signal: ${signal.id}`, {
      signalId: signal.id,
      payloadSize: JSON.stringify(payload).length,
      activeSessions: this.getStateMachineContext().activeSessions.size,
    });

    const promptStart = Date.now();
    const analysisPrompt = `Analyze this incoming signal and determine the session intent:

Signal: ${signal.id}
Provider: ${signal.provider.name}
Payload: ${JSON.stringify(payload, null, 2)}

Workspace Context:
- Available Agents: ${this.workspace ? Object.keys(this.workspace.agents || {}).join(", ") : "none"}
- Active Sessions: ${this.getStateMachineContext().activeSessions.size}

${this.config.intentPrompt || ""}

Determine:
1. What are the specific goals of this signal?
2. What constraints should apply (time, cost, etc)?
3. Which agents would be most relevant?
4. What execution strategy would work best (sequential, parallel, iterative)?

Provide a structured analysis.`;

    const promptTime = Date.now() - promptStart;
    this.logger.debug(`[PERF] Prompt construction took ${promptTime}ms`, {
      promptLength: analysisPrompt.length,
    });

    try {
      const llmStart = Date.now();
      this.logger.debug(`[PERF] Starting LLM call for signal analysis`, {
        model: this.config.model || "claude-4-sonnet-20250514",
        promptTokensEstimate: Math.round(analysisPrompt.length / 4),
        systemPromptLength: this.prompts.system.length,
      });

      const response = await this.generateLLM(
        this.config.model || "claude-4-sonnet-20250514",
        this.prompts.system,
        analysisPrompt,
        true,
        {
          operation: "signal_analysis",
          signalId: signal.id,
          workspaceId: this.id,
          payloadSize: JSON.stringify(payload).length,
        },
      );

      const llmTime = Date.now() - llmStart;
      this.logger.debug(`[PERF] LLM call completed`, {
        duration: llmTime,
        responseLength: response.length,
        responseTokensEstimate: Math.round(response.length / 4),
        model: this.config.model || "claude-4-sonnet-20250514",
        requestSize: analysisPrompt.length + this.prompts.system.length,
      });

      // Parse the response into SessionIntent
      const parseStart = Date.now();
      this.logger.debug(`[DEBUG] Raw LLM response`, {
        response: response.substring(0, 500) + (response.length > 500 ? "..." : ""),
        fullLength: response.length,
      });

      const goals = this.extractGoalsFromResponse(response);
      const suggestedAgents = this.extractSuggestedAgentsFromResponse(response);
      const strategy = this.extractStrategyFromResponse(response);
      const parseTime = Date.now() - parseStart;
      this.logger.debug(`[PERF] Response parsing took ${parseTime}ms`, {
        goalsFound: goals.length,
        agentsFound: suggestedAgents.length,
        strategy,
        extractedGoals: goals,
        extractedAgents: suggestedAgents,
      });

      const intentStart = Date.now();
      const intent = {
        id: crypto.randomUUID(),
        signal: {
          type: signal.id,
          data: payload,
          metadata: {
            provider: signal.provider.name,
            timestamp: new Date().toISOString(),
          },
        },
        goals: goals.length > 0 ? goals : this.inferGoalsFromSignal(signal, payload),
        constraints: {
          timeLimit: 300000,
          costLimit: 100,
        },
        suggestedAgents: suggestedAgents.length > 0
          ? suggestedAgents
          : (this.workspace ? Object.keys(this.workspace.agents) : []),
        executionHints: {
          strategy: strategy as any || "iterative",
          parallelism: response.toLowerCase().includes("parallel"),
          maxIterations: 3,
        },
        userPrompt: this.config.intentPrompt || "",
      };
      const intentTime = Date.now() - intentStart;

      const totalTime = Date.now() - startTime;
      this.logger.debug(`[PERF] analyzeSignal completed successfully`, {
        totalTime,
        llmTime,
        llmPercentage: Math.round((llmTime / totalTime) * 100),
        parseTime,
        intentConstructionTime: intentTime,
        signalId: signal.id,
        finalIntent: {
          id: intent.id,
          goals: intent.goals,
          strategy: intent.executionHints?.strategy,
          agentCount: intent.suggestedAgents?.length || 0,
        },
      });

      return intent;
    } catch (error) {
      const errorTime = Date.now() - startTime;
      this.logger.debug(`[PERF] analyzeSignal failed after ${errorTime}ms: ${error}`, {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Fallback to synchronous method
      return this.createSessionIntent(signal, payload);
    }
  }

  // Create filtered session context based on intent
  async createSessionContext(
    intent: SessionIntent,
    signal: IWorkspaceSignal,
    payload: any,
    signalData?: { signalConfig?: any; jobs?: any },
  ): Promise<any> {
    const startTime = Date.now();
    this.logger.debug(`[PERF] Starting createSessionContext`, {
      intentId: intent.id,
      signalId: signal.id,
      hasSignalData: !!signalData,
      signalDataKeys: signalData ? Object.keys(signalData) : [],
      intentGoals: intent.goals?.length || 0,
      intentAgents: intent.suggestedAgents?.length || 0,
    });

    try {
      // Step 1: Select appropriate job based on signal configuration and payload
      const jobStart = Date.now();
      this.logger.debug(`[DEBUG] About to select job`, {
        signalId: signal.id,
        payloadKeys: Object.keys(payload),
        signalConfigAvailable: !!(signalData?.signalConfig),
        jobsAvailable: !!(signalData?.jobs),
        mergedConfigAvailable: !!this.mergedConfig,
      });

      const selectedJob = this.selectJobForSignal(signal, payload, signalData);
      const jobTime = Date.now() - jobStart;
      this.logger.debug(`[PERF] Job selection took ${jobTime}ms`, {
        selectedJob: selectedJob?.name || "none",
        hasSignalData: !!signalData,
        jobExecutionStrategy: selectedJob?.execution?.strategy,
        jobAgentCount: selectedJob?.execution?.agents?.length || 0,
      });

      // Step 2: Determine available agents based on job specification or fallback
      const agentStart = Date.now();
      let availableAgents;
      if (selectedJob) {
        // Get agents specified in the job
        const jobAgentIds = this.extractAgentIdsFromJob(selectedJob);
        availableAgents = this.getAllAgentMetadata().filter((agent) =>
          jobAgentIds.includes(agent.id)
        );
      } else {
        // Fallback to intent-based or all agents
        availableAgents = intent.suggestedAgents && intent.suggestedAgents.length > 0
          ? this.getAllAgentMetadata().filter((agent) => intent.suggestedAgents?.includes(agent.id))
          : this.getAllAgentMetadata();
      }
      const agentTime = Date.now() - agentStart;
      this.logger.debug(`[PERF] Agent selection took ${agentTime}ms`, {
        totalAgents: this.getAllAgentMetadata().length,
        selectedAgents: availableAgents.length,
        selectionMethod: selectedJob ? "job-based" : "intent-based",
        selectedAgentIds: availableAgents.map((a) => a.id),
        allAvailableAgentIds: this.getAllAgentMetadata().map((a) => a.id),
      });

      const contextStart = Date.now();
      this.logger.debug(`[DEBUG] Building session context`, {
        hasWorkspace: !!this.workspace,
        workspaceId: this.workspace?.id,
        hasSignalPrompts: !!(this.config.signalPrompts?.[signal.id]),
        hasSessionPrompts: !!(this.config.prompts?.session),
        hasEvaluationPrompts: !!(this.config.prompts?.evaluation),
      });

      const context = {
        availableAgents,
        filteredMemory: [], // TODO: Implement memory filtering
        constraints: intent.constraints,
        jobSpec: selectedJob, // Include job specification for SessionSupervisor
        additionalContext: {
          workspaceId: this.workspace?.id,
          sessionIntent: intent,
        },
        additionalPrompts: {
          signal: this.config.signalPrompts?.[signal.id] || "",
          session: this.config.prompts?.session || "",
          evaluation: this.config.prompts?.evaluation || "",
        },
      };
      const contextTime = Date.now() - contextStart;

      const totalTime = Date.now() - startTime;
      this.logger.debug(`[PERF] createSessionContext completed successfully`, {
        totalTime,
        jobSelectionTime: jobTime,
        agentSelectionTime: agentTime,
        contextBuildTime: contextTime,
        agentsSelected: availableAgents.length,
        hasJobSpec: !!selectedJob,
        contextSize: JSON.stringify(context).length,
        memoryFilteringTodo: true,
      });

      return context;
    } catch (error) {
      const errorTime = Date.now() - startTime;
      this.logger.debug(`[PERF] createSessionContext failed after ${errorTime}ms: ${error}`, {
        intentId: intent.id,
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Fallback to all agents without job specification
      return {
        availableAgents: this.getAllAgentMetadata(),
        filteredMemory: [],
        constraints: intent.constraints,
        jobSpec: null,
      };
    }
  }

  // Select appropriate job based on signal configuration and payload
  private selectJobForSignal(
    signal: IWorkspaceSignal,
    payload: any,
    signalData?: { signalConfig?: any; jobs?: any },
  ): any | null {
    try {
      const availableJobs = signalData?.jobs || this.mergedConfig?.jobs || {};

      this.logger.debug(`[DEBUG] selectJobForSignal started`, {
        signalId: signal.id,
        signalDataProvided: !!signalData,
        signalDataJobs: signalData?.jobs ? Object.keys(signalData.jobs) : [],
        mergedConfigJobs: this.mergedConfig?.jobs ? Object.keys(this.mergedConfig.jobs) : [],
        availableJobNames: Object.keys(availableJobs),
        payloadKeys: Object.keys(payload),
        mergedConfigAvailable: !!this.mergedConfig,
        jobsSourceUsed: signalData?.jobs ? 'signalData' : (this.mergedConfig?.jobs ? 'mergedConfig' : 'none'),
      });

      // Find jobs that have triggers for this signal
      const matchingJobs: Array<{ job: any; trigger: any }> = [];

      for (const [jobName, jobSpec] of Object.entries(availableJobs)) {
        const triggers = (jobSpec as any).triggers;
        if (triggers) {
          for (const trigger of triggers) {
            if (trigger.signal === signal.id) {
              matchingJobs.push({ job: jobSpec, trigger });
            }
          }
        }
      }

      this.logger.debug(`[DEBUG] Found jobs with triggers for signal`, {
        signalId: signal.id,
        matchingJobsCount: matchingJobs.length,
        matchingJobs: matchingJobs.map(({ job, trigger }) => ({
          jobName: job.name,
          hasCondition: !!trigger.condition,
          condition: trigger.condition,
        })),
      });

      if (matchingJobs.length === 0) {
        this.logger.debug(`[DEBUG] No jobs found with triggers for signal`, {
          signalId: signal.id,
        });
        return null;
      }

      // Evaluate job trigger conditions to find the first matching job
      for (const [index, { job, trigger }] of matchingJobs.entries()) {
        this.logger.debug(`[DEBUG] Evaluating job trigger ${index + 1}/${matchingJobs.length}`, {
          jobName: job.name,
          condition: trigger.condition,
          payload,
        });

        const conditionResult = this.evaluateJobCondition(trigger.condition, payload);
        this.logger.debug(`[DEBUG] Job trigger condition evaluation result`, {
          jobName: job.name,
          condition: trigger.condition,
          result: conditionResult,
        });

        if (conditionResult) {
          this.logger.debug(`[DEBUG] Job selected successfully`, {
            selectedJob: job.name,
            jobSpec: {
              name: job.name,
              strategy: job.execution?.strategy,
              agentCount: job.execution?.agents?.length || 0,
              agents: job.execution?.agents?.map((a: any) => typeof a === "string" ? a : a.id) ||
                [],
            },
          });
          return job;
        }
      }

      this.logger.debug(`[DEBUG] No matching job found`, {
        signalId: signal.id,
        totalJobsEvaluated: matchingJobs.length,
        availableJobs: Object.keys(availableJobs),
      });
      return null;
    } catch (error) {
      this.logger.debug(`[DEBUG] selectJobForSignal error`, {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  // Evaluate job condition against payload
  private evaluateJobCondition(condition: string | undefined, payload: any): boolean {
    if (!condition) return true; // No condition means always match

    try {
      // Create evaluation context with payload properties
      const context = { ...payload };

      // Simple condition evaluation - in production would use safer evaluation
      // For now, handle the specific telephone game condition
      if (condition.includes("message && message.length")) {
        const message = payload.message;
        if (!message) return false;

        // Parse the condition to extract length comparison
        if (condition.includes("< 100")) {
          return message.length > 0 && message.length < 100;
        } else if (condition.includes(">= 100")) {
          return message.length >= 100;
        }
      }

      // Default: condition not understood, return false
      this.log(`Unknown condition format: ${condition}`);
      return false;
    } catch (error) {
      this.log(`Error evaluating condition "${condition}": ${error}`);
      return false;
    }
  }

  // Extract agent IDs from job specification
  private extractAgentIdsFromJob(jobSpec: any): string[] {
    const agentIds: string[] = [];

    if (jobSpec.execution?.agents) {
      // Sequential or parallel strategy
      agentIds.push(...jobSpec.execution.agents.map((agent: any) => agent.id));
    }

    if (jobSpec.execution?.stages) {
      // Staged strategy
      for (const stage of jobSpec.execution.stages) {
        agentIds.push(...stage.agents.map((agent: any) => agent.id));
      }
    }

    return agentIds;
  }

  // Infer goals from signal type and payload
  private inferGoalsFromSignal(
    signal: IWorkspaceSignal,
    payload: any,
  ): string[] {
    // Let the signal provider define its own goals if available
    if (
      signal.provider &&
      typeof signal.provider === "object" &&
      "inferGoals" in signal.provider &&
      typeof signal.provider.inferGoals === "function"
    ) {
      return (signal.provider as any).inferGoals(payload);
    }

    // Otherwise use LLM to analyze the signal and payload
    // For now, return generic goals
    return [
      `Process ${signal.id} signal from ${signal.provider.name}`,
      "Execute appropriate actions based on signal data",
      "Return results to signal callback",
    ];
  }

  async generateExecutionPlan(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<SessionPlan> {
    const intent = this.createSessionIntent(signal, payload);

    const planPrompt = `Given the following session intent, create an execution plan:

Intent: ${JSON.stringify(intent, null, 2)}
Available Agents: ${this.getAvailableAgents()}

Create a structured plan that:
1. Identifies which agents to use for each goal
2. Determines the execution phases and order
3. Specifies dependencies between agent tasks

Respond with a JSON object matching the SessionPlan interface with phases array.`;

    // For now, skip LLM call and use default plan
    // TODO: Implement proper LLM integration
    this.log("Using default plan (LLM integration pending)");
    return this.getDefaultPlan(signal, payload, intent);
  }

  private getAvailableAgents(): string {
    if (!this.workspace) return "No workspace set";

    // Handle serialized workspace with agent metadata
    if (this.workspace.agents && typeof this.workspace.agents === "object") {
      return Object.entries(this.workspace.agents)
        .map(([id, agent]: [string, any]) => {
          if (typeof agent === "object" && agent.name) {
            return `- ${agent.name}: ${agent.purpose || ""}`;
          }
          return `- ${id}`;
        })
        .join("\n");
    }

    return "No agents available";
  }

  private getDefaultPlan(
    signal: IWorkspaceSignal,
    payload: any,
    intent: SessionIntent,
  ): SessionPlan {
    // Create a generic plan based on available agents
    this.log(`Workspace agents:`, "debug", { agents: this.workspace?.agents });

    // Handle both full workspace objects and serialized metadata
    let availableAgents: string[] = [];
    if (this.workspace?.agents) {
      // Check if agents is already an object with agent metadata
      if (
        typeof this.workspace.agents === "object" &&
        !Array.isArray(this.workspace.agents)
      ) {
        availableAgents = Object.keys(this.workspace.agents);
      }
    }

    this.log(
      `Creating default plan with agents: ${availableAgents.join(", ")}`,
    );

    return {
      intentId: intent.id,
      phases: [{
        id: "default-phase",
        name: "Default Processing",
        agents: availableAgents.map((agentId) => ({
          agentId,
          task: `Process signal with ${agentId}`,
        })),
        executionStrategy: "sequential",
      }],
      reasoning: "Default plan using available agents",
    };
  }

  async executeSessionPlan(
    session: IWorkspaceSession,
    plan: SessionPlan,
    initialPayload: any,
  ): Promise<void> {
    this.log(`Executing plan: ${plan.reasoning}`);

    try {
      // Start the session - it will handle its own lifecycle through FSM
      await session.start();

      // The session FSM will handle:
      // 1. Planning phase (using the intent)
      // 2. Executing agents
      // 3. Evaluating results
      // 4. Refining if needed
      // 5. Completing or failing

      // Monitor session state changes
      const checkInterval = setInterval(() => {
        const status = (session as Session).status;

        if (status === "completed") {
          clearInterval(checkInterval);
          this.stateActor.send({
            type: "SESSION_COMPLETED",
            sessionId: session.id,
            result: (session as Session).getArtifacts(),
          });
        } else if (status === "failed" || status === "cancelled") {
          clearInterval(checkInterval);
          this.stateActor.send({
            type: "SESSION_FAILED",
            sessionId: session.id,
            error: new Error(`Session ${status}`),
          });
        }
      }, 500);
    } catch (error) {
      // Handle any startup errors
      this.stateActor.send({
        type: "SESSION_FAILED",
        sessionId: session.id,
        error: error as Error,
      });
      throw error;
    }
  }

  private processCommand(command: string): string {
    const [cmd, ...args] = command.slice(1).split(" ");

    switch (cmd) {
      case "status":
        return this.workspace
          ? JSON.stringify(this.workspace.snapshot(), null, 2)
          : "No workspace set";
      case "agents":
        return this.workspace
          ? `Active agents: ${Object.keys(this.workspace.agents).join(", ") || "none"}`
          : "No workspace set";
      case "signals":
        return this.workspace
          ? `Configured signals: ${Object.keys(this.workspace.signals).join(", ") || "none"}`
          : "No workspace set";
      case "sessions":
        return `Active sessions: ${this.sessions.size}`;
      case "state":
        const state = this.getCurrentState();
        const context = this.getStateMachineContext();
        return `State Machine Status:
  Current State: ${state}
  Active Sessions: ${context.activeSessions.size}
  Current Signal: ${context.currentSignal?.id || "none"}
  Has Error: ${context.error ? "yes" : "no"}`;
      case "reset":
        this.stateActor.send({ type: "RESET" });
        return "State machine reset to idle state";
      case "help":
        return "Available commands: /status, /agents, /signals, /sessions, /state, /reset, /help";
      default:
        return `Unknown command: ${cmd}. Use /help for available commands.`;
    }
  }

  // Helper methods for parsing LLM responses
  private extractGoalsFromResponse(response: string): string[] {
    const goals = [];
    const lines = response.split("\n");
    let inGoalsSection = false;

    for (const line of lines) {
      if (
        line.toLowerCase().includes("goal") ||
        line.toLowerCase().includes("objective")
      ) {
        inGoalsSection = true;
      }
      if (inGoalsSection && line.trim().startsWith("-")) {
        goals.push(line.trim().substring(1).trim());
      }
      if (line.trim() === "" && inGoalsSection) {
        inGoalsSection = false;
      }
    }

    return goals;
  }

  private extractSuggestedAgentsFromResponse(response: string): string[] {
    const agents = [];
    const agentIds = this.workspace ? Object.keys(this.workspace.agents || {}) : [];

    for (const agentId of agentIds) {
      if (response.toLowerCase().includes(agentId.toLowerCase())) {
        agents.push(agentId);
      }
    }

    return agents;
  }

  private extractStrategyFromResponse(response: string): string {
    if (response.toLowerCase().includes("sequential")) return "deterministic";
    if (response.toLowerCase().includes("parallel")) return "exploratory";
    if (response.toLowerCase().includes("iterative")) return "iterative";
    return "exploratory";
  }

  private extractAvailableAgentsFromResponse(response: string): any[] {
    if (!this.workspace || !this.workspace.agents) return [];

    const allAgents = Object.entries(this.workspace.agents);
    const selectedAgents = [];

    // If response mentions specific agents, filter to those
    for (const [id, agent] of allAgents) {
      if (
        response.toLowerCase().includes(id.toLowerCase()) ||
        response.toLowerCase().includes("all agents")
      ) {
        selectedAgents.push({
          id,
          name: agent.name?.() || id,
          type: (agent as any).type || id.replace("-agent", ""),
          purpose: agent.purpose?.() || "",
        });
      }
    }

    return selectedAgents;
  }

  private getAllAgentMetadata(): any[] {
    if (!this.workspace || !this.workspace.agents) return [];

    return Object.entries(this.workspace.agents).map(([id, agent]) => {
      // Check if agent is metadata-only (has isMetadata flag) or actual agent instance
      const isMetadataOnly = (agent as any).isMetadata === true;

      if (isMetadataOnly) {
        // Agent is metadata-only, extract full configuration
        return {
          id,
          name: typeof (agent as any).name === "function"
            ? (agent as any).name()
            : (agent as any).name || id,
          type: (agent as any).type,
          purpose: typeof (agent as any).purpose === "function"
            ? (agent as any).purpose()
            : (agent as any).purpose || "",
          config: (agent as any).config, // Include full configuration for AgentSupervisor
        };
      } else {
        // Legacy agent instance, extract basic metadata
        return {
          id,
          name: typeof agent.name === "function" ? agent.name() : agent.name || id,
          type: (agent as any).type || id.replace("-agent", ""),
          purpose: typeof agent.purpose === "function" ? agent.purpose() : agent.purpose || "",
          config: (agent as any).config || {}, // Include any stored config
        };
      }
    });
  }

  // IWorkspaceSupervisor interface methods
  manageAgentLifecycle(): void {
    // TODO: Implement agent lifecycle management
    this.log("Managing agent lifecycle");
  }

  processSignalInterrupts(): void {
    // TODO: Implement signal interrupt processing
    this.log("Processing signal interrupts");
  }

  // Cleanup method
  destroy(): void {
    this.log("Shutting down WorkspaceSupervisor state machine");
    this.stateActor.stop();
  }
}
