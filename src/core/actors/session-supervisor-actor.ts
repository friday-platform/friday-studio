/**
 * Session Supervisor Actor
 *
 * Orchestrates the execution of agent sessions within Atlas workspaces.
 * Manages the complete lifecycle of a session from planning through execution.
 *
 * Key responsibilities:
 * - Creates execution plans using multi-step reasoning or cached job specs
 * - Executes agents in sequential or parallel phases
 * - Monitors progress and applies supervision-level controls
 * - Handles memory operations for fact extraction and summaries
 */

import type { JobSpecification } from "@atlas/config";
import type {
  ActorInitParams,
  AgentExecutePayload,
  AgentExecutionConfig,
  AgentTask,
  BaseActor,
  CombinedAgentInput,
  ExecutionPlanReasoningStep,
  SessionResult,
  SessionSupervisorConfig,
  ToolExecutorResult,
} from "@atlas/core";
import type { Tool } from "ai";
import { generateText, stepCountIs, ToolCallUnion, ToolResultUnion } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod/v4";
import type { IWorkspaceSignal } from "../../types/core.ts";
import { type ChildLogger, logger } from "../../utils/logger.ts";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";
import { AgentExecutionActor } from "./agent-execution-actor.ts";

export interface SessionContext {
  sessionId: string;
  workspaceId?: string;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  jobSpec?: JobSpecification;
  availableAgents: string[];
  constraints?: Record<string, unknown>;
  additionalPrompts?: {
    planning?: string;
    evaluation?: string;
  };
}

export interface AgentResult {
  agentId: string;
  task: string;
  input: unknown;
  output: unknown;
  duration: number;
  timestamp: string;
  reasoning?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}

export interface ExecutionPlan {
  id: string;
  phases: ExecutionPhase[];
  reasoning: string;
  strategy: string;
  confidence: number;
  reasoningSteps?: ExecutionPlanReasoningStep[];
}

export interface ExecutionPhase {
  id: string;
  name: string;
  executionStrategy: "sequential" | "parallel";
  agents: AgentTask[];
  reasoning?: string;
}

export interface SessionSummary {
  sessionId: string;
  status: "completed" | "failed" | "partial";
  totalPhases: number;
  totalAgents: number;
  duration: number;
  reasoning: string;
  results: AgentResult[];
}

