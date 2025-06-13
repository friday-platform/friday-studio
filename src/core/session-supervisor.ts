import type { IWorkspaceSignal } from "../types/core.ts";
import { AgentSupervisor, type SupervisedAgentResult } from "./agent-supervisor.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { type AtlasMemoryConfig } from "./memory-config.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "./memory/coala-memory.ts";
import { FactExtractor } from "./memory/fact-extractor.ts";
import { KnowledgeGraphManager } from "./memory/knowledge-graph.ts";
import { KnowledgeGraphLocalStorageAdapter } from "../storage/knowledge-graph-local.ts";
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
  private factExtractor?: FactExtractor;
  private knowledgeGraph?: KnowledgeGraphManager;

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

    // Initialize knowledge graph and fact extractor for semantic memory
    this.initializeSemanticFactExtraction();

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

      // Step 6: Record execution in working memory and extract facts
      await this.recordExecutionInWorkingMemory(agentId, task, input, result, context);

      // Step 7: Clean up worker
      await this.agentSupervisor.terminateWorker(workerInstance.id);

      this.log(`Agent ${agentId} executed successfully with supervision`);
      return result;
    } catch (error) {
      this.log(`Supervised execution failed for agent ${agentId}: ${error}`);
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

    // Extract semantic facts from agent execution
    await this.extractFactsFromAgentExecution(agentId, task, input, result, context);
  }

  // Extract facts from individual agent execution
  private async extractFactsFromAgentExecution(
    agentId: string,
    task: AgentTask,
    input: any,
    result: SupervisedAgentResult,
    context: Record<string, any>,
  ): Promise<void> {
    if (!this.factExtractor) {
      return; // Skip if fact extractor not available
    }

    try {
      // Extract facts from this agent execution
      const extractionResult = await this.factExtractor.extractFactsFromAgentExecution(
        agentId,
        task,
        input,
        result.output,
        {
          ...context,
          execution_metadata: result.execution_metadata,
          validation: result.validation,
          analysis: result.analysis,
          supervision: result.supervision,
        },
      );

      if (extractionResult.extractedFacts.length > 0) {
        this.log(
          `Extracted ${extractionResult.extractedFacts.length} facts from agent ${agentId} execution`,
          {
            factsFound: extractionResult.analysisMetadata.factsFound,
            confidence: extractionResult.analysisMetadata.confidence,
            processingTime: extractionResult.analysisMetadata.processingTime,
          },
        );

        // Store extracted facts in session memory for immediate access
        await this.storeExtractedFactsInMemory(extractionResult.extractedFacts);
      }
    } catch (error) {
      this.log(`Warning: Failed to extract facts from agent ${agentId} execution: ${error}`);
      // Don't throw - fact extraction failure shouldn't break agent execution
    }
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

      // Build execution history for context
      const executionHistory = workingMemoryContext.map((record) => ({
        agent: record.agentId,
        task_description: record.task?.description,
        input_summary: this.summarizeData(record.input),
        output_summary: this.summarizeData(record.output),
        success: record.metadata?.success,
        timestamp: record.metadata?.timestamp,
        sequence: record.sequence_number,
        tools_used: record.tools || [],
      }));

      // Enrich the input with working memory context
      const enrichedInput = {
        ...originalInput,
        _atlas_context: {
          session_id: this.sessionContext.sessionId,
          current_agent: agentId,
          task_description: task.task,
          execution_history: executionHistory,
          previous_executions_count: executionHistory.length,
          last_execution: executionHistory.length > 0 ? executionHistory[0] : null,
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
      this.log(`Extracted ${extractionResult.extractedFacts.length} semantic facts from signal`, {
        signalId: extractionResult.analysisMetadata.signalId,
        factsFound: extractionResult.analysisMetadata.factsFound,
        confidence: extractionResult.analysisMetadata.confidence,
        processingTime: extractionResult.analysisMetadata.processingTime,
      });

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

  // Memory-Enhanced Prompt Preparation
  async enrichTaskWithMemory(
    agentId: string,
    task: AgentTask,
    input: any,
    context: Record<string, any>,
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
      const workingMemoryContext = await this.getCurrentSessionWorkingMemory();

      // 3. Get all procedural memory rules from workspace
      const proceduralRules = await this.getProceduralMemoryRules();

      // 4. Get episodic summary of previous same-agent executions
      const episodicSummary = await this.getPreviousAgentExecutionSummary(agentId);

      // 5. Build enhanced prompt
      const memoryEnhancedPrompt = this.buildMemoryEnhancedPrompt(
        task.task,
        relevantFacts,
        workingMemoryContext,
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
    agentId: string,
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
  private async getCurrentSessionWorkingMemory(): Promise<any[]> {
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
  private async getProceduralMemoryRules(): Promise<any[]> {
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

      return proceduralMemories.map((memory) => ({
        rule: memory.content?.rule || memory.content || memory,
        description: memory.content?.description || "",
        priority: memory.content?.priority || "normal",
        scope: memory.content?.scope || "general",
      }));
    } catch (error) {
      this.log(`Warning: Failed to retrieve procedural rules: ${error}`);
      return [];
    }
  }

  // Get episodic summary of previous same-agent executions for same signal
  private async getPreviousAgentExecutionSummary(agentId: string): Promise<string | null> {
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
    proceduralRules: any[],
    episodicSummary: string | null,
  ): string {
    let enhancedPrompt = originalTask;

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
}
