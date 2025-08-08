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
  AgentExecutionConfig,
  AgentTask,
  BaseActor,
  CombinedAgentInput,
  ExecutionPlanReasoningStep,
  IAgentOrchestrator,
  SessionResult,
  SessionSupervisorConfig,
  ToolExecutorResult,
} from "@atlas/core";
import type { Tool } from "ai";
import { generateText, stepCountIs, ToolCallUnion, ToolResultUnion } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod/v4";
import type { IWorkspaceArtifact, IWorkspaceSignal } from "../../types/core.ts";
import { type Logger, logger } from "@atlas/logger";
import { getSupervisionConfig, SupervisionLevel } from "../supervision-levels.ts";
import { AwaitingSupervisorDecision, StreamEmitter, StreamEvent } from "@atlas/agent-sdk";
import { HTTPStreamEmitter, NoOpStreamEmitter } from "@atlas/core";

export interface SessionContext {
  sessionId: string;
  workspaceId?: string;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  jobSpec?: JobSpecification;
  availableAgents: string[];
  constraints?: Record<string, unknown>;
  streamId?: string; // Optional streamId for streaming support
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
  private logger: Logger;
  id: string;
  private sessionContext?: SessionContext;
  private supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD;
  private status: "idle" | "planning" | "executing" | "completed" | "failed" = "idle";
  private config?: SessionSupervisorConfig;
  private cachedPlan?: ExecutionPlan;
  private agentOrchestrator?: IAgentOrchestrator; // Agent orchestrator for MCP-based execution
  private artifacts: IWorkspaceArtifact[] = []; // Store session artifacts
  private llmProvider = createAnthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  });

  // Stream management
  private baseStreamEmitter?: StreamEmitter;
  private streamMetrics = {
    totalEvents: 0,
    filteredEvents: 0,
    errorEvents: 0,
    agentMetrics: new Map<string, { events: number; errors: number }>(),
  };

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

    this.logger = logger.child({
      actorId: this.id,
      component: "SessionSupervisorActor",
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

  setAgentOrchestrator(orchestrator: IAgentOrchestrator): void {
    this.agentOrchestrator = orchestrator;
    this.logger.info("Agent orchestrator set", {
      sessionId: this.sessionId,
    });
  }

  initialize(params?: ActorInitParams): void {
    if (params && "actorId" in params) {
      this.id = params.actorId;
      this.sessionId = params.parentId || this.sessionId;

      this.logger = logger.child({
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
      streamMetrics: this.streamMetrics,
    });

    // End streaming
    if (this.baseStreamEmitter) {
      this.streamSessionEvent("session.completed", {
        totalAgents: this.streamMetrics.agentMetrics.size,
        totalEvents: this.streamMetrics.totalEvents,
        filteredEvents: this.streamMetrics.filteredEvents,
      });

      void this.baseStreamEmitter.end();
    }

    this.status = "completed";
  }

  initializeSession(context: SessionContext): void {
    this.sessionContext = context;
    // Clear cached plan when context changes
    this.cachedPlan = undefined;

    // Initialize streaming if streamId provided
    if (context.streamId) {
      this.baseStreamEmitter = new HTTPStreamEmitter(
        context.streamId,
        context.sessionId,
        Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080",
        this.logger,
      );

      // Emit session start event
      this.streamSessionEvent("session_started", {
        sessionId: context.sessionId,
        signalId: context.signal.id,
        workspaceId: context.workspaceId,
      });
    } else {
      this.baseStreamEmitter = new NoOpStreamEmitter();
    }

    this.logger.info("Session initialized", {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      signalId: context.signal.id,
      availableAgents: context.availableAgents.length,
      hasStreaming: !!context.streamId,
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

    // Store agent results as artifact
    if (allResults.length > 0) {
      const agentResultsArtifact: IWorkspaceArtifact = {
        id: crypto.randomUUID(),
        type: "agent_results",
        data: allResults,
        createdAt: new Date(),
        createdBy: this.sessionId,
      };
      this.artifacts.push(agentResultsArtifact);

      this.logger.info("Stored agent results as artifact", {
        artifactId: agentResultsArtifact.id,
        resultCount: allResults.length,
        sessionId: this.sessionId,
      });
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
        // Combine results from previous phases + current phase agents
        const allPreviousResults = [...previousResults, ...phaseResults];
        const result = await this.executeAgent(agentTask, allPreviousResults, phaseResults);
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

    // the signal that triggers the session - payload is whatever json is in -d
    let input: unknown = this.sessionContext?.payload;

    if (agentTask.inputSource === "previous" && previousResults.length > 0) {
      const lastOutput = previousResults[previousResults.length - 1]?.output;
      // If the output is an LLM response object, extract the actual response text
      if (typeof lastOutput === "object" && lastOutput !== null && "response" in lastOutput) {
        input = (lastOutput as any).response;
      } else {
        input = lastOutput;
      }
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

    this.logger.info("Executing agent", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      inputSource: agentTask.inputSource,
      reasoning: agentTask.reasoning,
    });

    // Stream agent start
    this.streamSessionEvent("agent.started", {
      agentId: agentTask.agentId,
      task: agentTask.task,
      phase: agentTask.phase || "execution",
    });

    let result;

    if (!this.agentOrchestrator) {
      throw new Error("Agent orchestrator is not available");
    }

    // Use orchestrator if available (new MCP-based execution)
    this.logger.info("Using orchestrator for execution");
    try {
      // @deprecated Check if this is a system agent that expects objects
      // System agents should receive input as-is, not stringified
      const agentConfig = this.config?.agents?.[agentTask.agentId];
      const isSystemAgent = agentConfig?.type === "system";

      // Extract the actual message/input to send to the agent
      let prompt: string | unknown;

      if (isSystemAgent) {
        // @deprecated System agents receive input as-is
        prompt = input;
        this.logger.debug("Passing raw input to system agent", {
          agentId: agentTask.agentId,
          inputType: typeof input,
        });
      } else if (agentTask.task && agentTask.task !== "Execute job task") {
        // Use explicit task if provided
        prompt = agentTask.task;
      } else if (typeof input === "string") {
        // Direct string input (e.g., from previous agent)
        prompt = input;
      } else if (typeof input === "object" && input !== null && "message" in input) {
        // Extract message from signal payload
        prompt = (input as any).message;
      } else if (typeof input === "object" && input !== null && "text" in input) {
        // Extract text from signal payload (common field name)
        prompt = (input as any).text;
      } else {
        // Fallback to JSON representation
        prompt = JSON.stringify(input);
      }

      const orchestratorResult = await this.agentOrchestrator.executeAgent(
        agentTask.agentId,
        prompt,
        {
          sessionId: this.sessionId,
          workspaceId: this.workspaceId || "global",
          streamId: this.sessionContext?.streamId,
          previousResults,
          additionalContext: {
            input,
            reasoning: agentTask.reasoning,
          },
          // Pass callback for stream events
          onStreamEvent: (event) => {
            this.handleAgentStreamEvent(
              agentTask.agentId,
              agentTask.phase || "execution",
              event,
            );
          },
        },
      );

      // Extract output from orchestrator result
      result = {
        output: orchestratorResult.output,
        duration: orchestratorResult.duration,
      };

      // Stream agent completion
      this.streamSessionEvent("agent.completed", {
        agentId: agentTask.agentId,
        duration: Date.now() - startTime,
        success: true,
      });
    } catch (error) {
      // Check if it's an approval exception
      if (error instanceof AwaitingSupervisorDecision) {
        return await this.handleApprovalRequest(error, agentTask, startTime);
      }

      // Stream agent failure
      this.streamSessionEvent("agent.failed", {
        agentId: agentTask.agentId,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });

      this.logger.error("Agent orchestrator execution failed", {
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
        this.logger.warn("Failed to extract semantic facts", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (memoryConfig?.summary !== false) {
      try {
        this.generateWorkingMemorySummary(summary);
        this.logger.info("Working memory summary generated");
      } catch (error) {
        this.logger.warn("Failed to generate working memory summary", {
          error: error instanceof Error ? error.message : String(error),
        });
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
- Signal Type: ${context.signal.type || "unknown"}
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

    const executionStrategy = jobSpec.execution?.strategy || "sequential";
    const phases: ExecutionPhase[] = [{
      id: crypto.randomUUID(),
      name: jobSpec.name || "Job Execution",
      executionStrategy,
      agents: agents.map((agent, index) => {
        const agentId = typeof agent === "string" ? agent : agent.id;
        const agentObj = typeof agent === "string" ? null : agent;

        return {
          agentId,
          task: agentObj?.context?.task || "Execute job task",
          inputSource: executionStrategy === "sequential" && index > 0 ? "previous" : "signal",
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

    // Always include atlas-platform for all agents to access Atlas tools
    if (!tools.includes("atlas-platform")) {
      tools = ["atlas-platform", ...tools];
    }

    return {
      agentId,
      agent: agentConfig,
      tools: tools,
      memory: this.config?.memory,
      workspaceTools: this.config?.tools,
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

  /**
   * Get all artifacts created during session execution
   */
  getArtifacts(): IWorkspaceArtifact[] {
    return [...this.artifacts];
  }

  /**
   * Handles approval requests from agents.
   *
   * @disclaimer TEMPORARY IMPLEMENTATION - This currently auto-approves all requests.
   * Full approval handling with policies, UI integration, and human-in-the-loop
   * has been designed but not yet implemented. See tasks/supervisor-approval-handling.md
   * for the complete design.
   *
   * TODO: Implement full approval handling as specified in the design document.
   */
  private async handleApprovalRequest(
    error: AwaitingSupervisorDecision,
    agentTask: AgentTask,
    startTime: number,
  ): Promise<AgentResult> {
    const { request, approvalId, agentId } = error;

    // Log the approval request for audit trail
    this.logger.warn(
      "Auto-approving agent request (temporary implementation)",
      {
        approvalId,
        agentId,
        request: request,
        sessionId: this.sessionId,
        disclaimer:
          "This is a temporary auto-approval. Full approval handling not yet implemented.",
      },
    );

    // Auto-approve with clear indication this is temporary
    const decision = {
      approved: true,
      reason: "Auto-approved (temporary implementation - full approval handling pending)",
    };

    // Resume agent execution with approval
    if (!this.agentOrchestrator) {
      throw new Error("Agent orchestrator not available for approval resumption");
    }

    const orchestratorResult = await this.agentOrchestrator.resumeWithApproval(
      approvalId,
      decision,
    );

    const duration = Date.now() - startTime;

    // Return formatted result
    return {
      agentId,
      task: agentTask.task,
      input: request,
      output: orchestratorResult.output,
      duration,
      timestamp: new Date().toISOString(),
      reasoning: agentTask.reasoning,
      approvalDecision: decision,
    };
  }

  // Central stream event handler - all agent streams flow through here
  private handleAgentStreamEvent(
    agentId: string,
    phase: string,
    event: StreamEvent,
  ): void {
    // Update metrics
    this.streamMetrics.totalEvents++;
    const agentMetrics = this.streamMetrics.agentMetrics.get(agentId) ||
      { events: 0, errors: 0 };
    agentMetrics.events++;

    if (event.type === "error") {
      this.streamMetrics.errorEvents++;
      agentMetrics.errors++;
    }

    this.streamMetrics.agentMetrics.set(agentId, agentMetrics);

    // Enrich event with session context
    const enrichedEvent = this.enrichStreamEvent(event, agentId, phase);

    // Emit supervised event
    this.baseStreamEmitter?.emit(enrichedEvent);
  }

  // Enrich events with session metadata
  private enrichStreamEvent(
    event: StreamEvent,
    agentId: string,
    phase: string,
  ): StreamEvent {
    // Add metadata to all events
    const enriched = {
      ...event,
      metadata: {
        ...(event as any).metadata,
        sessionId: this.sessionId,
        agentId,
        phase,
        timestamp: Date.now(),
        sequenceNumber: this.streamMetrics.totalEvents,
      },
    } as any;

    // Special handling for text events - add agent prefix
    if (event.type === "text") {
      return {
        ...enriched,
        content: `[${agentId}]: ${event.content}`,
      };
    }

    return enriched;
  }

  // Stream session-level events
  private streamSessionEvent(eventType: string, data: unknown): void {
    this.baseStreamEmitter?.emit({
      type: "custom",
      eventType: `session.${eventType}`,
      data,
    });
  }
}
