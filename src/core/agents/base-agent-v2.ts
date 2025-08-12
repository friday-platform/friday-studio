/**
 * BaseAgent v2 - Simplified base agent for the actor-based architecture
 *
 * Provides core agent functionality:
 * - Memory integration (CoALA)
 * - Context management
 * - LLM access via LLMProvider
 * - Tool execution
 * - Optional reasoning capabilities via @atlas/reasoning
 */

import type {
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessageManager,
  IWorkspaceSupervisor,
} from "../../types/core.ts";
import { ContextManager as Context } from "../context.ts";
import { CoALAMemoryManager, CoALAMemoryType } from "@atlas/memory";
import { MessageManager as Messages } from "../messages.ts";
import { LLMProvider } from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import { type AtlasMemoryConfig, MemoryConfigManager } from "../memory-config.ts";

/**
 * @deprecated As soon as the remote agent adapter has been migrated, this class should be removed.
 * @see src/core/agents/remote/remote-agent.ts
 */
export abstract class BaseAgent {
  id: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  protected logger: Logger;
  protected memoryConfigManager: MemoryConfigManager;

  constructor(memoryConfig?: AtlasMemoryConfig, id?: string) {
    this.id = id || crypto.randomUUID();
    this.context = new Context();
    this.messages = new Messages();
    this.prompts = { system: "", user: "" };

    // Initialize memory configuration if provided
    if (memoryConfig) {
      this.memoryConfigManager = new MemoryConfigManager(memoryConfig);
    }

    // Initialize memory manager with defaults
    this.memory = new CoALAMemoryManager(
      this, // Pass the agent as scope
      undefined, // Use default storage adapter
      false, // Disable cognitive loop
    );

    // Initialize logger
    this.logger = logger.child({
      agentId: this.id,
      agentName: this.name(),
      agentType: this.constructor.name,
    });

    // Initialize gates array
    this.gates = [];
  }

  // Conversation management methods required by IAtlasScope
  newConversation(): ITempestMessageManager {
    this.messages = new Messages();
    return this.messages;
  }

  getConversation(): ITempestMessageManager {
    return this.messages;
  }

  archiveConversation(): void {
    // Archive current conversation to memory if needed
    this.logger.info("Archiving conversation");
  }

  deleteConversation(): void {
    // Clear the current conversation
    this.messages = new Messages();
    this.logger.info("Deleted conversation");
  }

  // Abstract methods that subclasses must implement
  abstract name(): string;
  abstract nickname(): string;
  abstract version(): string;
  abstract provider(): string;
  abstract purpose(): string;
  abstract controls(): object;

