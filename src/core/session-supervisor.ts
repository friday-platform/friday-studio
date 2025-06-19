import type { IWorkspaceSignal } from "../types/core.ts";
import { AgentSupervisor, type SupervisedAgentResult } from "./agent-supervisor.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { type AtlasMemoryConfig } from "./memory-config.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./memory/coala-memory.ts";
import { FactExtractor } from "./memory/fact-extractor.ts";
import { KnowledgeGraphManager } from "./memory/knowledge-graph.ts";
import { KnowledgeGraphLocalStorageAdapter } from "../storage/knowledge-graph-local.ts";
import { logger } from "../utils/logger.ts";
import type { TriggerSpecification } from "./config-loader.ts";
import { AtlasConfigLoader, type AtlasSupervisionConfig } from "./atlas-config-loader.ts";
import { SupervisionLevel } from "./caching/supervision-cache.ts";
import { getSupervisionConfig } from "./supervision-levels.ts";
import {
  type StreamingMemoryConfig,
  StreamingMemoryManager,
} from "./memory/streaming/streaming-memory-manager.ts";
import { ContextProvisioner } from "./context/context-provisioner.ts";

// Job specification types
export interface JobSpecification {
  name: string;
  description: string;
  triggers?: JobTrigger[]; // Signal triggers that activate this job
  session_prompts?: {
    planning?: string;
    evaluation?: string;
  };
  execution: JobExecution;
  success_criteria?: Record<string, any>;
  error_handling?: {
    max_retries?: number;
    retry_delay_seconds?: number;
    timeout_seconds?: number;
  };
  resources?: {
    estimated_duration_seconds?: number;
    max_memory_mb?: number;
    required_capabilities?: string[];
  };
}

export interface JobTrigger {
  signal: string;
  condition?: string | object;
  naturalLanguageCondition?: string;
}

export interface JobExecution {
  strategy: "sequential" | "parallel" | "conditional" | "staged";
  agents: JobAgentSpec[];
  stages?: JobStage[];
  context?: {
    filesystem?: {
      patterns: string[];
      base_path?: string;
      max_file_size?: number;
      include_content?: boolean;
    };
    [key: string]: any;
  };
}

export interface JobAgentSpec {
  id: string;
  mode?: string; // For agents that have multiple modes (e.g., "load", "store")
  prompt?: string;
  config?: Record<string, any>;
  input?: Record<string, any>;
  input_source?: "signal" | "previous" | "combined" | "filesystem_context"; // Source of input for the agent
}

export interface JobStage {
  name: string;
  strategy: "sequential" | "parallel";
  agents: JobAgentSpec[];
}

// Agent type definitions
export type AgentType = "tempest" | "llm" | "remote";

export interface TempestAgentConfig {
  type: "tempest";
  agent: string; // Catalog reference
  version: string;
  config?: Record<string, any>;
}

export interface LLMAgentConfig {
  type: "llm";
  provider?: "anthropic" | "openai" | "google"; // Optional, defaults to "anthropic"
  model: string;
  purpose: string;
  tools?: string[];
  prompts?: {
    system?: string;
    [key: string]: string | undefined;
  };
  // MCP integration fields
  mcp_servers?: string[]; // References to MCP servers
  max_steps?: number; // For multi-step tool calling
  tool_choice?: "auto" | "required" | "none" | { type: "tool"; toolName: string }; // Tool choice control
}

export interface RemoteAgentConfig {
  type: "remote";
  protocol: "acp" | "a2a" | "custom" | "mcp";
  endpoint: string;
  purpose?: string;
  auth?: {
    type: "bearer" | "api_key" | "basic" | "none";
    token_env?: string;
    token?: string;
    api_key_env?: string;
    api_key?: string;
    header?: string;
    username?: string;
    password?: string;
  };
  timeout?: number;
  schema?: {
    validate_input?: boolean;
    validate_output?: boolean;
    input?: Record<string, any>;
    output?: Record<string, any>;
  };
  acp?: {
    agent_name: string;
    default_mode?: "sync" | "async" | "stream";
    timeout_ms?: number;
    max_retries?: number;
    health_check_interval?: number;
  };
  a2a?: Record<string, any>;
  custom?: Record<string, any>;
  mcp?: {
    timeout_ms?: number;
    allowed_tools?: string[];
    denied_tools?: string[];
  };
  validation?: {
    test_execution?: boolean;
    timeout_ms?: number;
  };
  monitoring?: {
    enabled?: boolean;
    circuit_breaker?: {
      failure_threshold?: number;
      timeout_ms?: number;
      half_open_max_calls?: number;
    };
  };
}

export type AgentConfig =
  | TempestAgentConfig
  | LLMAgentConfig
  | RemoteAgentConfig;

// Session-specific context provided by WorkspaceSupervisor
export interface SessionContext {
  sessionId: string;
  workspaceId: string;
  signal: IWorkspaceSignal;
  payload: any;
  availableAgents: AgentMetadata[];
  filteredMemory: any[];
  jobSpec?: JobSpecification; // Job specification to execute
  executionSequence?: number; // Track execution order for working memory
  constraints?: {
    timeLimit?: number;
    costLimit?: number;
  };
  // Additional prompts to layer onto the session
  additionalPrompts?: {
    signal?: string; // Signal-specific prompt
    session?: string; // Session-specific prompt
    evaluation?: string; // Evaluation-specific prompt
  };
}

export type AgentMetadata =
  & {
    id: string;
    name: string;
    purpose: string;
    capabilities?: string[];
  }
  & (
    | { type: "tempest"; config: TempestAgentConfig }
    | { type: "llm"; config: LLMAgentConfig }
    | { type: "remote"; config: RemoteAgentConfig }
  );

export interface ExecutionPlan {
  id: string;
  sessionId: string;
  phases: ExecutionPhase[];
  successCriteria: string[];
  adaptationStrategy: "rigid" | "flexible" | "exploratory";
}

export interface ExecutionPhase {
  id: string;
  name: string;
  agents: AgentTask[];
  executionStrategy: "sequential" | "parallel";
  continueCondition?: string;
}

export interface AgentTask {
  agentId: string;
  task: string;
  inputSource: "signal" | "previous" | "combined" | "filesystem_context";
  dependencies?: string[];
  mode?: string; // For agents with multiple modes
  config?: Record<string, any>; // Agent-specific configuration
}

export interface AgentResult {
  agentId: string;
  task: string;
  input: any;
  output: any;
  duration: number;
  timestamp: string;
}

export class SessionSupervisor extends BaseAgent {
  protected sessionContext: SessionContext | null = null;
  private executionPlan: ExecutionPlan | null = null;
  private executionResults: AgentResult[] = [];
  private agentSupervisor!: AgentSupervisor;
  private sessionMemoryManager: CoALAMemoryManager;
  private memoryConfig: AtlasMemoryConfig; // Store for AgentSupervisor
  private factExtractor?: FactExtractor;
  private knowledgeGraph?: KnowledgeGraphManager;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;
  private streamingMemory?: StreamingMemoryManager;
  private precomputedPlans: Record<string, any>; // Shared planning cache from WorkspaceSupervisor
  private contextProvisioner?: ContextProvisioner;

  constructor(
    memoryConfig: AtlasMemoryConfig,
    parentScopeId?: string,
    precomputedPlans?: Record<string, any>,
  ) {
    super(memoryConfig, parentScopeId);
    this.memoryConfig = memoryConfig; // Store for later use
    this.precomputedPlans = this.validateAndSanitizePlans(precomputedPlans || {}, parentScopeId); // Store shared plans

    // Override logger from BaseAgent with proper supervisor context
    this.logger = logger.createChildLogger({
      sessionId: this.id,
      workerType: "session-supervisor",
    });

    // Initialize session-scoped memory
    this.sessionMemoryManager = this.memoryConfigManager.getMemoryManager(this, "session");

    // Initialize knowledge graph and fact extractor for semantic memory
    this.initializeSemanticFactExtraction();

    // Enable advanced planning and reasoning for complex decision making
    this.enableAdvancedPlanning({
      cacheDir: Deno.cwd(),
      enableCaching: true,
      enablePatternMatching: true,
      reasoningConfig: {
        allowLLMSelection: true,
        defaultMethod: "react", // ReAct is good for session coordination with tool use
      },
    });

    // Set supervisor-specific prompts
    this.prompts = {
      system:
        `You are a Session Supervisor responsible for coordinating agent execution within a workspace session.
Your role is to:
1. Analyze incoming signals and their payloads
2. Create intelligent execution plans based on available agents
3. Coordinate agent execution and data flow
4. Evaluate results and adapt the plan if needed
5. Determine when the session goal has been achieved

You have access to a filtered view of the workspace tailored for this specific session.

You can use advanced reasoning methods to make complex decisions about agent coordination and execution strategies.`,
      user: "",
    };
  }

  name(): string {
    return "SessionSupervisor";
  }

  nickname(): string {
    return "Session Supervisor";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas";
  }

  purpose(): string {
    return "Intelligently coordinates agent execution within a session based on signals and goals";
  }

  controls(): object {
    return {
      canPlan: true,
      canCoordinate: true,
      canEvaluate: true,
      canAdapt: true,
    };
  }

  override getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  getSessionContext(): SessionContext | null {
    return this.sessionContext;
  }

  // Initialize AgentSupervisor for supervised execution
  initializeAgentSupervisor(agentSupervisorConfig: any): void {
    this.agentSupervisor = new AgentSupervisor(agentSupervisorConfig, this.id);
    this.log("AgentSupervisor initialized for supervised agent execution");
  }

