import type {
  IAtlasAgent,
  IAtlasScope,
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessageManager,
  IWorkspaceSupervisor,
} from "../../types/core.ts";
import { ContextManager as Context } from "../context.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "../memory/coala-memory.ts";
import { MessageManager as Messages } from "../messages.ts";
import { LLMProvider } from "../../utils/llm/provider.ts";
import { type ChildLogger, logger } from "../../utils/logger.ts";
import { type AtlasMemoryConfig, MemoryConfigManager } from "../memory-config.ts";
import {
  PlanningEngine,
  type PlanningEngineConfig,
  type PlanningTask,
} from "../planning/planning-engine.ts";

export abstract class BaseAgent implements IAtlasAgent, IAtlasScope {
  id: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  gates: any[] = [];
  protected logger: ChildLogger;
  protected memoryConfigManager: MemoryConfigManager;
  protected planningEngine?: PlanningEngine;

  constructor(memoryConfig?: AtlasMemoryConfig, id?: string) {
    this.id = id || crypto.randomUUID();
    this.context = new Context();
    this.messages = new Messages();
    this.prompts = {
      system: "",
      user: "",
    };

    // Initialize logger for this agent
    this.logger = logger.createChildLogger({
      agentId: this.id,
      workerType: "agent",
      agentName: this.name?.() || "BaseAgent",
    });

    // Use provided memoryConfig or create default
    const config: AtlasMemoryConfig = memoryConfig || {
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
          relevant_memories: 2,
          past_successes: 1,
          past_failures: 1,
        },
        memory_types: {
          working: { enabled: true, max_age_hours: 2, max_entries: 50 },
          procedural: { enabled: true, max_age_days: 7, max_entries: 100 },
          episodic: { enabled: false, max_age_days: 1, max_entries: 10 },
          semantic: { enabled: true, max_age_days: 14, max_entries: 200 },
          contextual: { enabled: false, max_age_hours: 1, max_entries: 5 },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 5,
          past_successes: 3,
          past_failures: 2,
        },
        memory_types: {
          working: { enabled: true, max_age_hours: 24, max_entries: 100 },
          episodic: { enabled: true, max_age_days: 7, max_entries: 50 },
          procedural: { enabled: true, max_age_days: 30, max_entries: 200 },
          semantic: { enabled: true, max_age_days: 90, max_entries: 500 },
          contextual: { enabled: true, max_age_hours: 24, max_entries: 100 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: false,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 3,
        },
        memory_types: {
          working: { enabled: false, max_entries: 0 },
          episodic: { enabled: true, max_age_days: 90, max_entries: 1000 },
          procedural: { enabled: true, max_age_days: 365, max_entries: 500 },
          semantic: { enabled: true, max_age_days: 365, max_entries: 2000 },
          contextual: { enabled: true, max_age_days: 30, max_entries: 200 },
        },
      },
    };
    this.memoryConfigManager = new MemoryConfigManager(config);
    this.memory = this.memoryConfigManager.getMemoryManager(this, "agent");