export class SessionSupervisorActor implements BaseActor {
  readonly type = "session" as const;
  private sessionId: string;
  private workspaceId?: string;
  private logger: ChildLogger;
  id: string;
  private sessionContext?: SessionContext;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;
  private status: "idle" | "planning" | "executing" | "completed" | "failed" = "idle";
  private config?: SessionSupervisorConfig;
  private cachedPlan?: ExecutionPlan;
  private llmProvider = createAnthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  });

  constructor(
    sessionId: string,
    workspaceId?: string,
    id?: string,
    config?: SessionSupervisorConfig,
  ) {
    this.id = id || crypto.randomUUID();
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.config = config;

    this.logger = logger.createChildLogger({
      actorId: this.id,
      actorType: "session-supervisor",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });

    this.logger.info("Session supervisor actor initialized");
  }

  setConfig(config: SessionSupervisorConfig): void {
    this.config = config;
    this.logger.info("Session config set", {
      sessionId: this.sessionId,
      agentCount: Object.keys(config.agents).length,
      jobName: config.job.name,
    });
  }

  initialize(params?: ActorInitParams): void {
    if (params && "actorId" in params) {
      this.id = params.actorId;
      this.sessionId = params.parentId || this.sessionId;

      this.logger = logger.createChildLogger({
        actorId: this.id,
        actorType: "session-supervisor",
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      });
    }

    this.logger.info("Initializing session supervisor actor");

    this.supervisionLevel = this.getSupervisionLevel();

    this.logger.info("Session supervisor actor initialized", {
      supervisionLevel: this.supervisionLevel,
      workspaceId: this.workspaceId || "global",
    });
  }

  shutdown(): void {
    this.logger.info("Session supervisor actor shutting down", {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });
    this.status = "completed";
  }

  initializeSession(context: SessionContext): void {
    this.sessionContext = context;
    // Clear cached plan when context changes
    this.cachedPlan = undefined;

    this.logger.info("Session initialized", {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      signalId: context.signal.id,
      availableAgents: context.availableAgents.length,
    });
  }

  async createExecutionPlan(): Promise<ExecutionPlan> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    // Return cached plan if available
    if (this.cachedPlan) {
      this.logger.info("Using cached execution plan", {
        planId: this.cachedPlan.id,
        phases: this.cachedPlan.phases.length,
      });
      return this.cachedPlan;
    }

    const startTime = Date.now();

    // Check for pre-computed job specs (keep existing logic)
    const jobSpecPlan = this.getCachedJobSpec();
    if (jobSpecPlan) {
      this.logger.info("Using cached execution plan from job spec", {
        planId: jobSpecPlan.id,
        phases: jobSpecPlan.phases.length,
      });
      // Cache the job spec plan too
      this.cachedPlan = jobSpecPlan;
      return jobSpecPlan;
    }

    // Check if planning should be skipped (keep existing logic)
    const skipPlanning = this.sessionContext.jobSpec?.config?.supervision?.skip_planning;
    if (skipPlanning) {
      this.logger.info("Skipping planning phase due to job configuration");
      return {
        id: crypto.randomUUID(),
        phases: [],
        reasoning: "Planning skipped by job configuration",
        strategy: "skip-planning",
        confidence: 1.0,
      };
    }

    // New implementation using generateText
    this.logger.info("Computing execution plan using AI SDK");

    // Create tools for agent execution
    const planningTools = this.createPlanningTools();

    const result = await generateText({
      model: this.llmProvider("claude-3-7-sonnet-20250219"),
      system: this.buildExecutionPlanningPrompt(this.sessionContext),
      messages: [{
        role: "user",
        content: `Analyze this signal and create an execution plan: ${
          JSON.stringify(this.sessionContext.signal)
        }`,
      }],
      tools: planningTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(10),
      temperature: 0.3, // Lower temperature for more consistent planning
      maxOutputTokens: 4000,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 15000 },
        },
      },
    });

    // Parse the plan from the response including tool calls
    const plan = this.parsePlanFromResponse(
      result.text,
      result.reasoningText,
      result.toolCalls,
      result.toolResults,
    );

    const duration = Date.now() - startTime;
    this.logger.info("Execution plan created", {
      planId: plan.id,
      duration,
      phases: plan.phases.length,
    });

    // Cache the plan for subsequent calls
    this.cachedPlan = plan;

    return plan;
  }

  async executeSession(): Promise<SessionSummary> {
    if (!this.sessionContext) {
      throw new Error("Session not initialized");
    }

    const sessionStartTime = Date.now();

    // Create execution plan
    const plan = await this.createExecutionPlan();

    const allResults: AgentResult[] = [];

    // Execute each phase
    for (const [phaseIndex, phase] of plan.phases.entries()) {
      this.logger.info("Executing phase", {
        phaseIndex: phaseIndex + 1,
        phaseName: phase.name,
        strategy: phase.executionStrategy,
        agentCount: phase.agents.length,
      });

      const phaseResults = await this.executePhase(phase, allResults);
      allResults.push(...phaseResults);

      // Evaluate progress after each phase
      const shouldContinue = this.evaluateProgress(allResults, plan);
      if (!shouldContinue) {
        this.logger.info("Session completion criteria met, stopping execution");
        break;
      }
    }

    // Generate session summary
    const duration = Date.now() - sessionStartTime;
    const summary = this.generateSessionSummary(allResults, plan, duration);

    // Handle memory operations based on job configuration
    this.handleMemoryOperations(summary);

    this.logger.info("Session execution completed", {
      sessionId: this.sessionId,
      status: summary.status,
      phases: summary.totalPhases,
      agents: summary.totalAgents,
      duration,
    });

    return summary;
  }

  private async executePhase(
    phase: ExecutionPhase,
    previousResults: AgentResult[],
  ): Promise<AgentResult[]> {
    const phaseResults: AgentResult[] = [];

    if (phase.executionStrategy === "sequential") {
      for (const agentTask of phase.agents) {
        const result = await this.executeAgent(agentTask, previousResults, phaseResults);
        phaseResults.push(result);
      }
    } else {
      const promises = phase.agents.map((agentTask) =>
        this.executeAgent(agentTask, previousResults, phaseResults)
      );
      const parallelResults = await Promise.all(promises);
      phaseResults.push(...parallelResults);
    }

    return phaseResults;
  }

  private async executeAgent(
    agentTask: AgentTask,
    previousResults: AgentResult[],
    _phaseResults: AgentResult[],
  ): Promise<AgentResult> {
    const startTime = Date.now();

    let input: unknown = this.sessionContext?.payload;

    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      input = previousResults[previousResults.length - 1].output;
    } else if (agentTask.inputSource === "combined") {
      const combinedInput: CombinedAgentInput = {
        original: this.sessionContext?.payload || {},
        previous: previousResults.map((r) => ({
          agentId: r.agentId,
          output: r.output,
        })),
      };
      input = combinedInput;
    } else if (agentTask.dependencies?.length) {
      const lastDep = agentTask.dependencies[agentTask.dependencies.length - 1];
      const depResult = previousResults.find((r) => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output;
      }
    }

    const payload: AgentExecutePayload = {
      agentId: agentTask.agentId,
      input,
      sessionContext: {
        sessionId: this.sessionId,
        workspaceId: this.workspaceId || "global",
        task: agentTask.task,
        reasoning: agentTask.reasoning,
      },
    };

    // Get agent execution configuration
    const agentExecutionConfig = this.getAgentExecutionConfig(agentTask.agentId);

    const agentActor = new AgentExecutionActor(
      crypto.randomUUID(),
      agentExecutionConfig,
    );

    await agentActor.initialize();

    this.logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
      reasoning: agentTask.reasoning,
    });

    let result;
    try {
      result = await agentActor.executeTask(payload);
    } catch (error) {
      this.logger.error("Agent execution failed", {
        agentId: agentTask.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const duration = Date.now() - startTime;

    const agentResult: AgentResult = {
      agentId: agentTask.agentId,
      task: agentTask.task,
      input,
      output: result.output,
      duration,
      timestamp: new Date().toISOString(),
      reasoning: agentTask.reasoning,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
    };

    this.logger.info("Agent execution completed", {
      agentId: agentTask.agentId,
      duration,
      success: true,
      hasToolCalls: !!agentResult.toolCalls?.length,
    });

    return agentResult;
  }

  private evaluateProgress(
    results: AgentResult[],
    _plan: ExecutionPlan,
  ): boolean {
    const supervisionConfig = getSupervisionConfig(this.supervisionLevel);

    if (!supervisionConfig.postExecutionValidation) {
      return true;
    }

    const hasResults = results.length > 0;
    const hasFailures = results.some((r) => !r.output);

    if (hasFailures && this.supervisionLevel === SupervisionLevel.PARANOID) {
      return false; // Stop on any failure in paranoid mode
    }

    return hasResults;
  }

  private generateSessionSummary(
    results: AgentResult[],
    plan: ExecutionPlan,
    duration: number,
  ): SessionSummary {
    const status = results.every((r) => r.output) ? "completed" : "partial";

    const reasoning =
      `Session executed ${results.length} agents across ${plan.phases.length} phases. ` +
      `Strategy: ${plan.strategy}, Confidence: ${plan.confidence}`;

    return {
      sessionId: this.sessionId,
      status,
      totalPhases: plan.phases.length,
      totalAgents: results.length,
      duration,
      reasoning,
      results,
    };
  }

  private handleMemoryOperations(summary: SessionSummary): void {
    const jobSpec = this.sessionContext?.jobSpec;
    const memoryConfig = jobSpec?.config?.memory;
    const memoryEnabled = memoryConfig?.enabled !== false;

    if (!memoryEnabled) {
      this.logger.info("Memory operations disabled");
      return;
    }

    if (memoryConfig?.fact_extraction !== false) {
      try {
        this.extractAndStoreSemanticFacts(summary);
        this.logger.info("Semantic facts extracted and stored");
      } catch (error) {
        this.logger.warn("Failed to extract semantic facts", { error: error.message });
      }
    }

    if (memoryConfig?.summary !== false) {
      try {
        this.generateWorkingMemorySummary(summary);
        this.logger.info("Working memory summary generated");
      } catch (error) {
        this.logger.warn("Failed to generate working memory summary", { error: error.message });
      }
    }
  }

  private getSupervisionLevel(): SupervisionLevel {
    const jobSpec = this.sessionContext?.jobSpec;
    const levelStr = jobSpec?.config?.supervision?.level || "standard";

    switch (levelStr) {
      case "minimal":
        return SupervisionLevel.MINIMAL;
      case "detailed": // Config schema uses "detailed", maps to PARANOID
        return SupervisionLevel.PARANOID;
      case "standard":
      default:
        return SupervisionLevel.STANDARD;
    }
  }

  private buildExecutionPlanningPrompt(context: SessionContext): string {
    return `You are an execution planning supervisor for Atlas workspace sessions.

Your role is to analyze the incoming signal and create an execution plan using available agents.

Signal Information:
- Signal ID: ${context.signal.id}
- Signal Type: ${context.signal.type}
- Payload: ${JSON.stringify(context.payload)}

Available Agents:
${context.availableAgents.join(", ")}

${context.additionalPrompts?.planning || ""}

IMPORTANT: You MUST use the plan_agent_execution tool for each agent you want to include in the execution plan. Do not just describe the plan in text - use the tool calls to create the structured plan.

Create a comprehensive execution plan that:
1. Identifies which agents need to be called
2. Determines the order of execution (sequential or parallel)  
3. Specifies what task each agent should perform
4. Considers dependencies between agents

For each agent, call the plan_agent_execution tool with:
- agentId: the agent identifier
- task: specific task description
- inputSource: "signal", "previous", or "combined"
- dependencies: array of agent IDs this depends on
- phase: meaningful phase name  
- executionStrategy: "sequential" or "parallel"

Think step by step about the best approach to handle this signal, then use the tools to create the structured plan.`;
  }

  private createPlanningTools(): Record<string, Tool> {
    return {
      plan_agent_execution: {
        description: "Plan the execution of an agent with a specific task",
        inputSchema: z.object({
          agentId: z.string().describe("The ID of the agent to execute"),
          task: z.string().describe("The task for the agent to perform"),
          inputSource: z.enum(["signal", "previous", "combined"]).describe("Source of input data"),
          dependencies: z.array(z.string()).optional().describe(
            "Agent IDs this execution depends on",
          ),
          phase: z.string().describe("Execution phase name"),
          executionStrategy: z.enum(["sequential", "parallel"]).describe(
            "How to execute agents in this phase",
          ),
        }),
        execute: (params) => {
          // This tool is for planning only, not actual execution
          return { planned: true, ...params };
        },
      },
    };
  }

  private parsePlanFromResponse(
    text: string,
    reasoning: string | undefined,
    toolCalls?: Array<ToolCallUnion<Record<string, Tool>>>,
    toolResults?: Array<ToolResultUnion<Record<string, Tool>>>,
  ): ExecutionPlan {
    // Log the AI response for debugging
    this.logger.debug("AI Planning Response", {
      text: text?.substring(0, 500),
      reasoning: reasoning?.substring(0, 500),
      toolCallCount: toolCalls?.length || 0,
      toolResultCount: toolResults?.length || 0,
    });

    const planId = crypto.randomUUID();

    // Parse tool calls to extract planned agent executions
    if (toolCalls && toolCalls.length > 0) {
      this.logger.info("Processing AI tool calls for execution planning", {
        toolCallCount: toolCalls.length,
      });

      // Group tool calls by phase
      const phaseMap = new Map<string, Array<any>>();

      for (const toolCall of toolCalls) {
        if (toolCall.toolName === "plan_agent_execution") {
          const phase = toolCall.input?.phase || "Default Phase";
          if (!phaseMap.has(phase)) {
            phaseMap.set(phase, []);
          }
          phaseMap.get(phase)!.push(toolCall.input);
        }
      }

      // Convert phases to ExecutionPhase format
      const phases: ExecutionPhase[] = Array.from(phaseMap.entries()).map((
        [phaseName, agentPlans],
      ) => ({
        id: crypto.randomUUID(),
        name: phaseName,
        executionStrategy: agentPlans[0]?.executionStrategy || "sequential",
        agents: agentPlans.map((plan) => ({
          agentId: plan.agentId,
          task: plan.task,
          inputSource: plan.inputSource || "signal",
          dependencies: plan.dependencies,
          reasoning: `AI planned: ${plan.task}`,
        })),
      }));

      if (phases.length > 0) {
        this.logger.info("Successfully parsed AI-planned execution", {
          phases: phases.length,
          totalAgents: phases.reduce((sum, phase) => sum + phase.agents.length, 0),
        });

        return {
          id: planId,
          phases,
          reasoning: reasoning || "AI-generated execution plan with tool calls",
          strategy: "ai-planned",
          confidence: 0.9, // Higher confidence when AI used tools
          reasoningSteps: [],
        };
      }
    }

    // Fallback: parse the text response for planning information
    this.logger.warn("No tool calls found - parsing text response for planning", {
      hasText: !!text,
      hasReasoning: !!reasoning,
      availableAgents: this.sessionContext?.availableAgents.length || 0,
    });

    // Try to parse agent order from the AI's text response
    const intelligentOrder = this.parseAgentOrderFromText(text);

    if (intelligentOrder && intelligentOrder.length > 0) {
      this.logger.info("Extracted intelligent agent ordering from text", {
        originalOrder: this.sessionContext?.availableAgents.join(" → "),
        intelligentOrder: intelligentOrder.join(" → "),
      });

      const phases: ExecutionPhase[] = [{
        id: crypto.randomUUID(),
        name: "AI-Parsed Execution",
        executionStrategy: "sequential",
        agents: intelligentOrder.map((agentId) => ({
          agentId,
          task: `Execute ${agentId} based on AI analysis`,
          inputSource: "signal" as const,
          reasoning: "Extracted from AI text response",
        })),
      }];

      return {
        id: planId,
        phases,
        reasoning: text || reasoning || "AI-generated execution plan from text parsing",
        strategy: "ai-planned",
        confidence: 0.7, // Lower confidence when parsing text vs using tools
        reasoningSteps: [],
      };
    }

    // Last resort: use input order
    this.logger.warn("Could not parse intelligent order - using input order as fallback");

    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: "AI-Generated Execution",
      executionStrategy: "sequential",
      agents: this.sessionContext?.availableAgents.map((agentId) => ({
        agentId,
        task: "Process signal based on AI planning",
        inputSource: "signal" as const,
        reasoning: "Generated from AI planning",
      })) || [],
    }];

    return {
      id: planId,
      phases,
      reasoning: reasoning || "AI-generated execution plan",
      strategy: "ai-planned",
      confidence: 0.5, // Low confidence when using input order
      reasoningSteps: [],
    };
  }

  private parseAgentOrderFromText(text: string): string[] {
    if (!text || !this.sessionContext?.availableAgents) {
      return [];
    }

    // Look for patterns like "1. **Phase: Data Extraction** - Agent: data-extractor"
    const phasePattern = /(?:Phase:|Agent:)\s*([a-zA-Z-]+)/gi;
    const matches = Array.from(text.matchAll(phasePattern));

    const extractedAgents = matches
      .map((match) => match[1])
      .filter((agent) => this.sessionContext?.availableAgents.includes(agent));

    if (extractedAgents.length > 0) {
      this.logger.debug("Parsed agents from text phases", {
        extracted: extractedAgents,
        textSnippet: text.substring(0, 300),
      });
      return extractedAgents;
    }

    // Alternative: Look for agent names mentioned in order
    const availableAgents = this.sessionContext.availableAgents;
    const agentPositions = availableAgents.map((agent) => ({
      agent,
      position: text.toLowerCase().indexOf(agent.toLowerCase()),
    })).filter((item) => item.position !== -1);

    // Sort by position in text to get the order the AI mentioned them
    agentPositions.sort((a, b) => a.position - b.position);

    const orderedAgents = agentPositions.map((item) => item.agent);

    if (orderedAgents.length > 0) {
      this.logger.debug("Parsed agents from text mentions", {
        ordered: orderedAgents,
        positions: agentPositions,
      });
      return orderedAgents;
    }

    return [];
  }

  private getCachedJobSpec(): ExecutionPlan | null {
    if (!this.sessionContext?.jobSpec) {
      return null;
    }

    const jobSpec = this.sessionContext.jobSpec;
    const planId = crypto.randomUUID();
    const agents = jobSpec.execution?.agents || [];

    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: jobSpec.name || "Job Execution",
      executionStrategy: jobSpec.execution?.strategy || "sequential",
      agents: agents.map((agent) => {
        const agentId = typeof agent === "string" ? agent : agent.id;
        const agentObj = typeof agent === "string" ? null : agent;

        return {
          agentId,
          task: agentObj?.context?.task || "Execute job task",
          inputSource: "signal",
          dependencies: agentObj?.dependencies,
          reasoning: "Defined by job configuration",
        };
      }),
    }];

    return {
      id: planId,
      phases,
      reasoning: `Executing job: ${jobSpec.name}`,
      strategy: "job-based",
      confidence: 1.0,
    };
  }

  private extractAndStoreSemanticFacts(_summary: SessionSummary): void {
    this.logger.debug("Extracting semantic facts", { sessionId: this.sessionId });
  }

  private generateWorkingMemorySummary(_summary: SessionSummary): void {
    this.logger.debug("Generating working memory summary", { sessionId: this.sessionId });
  }

  /**
   * Get agent configuration and create execution config
   * Centralizes agent configuration access
   */
  private getAgentExecutionConfig(agentId: string): AgentExecutionConfig {
    const agentConfig = this.config?.agents?.[agentId];
    if (!agentConfig) {
      this.logger.error("Agent configuration not found", {
        agentId,
        availableAgents: Object.keys(this.config?.agents || {}),
        hasConfig: !!this.config,
        hasAgents: !!this.config?.agents,
      });
      throw new Error(`Agent configuration not found: ${agentId}`);
    }

    let tools: string[] = [];
    if (agentConfig.type === "llm") {
      tools = agentConfig.config.tools || [];
    } else if (agentConfig.type === "system") {
      tools = agentConfig.config.tools || [];
    }

    return {
      agentId,
      agent: agentConfig,
      tools: tools,
      memory: this.config?.memory,
    };
  }

  private toolExecutor(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<ToolExecutorResult> {
    return Promise.resolve({
      success: true,
      result: `Tool ${toolName} executed with parameters: ${JSON.stringify(parameters)}`,
      duration: 100,
    });
  }

  async execute(): Promise<SessionResult> {
    const startTime = Date.now();
    this.status = "executing";

    try {
      const summary = await this.executeSession();
      const duration = Date.now() - startTime;
      this.status = "completed";

      return {
        sessionId: this.sessionId,
        status: summary.status === "completed" ? "success" : "error",
        result: {
          totalPhases: summary.totalPhases,
          totalAgents: summary.totalAgents,
          reasoning: summary.reasoning,
          results: summary.results,
        },
        duration,
      };
    } catch (error) {
      this.status = "failed";
      return {
        sessionId: this.sessionId,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  abort(): void {
    this.logger.info("Aborting session", { sessionId: this.sessionId });
    this.status = "failed";
  }

  getStatus(): "idle" | "planning" | "executing" | "completed" | "failed" {
    return this.status;
  }
}