  /**
   * Main agent execution method
   */
  async invoke(
    input?: unknown,
    streaming?: (data: string) => void,
  ): Promise<{ result: unknown; message: string }> {
    this.logger.info("Agent invoked", {
      agentId: this.id,
      agentName: this.name(),
      hasInput: !!input,
      streaming: !!streaming,
    });

    try {
      // Load relevant memory
      const memories = await this.loadRelevantMemories(input);

      // Add memories to context
      if (memories.length > 0) {
        this.context.set("memories", memories);
      }

      // Execute agent logic (implemented by subclasses)
      const result = await this.execute(input, streaming);

      // Store execution results in memory
      await this.storeExecutionMemory(input, result);

      return {
        result,
        message: "Execution completed successfully",
      };
    } catch (error) {
      this.logger.error("Agent execution failed", {
        agentId: this.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Abstract execute method - subclasses implement their logic here
   */
  protected abstract execute(
    input?: unknown,
    streaming?: (data: string) => void,
  ): Promise<unknown>;

  /**
   * Complete a conversation using LLM
   */
  protected async complete(
    messages: Array<{ role: string; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      stream?: (delta: string) => void;
    },
  ): Promise<{ content: string; usage?: any }> {
    const model = options?.model || this.getDefaultModel();

    // Extract system and user messages
    const systemMessage = messages.find((m) => m.role === "system")?.content || "";
    const userMessage = messages.find((m) => m.role === "user")?.content || "";

    // Use static LLMProvider method with new unified API
    const response = await LLMProvider.generateText(userMessage, {
      systemPrompt: systemMessage,
      model,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      // Note: streaming is handled differently in the new API
    });

    return {
      content: response.text,
      usage: undefined, // Usage info not available in simplified API
    };
  }

  /**
   * Get default model for this agent
   */
  protected getDefaultModel(): string {
    return "claude-3-5-haiku-latest";
  }

  /**
   * Set agent prompts
   */
  setPrompts(system: string, user: string): void {
    this.prompts = { system, user };
  }

  /**
   * Get available tools for this agent
   */
  getAvailableTools(): string[] {
    // Override in subclasses to provide tools
    return [];
  }

  /**
   * Invoke a tool
   */
  protected async invokeTool(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<unknown> {
    // Override in subclasses to implement tool execution
    throw new Error(`Tool ${toolName} not implemented`);
  }

  /**
   * Load relevant memories for the current execution
   */
  private async loadRelevantMemories(input: unknown): Promise<any[]> {
    // Skip memory loading if no memory config
    if (!this.memoryConfigManager) return [];

    const memories = [];
    const config = this.memoryConfigManager.getActiveMemoryConfig();

    // Load working memory
    if (config.memory_types?.working?.enabled) {
      const workingMemories = await this.memory.retrieve(
        CoALAMemoryType.WORKING,
        { limit: config.context_limits?.relevant_memories || 5 },
      );
      memories.push(...workingMemories);
    }

    // Load semantic memories based on input
    if (config.memory_types?.semantic?.enabled && input) {
      const query = typeof input === "string" ? input : JSON.stringify(input);
      const semanticMemories = await this.memory.retrieve(
        CoALAMemoryType.SEMANTIC,
        {
          query,
          limit: config.context_limits?.relevant_memories || 5,
        },
      );
      memories.push(...semanticMemories);
    }

    return memories;
  }

  /**
   * Store execution results in memory
   */
  private async storeExecutionMemory(input: unknown, result: unknown): Promise<void> {
    // Skip memory storage if no memory config
    if (!this.memoryConfigManager) return;

    const config = this.memoryConfigManager.getActiveMemoryConfig();

    // Store in working memory
    if (config.memory_types?.working?.enabled) {
      await this.memory.store({
        type: CoALAMemoryType.WORKING,
        content: {
          input,
          result,
          agentId: this.id,
          agentName: this.name(),
          timestamp: new Date().toISOString(),
        },
        metadata: {
          source: "agent_execution",
          agentId: this.id,
        },
      });
    }
  }

  /**
   * Get relevant memory for a specific query
   */
  protected async getRelevantMemory(query: string): Promise<any[]> {
    // Skip memory retrieval if no memory config
    if (!this.memoryConfigManager) return [];

    const config = this.memoryConfigManager.getActiveMemoryConfig();

    return await this.memory.retrieve(
      CoALAMemoryType.SEMANTIC,
      {
        query,
        limit: config.context_limits?.relevant_memories || 5,
      },
    );
  }

  /**
   * Get scope type for memory configuration
   */
  getScopeType(): string {
    return "agent";
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.logger.info("Cleaning up agent", { agentId: this.id });
    // Add any cleanup logic here
  }

  /**
   * Optional: Enable reasoning capabilities
   * Agents that need complex reasoning can use this
   */
  async runReasoningCycle?(params: {
    goal: string;
    context?: any;
    tools?: Array<{ name: string; description: string }>;
    maxIterations?: number;
  }): Promise<any> {
    // Agents can implement this using @atlas/reasoning
    // See SessionSupervisorActor for an example
    throw new Error("Reasoning not implemented for this agent");
  }
}
