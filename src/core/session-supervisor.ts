import type { IWorkspaceSignal } from "../types/core.ts";
import { AgentSupervisor, type SupervisedAgentResult } from "./agent-supervisor.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { type AtlasMemoryConfig, MemoryConfigManager } from "./memory-config.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./memory/coala-memory.ts";
import { logger } from "../utils/logger.ts";

// Job specification types
export interface JobSpecification {
  name: string;
  description: string;
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

export interface JobExecution {
  strategy: "sequential" | "parallel" | "conditional" | "staged";
  agents: JobAgentSpec[];
  stages?: JobStage[];
}

export interface JobAgentSpec {
  id: string;
  mode?: string; // For agents that have multiple modes (e.g., "load", "store")
  prompt?: string;
  config?: Record<string, any>;
  input?: Record<string, any>;
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
  model: string;
  purpose: string;
  tools?: string[];
  prompts?: {
    system?: string;
    [key: string]: string | undefined;
  };
}

export interface RemoteAgentConfig {
  type: "remote";
  protocol: "acp" | "a2a" | "custom";
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
  inputSource: "signal" | "previous" | "combined";
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

  constructor(memoryConfig: AtlasMemoryConfig, parentScopeId?: string) {
    super(memoryConfig, parentScopeId);
    this.memoryConfig = memoryConfig; // Store for later use

    // Override logger from BaseAgent with proper supervisor context
    this.logger = logger.createChildLogger({
      sessionId: this.id,
      workerType: "session-supervisor",
    });

    // Initialize session-scoped memory
    this.sessionMemoryManager = this.memoryConfigManager.getMemoryManager(this, "session");

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

You have access to a filtered view of the workspace tailored for this specific session.`,
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

  // Initialize session with context from WorkspaceSupervisor
  initializeSession(context: SessionContext): Promise<void> | void {
    this.sessionContext = context;
    this.log(
      `Initializing session ${context.sessionId} for signal ${context.signal.id}`,
    );

    // Initialize AgentSupervisor for supervised execution
    this.initializeAgentSupervisor({
      model: "claude-4-sonnet-20250514",
      memoryConfig: this.memoryConfig, // Pass the proper memory configuration
      prompts: {
        system: "You are an AgentSupervisor responsible for safe agent execution.",
      },
    });

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

  // Create execution plan using job specification or LLM reasoning
  createExecutionPlan(): Promise<ExecutionPlan> | ExecutionPlan {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    this.log(`[createExecutionPlan] Checking for jobSpec...`);
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

    // If we have a job specification, use it directly (fast path)
    if (this.sessionContext.jobSpec) {
      this.log(
        `Using fast job spec path for: ${this.sessionContext.jobSpec.name}`,
      );
      return this.createPlanFromJobSpec(this.sessionContext.jobSpec);
    }

    // Debug why jobSpec is missing
    this.log(
      `No jobSpec found - signal: ${this.sessionContext.signal.id}, context has: ${
        Object.keys(this.sessionContext).join(", ")
      }`,
    );

    // Fallback to LLM-based planning
    this.log("Using LLM-based planning fallback");
    return this.createLLMBasedPlan();
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
          inputSource: index === 0 ? "signal" : "previous",
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
            inputSource: stageIndex === 0 ? "signal" : "previous",
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
          inputSource: "signal",
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

  // Fallback LLM-based planning for backward compatibility
  private async createLLMBasedPlan(): Promise<ExecutionPlan> {
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
  private parseExecutionPlan(llmResponse: string): ExecutionPlan {
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

  // Evaluate execution progress and determine next steps
  async evaluateProgress(results: AgentResult[]): Promise<{
    isComplete: boolean;
    nextAction?: "continue" | "retry" | "adapt" | "escalate";
    feedback?: string;
  }> {
    this.executionResults = results;

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

      // Step 4: Execute with supervision
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

      const result = await this.agentSupervisor.executeAgentSupervised(
        workerInstance,
        input,
        task,
        supervision,
      );

      // Step 5: Clean up worker
      await this.agentSupervisor.terminateWorker(workerInstance.id);

      this.log(`Agent ${agentId} executed successfully with supervision`);
      return result;
    } catch (error) {
      this.log(`Supervised execution failed for agent ${agentId}: ${error}`);
      throw new Error(`Supervised agent execution failed: ${error}`);
    }
  }

  // Generate an intelligent summary of the session results
  async generateSessionSummary(phaseResults: any[]): Promise<string> {
    if (!this.sessionContext) {
      return "No session context available for summary.";
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
}