    // Initialize agent memory with startup context
    this.rememberAgentInitialization();
  }

  // IAtlasAgent interface methods
  abstract name(): string;
  abstract nickname(): string;
  abstract version(): string;
  abstract provider(): string;
  abstract purpose(): string;
  abstract controls(): object;

  getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  scope(): IAtlasScope {
    return this;
  }

  // IAtlasScope methods
  newConversation(): ITempestMessageManager {
    return new Messages();
  }

  getConversation(): ITempestMessageManager {
    return this.messages;
  }

  archiveConversation(): void {
    // Archive conversation using CoALA memory with agent-specific context
    const coalaMemory = this.memory as CoALAMemoryManager;
    const conversationHistory = this.messages.getHistory();

    if (conversationHistory.length > 0) {
      coalaMemory.rememberWithMetadata(
        `conversation_${this.name()}_${Date.now()}`,
        {
          agentName: this.name(),
          messageCount: conversationHistory.length,
          messages: conversationHistory,
          archivedAt: new Date(),
        },
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ["conversation", "archived", this.name(), "agent-interaction"],
          relevanceScore: 0.6,
          confidence: 1.0,
          decayRate: 0.03, // Agent conversations decay slower than general conversations
        },
      );
    }
  }

  deleteConversation(): void {
    this.messages = new Messages();
  }

  // CoALA Memory Helper Methods
  private rememberAgentInitialization(): void {
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.rememberWithMetadata(
      "agent-initialization",
      {
        agentId: this.id,
        agentName: this.name(),
        agentType: this.constructor.name,
        provider: this.provider(),
        purpose: this.purpose(),
        initializedAt: new Date(),
      },
      {
        memoryType: CoALAMemoryType.CONTEXTUAL,
        tags: ["agent", "initialization", this.name(), "startup"],
        relevanceScore: 0.8,
        confidence: 1.0,
      },
    );
  }

  protected rememberTask(taskId: string, task: any, result: any, success: boolean): void {
    // Use configuration-driven memory only
    this.memoryConfigManager.rememberWithScope(
      this.memory as CoALAMemoryManager,
      `task_${taskId}`,
      {
        taskId,
        task,
        result,
        success,
        agentName: this.name(),
        executedAt: new Date(),
        duration: task.duration || 0,
      },
      success ? CoALAMemoryType.PROCEDURAL : CoALAMemoryType.EPISODIC,
      "agent",
      [
        "task",
        this.name(),
        success ? "success" : "failure",
        task.type || "general",
      ],
      success ? 0.7 : 0.9, // Failures are more relevant for learning
    );
  }

  protected rememberInteraction(interactionType: string, data: any): void {
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.rememberWithMetadata(
      `interaction_${interactionType}_${Date.now()}`,
      {
        type: interactionType,
        agentName: this.name(),
        data,
        timestamp: new Date(),
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["interaction", this.name(), interactionType],
        relevanceScore: 0.5,
        confidence: 1.0,
      },
    );
  }

  protected getRelevantMemories(query: string, limit: number = 5): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    return coalaMemory.queryMemories?.({
      content: query,
      tags: [this.name()],
      minRelevance: 0.3,
      limit,
    }) || [];
  }

  protected getPastSuccesses(taskType?: string): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    const query: any = {
      tags: ["success", this.name()],
      minRelevance: 0.5,
      limit: 10,
    };
    if (taskType) {
      query.tags.push(taskType);
    }
    return coalaMemory.queryMemories?.(query) || [];
  }

  protected getPastFailures(taskType?: string): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    const query: any = {
      tags: ["failure", this.name()],
      minRelevance: 0.5,
      limit: 5,
    };
    if (taskType) {
      query.tags.push(taskType);
    }
    return coalaMemory.queryMemories?.(query) || [];
  }

  // Utility methods for logging
  protected log(
    message: string,
    level: "debug" | "info" | "warn" | "error" = "info",
    context?: any,
  ): void {
    const logContext = {
      agentName: this.name(),
      agentId: this.id,
      ...context,
    };

    // Use static method calls instead of dynamic property access for worker compatibility
    switch (level) {
      case "debug":
        this.logger.debug(message, logContext);
        break;
      case "info":
        this.logger.info(message, logContext);
        break;
      case "warn":
        this.logger.warn(message, logContext);
        break;
      case "error":
        this.logger.error(message, logContext);
        break;
    }

    // Remember significant log events
    if (level === "error" || message.includes("error") || message.includes("failed")) {
      this.rememberInteraction("log_error", { message, context, level });
    }
  }

  // Enhanced LLM generation methods with CoALA memory context
  async generateLLM(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    includeMemoryContext: boolean = true,
    operationContext?: { operation: string; [key: string]: any },
  ): Promise<string> {
    const startTime = Date.now();

    try {
      // Enhance prompts with memory context if requested
      let memoryContext = "";
      if (includeMemoryContext) {
        const memContext = this.buildMemoryContext(userPrompt);
        memoryContext = `${memContext.systemContext}\n\n${memContext.userContext}`;
      }

      // Use LLM provider directly
      const text = await LLMProvider.generateText(userPrompt, {
        model,
        systemPrompt,
        memoryContext: memoryContext || undefined,
        maxTokens: 2000,
        temperature: 0.7,
        operationContext: operationContext ||
          { operation: "agent_generation", agentId: this.id, agentName: this.name() },
      });

      const duration = Date.now() - startTime;

      // Remember this LLM interaction
      this.rememberTask(
        `llm_generation_${Date.now()}`,
        {
          model,
          type: "llm_generation",
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration,
        },
        {
          responseLength: text.length,
          truncatedResponse: text.substring(0, 500),
        },
        true,
      );

      return text;
    } catch (error) {
      const duration = Date.now() - startTime;

      // Remember LLM failure for learning
      this.rememberTask(
        `llm_failure_${Date.now()}`,
        {
          model,
          type: "llm_generation",
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration,
        },
        {
          error: error instanceof Error ? error.message : String(error),
        },
        false,
      );

      this.log(`LLM generation error: ${error}`);
      throw error;
    }
  }

  async *generateLLMStream(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    includeMemoryContext: boolean = true,
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    try {
      // Enhance prompts with memory context if requested
      let enhancedSystemPrompt = systemPrompt;
      let enhancedUserPrompt = userPrompt;

      if (includeMemoryContext) {
        const memoryContext = this.buildMemoryContext(userPrompt);
        enhancedSystemPrompt = `${systemPrompt}\n\n${memoryContext.systemContext}`;
        enhancedUserPrompt = `${userPrompt}\n\n${memoryContext.userContext}`;
      }

      const stream = LLMProvider.generateTextStream(enhancedUserPrompt, {
        model,
        systemPrompt: enhancedSystemPrompt,
        temperature: 0.7,
        maxTokens: 2000,
      });

      let fullResponse = "";
      for await (const chunk of stream) {
        fullResponse += chunk;
        yield chunk;
      }

      const duration = Date.now() - startTime;

      // Remember successful streaming interaction
      this.rememberTask(
        `llm_stream_${Date.now()}`,
        {
          model,
          type: "llm_streaming",
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration,
        },
        {
          responseLength: fullResponse.length,
          truncatedResponse: fullResponse.substring(0, 500),
        },
        true,
      );
    } catch (error) {
      const duration = Date.now() - startTime;

      // Remember streaming failure
      this.rememberTask(
        `llm_stream_failure_${Date.now()}`,
        {
          model,
          type: "llm_streaming",
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration,
        },
        {
          error: error instanceof Error ? error.message : String(error),
        },
        false,
      );

      this.log(`LLM stream generation error: ${error}`);
      throw error;
    }
  }

  // Memory context building for LLM enhancement
  private buildMemoryContext(userPrompt: string): {
    systemContext: string;
    userContext: string;
  } {
    // Use configuration-driven memory context building only
    const memoryContext = this.memoryConfigManager.buildMemoryContext(
      this.memory as CoALAMemoryManager,
      userPrompt,
      "agent",
    );

    // Add agent identity context
    const userContext = `\n--- Agent Context ---\n` +
      `Agent: ${this.name()}\n` +
      `Purpose: ${this.purpose()}\n` +
      `Provider: ${this.provider()}\n`;

    return {
      systemContext: memoryContext.systemContext,
      userContext: userContext,
    };
  }

  /**
   * Standard invoke implementation that most agents can use
   * Eliminates boilerplate code duplication across agents
   */
  async invoke(message: string, model?: string): Promise<string> {
    const modelToUse = model || this.getDefaultModel();

    try {
      let fullResponse = "";
      for await (const chunk of this.invokeStream(message, modelToUse)) {
        fullResponse += chunk;
      }
      return fullResponse;
    } catch (error) {
      this.log(`Agent invoke error: ${error}`);
      throw error;
    }
  }

  /**
   * Standard streaming invoke implementation
   * Eliminates boilerplate code duplication across agents
   */
  async *invokeStream(message: string, model?: string): AsyncIterableIterator<string> {
    const modelToUse = model || this.getDefaultModel();
    const prompts = this.getAgentPrompts();

    this.log(`${this.name()} processing: ${message.slice(0, 50)}...`);

    // Add to message history
    this.messages.newMessage(message, "human" as any);

    // Use the LLM to process the message
    const response = await this.generateLLM(
      modelToUse,
      prompts.system,
      message,
    );

    // Simply yield the entire response
    yield response;

    // Add response to message history
    this.messages.newMessage(response, "agent" as any);
  }

  /**
   * Get the default model for this agent
   * Uses configuration hierarchy: agent config > workspace config > system default
   */
  protected getDefaultModel(): string {
    // Try agent-specific config first
    const agentConfig = (this as any).config;
    if (agentConfig?.model) {
      return agentConfig.model;
    }

    // Try workspace-level default model
    if (this.supervisor?.config?.defaultModel) {
      return this.supervisor.config.defaultModel;
    }

    // Fall back to environment variable or system default
    return Deno.env.get("ATLAS_DEFAULT_MODEL") || "claude-4-sonnet-20250514";
  }

  /**
   * Set agent prompts (consolidates prompt duplication pattern)
   */
  protected setPrompts(system: string, user: string = ""): void {
    this.prompts = { system, user };
  }

  // Advanced Planning & Reasoning Methods (Optional Enhancement)

  /**
   * Enable advanced planning capabilities with configurable reasoning
   */
  enableAdvancedPlanning(config?: PlanningEngineConfig): void {
    const planningConfig: PlanningEngineConfig = {
      cacheDir: Deno.cwd(), // Use current working directory by default
      enableCaching: true,
      enablePatternMatching: true,
      ...config,
    };

    this.planningEngine = new PlanningEngine(planningConfig);
    this.logger.info("Advanced planning enabled", { agentId: this.id, agentName: this.name() });
  }

  /**
   * Generate a plan using advanced reasoning methods
   */
  async generatePlan(
    description: string,
    context?: any,
    options?: {
      complexity?: number;
      requiresToolUse?: boolean;
      qualityCritical?: boolean;
    },
  ): Promise<any> {
    if (!this.planningEngine) {
      throw new Error("Advanced planning not enabled. Call enableAdvancedPlanning() first.");
    }

    const task: PlanningTask = {
      id: crypto.randomUUID(),
      description,
      context: context || {},
      agentType: this.getAgentType(),
      complexity: options?.complexity,
      requiresToolUse: options?.requiresToolUse,
      qualityCritical: options?.qualityCritical,
    };

    const result = await this.planningEngine.generatePlan(task);

    // Remember the planning session
    this.rememberTask(
      `planning_${task.id}`,
      { description, options, agentType: task.agentType },
      { plan: result.plan, method: result.method, confidence: result.confidence },
      true,
    );

    this.logger.info("Generated plan", {
      taskId: task.id,
      method: result.method,
      confidence: result.confidence,
      cached: result.cached,
    });

    return result.plan;
  }

  /**
   * Get the agent type for planning context
   */
  private getAgentType(): "workspace" | "session" | "agent" | "custom" {
    if (this.constructor.name.includes("Workspace")) return "workspace";
    if (this.constructor.name.includes("Session")) return "session";
    return "agent";
  }

  /**
   * Check if advanced planning is enabled
   */
  isAdvancedPlanningEnabled(): boolean {
    return this.planningEngine !== undefined;
  }

  /**
   * Get available reasoning methods (if planning is enabled)
   */
  getAvailableReasoningMethods(): string[] {
    if (!this.planningEngine) {
      return [];
    }
    return this.planningEngine.getReasoningEngine().getAvailableMethods();
  }
}