  // Initialize AgentSupervisor using atlas.yml configuration
  async initializeStreamingMemory(context: SessionContext): Promise<void> {
    try {
      const atlasConfigLoader = AtlasConfigLoader.getInstance();
      const atlasConfig = await atlasConfigLoader.loadConfiguration();

      // Load streaming memory configuration from atlas.yml
      const streamingMemoryConfig = (atlasConfig.memory as any)?.streaming || {};
      const streamingConfig: StreamingMemoryConfig = {
        queue_max_size: streamingMemoryConfig.queue_max_size || 1000,
        batch_size: streamingMemoryConfig.batch_size || 10,
        flush_interval_ms: streamingMemoryConfig.flush_interval_ms || 1000,
        background_processing: streamingMemoryConfig.background_processing ?? true,
        persistence_enabled: streamingMemoryConfig.persistence_enabled ?? true,
        error_retry_attempts: streamingMemoryConfig.error_retry_attempts || 3,
        priority_processing: streamingMemoryConfig.priority_processing ?? true,
        dual_write_enabled: streamingMemoryConfig.dual_write_enabled ?? true,
        legacy_batch_enabled: streamingMemoryConfig.legacy_batch_enabled ?? false,
        stream_everything: streamingMemoryConfig.stream_everything ?? true,
        performance_tracking: streamingMemoryConfig.performance_tracking ?? true,
      };

      // Initialize streaming memory manager
      this.streamingMemory = new StreamingMemoryManager(
        this.sessionMemoryManager,
        streamingConfig,
        {
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
        },
      );

      this.log("Streaming memory initialized");
    } catch (error) {
      this.logger.error("Failed to initialize streaming memory", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: context.sessionId,
      });
      // Don't fail session initialization if streaming memory fails
    }
  }

  async initializeContextProvisioner(context: SessionContext): Promise<void> {
    try {
      this.contextProvisioner = new ContextProvisioner({
        workspaceId: context.workspaceId,
      });

      // Initialize with workspace sources (empty for now - Phase 1)
      await this.contextProvisioner.initialize();

      this.log("Context provisioner initialized for EMCP-based context loading");
    } catch (error) {
      this.logger.error("Failed to initialize context provisioner", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: context.sessionId,
      });
      // Don't fail session initialization if context provisioner fails
    }
  }

  async initializeAgentSupervisorFromConfig(context: SessionContext): Promise<void> {
    try {
      const atlasConfigLoader = AtlasConfigLoader.getInstance();
      const atlasConfig = await atlasConfigLoader.loadConfiguration();
      const agentSupervisorConfig = atlasConfig.supervisors.agent;

      // Extract supervision configuration with defaults
      const supervisionConfig = (agentSupervisorConfig.supervision as AtlasSupervisionConfig) || {};

      // Set session supervision level for optimizations
      this.supervisionLevel = (supervisionConfig as any).level
        ? SupervisionLevel[
          (supervisionConfig as any).level.toUpperCase() as keyof typeof SupervisionLevel
        ]
        : SupervisionLevel.MINIMAL;

      this.logger.debug("Atlas config supervision settings", {
        supervisionConfig,
        level: (supervisionConfig as any).level,
        cache_enabled: (supervisionConfig as any).cache_enabled,
        sessionSupervisionLevel: this.supervisionLevel,
      });

      this.initializeAgentSupervisor({
        model: agentSupervisorConfig.model,
        memoryConfig: this.memoryConfig,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        supervisionLevel: ((supervisionConfig as any).level &&
          SupervisionLevel[
            (supervisionConfig as any).level.toUpperCase() as keyof typeof SupervisionLevel
          ]) || SupervisionLevel.MINIMAL,
        cacheEnabled: (supervisionConfig as any).cache_enabled !== false,
        prompts: agentSupervisorConfig.prompts,
      });

      this.log(
        `AgentSupervisor initialized with supervision level: ${
          (supervisionConfig as any).level || SupervisionLevel.MINIMAL
        }`,
      );
    } catch (error) {
      this.logger.error("Failed to load atlas config, using defaults", { error });

      // Fallback to minimal config for performance
      this.initializeAgentSupervisor({
        model: "claude-4-sonnet-20250514",
        memoryConfig: this.memoryConfig,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        supervisionLevel: SupervisionLevel.MINIMAL,
        cacheEnabled: true,
        prompts: {
          system: "You are an AgentSupervisor responsible for safe agent execution.",
        },
      });
    }
  }

  // Initialize session with context from WorkspaceSupervisor
  async initializeSession(context: SessionContext): Promise<void> {
    this.sessionContext = context;
    this.log(
      `Initializing session ${context.sessionId} for signal ${context.signal.id}`,
    );

    // Initialize AgentSupervisor for supervised execution using atlas.yml config
    await this.initializeAgentSupervisorFromConfig(context);

    // Initialize streaming memory for performance
    await this.initializeStreamingMemory(context);

    // Initialize context provisioner for EMCP-based context loading
    await this.initializeContextProvisioner(context);

    // Log shared precomputed plans received from WorkspaceSupervisor
    const planCount = Object.keys(this.precomputedPlans || {}).length;
    this.log(
      `Received ${planCount} precomputed plans from WorkspaceSupervisor: ${
        Object.keys(this.precomputedPlans || {}).join(", ") || "none"
      }`,
    );

    // Store session context in session-scoped memory
    this.memoryConfigManager.rememberWithScope(
      this.sessionMemoryManager,
      "sessionContext",
      context,
      CoALAMemoryType.CONTEXTUAL,
      "session",
      ["session", "context", "initialization"],
      0.9,
    );
  }

  // Validate and sanitize precomputed plans to prevent security issues
  private validateAndSanitizePlans(
    plans: Record<string, any>,
    expectedWorkspaceId?: string,
  ): Record<string, any> {
    const sanitizedPlans: Record<string, any> = {};

    for (const [key, plan] of Object.entries(plans)) {
      try {
        // Security: Validate plan key format to prevent injection
        if (!this.isValidPlanKey(key)) {
          this.log(`Invalid plan key format detected: ${key}`, "warn");
          continue;
        }

        // Security: Verify workspace scope if available
        if (
          expectedWorkspaceId && plan?.context?.workspaceId &&
          plan.context.workspaceId !== expectedWorkspaceId
        ) {
          this.log(
            `Plan workspace mismatch: expected ${expectedWorkspaceId}, got ${plan.context.workspaceId}`,
            "warn",
          );
          continue;
        }

        // Sanitize the plan data
        sanitizedPlans[key] = this.sanitizePlan(plan);
      } catch (error) {
        this.log(`Failed to validate plan ${key}: ${error}`, "warn");
      }
    }

    return sanitizedPlans;
  }

  // Validate plan key format to prevent injection attacks
  private isValidPlanKey(key: string): boolean {
    // Allow only alphanumeric, hyphens, underscores, and colons
    const validKeyPattern = /^[a-zA-Z0-9\-_:]+$/;
    return validKeyPattern.test(key) && key.length <= 256; // Reasonable length limit
  }

  // Sanitize individual plan to remove sensitive data
  private sanitizePlan(plan: any): any {
    if (!plan || typeof plan !== "object") {
      return plan;
    }

    const sanitized = { ...plan };

    // Remove sensitive fields
    const sensitiveFields = [
      "workspaceSecrets",
      "privateKeys",
      "authTokens",
      "apiKeys",
      "passwords",
      "credentials",
      "internalConfig",
      "debugInfo",
    ];

    for (const field of sensitiveFields) {
      delete sanitized[field];
    }

    // Sanitize nested objects recursively
    if (sanitized.context && typeof sanitized.context === "object") {
      sanitized.context = this.sanitizePlan(sanitized.context);
    }

    return sanitized;
  }

  // Create secure, workspace-scoped cache key to prevent collisions
  private createSecurePlanKey(jobName: string, workspaceId: string): string {
    // Include workspace ID to prevent cross-workspace collisions
    // Use deterministic format for consistent lookups
    return `plan:${workspaceId}:${jobName}`;
  }

  // Validate plan before execution to ensure security and compatibility
  private validatePlanForExecution(plan: any, sessionContext: SessionContext): boolean {
    try {
      // Verify plan structure
      if (!plan || typeof plan !== "object") {
        return false;
      }

      // Verify workspace context matches if available
      if (plan.context?.workspaceId && plan.context.workspaceId !== sessionContext.workspaceId) {
        this.log(
          `Plan workspace mismatch: plan=${plan.context.workspaceId}, session=${sessionContext.workspaceId}`,
          "warn",
        );
        return false;
      }

      // Verify plan hasn't been tampered with (basic integrity check)
      if (plan.phases && !Array.isArray(plan.phases)) {
        return false;
      }

      // Additional validations can be added here
      return true;
    } catch (error) {
      this.log(`Plan validation error: ${error}`, "warn");
      return false;
    }
  }

  // Create execution plan using advanced reasoning or job specification
  async createExecutionPlan(): Promise<ExecutionPlan> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    this.log(`[createExecutionPlan] Checking for precomputed plans and jobSpec...`);
    this.log(
      `[createExecutionPlan] SessionContext keys: ${
        Object.keys(
          this.sessionContext,
        ).join(", ")
      }`,
    );
    this.log(
      `[createExecutionPlan] JobSpec present: ${!!this.sessionContext.jobSpec}`,
    );
    if (this.sessionContext.jobSpec) {
      this.log(
        `[createExecutionPlan] JobSpec name: ${this.sessionContext.jobSpec.name}`,
      );
    }

    // STEP 1: Check for precomputed execution plans (fastest path - zero LLM calls)
    if (this.sessionContext.jobSpec) {
      const jobName = this.sessionContext.jobSpec.name;
      this.log(`Checking for precomputed plan for job: ${jobName}`);

      // Create secure, workspace-scoped cache key
      const secureKey = this.createSecurePlanKey(jobName, this.sessionContext.workspaceId);

      // Check the shared precomputed plans from WorkspaceSupervisor
      if (this.precomputedPlans && this.precomputedPlans[secureKey]) {
        const precomputedPlan = this.precomputedPlans[secureKey];
        this.log(`Using shared precomputed execution plan for: ${jobName} (zero LLM calls)`);

        // Additional security validation before use
        if (!this.validatePlanForExecution(precomputedPlan, this.sessionContext)) {
          this.log(
            `Security validation failed for plan ${secureKey}, falling back to runtime planning`,
            "warn",
          );
        } else {
          // Convert precomputed plan to ExecutionPlan format with session-specific data
          const sessionPlan = this.convertPrecomputedPlanToExecutionPlan(
            precomputedPlan,
            this.sessionContext,
          );

          this.executionPlan = sessionPlan;
          return sessionPlan;
        }
      } else {
        this.log(
          `No precomputed plan found for job: ${jobName} (key: ${secureKey}) in shared cache, falling back to runtime planning`,
        );
        this.log(
          `Available precomputed plans: ${
            Object.keys(this.precomputedPlans || {}).join(", ") || "none"
          }`,
        );
      }
    }

    // STEP 2: If we have a job specification, use it directly (fast path)
    if (this.sessionContext.jobSpec) {
      this.log(
        `Using job spec path for: ${this.sessionContext.jobSpec.name}`,
      );
      return this.createPlanFromJobSpec(this.sessionContext.jobSpec);
    }

    // Debug why jobSpec is missing
    this.log(
      `No jobSpec found - signal: ${this.sessionContext.signal.id}, context has: ${
        Object.keys(this.sessionContext).join(", ")
      }`,
    );

    // Use advanced reasoning for complex planning decisions
    if (this.planningEngine) {
      try {
        this.log("Using advanced reasoning for execution planning");
        return await this.createAdvancedReasoningPlan();
      } catch (error) {
        this.log(`Advanced reasoning failed: ${error}`);
      }
    }

    // Fallback to LLM-based planning
    this.log("Using LLM-based planning fallback");
    return await this.createLLMBasedPlan();
  }

  // Create execution plan from job specification
  private createPlanFromJobSpec(jobSpec: JobSpecification): ExecutionPlan {
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext!.sessionId,
      phases: [],
      successCriteria: this.extractSuccessCriteria(jobSpec),
      adaptationStrategy: "flexible",
    };

    if (jobSpec.execution.strategy === "sequential") {
      // Create single phase with sequential execution
      plan.phases.push({
        id: "main-phase",
        name: jobSpec.name,
        agents: jobSpec.execution.agents.map((agentSpec, index) => ({
          agentId: agentSpec.id,
          task: this.buildAgentTask(agentSpec, jobSpec),
          inputSource: agentSpec.input_source || (index === 0 ? "signal" : "previous"),
          dependencies: index > 0 ? [jobSpec.execution.agents[index - 1].id] : [],
          mode: agentSpec.mode,
          config: agentSpec.config,
        })),
        executionStrategy: "sequential",
      });
    } else if (
      jobSpec.execution.strategy === "staged" &&
      jobSpec.execution.stages
    ) {
      // Create multiple phases from stages
      jobSpec.execution.stages.forEach((stage, stageIndex) => {
        plan.phases.push({
          id: `stage-${stageIndex}`,
          name: stage.name,
          agents: stage.agents.map((agentSpec) => ({
            agentId: agentSpec.id,
            task: this.buildAgentTask(agentSpec, jobSpec),
            inputSource: agentSpec.input_source || (stageIndex === 0 ? "signal" : "previous"),
            dependencies: [],
            mode: agentSpec.mode,
            config: agentSpec.config,
          })),
          executionStrategy: stage.strategy,
        });
      });
    } else {
      // Parallel or other strategies
      plan.phases.push({
        id: "main-phase",
        name: jobSpec.name,
        agents: jobSpec.execution.agents.map((agentSpec) => ({
          agentId: agentSpec.id,
          task: this.buildAgentTask(agentSpec, jobSpec),
          inputSource: agentSpec.input_source || "signal",
          dependencies: [],
          mode: agentSpec.mode,
          config: agentSpec.config,
        })),
        executionStrategy: jobSpec.execution.strategy === "parallel" ? "parallel" : "sequential",
      });
    }

    this.executionPlan = plan;
    return plan;
  }

  // Convert precomputed plan to session-specific ExecutionPlan
  private convertPrecomputedPlanToExecutionPlan(
    precomputedPlan: import("./planning/planning-config.ts").PrecomputedPlan,
    sessionContext: SessionContext,
  ): ExecutionPlan {
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: sessionContext.sessionId,
      phases: [],
      successCriteria: [
        `Execute all ${precomputedPlan.steps.length} steps successfully`,
        "Follow precomputed execution plan",
        "Complete within estimated duration",
      ],
      adaptationStrategy: "rigid", // Precomputed plans are rigid
    };

    // Convert precomputed steps to session execution phases
    if (
      precomputedPlan.type === "static_sequential" || precomputedPlan.type === "static_parallel"
    ) {
      plan.phases.push({
        id: "precomputed-phase",
        name: `Precomputed ${precomputedPlan.jobName}`,
        agents: precomputedPlan.steps.map((step, index) => ({
          agentId: step.agentId,
          task: step.task,
          inputSource: step.inputSource === "memory"
            ? "combined"
            : step.inputSource as "signal" | "previous" | "combined",
          dependencies: step.dependencies,
          mode: step.mode,
          config: step.config,
        })),
        executionStrategy: precomputedPlan.type === "static_sequential" ? "sequential" : "parallel",
      });
    } else {
      // Handle other plan types like behavior_tree, htn, mcts
      this.log(`Converting complex precomputed plan type: ${precomputedPlan.type}`);
      // For now, convert to sequential execution - could be enhanced later
      plan.phases.push({
        id: "complex-precomputed-phase",
        name: `Complex ${precomputedPlan.jobName}`,
        agents: precomputedPlan.steps.map((step) => ({
          agentId: step.agentId,
          task: step.task,
          inputSource: step.inputSource === "memory"
            ? "combined"
            : step.inputSource as "signal" | "previous" | "combined",
          dependencies: step.dependencies,
          mode: step.mode,
          config: step.config,
        })),
        executionStrategy: "sequential", // Default for complex plans
      });
    }

    return plan;
  }

  // Build agent task from job specification
  private buildAgentTask(
    agentSpec: JobAgentSpec,
    jobSpec: JobSpecification,
  ): string {
    if (agentSpec.prompt) {
      return agentSpec.prompt;
    }
    return `Execute ${agentSpec.id} according to job specification: ${jobSpec.description}`;
  }

  // Extract success criteria from job specification
  private extractSuccessCriteria(jobSpec: JobSpecification): string[] {
    const criteria = [];

    if (jobSpec.success_criteria) {
      Object.entries(jobSpec.success_criteria).forEach(([key, value]) => {
        criteria.push(`${key}: ${value}`);
      });
    }

    // Default criteria
    criteria.push(
      `Execute all ${jobSpec.execution.agents.length} agents successfully`,
    );
    criteria.push("Produce meaningful outputs from each agent");

    return criteria;
  }

  // Create simplified execution plan for minimal supervision mode
  private createSimplifiedPlan(): ExecutionPlan {
    if (!this.sessionContext) {
      throw new Error("Session context not available");
    }

    // Create a simple sequential plan using all available agents
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext.sessionId,
      phases: [{
        id: "simple-phase",
        name: "Sequential Execution",
        agents: this.sessionContext.availableAgents.map((agent, index) => ({
          agentId: agent.id,
          task: `Process signal ${this.sessionContext!.signal.id}`,
          inputSource: index === 0 ? "signal" : "previous",
          dependencies: index > 0 ? [this.sessionContext!.availableAgents[index - 1].id] : [],
        })),
        executionStrategy: "sequential",
      }],
      successCriteria: ["Execute all agents", "Produce output"],
      adaptationStrategy: "rigid",
    };

    this.executionPlan = plan;
    return plan;
  }

  // Create execution plan using advanced reasoning methods
  private async createAdvancedReasoningPlan(): Promise<ExecutionPlan> {
    if (!this.planningEngine || !this.sessionContext) {
      throw new Error("Advanced planning not available");
    }

    // Create a planning task for the session
    const planningTask = {
      id: `session-plan-${this.sessionContext.sessionId}`,
      description: `Create execution plan for ${this.sessionContext.signal.id} signal`,
      context: {
        signal: this.sessionContext.signal,
        payload: this.sessionContext.payload,
        availableAgents: this.sessionContext.availableAgents,
        constraints: this.sessionContext.constraints,
      },
      agentType: "session" as const,
      complexity: this.determineTaskComplexity(),
      requiresToolUse: this.requiresToolUsage(),
      qualityCritical: this.isQualityCritical(),
    };

    // Generate plan using reasoning engine
    const planResult = await this.planningEngine.generatePlan(planningTask);

    this.log(
      `Generated plan using ${planResult.method} reasoning (confidence: ${planResult.confidence})`,
    );

    // Convert plan result to ExecutionPlan format
    return this.convertReasoningPlanToExecutionPlan(planResult.plan);
  }

  // Determine task complexity for reasoning method selection
  private determineTaskComplexity(): number {
    if (!this.sessionContext) return 1;

    let complexity = 1;

    // Add complexity for multiple agents
    if (this.sessionContext.availableAgents.length > 2) complexity += 1;

    // Add complexity for complex signal types
    if (this.sessionContext.signal.id.includes("complex")) complexity += 1;

    // Add complexity for large payloads
    if (JSON.stringify(this.sessionContext.payload).length > 1000) complexity += 1;

    // Add complexity for constraints
    if (
      this.sessionContext.constraints?.timeLimit &&
      this.sessionContext.constraints.timeLimit < 60000
    ) complexity += 1;

    return Math.min(complexity, 5);
  }

  // Check if task requires tool usage
  private requiresToolUsage(): boolean {
    if (!this.sessionContext) return false;

    // Check if any agents are remote or have tool configurations
    return this.sessionContext.availableAgents.some((agent) =>
      agent.type === "remote" ||
      (agent.config as any)?.tools?.length > 0
    );
  }

  // Check if task is quality critical
  private isQualityCritical(): boolean {
    if (!this.sessionContext) return false;

    // Signals containing "critical", "error", or "failure" are quality critical
    const criticalKeywords = ["critical", "error", "failure", "security", "production"];
    const signalText = this.sessionContext.signal.id.toLowerCase();
    const payloadText = JSON.stringify(this.sessionContext.payload).toLowerCase();

    return criticalKeywords.some((keyword) =>
      signalText.includes(keyword) || payloadText.includes(keyword)
    );
  }

  // Convert reasoning plan result to ExecutionPlan format
  private convertReasoningPlanToExecutionPlan(plan: any): ExecutionPlan {
    if (!this.sessionContext) {
      throw new Error("No session context available");
    }

    const executionPlan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext.sessionId,
      phases: [],
      successCriteria: plan.successCriteria || ["All agents executed successfully"],
      adaptationStrategy: plan.adaptationStrategy || "flexible",
    };

    // Convert plan steps to execution phases
    if (plan.steps && Array.isArray(plan.steps)) {
      executionPlan.phases.push({
        id: "reasoning-planned-phase",
        name: "Advanced Reasoning Execution",
        agents: plan.steps.map((step: any, index: number) => ({
          agentId: step.agentId ||
            this.sessionContext!
              .availableAgents[index % this.sessionContext!.availableAgents.length]?.id ||
            "local-assistant",
          task: step.description || step.task || `Step ${index + 1}`,
          inputSource: index === 0 ? "signal" : "previous",
          dependencies: index > 0 ? [plan.steps[index - 1].agentId] : [],
        })),
        executionStrategy: plan.strategy === "parallel" ? "parallel" : "sequential",
      });
    } else {
      // Fallback: create simple sequential plan
      executionPlan.phases.push({
        id: "simple-phase",
        name: "Sequential Execution",
        agents: this.sessionContext.availableAgents.map((agent, index) => ({
          agentId: agent.id,
          task: `Process with ${agent.name}`,
          inputSource: index === 0 ? "signal" : "previous",
          dependencies: index > 0 ? [this.sessionContext!.availableAgents[index - 1].id] : [],
        })),
        executionStrategy: "sequential",
      });
    }

    this.executionPlan = executionPlan;
    return executionPlan;
  }

  // Fallback LLM-based planning for backward compatibility
  private async createLLMBasedPlan(): Promise<ExecutionPlan> {
    // Use simplified planning in minimal supervision mode
    if (this.supervisionLevel === SupervisionLevel.MINIMAL) {
      this.log("Using simplified planning (minimal supervision mode)");
      return this.createSimplifiedPlan();
    }

    const planPrompt = `Given the following session context, create an execution plan:

Signal: ${this.sessionContext!.signal.id}
Signal Provider: ${this.sessionContext!.signal.provider.name}
Payload: ${JSON.stringify(this.sessionContext!.payload, null, 2)}

Available Agents:
${
      this.sessionContext!.availableAgents.map(
        (a) =>
          `- ${a.id}: ${a.purpose}${
            a.capabilities ? "\n  Capabilities: " + a.capabilities.join(", ") : ""
          }`,
      ).join("\n")
    }

${this.sessionContext!.additionalPrompts?.signal || ""}
${this.sessionContext!.additionalPrompts?.session || ""}

Create an execution plan that:
1. Identifies which agents to use and in what order
2. Determines how data should flow between agents
3. Defines success criteria for the session
4. Specifies if the plan should be rigid or adaptive

For a telephone game, agents should transform the message sequentially.
For data processing, agents might work in parallel.
For complex tasks, multiple phases might be needed.

Respond with a structured plan.`;

    try {
      const response = await this.generateLLM(
        "claude-3-5-sonnet-20241022",
        this.prompts.system,
        planPrompt,
        true,
        {
          operation: "create_execution_plan",
          sessionId: this.sessionContext?.sessionId,
          signalType: this.sessionContext?.signal.id,
        },
      );

      // Parse the LLM response into ExecutionPlan
      return this.parseExecutionPlan(response);
    } catch (error) {
      this.log(`Error creating execution plan: ${error}`);
      // Fallback to a simple sequential plan
      return this.createDefaultPlan();
    }
  }

  // Parse LLM response into structured ExecutionPlan
  private parseExecutionPlan(_llmResponse: string): ExecutionPlan {
    // For now, create a simple plan based on the response
    // In production, this would parse the structured output
    const plan: ExecutionPlan = {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext!.sessionId,
      phases: [],
      successCriteria: ["All agents have processed the input successfully"],
      adaptationStrategy: "flexible",
    };

    // Extract agent ordering from response
    const agents = this.sessionContext!.availableAgents;

    // For telephone game, create sequential phases
    if (this.sessionContext!.signal.id.includes("telephone")) {
      plan.phases.push({
        id: "telephone-phase",
        name: "Message Transformation",
        agents: agents.map((agent, index) => ({
          agentId: agent.id,
          task: `Transform the message using ${agent.name}`,
          inputSource: index === 0 ? "signal" : "previous",
          dependencies: index > 0 ? [agents[index - 1].id] : [],
        })),
        executionStrategy: "sequential",
      });

      // Update success criteria to be more specific for telephone game
      plan.successCriteria = [
        `All ${agents.length} agents must process the message in sequence`,
        "Each agent must transform the output of the previous agent",
        "The final output should be significantly different from the original",
      ];
    }

    this.executionPlan = plan;
    return plan;
  }

  // Create a default plan when LLM fails
  private createDefaultPlan(): ExecutionPlan {
    const agents = this.sessionContext!.availableAgents;

    return {
      id: crypto.randomUUID(),
      sessionId: this.sessionContext!.sessionId,
      phases: [
        {
          id: "default-phase",
          name: "Default Processing",
          agents: agents.map((agent) => ({
            agentId: agent.id,
            task: `Process signal with ${agent.id}`,
            inputSource: "signal",
            dependencies: [],
          })),
          executionStrategy: "sequential",
        },
      ],
      successCriteria: ["All agents executed"],
      adaptationStrategy: "rigid",
    };
  }

  // Evaluate execution progress using advanced reasoning
  async evaluateProgress(results: AgentResult[]): Promise<{
    isComplete: boolean;
    nextAction?: "continue" | "retry" | "adapt" | "escalate";
    feedback?: string;
  }> {
    // Try advanced reasoning first for complex evaluation
    if (this.planningEngine && this.shouldUseAdvancedReasoning(results)) {
      try {
        return await this.evaluateProgressWithReasoning(results);
      } catch (error) {
        this.log(`Advanced evaluation failed: ${error}`);
      }
    }

    // Fallback to standard LLM evaluation
    return await this.evaluateProgressWithLLM(results);
  }

  // Check if we should use advanced reasoning for evaluation
  private shouldUseAdvancedReasoning(results: AgentResult[]): boolean {
    // Use advanced reasoning for:
    // 1. Complex sessions with many agents
    if (results.length > 3) return true;

    // 2. Quality critical tasks
    if (this.isQualityCritical()) return true;

    // 3. When there are failures that need analysis
    const hasFailures = results.some((result) =>
      !result.output || JSON.stringify(result.output).includes("error")
    );
    if (hasFailures) return true;

    return false;
  }

  // Evaluate progress using advanced reasoning methods
  private async evaluateProgressWithReasoning(results: AgentResult[]): Promise<{
    isComplete: boolean;
    nextAction?: "continue" | "retry" | "adapt" | "escalate";
    feedback?: string;
  }> {
    if (!this.planningEngine || !this.sessionContext) {
      throw new Error("Advanced reasoning not available");
    }

    // Create an evaluation task
    const evaluationTask = {
      id: `evaluation-${this.sessionContext.sessionId}`,
      description: `Evaluate execution progress for session ${this.sessionContext.sessionId}`,
      context: {
        originalSignal: this.sessionContext.signal,
        originalPayload: this.sessionContext.payload,
        executionResults: results,
        executionPlan: this.executionPlan,
        successCriteria: this.executionPlan?.successCriteria || [],
      },
      agentType: "session" as const,
      complexity: 3, // Evaluation is moderately complex
      requiresToolUse: false,
      qualityCritical: true, // Evaluation is always quality critical
    };

    // Use reasoning engine to evaluate
    const evaluationResult = await this.planningEngine.generatePlan(evaluationTask);

    this.log(`Evaluated progress using ${evaluationResult.method} reasoning`);

    // Parse the reasoning result
    const evaluation = evaluationResult.plan;

    // Check execution count first
    const totalAgentsInPlan = this.executionPlan?.phases.reduce(
      (sum, phase) => sum + phase.agents.length,
      0,
    ) || 0;

    const agentsExecuted = results.length;

    if (agentsExecuted < totalAgentsInPlan) {
      return {
        isComplete: false,
        nextAction: "continue",
        feedback: `Advanced reasoning: ${agentsExecuted}/${totalAgentsInPlan} agents executed. ${
          evaluation.reasoning || "Continuing execution."
        }`,
      };
    }

    // All agents executed - evaluate quality
    const isComplete = evaluation.isComplete !== false; // Default to complete if not specified
    const nextAction = evaluation.nextAction || (isComplete ? undefined : "retry");

    return {
      isComplete,
      nextAction: nextAction as any,
      feedback: `Advanced reasoning evaluation: ${evaluation.reasoning || "Execution complete."}`,
    };
  }

  // Standard LLM-based evaluation (fallback)
  private async evaluateProgressWithLLM(results: AgentResult[]): Promise<{
    isComplete: boolean;
    nextAction?: "continue" | "retry" | "adapt" | "escalate";
    feedback?: string;
  }> {
    this.executionResults = results;

    if (!this.sessionContext || !this.executionPlan) {
      throw new Error("Session context or execution plan not available");
    }

    const evaluationPrompt = `Evaluate the execution progress:

Original Signal: ${this.sessionContext!.signal.id}
Payload: ${JSON.stringify(this.sessionContext!.payload)}

Execution Plan:
- Total agents to execute: ${
      this.executionPlan!.phases.reduce(
        (sum, phase) => sum + phase.agents.length,
        0,
      )
    }
- Agents executed so far: ${results.length}

Execution Results:
${
      results
        .map(
          (r) =>
            `Agent: ${r.agentId}\n   Task: ${r.task}\n   Input: ${
              JSON.stringify(
                r.input,
              ).slice(0, 100)
            }...\n   Output: ${
              JSON.stringify(r.output).slice(
                0,
                200,
              )
            }...\n   Duration: ${r.duration}ms`,
        )
        .join("\n\n")
    }

Success Criteria:
${this.executionPlan!.successCriteria.join("\n")}

Determine:
1. Have ALL success criteria been met? (NOT just some)
2. Is the session goal FULLY achieved?
3. Should we continue to the next agent, or is the session complete?

IMPORTANT: The session is ONLY complete when ALL planned agents have executed successfully.

${this.sessionContext?.additionalPrompts?.evaluation || ""}

Provide a brief evaluation.`;

    try {
      const response = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        evaluationPrompt,
        true,
        {
          operation: "evaluate_progress",
          sessionId: this.sessionContext?.sessionId,
          agentsExecuted: results.length,
        },
      );

      // First check: Have all agents from execution plan actually executed?
      const totalAgentsInPlan = this.executionPlan!.phases.reduce(
        (sum, phase) => sum + phase.agents.length,
        0,
      );
      const agentsExecuted = results.length;

      // If not all agents have executed, session cannot be complete regardless of LLM response
      if (agentsExecuted < totalAgentsInPlan) {
        return {
          isComplete: false,
          nextAction: "continue",
          feedback:
            `${agentsExecuted}/${totalAgentsInPlan} agents executed. Continuing with next agent. LLM evaluation: ${response}`,
        };
      }

      // All agents have executed - now check for quality/success via LLM
      const lowerResponse = response.toLowerCase();
      const hasFailures = lowerResponse.includes("failed") ||
        lowerResponse.includes("error") ||
        lowerResponse.includes("unsuccessful");

      return {
        isComplete: !hasFailures,
        nextAction: hasFailures ? "retry" : undefined,
        feedback: response,
      };
    } catch (error) {
      this.log(`Error evaluating progress: ${error}`);
      // Default to complete if all phases executed
      return {
        isComplete: results.length >= this.sessionContext!.availableAgents.length,
        feedback: "Evaluation completed based on execution count",
      };
    }
  }

  // Get execution summary for WorkspaceSupervisor
  // Get enhanced task description for an agent from the execution plan
  getEnhancedTaskDescription(agentId: string): string | null {
    if (!this.executionPlan) {
      return null;
    }

    // Search through phases to find the task for this agent
    for (const phase of this.executionPlan.phases) {
      const agentTask = phase.agents.find((agent) => agent.agentId === agentId);
      if (agentTask) {
        return agentTask.task;
      }
    }

    return null;
  }

  getExecutionSummary(): {
    plan: ExecutionPlan | null;
    results: AgentResult[];
    status: "planning" | "executing" | "completed" | "failed";
  } {
    let status: "planning" | "executing" | "completed" | "failed" = "planning";

    if (this.executionPlan && this.executionResults.length > 0) {
      const totalTasks = this.executionPlan.phases.reduce(
        (sum, phase) => sum + phase.agents.length,
        0,
      );

      if (this.executionResults.length >= totalTasks) {
        status = "completed";
      } else {
        status = "executing";
      }
    }

    return {
      plan: this.executionPlan,
      results: this.executionResults,
      status,
    };
  }

  // Execute agent with supervision through AgentSupervisor
  async executeAgent(
    agentId: string,
    task: AgentTask,
    input: any,
    context: Record<string, any> = {},
  ): Promise<SupervisedAgentResult> {
    if (!this.agentSupervisor) {
      throw new Error(
        "AgentSupervisor not initialized. Call initializeAgentSupervisor() first.",
      );
    }

    const agent = this.sessionContext!.availableAgents.find(
      (a) => a.id === agentId,
    );
    if (!agent) {
      throw new Error(`Agent ${agentId} not found in available agents`);
    }

    this.log(`Executing ${agent.type} agent: ${agentId} with supervision`);

    try {
      // Step 1: Analyze agent for safety and optimization
      const analysis = await this.agentSupervisor.analyzeAgent(
        agent,
        task,
        this.sessionContext!,
      );

      // Step 2: Prepare secure execution environment
      const environment = await this.agentSupervisor.prepareEnvironment(
        agent,
        analysis,
      );

      // Step 3: Load agent safely in worker
      const workerInstance = await this.agentSupervisor.loadAgentSafely(
        agent,
        environment,
      );

      // Step 4: Memory-Enhanced Prompt Preparation
      const memoryEnrichedTask = await this.enrichTaskWithMemory(agentId, task, input, context);

      // Step 5: Execute with supervision
      const supervision = {
        pre_execution_checks: [
          "safety_validation",
          "resource_check",
          "permission_verify",
        ],
        runtime_monitoring: {
          resource_usage: true,
          output_validation: true,
          safety_monitoring: analysis.safety_assessment.risk_level !== "low",
          timeout_enforcement: true,
        },
        post_execution_validation: {
          output_quality: true,
          success_criteria: true,
          security_compliance: true,
          format_validation: true,
        },
      };

      // Enrich input with working memory context
      const enrichedInput = this.buildInputWithWorkingMemory(input, agentId, task);

      const result = await this.agentSupervisor.executeAgentSupervised(
        workerInstance,
        enrichedInput,
        memoryEnrichedTask,
        supervision,
      );

      // Step 6: Stream agent result for immediate memory processing
      if (this.streamingMemory) {
        await this.streamingMemory.streamAgentResult(
          agentId,
          input,
          result.output,
          result.execution_metadata.duration || 0,
          result.validation.is_valid,
          {
            tokensUsed: (result.execution_metadata as any).tokens_used,
            error: result.validation.is_valid
              ? undefined
              : result.validation.issues?.[0]?.description,
            priority: "normal",
          },
        );
      }

      // Step 7: Record execution in working memory (legacy for dual-write)
      await this.recordExecutionInWorkingMemory(agentId, task, input, result, context);

      // Step 8: Clean up worker
      await this.agentSupervisor.terminateWorker(workerInstance.id);

      this.log(`Agent ${agentId} executed successfully with supervision`);
      return result;
    } catch (error) {
      this.log(`Supervised execution failed for agent ${agentId}: ${error}`, "error", {
        agentId,
        sessionId: this.id,
        errorType: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Supervised agent execution failed: ${error}`);
    }
  }

  // Record agent execution in working memory for current session
  private async recordExecutionInWorkingMemory(
    agentId: string,
    task: AgentTask,
    input: any,
    result: SupervisedAgentResult,
    context: Record<string, any>,
  ): Promise<void> {
    if (!this.sessionMemoryManager) {
      this.log("Warning: No memory manager available for working memory recording");
      return;
    }

    const executionRecord = {
      agentId,
      task: {
        description: task.task,
        agentId: task.agentId,
        inputSource: task.inputSource,
        mode: task.mode,
      },
      input,
      output: result.output,
      metadata: {
        execution_time: result.execution_metadata.duration,
        success: result.validation.is_valid,
        error: result.validation.issues,
        supervision_summary: result.supervision,
        timestamp: result.timestamp,
        context,
      },
      tools: result.analysis?.optimization_suggestions || [],
      session_id: this.sessionContext?.sessionId,
      sequence_number: (this.sessionContext?.executionSequence || 0) + 1,
    };

    // Increment execution sequence counter
    if (this.sessionContext) {
      this.sessionContext.executionSequence = executionRecord.sequence_number;
    }

    // Record in working memory with metadata
    if (this.sessionMemoryManager.rememberWithMetadata) {
      await this.sessionMemoryManager.rememberWithMetadata(
        `execution_${agentId}_${executionRecord.sequence_number}`,
        executionRecord,
        {
          memoryType: CoALAMemoryType.WORKING,
          tags: [
            "agent_execution",
            `agent:${agentId}`,
            `task:${task.task}`,
            result.validation.is_valid ? "success" : "failure",
            `session:${this.sessionContext?.sessionId}`,
          ],
          relevanceScore: 1.0, // High relevance for current session
          associations: [
            `agent:${agentId}`,
            `session:${this.sessionContext?.sessionId}`,
            `task:${task.task}`,
          ],
          confidence: result.validation.is_valid ? 0.9 : 0.7,
          // Working memory should decay quickly - set to 2 hours
          decayRate: 0.5,
        },
      );
    } else {
      // Fallback to legacy method
      this.sessionMemoryManager.remember(
        `execution_${agentId}_${executionRecord.sequence_number}`,
        executionRecord,
      );
    }

    this.log(
      `Recorded execution of ${agentId} in working memory (sequence: ${executionRecord.sequence_number})`,
    );
  }

  // Extract semantic facts from the entire session at completion
  private async extractSessionSemanticFacts(
    workingMemoryEntries: any[],
    sessionSummary: string,
  ): Promise<void> {
    if (!this.factExtractor || !this.sessionContext) {
      this.log("Warning: Cannot extract session facts - missing fact extractor or session context");
      return;
    }

    try {
      this.log(
        `Starting comprehensive fact extraction from session ${this.sessionContext.sessionId}`,
      );

      // Build comprehensive session context for fact extraction
      const sessionContent = this.buildSessionAnalysisContent(workingMemoryEntries, sessionSummary);

      // Extract facts from the comprehensive session using specialized method
      const extractionResult = await this.factExtractor.extractFactsFromSessionExecution(
        this.sessionContext.sessionId,
        this.sessionContext.signal,
        this.sessionContext.payload,
        workingMemoryEntries,
        sessionSummary,
        sessionContent,
      );

      if (extractionResult.extractedFacts.length > 0) {
        this.log(
          `Extracted ${extractionResult.extractedFacts.length} facts from complete session`,
          "info",
          {
            factsFound: extractionResult.analysisMetadata.factsFound,
            confidence: extractionResult.analysisMetadata.confidence,
            processingTime: extractionResult.analysisMetadata.processingTime,
          },
        );

        // Store extracted facts in session memory for immediate access
        await this.storeExtractedFactsInMemory(extractionResult.extractedFacts);
      } else {
        this.log("No significant facts extracted from session analysis");
      }
    } catch (error) {
      this.log(`Warning: Failed to extract facts from session: ${error}`);
      // Don't throw - fact extraction failure shouldn't break session completion
    }
  }

  // Build comprehensive session content for fact extraction analysis
  private buildSessionAnalysisContent(
    workingMemoryEntries: any[],
    sessionSummary: string,
  ): string {
    if (!this.sessionContext) {
      return "";
    }

    const executionChain = workingMemoryEntries
      .sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0))
      .map((entry) => {
        return `${entry.sequence_number}. Agent: ${entry.agentId}
   Task: ${entry.task?.description || entry.task || "Unknown task"}
   Input: ${this.summarizeData(entry.input, 300)}
   Output: ${this.summarizeData(entry.output, 300)}
   Success: ${entry.metadata?.success}
   Tools Used: ${entry.tools?.join(", ") || "none"}
   Duration: ${entry.metadata?.execution_time}ms`;
      }).join("\n\n");

    return `Session Comprehensive Analysis Context:
Session ID: ${this.sessionContext.sessionId}
Workspace ID: ${this.sessionContext.workspaceId}
Triggering Signal: ${this.sessionContext.signal.id}
Signal Provider: ${this.sessionContext.signal.provider?.name || "unknown"}
Original Signal Payload: ${this.summarizeData(this.sessionContext.payload, 500)}

Complete Agent Execution Chain (${workingMemoryEntries.length} executions):
${executionChain}

LLM-Generated Session Summary:
${sessionSummary}

Session Goals: ${
      this.executionPlan?.successCriteria.join(", ") || "Process signal through available agents"
    }
Overall Success: ${
      workingMemoryEntries.length > 0 && workingMemoryEntries.filter((e) =>
              e.metadata?.success
            ).length / workingMemoryEntries.length >= 0.7
    }`;
  }

  // Build input enriched with working memory context from current session
  private buildInputWithWorkingMemory(
    originalInput: any,
    agentId: string,
    task: AgentTask,
  ): any {
    if (!this.sessionMemoryManager || !this.sessionContext) {
      return originalInput;
    }

    try {
      // Check memory configuration: if session memory should not be included in context, pass clean input
      if (!this.memoryConfig.session.include_in_context) {
        this.log(
          `Passing clean input to ${agentId} due to memory config (session.include_in_context: false)`,
        );
        return originalInput;
      }

      // For sequential execution with "previous" input source,
      // DON'T add execution history context - pass clean input for telephone game behavior
      const currentAgentTask = this.executionPlan?.phases
        .find((phase) => phase.executionStrategy === "sequential")
        ?.agents.find((agent) => agent.agentId === agentId);

      const inputSource = currentAgentTask?.inputSource;
      const shouldPassCleanInput = inputSource === "previous";

      // For filesystem_context input source, enhance with signal type information
      if (inputSource === "filesystem_context") {
        this.log(
          `Providing filesystem analysis context to ${agentId}`,
        );
        return {
          ...originalInput,
          analysis_type: agentId.includes("performance")
            ? "performance"
            : agentId.includes("dx")
            ? "developer_experience"
            : agentId.includes("architecture")
            ? "architecture"
            : "comprehensive",
          signal_context: {
            signal_id: this.sessionContext.signal.id,
            signal_type: this.sessionContext.signal.provider?.name,
            triggered_at: new Date().toISOString(),
          },
        };
      }

      if (shouldPassCleanInput) {
        this.log(
          `Passing clean input to ${agentId} for sequential execution (inputSource: ${inputSource})`,
        );
        return originalInput;
      }

      // Query working memory for current session executions
      let workingMemoryContext: any[] = [];

      if (this.sessionMemoryManager.queryMemories) {
        // Use CoALA advanced query
        workingMemoryContext = this.sessionMemoryManager.queryMemories({
          memoryType: CoALAMemoryType.WORKING,
          tags: [`session:${this.sessionContext.sessionId}`],
          limit: 10,
        });
      } else {
        // Fallback: Get all keys and filter for session executions
        const allKeys = Object.keys(this.sessionMemoryManager as any);
        workingMemoryContext = allKeys
          .filter((key) => key.startsWith("execution_"))
          .map((key) => this.sessionMemoryManager!.recall(key))
          .filter((record) => record && record.session_id === this.sessionContext!.sessionId)
          .sort((a, b) => (b.sequence_number || 0) - (a.sequence_number || 0))
          .slice(0, 10);
      }

      // Build execution history for context (simplified to reduce noise)
      const executionHistory = workingMemoryContext.slice(0, 3).map((record) => ({
        agent: record.agentId,
        task: record.task?.description || "unknown task",
        success: record.metadata?.success,
        sequence: record.sequence_number,
      }));

      // Enrich the input with working memory context (simplified)
      const enrichedInput = {
        ...originalInput,
        _atlas_context: {
          session_id: this.sessionContext.sessionId,
          task: task.task,
          previous_executions: executionHistory,
        },
      };

      this.log(`Enriched input for ${agentId} with ${executionHistory.length} previous executions`);
      return enrichedInput;
    } catch (error) {
      this.log(`Warning: Failed to build working memory context: ${error}`);
      return originalInput;
    }
  }

  // Helper method to summarize data for context
  private summarizeData(data: any, maxLength: number = 200): string {
    if (!data) return "";

    const jsonStr = JSON.stringify(data);
    if (jsonStr.length <= maxLength) {
      return jsonStr;
    }

    return jsonStr.substring(0, maxLength - 3) + "...";
  }

  // Generate an intelligent summary of the session results
  async generateSessionSummary(phaseResults: any[]): Promise<string> {
    if (!this.sessionContext) {
      return "No session context available for summary.";
    }

    // Skip expensive LLM summary generation in minimal supervision mode
    if (this.supervisionLevel === SupervisionLevel.MINIMAL) {
      const allResults = phaseResults.flatMap((phase) => phase.results);
      return `Session completed with ${allResults.length} agent executions. Signal: ${this.sessionContext.signal.id}. Results: ${
        allResults.map((r) => `${r.agentId} (${r.duration}ms)`).join(", ")
      }.`;
    }

    const allResults = phaseResults.flatMap((phase) => phase.results);

    const summaryPrompt = `Summarize this session execution:

Signal: ${this.sessionContext.signal.id}
Original Input: ${JSON.stringify(this.sessionContext.payload)}

Agent Execution Chain:
${
      allResults
        .map(
          (r, i) =>
            `${i + 1}. ${r.agentId}:\n   Input: ${
              JSON.stringify(r.input).slice(
                0,
                100,
              )
            }...\n   Output: ${r.output}\n   Duration: ${r.duration}ms`,
        )
        .join("\n\n")
    }

Session Goals: ${
      this.executionPlan?.successCriteria.join(", ") ||
      "Process signal through agents"
    }

Provide a concise but informative summary that:
1. Describes what happened in the session
2. Highlights key transformations or results
3. Notes whether the session goals were achieved
4. Mentions any interesting patterns or observations

Keep the summary focused and relevant to the specific use case.`;

    try {
      const summary = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        summaryPrompt,
        true,
        {
          operation: "generate_session_summary",
          sessionId: this.sessionContext?.sessionId,
          resultsCount: allResults.length,
        },
      );

      return summary;
    } catch (error) {
      this.log(`Error generating summary: ${error}`);
      return `Session completed with ${allResults.length} agent executions. Unable to generate AI summary.`;
    }
  }

  // Initialize semantic fact extraction components
  private initializeSemanticFactExtraction(): void {
    try {
      // Initialize knowledge graph
      const basePath = `./.atlas/memory/knowledge-graph`;
      const kgStorageAdapter = new KnowledgeGraphLocalStorageAdapter(basePath);
      this.knowledgeGraph = new KnowledgeGraphManager(kgStorageAdapter, this.id);

      // Initialize fact extractor
      this.factExtractor = new FactExtractor(
        this.memoryConfig,
        this.knowledgeGraph,
        this.id,
        this.id,
      );

      this.log("Initialized semantic fact extraction components");
    } catch (error) {
      this.log(`Warning: Failed to initialize semantic fact extraction: ${error}`);
    }
  }

  // Extract facts from signal and store in semantic memory
  async extractAndStoreSemanticFacts(): Promise<void> {
    if (!this.sessionContext || !this.factExtractor) {
      this.log("Warning: Cannot extract semantic facts - missing context or fact extractor");
      return;
    }

    try {
      this.log(`Starting semantic fact extraction from signal: ${this.sessionContext.signal.id}`);

      // Extract facts from the signal that triggered this session
      const extractionResult = await this.factExtractor.extractFactsFromSignal(
        this.sessionContext.signal,
        this.sessionContext.payload,
      );

      // Log extraction results
      this.log(
        `Extracted ${extractionResult.extractedFacts.length} semantic facts from signal`,
        "info",
        {
          signalId: extractionResult.analysisMetadata.signalId,
          factsFound: extractionResult.analysisMetadata.factsFound,
          confidence: extractionResult.analysisMetadata.confidence,
          processingTime: extractionResult.analysisMetadata.processingTime,
        },
      );

      // Store facts in session memory as well for immediate access
      if (extractionResult.extractedFacts.length > 0) {
        await this.storeExtractedFactsInMemory(extractionResult.extractedFacts);
      }

      this.log(`Successfully processed semantic facts for signal ${this.sessionContext.signal.id}`);
    } catch (error) {
      this.log(`Error extracting semantic facts from signal: ${error}`);
    }
  }

  // Store extracted facts in session memory for immediate access
  private async storeExtractedFactsInMemory(extractedFacts: any[]): Promise<void> {
    for (const fact of extractedFacts) {
      const factKey = `semantic_fact_${crypto.randomUUID()}`;

      if (this.sessionMemoryManager.rememberWithMetadata) {
        await this.sessionMemoryManager.rememberWithMetadata(
          factKey,
          fact,
          {
            memoryType: CoALAMemoryType.SEMANTIC,
            tags: [
              "extracted_fact",
              `signal:${this.sessionContext?.signal.id}`,
              `type:${fact.type}`,
              "workspace_knowledge",
            ],
            relevanceScore: fact.confidence,
            associations: [
              `signal:${this.sessionContext?.signal.id}`,
              `workspace:${this.sessionContext?.workspaceId}`,
            ],
            confidence: fact.confidence,
            decayRate: 0.05, // Very slow decay for semantic facts
          },
        );
      } else {
        this.sessionMemoryManager.remember(factKey, fact);
      }
    }
  }

  // Generate session working memory summary for episodic storage
  async generateWorkingMemorySummary(): Promise<void> {
    if (!this.sessionContext || !this.sessionMemoryManager) {
      this.log(
        "Warning: Cannot generate working memory summary - missing context or memory manager",
      );
      return;
    }

    // Skip expensive memory consolidation in minimal supervision mode
    if (this.supervisionLevel === SupervisionLevel.MINIMAL) {
      this.log("Skipping working memory consolidation (minimal supervision mode)");
      return;
    }

    try {
      // Query all working memory for this session
      let workingMemoryEntries: any[] = [];

      if (this.sessionMemoryManager.queryMemories) {
        workingMemoryEntries = this.sessionMemoryManager.queryMemories({
          memoryType: CoALAMemoryType.WORKING,
          tags: [`session:${this.sessionContext.sessionId}`],
          limit: 100, // Get all entries for complete summary
        });
      } else {
        // Fallback method
        const allKeys = Object.keys(this.sessionMemoryManager as any);
        workingMemoryEntries = allKeys
          .filter((key) => key.startsWith("execution_"))
          .map((key) => this.sessionMemoryManager!.recall(key))
          .filter((record) => record && record.session_id === this.sessionContext!.sessionId)
          .sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0));
      }

      // Build detailed working memory context for LLM analysis
      const workingMemoryContext = workingMemoryEntries.map((entry) => ({
        sequence: entry.sequence_number,
        agent: entry.agentId,
        task: entry.task?.description,
        input_summary: this.summarizeData(entry.input, 150),
        output_summary: this.summarizeData(entry.output, 150),
        success: entry.metadata?.success,
        execution_time: entry.metadata?.execution_time,
        tools_used: entry.tools || [],
        timestamp: entry.metadata?.timestamp,
      }));

      // Generate LLM-based summary of working memory
      const summaryPrompt =
        `Analyze and summarize this session's working memory for episodic storage:

Session Information:
- Session ID: ${this.sessionContext.sessionId}
- Workspace ID: ${this.sessionContext.workspaceId}
- Triggering Signal: ${this.sessionContext.signal.id}
- Signal Provider: ${this.sessionContext.signal.provider?.name || "unknown"}
- Original Input: ${this.summarizeData(this.sessionContext.payload, 200)}

Working Memory Execution Chain (${workingMemoryEntries.length} executions):
${
          workingMemoryContext.map((entry) =>
            `${entry.sequence}. Agent: ${entry.agent}
   Task: ${entry.task}
   Input: ${entry.input_summary}
   Output: ${entry.output_summary}
   Success: ${entry.success}
   Duration: ${entry.execution_time}ms
   Tools: ${entry.tools_used.join(", ") || "none"}`
          ).join("\n\n")
        }

Session Goals: ${
          this.executionPlan?.successCriteria.join(", ") ||
          "Process signal through available agents"
        }

Create a comprehensive episodic memory summary that includes:
1. **What happened**: Clear description of the session's purpose and execution
2. **Key outcomes**: Primary results and transformations achieved
3. **Agent interactions**: How agents collaborated and built upon each other's work  
4. **Success assessment**: Whether goals were achieved and any notable issues
5. **Patterns and insights**: Interesting behaviors, efficiency, or learning opportunities
6. **Context for future sessions**: Information that would be valuable for similar future work

Focus on creating a rich episodic memory that captures both the factual sequence of events and the qualitative insights that would be valuable for future workspace sessions.`;

      const workingMemorySummary = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        summaryPrompt,
        false, // Don't include existing memory context to avoid recursion
        {
          operation: "generate_working_memory_summary",
          sessionId: this.sessionContext.sessionId,
          executionCount: workingMemoryEntries.length,
        },
      );

      // Determine overall session success
      const successfulExecutions = workingMemoryContext.filter((entry) => entry.success).length;
      const totalExecutions = workingMemoryContext.length;
      const overallSuccess = totalExecutions > 0 && (successfulExecutions / totalExecutions) >= 0.7;

      // Create episodic memory entry
      const episodicEntry = {
        session_id: this.sessionContext.sessionId,
        workspace_id: this.sessionContext.workspaceId,
        signal: {
          id: this.sessionContext.signal.id,
          provider: this.sessionContext.signal.provider?.name,
          payload: this.sessionContext.payload,
        },
        execution_summary: {
          total_executions: totalExecutions,
          successful_executions: successfulExecutions,
          overall_success: overallSuccess,
          execution_chain: workingMemoryContext.map((entry) => ({
            agent: entry.agent,
            task_type: entry.task,
            success: entry.success,
            duration_ms: entry.execution_time,
          })),
        },
        llm_generated_summary: workingMemorySummary,
        session_artifacts: this.executionResults.map((result) => ({
          agent: result.agentId,
          output_type: typeof result.output,
          has_output: !!result.output,
        })),
        timestamp: new Date().toISOString(),
        metadata: {
          session_duration_ms: Date.now() -
            (new Date(this.sessionContext.sessionId.split("_")[1] || Date.now()).getTime()),
          goals_achieved: overallSuccess,
          agent_count: new Set(workingMemoryContext.map((entry) => entry.agent)).size,
        },
      };

      // Store in workspace episodic memory (this would need access to workspace memory manager)
      await this.storeSessionEpisodicMemory(episodicEntry);

      // Extract semantic facts from the entire session
      await this.extractSessionSemanticFacts(workingMemoryEntries, workingMemorySummary);

      this.log(
        `Generated and stored working memory summary for session ${this.sessionContext.sessionId}`,
      );
    } catch (error) {
      this.log(`Error generating working memory summary: ${error}`);
    }
  }

  // Store session summary in workspace episodic memory
  private async storeSessionEpisodicMemory(episodicEntry: any): Promise<void> {
    // This method needs access to workspace-level memory manager
    // For now, we'll store it in session memory with tags indicating it should be moved to workspace
    if (this.sessionMemoryManager.rememberWithMetadata) {
      await this.sessionMemoryManager.rememberWithMetadata(
        `session_summary_${this.sessionContext?.sessionId}`,
        episodicEntry,
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: [
            "session_summary",
            "episodic_memory",
            `workspace:${this.sessionContext?.workspaceId}`,
            `signal:${this.sessionContext?.signal.id}`,
            `session:${this.sessionContext?.sessionId}`,
            "transfer_to_workspace", // Tag indicating this should be moved to workspace memory
          ],
          relevanceScore: 0.8, // High relevance for episodic memory
          associations: [
            `workspace:${this.sessionContext?.workspaceId}`,
            `signal_provider:${this.sessionContext?.signal.provider?.name}`,
          ],
          confidence: 0.9,
          decayRate: 0.1, // Slow decay for episodic memories
        },
      );
    } else {
      // Fallback to legacy storage
      this.sessionMemoryManager.remember(
        `session_summary_${this.sessionContext?.sessionId}`,
        episodicEntry,
      );
    }

    this.log(`Stored session episodic memory: session_summary_${this.sessionContext?.sessionId}`);
  }

  // Provision filesystem context via EMCP providers
  private async provisionFilesystemContext(agentId: string, task: AgentTask): Promise<string> {
    try {
      // Check if context provisioner is available
      if (!this.contextProvisioner) {
        this.log("Warning: Context provisioner not initialized, skipping filesystem context");
        return "";
      }

      // Check if session context and job spec are available
      if (!this.sessionContext?.jobSpec) {
        return "";
      }

      const jobSpec = this.sessionContext.jobSpec;

      // Use EMCP filesystem provisioning method
      const context = await this.contextProvisioner.provisionFilesystemContext(
        agentId,
        jobSpec,
        this.sessionContext.sessionId,
      );

      if (context) {
        this.log(`Provisioned filesystem context for ${agentId} via EMCP providers`);
      }

      return context;
    } catch (error) {
      this.log(`Error provisioning filesystem context: ${error}`);
      return "";
    }
  }

  // Memory-Enhanced Prompt Preparation
  async enrichTaskWithMemory(
    agentId: string,
    task: AgentTask,
    input: any,
    _context: Record<string, any>,
  ): Promise<AgentTask> {
    if (!this.sessionContext || !this.sessionMemoryManager) {
      this.log("Warning: Cannot enrich task with memory - missing context or memory manager");
      return task;
    }

    try {
      this.log(`Enriching task for agent ${agentId} with memory content`);

      // 1. Get relevant semantic facts from workspace (max 10)
      const relevantFacts = await this.getRelevantSemanticFacts(agentId, task, input);

      // 2. Get working memory from current session
      const workingMemoryContext = this.getCurrentSessionWorkingMemory();

      // 3. Get all procedural memory rules from workspace
      const proceduralRules = this.getProceduralMemoryRules();

      // 4. Get episodic summary of previous same-agent executions
      const episodicSummary = this.getPreviousAgentExecutionSummary(agentId);

      // 5. Load filesystem context via EMCP providers if specified in job context
      const filesystemContext = await this.provisionFilesystemContext(agentId, task);

      // 6. Build enhanced prompt
      const memoryEnhancedPrompt = this.buildMemoryEnhancedPrompt(
        task.task,
        relevantFacts,
        workingMemoryContext,
        filesystemContext,
        proceduralRules,
        episodicSummary,
      );

      // 6. Return enhanced task
      const enhancedTask: AgentTask = {
        ...task,
        task: memoryEnhancedPrompt,
      };

      this.log(
        `Task enriched with ${relevantFacts.length} facts, ${workingMemoryContext.length} working memories, ${proceduralRules.length} rules, and episodic summary`,
      );
      return enhancedTask;
    } catch (error) {
      this.log(`Warning: Failed to enrich task with memory: ${error}`);
      return task; // Return original task if enrichment fails
    }
  }

  // Get relevant semantic facts from workspace knowledge graph
  private async getRelevantSemanticFacts(
    _agentId: string,
    task: AgentTask,
    input: any,
  ): Promise<any[]> {
    if (!this.knowledgeGraph) {
      this.log("No knowledge graph available for semantic fact retrieval");
      return [];
    }

    try {
      // Extract key terms from task and input for relevance matching
      const searchTerms = this.extractSearchTerms(task.task, input);

      const facts = [];

      // Query knowledge graph for each search term
      for (const term of searchTerms.slice(0, 3)) { // Limit search terms to avoid too many queries
        const results = await this.knowledgeGraph.queryKnowledge({
          search: term,
          minConfidence: 0.6,
          limit: 4, // Get up to 4 facts per term
        });

        facts.push(...results.facts);
      }

      // Remove duplicates and limit to 10 facts
      const uniqueFacts = facts
        .filter((fact, index, self) => self.findIndex((f) => f.id === fact.id) === index)
        .slice(0, 10);

      return uniqueFacts.map((fact) => ({
        statement: fact.statement,
        confidence: fact.confidence,
        source: fact.source,
        entities: fact.entities?.slice(0, 3) || [], // Limit entities for readability
      }));
    } catch (error) {
      this.log(`Warning: Failed to retrieve semantic facts: ${error}`);
      return [];
    }
  }

  // Extract search terms from task and input
  private extractSearchTerms(taskDescription: string, input: any): string[] {
    const terms = new Set<string>();

    // Extract from task description
    const taskWords = taskDescription.toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3 && !this.isStopWord(word));

    // Extract from input if it's a string or has string properties
    let inputText = "";
    if (typeof input === "string") {
      inputText = input;
    } else if (input && typeof input === "object") {
      inputText = JSON.stringify(input);
    }

    const inputWords = inputText.toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3 && !this.isStopWord(word));

    // Combine and prioritize
    [...taskWords.slice(0, 3), ...inputWords.slice(0, 2)].forEach((word) => terms.add(word));

    return Array.from(terms).slice(0, 5); // Limit to 5 search terms
  }

  // Simple stop word filter
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      "with",
      "from",
      "they",
      "this",
      "that",
      "have",
      "been",
      "will",
      "your",
      "what",
      "when",
      "where",
      "their",
    ]);
    return stopWords.has(word.toLowerCase());
  }

  // Get working memory from current session
  private getCurrentSessionWorkingMemory(): any[] {
    if (!this.sessionMemoryManager || !this.sessionContext) {
      return [];
    }

    try {
      let workingMemories: any[] = [];

      if (this.sessionMemoryManager.queryMemories) {
        workingMemories = this.sessionMemoryManager.queryMemories({
          memoryType: CoALAMemoryType.WORKING,
          tags: [`session:${this.sessionContext.sessionId}`],
          limit: 8, // Limit to most recent 8 executions
        });
      } else {
        // Fallback method
        const allKeys = Object.keys(this.sessionMemoryManager as any);
        workingMemories = allKeys
          .filter((key) => key.startsWith("execution_"))
          .map((key) => this.sessionMemoryManager!.recall(key))
          .filter((record) => record && record.session_id === this.sessionContext!.sessionId)
          .sort((a, b) => (b.sequence_number || 0) - (a.sequence_number || 0))
          .slice(0, 8);
      }

      return workingMemories.map((memory) => ({
        agent: memory.agentId,
        task: memory.task?.description || memory.task,
        input_summary: this.summarizeData(memory.input, 100),
        output_summary: this.summarizeData(memory.output, 100),
        success: memory.metadata?.success,
        sequence: memory.sequence_number,
        timestamp: memory.metadata?.timestamp,
      }));
    } catch (error) {
      this.log(`Warning: Failed to retrieve working memory: ${error}`);
      return [];
    }
  }

  // Get all procedural memory rules from workspace
  private getProceduralMemoryRules(): any[] {
    if (!this.sessionMemoryManager) {
      return [];
    }

    try {
      let proceduralMemories: any[] = [];

      if (this.sessionMemoryManager.queryMemories) {
        proceduralMemories = this.sessionMemoryManager.queryMemories({
          memoryType: CoALAMemoryType.PROCEDURAL,
          limit: 50, // Get all procedural rules
        });
      } else {
        // Fallback: try to get procedural memories from storage
        const allKeys = Object.keys(this.sessionMemoryManager as any);
        proceduralMemories = allKeys
          .filter((key) => key.includes("procedural") || key.includes("rule"))
          .map((key) => this.sessionMemoryManager!.recall(key))
          .filter((record) => record && record.memoryType === CoALAMemoryType.PROCEDURAL);
      }

      // Extract rules from procedural memory content
      const rules: Array<{
        rule: string;
        description: string;
        priority: string;
        scope: string;
      }> = [];

      for (const memory of proceduralMemories) {
        const content = memory.content;

        if (content && typeof content === "object") {
          // Handle the structure used by memory-agent: { insights: [...], type: "...", ... }
          if ("insights" in content && Array.isArray(content.insights)) {
            content.insights.forEach((insight: unknown) => {
              if (typeof insight === "string") {
                rules.push({
                  rule: insight,
                  description: content.description || `${content.type || "Procedural"} insight`,
                  priority: content.priority || "normal",
                  scope: content.scope || "general",
                });
              }
            });
          } // Handle direct rule objects: { rule: "...", description: "...", ... }
          else if ("rule" in content && typeof content.rule === "string") {
            rules.push({
              rule: content.rule,
              description: content.description || "",
              priority: content.priority || "normal",
              scope: content.scope || "general",
            });
          } // Handle string content directly
          else if (typeof content === "string") {
            rules.push({
              rule: content,
              description: "",
              priority: "normal",
              scope: "general",
            });
          }
        } // Fallback: if content is a string, use it directly
        else if (typeof content === "string") {
          rules.push({
            rule: content,
            description: "",
            priority: "normal",
            scope: "general",
          });
        }
      }

      return rules;
    } catch (error) {
      this.log(`Warning: Failed to retrieve procedural rules: ${error}`);
      return [];
    }
  }

  // Get episodic summary of previous same-agent executions for same signal
  private getPreviousAgentExecutionSummary(agentId: string): string | null {
    if (!this.sessionMemoryManager || !this.sessionContext) {
      return null;
    }

    try {
      let episodicMemories: any[] = [];

      if (this.sessionMemoryManager.queryMemories) {
        episodicMemories = this.sessionMemoryManager.queryMemories({
          memoryType: CoALAMemoryType.EPISODIC,
          tags: [`agent:${agentId}`, `signal:${this.sessionContext.signal.id}`],
          limit: 5, // Get recent episodic memories
        });
      } else {
        // Fallback: search for episodic memories by key patterns
        const allKeys = Object.keys(this.sessionMemoryManager as any);
        episodicMemories = allKeys
          .filter((key) => key.includes("session_summary") || key.includes("episodic"))
          .map((key) => this.sessionMemoryManager!.recall(key))
          .filter((record) =>
            record &&
            record.memoryType === CoALAMemoryType.EPISODIC &&
            record.execution_summary?.execution_chain?.some((exec: any) => exec.agent === agentId)
          )
          .slice(0, 5);
      }

      if (episodicMemories.length === 0) {
        return null;
      }

      // Find the most recent execution summary for this agent and signal
      const relevantMemory = episodicMemories
        .filter((memory) => {
          const content = memory.content || memory;
          return content.signal?.id === this.sessionContext!.signal.id &&
            content.execution_summary?.execution_chain?.some((exec: any) => exec.agent === agentId);
        })
        .sort((a, b) =>
          new Date(b.timestamp || b.content?.timestamp || 0).getTime() -
          new Date(a.timestamp || a.content?.timestamp || 0).getTime()
        )
        .shift();

      if (!relevantMemory) {
        return null;
      }

      const content = relevantMemory.content || relevantMemory;
      const agentExecution = content.execution_summary?.execution_chain?.find((exec: any) =>
        exec.agent === agentId
      );

      if (!agentExecution) {
        return null;
      }

      return `Previous execution of ${agentId} for signal ${this.sessionContext.signal.id}:
Task: ${agentExecution.task_type}
Success: ${agentExecution.success}
Duration: ${agentExecution.duration_ms}ms
Overall Session Summary: ${
        content.llm_generated_summary?.substring(0, 300) || "No summary available"
      }...`;
    } catch (error) {
      this.log(`Warning: Failed to retrieve episodic summary: ${error}`);
      return null;
    }
  }

  // Build memory-enhanced prompt
  private buildMemoryEnhancedPrompt(
    originalTask: string,
    semanticFacts: any[],
    workingMemory: any[],
    filesystemContext: string,
    proceduralRules: any[],
    episodicSummary: string | null,
  ): string {
    let enhancedPrompt = originalTask;

    // Add execution prompts from job specification if available
    if (this.sessionContext?.jobSpec?.session_prompts?.planning) {
      enhancedPrompt += `\n\n## EXECUTION GUIDANCE\n`;
      enhancedPrompt += this.sessionContext.jobSpec.session_prompts.planning;
      enhancedPrompt += `\n`;
    }

    // Add filesystem context section FIRST for analysis tasks
    if (filesystemContext) {
      enhancedPrompt += `\n\n## FILESYSTEM CONTEXT\n`;
      enhancedPrompt +=
        `You are analyzing the Atlas codebase. Here are the relevant files:\n\n`;
      enhancedPrompt += filesystemContext;
      enhancedPrompt +=
        `\n**Please provide specific analysis based on this actual Atlas codebase, not generic recommendations.**\n`;
    }

    // Add semantic facts section
    if (semanticFacts.length > 0) {
      enhancedPrompt += `\n\n## RELEVANT WORKSPACE KNOWLEDGE\n`;
      enhancedPrompt +=
        `The following facts from workspace semantic memory are relevant to your task:\n\n`;

      semanticFacts.forEach((fact, index) => {
        enhancedPrompt += `${index + 1}. ${fact.statement} (confidence: ${
          (fact.confidence * 100).toFixed(0)
        }%)\n`;
        if (fact.entities && fact.entities.length > 0) {
          enhancedPrompt += `   Entities: ${fact.entities.map((e: any) => e.name).join(", ")}\n`;
        }
      });
    }

    // Add working memory section
    if (workingMemory.length > 0) {
      enhancedPrompt += `\n\n## CURRENT SESSION CONTEXT\n`;
      enhancedPrompt += `Previous executions in this session (most recent first):\n\n`;

      workingMemory.forEach((execution, index) => {
        enhancedPrompt += `${index + 1}. Agent: ${execution.agent}\n`;
        enhancedPrompt += `   Task: ${execution.task}\n`;
        enhancedPrompt += `   Input: ${execution.input_summary}\n`;
        enhancedPrompt += `   Output: ${execution.output_summary}\n`;
        enhancedPrompt += `   Success: ${execution.success}\n\n`;
      });
    }

    // Add procedural rules section
    if (proceduralRules.length > 0) {
      enhancedPrompt += `\n\n## WORKSPACE RULES AND PROCEDURES\n`;
      enhancedPrompt +=
        `**IMPORTANT: You must strictly follow these workspace rules and procedures:**\n\n`;

      proceduralRules.forEach((rule, index) => {
        enhancedPrompt += `${index + 1}. ${rule.rule}\n`;
        if (rule.description) {
          enhancedPrompt += `   Description: ${rule.description}\n`;
        }
        if (rule.priority && rule.priority !== "normal") {
          enhancedPrompt += `   Priority: ${rule.priority}\n`;
        }
        enhancedPrompt += `\n`;
      });

      enhancedPrompt +=
        `**These rules are mandatory and must be followed in all circumstances.**\n`;
    }

    // Add episodic summary section
    if (episodicSummary) {
      enhancedPrompt += `\n\n## PREVIOUS EXECUTION CONTEXT\n`;
      enhancedPrompt += `Context from previous executions of this agent for the same signal:\n\n`;
      enhancedPrompt += episodicSummary;
      enhancedPrompt +=
        `\n\nUse this context to improve your performance and avoid repeating previous issues.\n`;
    }

    return enhancedPrompt;
  }

  /**
   * Shutdown streaming memory and perform final cleanup
   */
  async shutdown(): Promise<void> {
    try {
      if (this.streamingMemory) {
        // Stream session completion before shutdown
        if (this.sessionContext && this.executionResults.length > 0) {
          const totalDuration = this.executionResults.reduce(
            (sum, result) => sum + (result.duration || 0),
            0,
          );
          const successRate = this.executionResults.filter((r) => r.output).length /
            this.executionResults.length;

          await this.streamingMemory.streamSessionComplete(
            this.sessionContext.sessionId,
            totalDuration,
            this.executionResults.length,
            successRate,
            this.executionResults[this.executionResults.length - 1]?.output,
            `Session with ${this.executionResults.length} agents completed`,
          );
        }

        // Shutdown streaming memory
        await this.streamingMemory.shutdown();
        this.log("Streaming memory shutdown complete");
      }
    } catch (error) {
      this.logger.error("Error during streaming memory shutdown", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: this.sessionContext?.sessionId,
      });
    }

    // Shutdown context provisioner
    try {
      if (this.contextProvisioner) {
        await this.contextProvisioner.shutdown();
        this.log("Context provisioner shutdown complete");
      }
    } catch (error) {
      this.logger.error("Error during context provisioner shutdown", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: this.sessionContext?.sessionId,
      });
    }
  }
}
