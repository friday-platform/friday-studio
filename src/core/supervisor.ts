import { assign, createActor, createMachine, fromPromise } from "xstate";
import type {
  IAtlasScope,
  IWorkspace,
  IWorkspaceAgent,
  IWorkspaceSession,
  IWorkspaceSignal,
  IWorkspaceSupervisor,
} from "../types/core.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { MCPServerRegistry } from "./agents/mcp/mcp-server-registry.ts";
import { type JobMatch, JobTriggerMatcher } from "./job-trigger-matcher.ts";
import type { AtlasMemoryConfig } from "./memory-config.ts";
import { type ResponseConfig, Session, SessionIntent, SessionPlan } from "./session.ts";
import {
  type AgentInfo,
  type EnhancedTask,
  type SignalProcessingConfig,
  SignalProcessor,
} from "./signal-processing/index.ts";

// XState types for WorkspaceSupervisor FSM
interface SupervisorContext {
  currentSignal: IWorkspaceSignal | null;
  currentPayload: any;
  executionPlan: any;
  activeSessions: Map<string, IWorkspaceSession>;
  error: Error | null;
  currentJobMatch?: JobMatch; // Store the matched job and trigger
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
            (
              { input }: { input: { signal: IWorkspaceSignal; payload: any } },
            ) => {
              return Promise.resolve(supervisor.generateExecutionPlan(
                input.signal,
                input.payload,
              ));
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

              // Create session with intent (response channels handled at daemon layer)
              const session = new Session(
                supervisor.id,
                {
                  triggers: [input.signal],
                  callback: (_result: any) => Promise.resolve(),
                },
                supervisor.getWorkspaceAgents(),
                undefined, // workflows
                undefined, // sources
                intent,
                undefined, // storageAdapter
                true, // enableCognitiveLoop
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
  private signalProcessor: SignalProcessor;
  private jobTriggerMatcher: JobTriggerMatcher;
  private currentJobMatch?: JobMatch; // Store current job match for session creation

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
    this.model = config.model || "claude-3-5-sonnet-20241022";

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

    // Enable advanced planning capabilities
    this.enableAdvancedPlanning({
      cacheDir: config.atlasPath || Deno.cwd(),
      enableCaching: true,
      enablePatternMatching: true,
      reasoningConfig: {
        allowLLMSelection: true,
        defaultMethod: "chain-of-thought",
      },
    });

    // Initialize signal processor with configuration
    this.signalProcessor = new SignalProcessor(this.createSignalProcessingConfig());

    // Initialize job trigger matcher for direct job-signal evaluation
    this.jobTriggerMatcher = new JobTriggerMatcher({
      condition_evaluation: {
        evaluators: {
          jsonlogic: { enabled: true, priority: 100 },
          simple_expression: { enabled: true, priority: 50 },
          exact_match: { enabled: true, priority: 10 },
        },
        fallback_strategy: "allow",
        require_match_confidence: 0.5,
      },
      min_confidence: 0.5,
      max_matches_per_signal: 10,
      enable_parallel_evaluation: true,
    });

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

  // Initialize supervisor with workspace and precompute plans
  async initialize(): Promise<void> {
    this.log("Initializing WorkspaceSupervisor with advanced planning...");

    // Initialize MCP Server Registry with workspace configuration
    await this.initializeMCPRegistry();

    // Enable advanced planning if not already enabled
    if (!this.planningEngine) {
      this.enableAdvancedPlanning();
    }

    // Precompute plans for all configured jobs
    await this.precomputePlansForJobs();

    // Precompute signal analysis patterns to eliminate LLM calls
    await this.precomputeSignalAnalysisPatterns();

    this.log("WorkspaceSupervisor initialization complete");
  }

  /**
   * Initialize MCP Server Registry with platform and workspace configurations
   */
  private async initializeMCPRegistry(): Promise<void> {
    try {
      this.log("Initializing MCP Server Registry...");

      // Use MCP server configuration passed from workspace runtime
      const workspaceTools = this.config?.workspaceTools;
      const workspaceMcpServers = workspaceTools?.mcp?.servers;

      if (workspaceMcpServers) {
        this.log(`Using passed MCP server configuration`, "info", {
          mcpServerCount: Object.keys(workspaceMcpServers).length,
          mcpServerIds: Object.keys(workspaceMcpServers),
        });

        // Create a minimal workspace config object for the registry
        const workspaceConfig = { mcp_servers: workspaceMcpServers };

        // Initialize the MCP Server Registry with workspace configuration only
        // (atlas config not needed since it wasn't being used anyway)
        MCPServerRegistry.initialize(undefined, workspaceConfig);
      } else {
        this.log("No MCP server configuration provided to supervisor worker");
        MCPServerRegistry.initialize(undefined, undefined);
      }

      const registeredServers = MCPServerRegistry.listServers();
      this.log(
        `MCP Server Registry initialized with ${registeredServers.length} servers: ${
          registeredServers.join(", ")
        }`,
      );
    } catch (error) {
      this.log(
        `Failed to initialize MCP Server Registry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Don't throw - MCP is optional and workspace should continue without it
    }
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
  spawnSession(
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

  // Pre-compute plans for all jobs at startup
  async precomputePlansForJobs(): Promise<void> {
    if (!this.planningEngine) {
      this.log("Advanced planning not enabled, skipping plan precomputation");
      return;
    }

    if (!this.mergedConfig?.jobs) {
      this.log("No jobs configured, skipping plan precomputation");
      return;
    }

    const jobs = this.mergedConfig.jobs;
    const jobNames = Object.keys(jobs);

    if (jobNames.length === 0) {
      this.log("No jobs found to precompute plans for");
      return;
    }

    this.log(`Starting background job plan precomputation for ${jobNames.length} jobs...`);

    // Process jobs in background without blocking initialization
    setTimeout(async () => {
      const startTime = Date.now();

      for (const jobName of jobNames) {
        try {
          const job = jobs[jobName];
          this.log(`Precomputing plan for job: ${jobName}`);

          // Create a planning task from the job specification
          const task = {
            id: `job-${jobName}`,
            description: job.description || `Execute job: ${jobName}`,
            context: {
              jobSpec: job,
              workspaceId: this.id,
              availableAgents: this.getAllAgentMetadata(),
            },
            agentType: "workspace" as const,
            complexity: this.inferJobComplexity(job),
            requiresToolUse: this.jobRequiresTools(job),
            qualityCritical: job.critical || false,
          };

          // Generate and cache the plan
          if (this.planningEngine) {
            await this.planningEngine.generatePlan(task);
          }
          this.log(`Plan precomputed for job: ${jobName}`);
        } catch (error) {
          this.log(`Failed to precompute plan for job ${jobName}: ${error}`);
        }
      }

      const totalTime = Date.now() - startTime;
      this.log(`Job plan precomputation completed in ${totalTime}ms for ${jobNames.length} jobs`);
    }, 100); // Small delay to let initialization complete first
  }

  // Precompute signal analysis patterns to eliminate LLM calls
  async precomputeSignalAnalysisPatterns(): Promise<void> {
    if (!this.mergedConfig) {
      this.log("No merged configuration available, skipping signal analysis precomputation");
      return;
    }

    const signals = this.mergedConfig.workspace?.signals || {};
    const jobs = this.mergedConfig.jobs || {};
    const availableAgents = this.getAllAgentMetadata().map((agent) => agent.id);

    if (Object.keys(signals).length === 0) {
      this.log("No signals configured, skipping signal analysis precomputation");
      return;
    }

    this.log(
      `Starting signal analysis pattern precomputation for ${
        Object.keys(signals).length
      } signals...`,
    );

    try {
      // Validate job trigger specifications
      const validation = this.jobTriggerMatcher.validateJobTriggers(jobs);

      if (!validation.valid) {
        this.log("Job trigger validation failed", "error", {
          errors: validation.errors,
        });
        throw new Error(`Invalid job triggers: ${validation.errors.join(", ")}`);
      }

      if (validation.warnings.length > 0) {
        this.log("Job trigger validation warnings", "warn", {
          warnings: validation.warnings,
        });
      }

      this.log("Job trigger validation complete", "info", {
        totalJobs: Object.keys(jobs).length,
        errors: validation.errors.length,
        warnings: validation.warnings.length,
      });
    } catch (error) {
      this.log(`Failed to validate job triggers: ${error}`);
    }
  }

  // Get precomputed plans for sharing with SessionSupervisors (workspace-scoped and secured)
  getPrecomputedPlans(requestingWorkspaceId?: string): Record<string, any> {
    // Security: Verify requesting workspace matches this supervisor's workspace
    if (requestingWorkspaceId && requestingWorkspaceId !== this.id) {
      this.log(
        `Security violation: workspace ${requestingWorkspaceId} requested plans from ${this.id}`,
        "warn",
      );
      return {};
    }

    // For now, return empty plans since we need to implement a proper cache sharing mechanism
    // The current planning engine doesn't support the getAllPrecomputedPlans() method
    // TODO: Implement proper planning cache sharing with workspace-scoped keys
    this.log(
      `getPrecomputedPlans() called for workspace ${this.id} - cache sharing not yet implemented`,
      "debug",
    );
    return {};
  }

  // Create secure, collision-resistant cache key for plans
  private createSecurePlanKey(jobName: string): string {
    // Include workspace ID to prevent cross-workspace collisions
    // Use deterministic hashing for consistent keys
    const keyData = `${this.id}:${jobName}`;
    // In production, use crypto.subtle.digest for proper hashing
    return `plan:${keyData}`;
  }

  // Sanitize plan data before sharing to remove sensitive information
  private sanitizePlanForSharing(plan: any): any {
    if (!plan || typeof plan !== "object") {
      return plan;
    }

    // Remove potentially sensitive fields
    const sanitized = { ...plan };
    delete sanitized.workspaceSecrets;
    delete sanitized.privateKeys;
    delete sanitized.authTokens;
    delete sanitized.internalConfig;

    // Ensure no workspace-specific absolute paths
    if (sanitized.context?.workspacePath) {
      sanitized.context.workspacePath = "[WORKSPACE_PATH]";
    }

    return sanitized;
  }

  // Infer job complexity from job specification
  private inferJobComplexity(job: any): number {
    let complexity = 1;

    // Add complexity for multiple agents
    if (job.execution?.agents?.length > 1) complexity += 2;

    // Add complexity for behavior tree strategy
    if (job.execution?.strategy === "behavior-tree") complexity += 1;

    // Add complexity for multiple stages
    if (job.execution?.stages?.length > 1) complexity += 1;

    // Add complexity for conditions
    if (job.triggers?.some((t: any) => t.condition)) complexity += 1;

    return Math.min(complexity, 5); // Cap at 5
  }

  // Check if job requires tool usage
  private jobRequiresTools(job: any): boolean {
    // Check if any agents in the job are tool-based
    const agentIds = this.extractAgentIdsFromJob(job);
    const agentMetadata = this.getAllAgentMetadata();

    return agentIds.some((id) => {
      const agent = agentMetadata.find((a) => a.id === id);
      return agent?.type === "remote" || agent?.config?.tools?.length > 0;
    });
  }

  // Analyze signal using direct job trigger evaluation (eliminates redundant LLM calls)
  async analyzeSignal(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<SessionIntent> {
    const startTime = Date.now();
    this.logger.debug(`[PERF] Starting job trigger evaluation for signal: ${signal.id}`, {
      signalId: signal.id,
      payloadSize: JSON.stringify(payload).length,
      activeSessions: this.getStateMachineContext().activeSessions.size,
    });

    try {
      // STEP 1: Find matching jobs using declarative trigger evaluation (zero LLM calls)
      const jobs = this.mergedConfig?.jobs || {};
      const matches: JobMatch[] = await this.jobTriggerMatcher.findMatchingJobs(
        signal,
        payload,
        jobs,
      );

      const totalTime = Date.now() - startTime;

      // STEP 2: If we found matching jobs, create intent from the best match
      if (matches.length > 0) {
        const bestMatch = matches[0]; // Already sorted by confidence

        this.logger.debug(`[PERF] Job trigger evaluation completed with direct match`, {
          totalTime,
          signalId: signal.id,
          matchedJob: bestMatch.job.name,
          confidence: bestMatch.evaluationResult.confidence,
          evaluator: bestMatch.evaluationResult.evaluator,
          totalMatches: matches.length,
          performance: "~20 seconds saved vs LLM analysis",
        });

        return this.createSessionIntentFromJobMatch(signal, payload, bestMatch);
      }

      // STEP 3: No matching jobs found - fallback to LLM analysis
      this.logger.debug(`[PERF] No matching job triggers found, falling back to LLM analysis`, {
        signalId: signal.id,
        evaluationTime: totalTime,
        fallbackReason: "no_matching_triggers",
        availableJobs: Object.keys(jobs).length,
      });

      return await this.analyzeSignalWithLLM(signal, payload);
    } catch (error) {
      const errorTime = Date.now() - startTime;
      this.logger.debug(`[PERF] Job trigger evaluation failed after ${errorTime}ms: ${error}`, {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Final fallback to synchronous method
      return this.createSessionIntent(signal, payload);
    }
  }

  // Create session intent from a matched job specification
  private createSessionIntentFromJobMatch(
    signal: IWorkspaceSignal,
    payload: any,
    match: JobMatch,
  ): SessionIntent {
    const job = match.job;

    // Extract agent IDs from job specification
    const suggestedAgents = job.execution?.agents?.map((agent) => agent.id) || [];

    // Map job execution strategy to session execution hint
    const mapExecutionStrategy = (
      strategy?: string,
    ): "iterative" | "deterministic" | "exploratory" => {
      switch (strategy) {
        case "sequential":
        case "parallel":
          return "deterministic";
        case "staged":
        case "hierarchical-task-network":
          return "iterative";
        case "conditional":
        case "monte-carlo-tree-search":
          return "exploratory";
        default:
          return "deterministic";
      }
    };

    return {
      id: crypto.randomUUID(),
      signal: {
        type: signal.id,
        data: payload,
        metadata: {
          provider: signal.provider.name,
          timestamp: new Date().toISOString(),
          matchedJob: job.name,
          evaluationMethod: "job-trigger-match",
          confidence: match.evaluationResult.confidence,
          evaluator: match.evaluationResult.evaluator,
        },
      },
      goals: [
        `Execute job: ${job.name}`,
        job.description || `Process ${signal.id} signal`,
      ],
      constraints: {
        timeLimit: job.resources?.estimated_duration_seconds
          ? job.resources.estimated_duration_seconds * 1000
          : 300000, // 5 minutes default
        costLimit: job.resources?.cost_limit || 100,
      },
      suggestedAgents,
      executionHints: {
        strategy: mapExecutionStrategy(job.execution?.strategy),
        parallelism: job.execution?.strategy === "parallel",
        maxIterations: 3,
      },
      userPrompt: job.session_prompts?.planning || "",
    };
  }

  // LLM-based signal analysis (fallback for signals without matching job triggers)
  private async analyzeSignalWithLLM(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<SessionIntent> {
    const startTime = Date.now();
    this.logger.debug(`[PERF] Starting LLM-based signal analysis for signal: ${signal.id}`, {
      signalId: signal.id,
      reason: "no_matching_job_triggers",
    });

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

    try {
      const llmStart = Date.now();
      this.logger.debug(`[PERF] Starting LLM call for signal analysis`, {
        model: this.config.model || "claude-3-5-sonnet-20241022",
        promptTokensEstimate: Math.round(analysisPrompt.length / 4),
        systemPromptLength: this.prompts.system.length,
      });

      const response = await this.generateLLM(
        this.config.model || "claude-3-5-sonnet-20241022",
        this.prompts.system,
        analysisPrompt,
        true,
        {
          operation: "signal_analysis_llm_fallback",
          signalId: signal.id,
          workspaceId: this.id,
          payloadSize: JSON.stringify(payload).length,
        },
      );

      const llmTime = Date.now() - llmStart;
      const totalTime = Date.now() - startTime;
      this.logger.debug(`[PERF] LLM signal analysis completed`, {
        totalTime,
        llmTime,
        llmPercentage: Math.round((llmTime / totalTime) * 100),
        responseLength: response.length,
        signalId: signal.id,
      });

      // Parse the response into SessionIntent
      const goals = this.extractGoalsFromResponse(response);
      const suggestedAgents = this.extractSuggestedAgentsFromResponse(response);
      const strategy = this.extractStrategyFromResponse(response);

      const intent = {
        id: crypto.randomUUID(),
        signal: {
          type: signal.id,
          data: payload,
          metadata: {
            provider: signal.provider.name,
            timestamp: new Date().toISOString(),
            analysisMethod: "llm_fallback",
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

      return intent;
    } catch (error) {
      const errorTime = Date.now() - startTime;
      this.logger.debug(`[PERF] LLM signal analysis failed after ${errorTime}ms: ${error}`, {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
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

      const selectedJobMatch = await this.selectJobForSignal(signal, payload, signalData);
      const selectedJob = selectedJobMatch?.job;
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
        sessionId: crypto.randomUUID(), // Will be overridden by session worker
        workspaceId: this.workspace?.id || "unknown",
        signal,
        payload,
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
          evaluation: selectedJob?.session_prompts?.evaluation || this.config.prompts?.evaluation ||
            "",
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
  private async selectJobForSignal(
    signal: IWorkspaceSignal,
    payload: any,
    signalData?: { signalConfig?: any; jobs?: any },
  ): Promise<{ job: any; trigger: any } | null> {
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
        jobsSourceUsed: signalData?.jobs
          ? "signalData"
          : (this.mergedConfig?.jobs ? "mergedConfig" : "none"),
      });

      // Find jobs that have triggers for this signal
      const matchingJobs: Array<{ job: any; trigger: any }> = [];

      for (const [_jobName, jobSpec] of Object.entries(availableJobs)) {
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

        const conditionResult = await this.evaluateJobCondition(trigger.condition, payload);
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
          // Store the current job match for session creation
          this.currentJobMatch = {
            job,
            trigger,
            evaluationResult: { matched: true },
            matchedAt: Date.now(),
          } as JobMatch;
          return { job, trigger };
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

  // Evaluate job condition against payload using ConditionEvaluatorRegistry
  private async evaluateJobCondition(
    condition: string | object | undefined,
    payload: any,
  ): Promise<boolean> {
    if (!condition) return true; // No condition means always match

    try {
      // Use the same ConditionEvaluatorRegistry as the JobTriggerMatcher
      const result = await this.jobTriggerMatcher.getConditionEvaluatorRegistry().evaluate(
        condition,
        payload,
      );

      this.logger.debug(`Job condition evaluation result`, {
        condition: typeof condition === "object" ? JSON.stringify(condition) : condition,
        payload: JSON.stringify(payload),
        matches: result.matches,
        confidence: result.confidence,
        evaluator: result.evaluator,
      });

      return result.matches;
    } catch (error) {
      this.log(
        `Error evaluating condition "${
          typeof condition === "object" ? JSON.stringify(condition) : condition
        }": ${error}`,
      );
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
    // Try to use cached plan from advanced planning first
    if (this.planningEngine) {
      try {
        const selectedJobMatch = await this.selectJobForSignal(signal, payload);
        const selectedJob = selectedJobMatch?.job;
        if (selectedJob) {
          this.log(`Using cached plan for job: ${selectedJob.name}`);
          const task = {
            id: `signal-${signal.id}-${Date.now()}`,
            description: `Execute ${selectedJob.name} for signal ${signal.id}`,
            context: {
              jobSpec: selectedJob,
              signal,
              payload,
              workspaceId: this.id,
            },
            agentType: "workspace" as const,
          };

          const planResult = await this.planningEngine.generatePlan(task);
          if (planResult.cached) {
            this.log(`Using cached execution plan (${planResult.method})`);
            return this.convertPlanToPlanFormat(planResult.plan, signal, payload);
          }
        }
      } catch (error) {
        this.log(`Advanced planning failed, falling back: ${error}`);
      }
    }

    // Use enhanced signal analysis as fallback
    try {
      const enhancedResult = await this.analyzeSignalEnhanced(signal, payload);

      if (enhancedResult.enhancedTask) {
        // Create plan based on enhanced task
        return this.createEnhancedPlan(
          signal,
          payload,
          enhancedResult.intent,
          enhancedResult.enhancedTask,
        );
      }
    } catch (error) {
      this.logger.warn("Enhanced plan generation failed, falling back to legacy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Final fallback to legacy plan generation
    const intent = this.createSessionIntent(signal, payload);
    return this.getDefaultPlan(signal, payload, intent);
  }

  // Convert planning engine result to SessionPlan format
  private convertPlanToPlanFormat(plan: any, signal: IWorkspaceSignal, payload: any): SessionPlan {
    const intent = this.createSessionIntent(signal, payload);

    return {
      intentId: intent.id,
      phases: [{
        id: "advanced-planned-phase",
        name: plan.description || "Advanced Planned Execution",
        agents: plan.steps?.map((step: any, index: number) => ({
          agentId: step.agent || "local-assistant",
          task: step.description || `Step ${index + 1}`,
          expectedOutputs: step.outputs || ["result"],
        })) || [{
          agentId: "local-assistant",
          task: "Execute planned action",
        }],
        executionStrategy: plan.strategy || "sequential",
      }],
      estimatedDuration: plan.estimatedDuration || 120000,
      reasoning: `Advanced planning generated: ${plan.reasoning || plan.method}`,
    };
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
    _signal: IWorkspaceSignal,
    _payload: any,
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
    _initialPayload: any,
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
    const [cmd] = command.slice(1).split(" ");

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

  // Create enhanced execution plan from task
  private createEnhancedPlan(
    signal: IWorkspaceSignal,
    payload: any,
    intent: SessionIntent,
    task: EnhancedTask,
  ): SessionPlan {
    // Determine agent to use from intent
    const selectedAgent = intent.suggestedAgents?.[0] || "local-assistant";

    return {
      intentId: intent.id,
      phases: [
        {
          id: "enhanced-execution",
          name: task.description,
          agents: [
            {
              agentId: selectedAgent,
              task:
                `${task.action.type} ${task.action.target.type} ${task.action.target.identifier}: ${task.data.issue.description}`,
              expectedOutputs: ["task_result"],
            },
          ],
          executionStrategy: "sequential",
        },
      ],
      estimatedDuration: this.estimateExecutionTime(task.estimatedComplexity),
      reasoning:
        `Enhanced processing identified ${task.data.issue.type} requiring ${task.action.type} action by ${selectedAgent}`,
    };
  }

  // Estimate execution time based on complexity
  private estimateExecutionTime(complexity: string): number {
    switch (complexity) {
      case "simple":
        return 60000; // 1 minute
      case "moderate":
        return 180000; // 3 minutes
      case "complex":
        return 300000; // 5 minutes
      default:
        return 120000; // 2 minutes
    }
  }

  // Create signal processing configuration from workspace settings
  private createSignalProcessingConfig(): SignalProcessingConfig {
    // Default patterns for generic signal types - platform-agnostic
    const defaultPatterns = [
      {
        name: "high_severity_warning",
        domain: "general",
        triggers: [
          { field: "severity", value: "Warning" },
          { field: "event.type", value: "Warning" },
          { field: "level", value: "warning" },
        ],
        category: "warning",
        severity: "medium" as const,
        actionType: "investigate" as const,
        urgency: 6,
        entityExtraction: [
          { name: "resource_name", field: "object.name" },
          { name: "resource_type", field: "object.type" },
          { name: "message", field: "event.message" },
        ],
      },
      {
        name: "critical_failure",
        domain: "infrastructure",
        triggers: [
          { field: "event.reason", value: "Failed" },
          { field: "status", value: "error" },
          { field: "severity", value: "Critical" },
        ],
        category: "critical_error",
        severity: "high" as const,
        actionType: "fix" as const,
        urgency: 9,
        entityExtraction: [
          { name: "resource_name", field: "object.name", required: true },
          { name: "scope", field: "scope", required: false },
          { name: "error_reason", field: "event.reason", required: true },
          { name: "resource_type", field: "object.type" },
        ],
      },
    ];

    // Default task templates - platform-agnostic
    const defaultTemplates = [
      {
        name: "fix_infrastructure_issue",
        descriptionTemplate: "Fix {error_reason} for {resource_type} {resource_name} in {scope}",
        actionType: "fix",
        complexity: "moderate" as const,
        requiredCapabilities: ["infrastructure", "fix"],
        dataExtraction: {
          requiredFields: ["resource_name", "error_reason"],
          optionalFields: ["scope", "resource_type"],
          transformations: {},
        },
      },
      {
        name: "investigate_warning",
        descriptionTemplate: "Investigate {resource_type} {resource_name} warning",
        actionType: "investigate",
        complexity: "simple" as const,
        requiredCapabilities: ["general", "investigate"],
        dataExtraction: {
          requiredFields: ["resource_name", "message"],
          optionalFields: ["resource_type", "scope"],
          transformations: {},
        },
      },
    ];

    // Default agent routing rules - platform-agnostic
    const defaultRouting = [
      {
        capability: "infrastructure",
        preferredAgents: ["local-assistant"],
        fallbackAgents: [],
      },
      {
        capability: "fix",
        preferredAgents: ["local-assistant"],
        fallbackAgents: [],
      },
      {
        capability: "investigate",
        preferredAgents: ["local-assistant"],
        fallbackAgents: [],
      },
      {
        capability: "general",
        preferredAgents: ["local-assistant"],
        fallbackAgents: [],
      },
    ];

    return {
      patterns: defaultPatterns,
      taskTemplates: defaultTemplates,
      agentRouting: defaultRouting,
    };
  }

  // Enhanced analyzeSignal method using signal processor
  async analyzeSignalEnhanced(
    signal: IWorkspaceSignal,
    payload: any,
  ): Promise<{ intent: SessionIntent; enhancedTask?: EnhancedTask }> {
    const startTime = Date.now();

    try {
      // Get available agents
      const availableAgents: AgentInfo[] = this.getAllAgentMetadata().map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        metadata: agent,
      }));

      // Process signal through enhanced pipeline
      const processingResult = await this.signalProcessor.processSignal(payload, availableAgents);

      // Create session intent from enhanced task
      const intent: SessionIntent = {
        id: crypto.randomUUID(),
        signal: {
          type: signal.id,
          data: payload,
          metadata: {
            provider: signal.provider.name,
            timestamp: new Date().toISOString(),
            enhancedTask: processingResult.task,
          },
        },
        goals: [processingResult.task.description],
        constraints: {
          timeLimit: 300000, // 5 minutes default
        },
        suggestedAgents: processingResult.selectedAgent
          ? [processingResult.selectedAgent.id]
          : availableAgents.map((a) => a.id),
        executionHints: {
          strategy: "deterministic",
          parallelism: false,
          maxIterations: 3,
        },
        userPrompt: this.createEnhancedUserPrompt(processingResult.task),
      };

      const processingTime = Date.now() - startTime;
      this.logger.info("Enhanced signal analysis completed", {
        processingTime,
        taskDescription: processingResult.task.description,
        selectedAgent: processingResult.selectedAgent?.id,
        priority: processingResult.task.priority,
      });

      return { intent, enhancedTask: processingResult.task };
    } catch (error) {
      this.logger.warn("Enhanced signal processing failed, falling back to legacy", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to legacy analysis
      const intent = await this.analyzeSignal(signal, payload);
      return { intent };
    }
  }

  // Create enhanced user prompt from task
  private createEnhancedUserPrompt(task: EnhancedTask): string {
    return `Task: ${task.description}

Action Required: ${task.action.type}
Target: ${task.action.target.type} "${task.action.target.identifier}"

Issue Details:
- Type: ${task.data.issue.type}
- Description: ${task.data.issue.description}
- Priority: ${task.priority}/10
- Complexity: ${task.estimatedComplexity}

Context:
- Environment: ${task.data.context.environment}
- Source: ${task.data.context.source}
- Timestamp: ${task.data.context.timestamp}

Required Capabilities: ${task.requiredCapabilities.join(", ")}

Please ${task.action.type} the ${task.action.target.type} based on the provided information.`;
  }

  // Cleanup method
  destroy(): void {
    this.log("Shutting down WorkspaceSupervisor state machine");
    this.stateActor.stop();
  }
}
