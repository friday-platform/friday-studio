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
import { createAnthropic } from "npm:@ai-sdk/anthropic";
import { generateText, streamText } from "npm:ai";

export abstract class BaseAgent implements IAtlasAgent, IAtlasScope {
  id: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  gates: any[] = [];

  constructor(id?: string) {
    this.id = id || crypto.randomUUID();
    this.context = new Context();
    this.memory = new CoALAMemoryManager(this);
    this.messages = new Messages();
    this.prompts = {
      system: "",
      user: "",
    };

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
          archivedAt: new Date()
        },
        {
          memoryType: CoALAMemoryType.EPISODIC,
          tags: ['conversation', 'archived', this.name(), 'agent-interaction'],
          relevanceScore: 0.6,
          confidence: 1.0,
          decayRate: 0.03 // Agent conversations decay slower than general conversations
        }
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
      'agent-initialization',
      {
        agentId: this.id,
        agentName: this.name(),
        agentType: this.constructor.name,
        provider: this.provider(),
        purpose: this.purpose(),
        initializedAt: new Date()
      },
      {
        memoryType: CoALAMemoryType.CONTEXTUAL,
        tags: ['agent', 'initialization', this.name(), 'startup'],
        relevanceScore: 0.8,
        confidence: 1.0
      }
    );
  }

  protected rememberTask(taskId: string, task: any, result: any, success: boolean): void {
    const coalaMemory = this.memory as CoALAMemoryManager;
    coalaMemory.rememberWithMetadata(
      `task_${taskId}`,
      {
        taskId,
        task,
        result,
        success,
        agentName: this.name(),
        executedAt: new Date(),
        duration: task.duration || 0
      },
      {
        memoryType: success ? CoALAMemoryType.PROCEDURAL : CoALAMemoryType.EPISODIC,
        tags: [
          'task', 
          this.name(), 
          success ? 'success' : 'failure',
          task.type || 'general'
        ],
        relevanceScore: success ? 0.7 : 0.9, // Failures are more relevant for learning
        confidence: 1.0,
        decayRate: success ? 0.05 : 0.02 // Keep failures longer for learning
      }
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
        timestamp: new Date()
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ['interaction', this.name(), interactionType],
        relevanceScore: 0.5,
        confidence: 1.0
      }
    );
  }

  protected getRelevantMemories(query: string, limit: number = 5): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    return coalaMemory.queryMemories?.({
      content: query,
      tags: [this.name()],
      minRelevance: 0.3,
      limit
    }) || [];
  }

  protected getPastSuccesses(taskType?: string): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    const query: any = {
      tags: ['success', this.name()],
      minRelevance: 0.5,
      limit: 10
    };
    if (taskType) {
      query.tags.push(taskType);
    }
    return coalaMemory.queryMemories?.(query) || [];
  }

  protected getPastFailures(taskType?: string): any[] {
    const coalaMemory = this.memory as CoALAMemoryManager;
    const query: any = {
      tags: ['failure', this.name()],
      minRelevance: 0.5,
      limit: 5
    };
    if (taskType) {
      query.tags.push(taskType);
    }
    return coalaMemory.queryMemories?.(query) || [];
  }

  // Utility methods for logging
  protected log(message: string, context?: any): void {
    const prefix = `[${this.name()}]`;
    if (context) {
      console.log(prefix, message, context);
    } else {
      console.log(prefix, message);
    }
    
    // Remember significant log events
    if (message.includes('error') || message.includes('failed')) {
      this.rememberInteraction('log_error', { message, context });
    }
  }

  // Enhanced LLM generation methods with CoALA memory context
  async generateLLM(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    includeMemoryContext: boolean = true
  ): Promise<string> {
    const startTime = Date.now();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not found in environment variables");
    }

    const anthropic = createAnthropic({ apiKey });

    try {
      // Enhance prompts with memory context if requested
      let enhancedSystemPrompt = systemPrompt;
      let enhancedUserPrompt = userPrompt;

      if (includeMemoryContext) {
        const memoryContext = this.buildMemoryContext(userPrompt);
        enhancedSystemPrompt = `${systemPrompt}\n\n${memoryContext.systemContext}`;
        enhancedUserPrompt = `${userPrompt}\n\n${memoryContext.userContext}`;
      }

      const { text } = await generateText({
        model: anthropic(model),
        messages: [
          { role: "system", content: enhancedSystemPrompt },
          { role: "user", content: enhancedUserPrompt },
        ],
        temperature: 0.7,
        maxTokens: 2000,
      });

      const duration = Date.now() - startTime;
      
      // Remember this LLM interaction
      this.rememberTask(
        `llm_generation_${Date.now()}`,
        {
          model,
          type: 'llm_generation',
          userPrompt: userPrompt.substring(0, 200), // Truncate for storage
          includeMemoryContext,
          duration
        },
        {
          responseLength: text.length,
          truncatedResponse: text.substring(0, 500) // Store truncated response
        },
        true
      );

      return text;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Remember LLM failure for learning
      this.rememberTask(
        `llm_failure_${Date.now()}`,
        {
          model,
          type: 'llm_generation',
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration
        },
        {
          error: error instanceof Error ? error.message : String(error)
        },
        false
      );

      this.log(`LLM generation error: ${error}`);
      throw error;
    }
  }

  async *generateLLMStream(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    includeMemoryContext: boolean = true
  ): AsyncGenerator<string> {
    const startTime = Date.now();
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not found in environment variables");
    }

    const anthropic = createAnthropic({ apiKey });

    try {
      // Enhance prompts with memory context if requested
      let enhancedSystemPrompt = systemPrompt;
      let enhancedUserPrompt = userPrompt;

      if (includeMemoryContext) {
        const memoryContext = this.buildMemoryContext(userPrompt);
        enhancedSystemPrompt = `${systemPrompt}\n\n${memoryContext.systemContext}`;
        enhancedUserPrompt = `${userPrompt}\n\n${memoryContext.userContext}`;
      }

      const { textStream } = streamText({
        model: anthropic(model),
        messages: [
          { role: "system", content: enhancedSystemPrompt },
          { role: "user", content: enhancedUserPrompt },
        ],
        temperature: 0.7,
        maxTokens: 2000,
      });

      let fullResponse = "";
      for await (const chunk of textStream) {
        fullResponse += chunk;
        yield chunk;
      }

      const duration = Date.now() - startTime;
      
      // Remember successful streaming interaction
      this.rememberTask(
        `llm_stream_${Date.now()}`,
        {
          model,
          type: 'llm_streaming',
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration
        },
        {
          responseLength: fullResponse.length,
          truncatedResponse: fullResponse.substring(0, 500)
        },
        true
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Remember streaming failure
      this.rememberTask(
        `llm_stream_failure_${Date.now()}`,
        {
          model,
          type: 'llm_streaming',
          userPrompt: userPrompt.substring(0, 200),
          includeMemoryContext,
          duration
        },
        {
          error: error instanceof Error ? error.message : String(error)
        },
        false
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
    // Get relevant memories for this prompt
    const relevantMemories = this.getRelevantMemories(userPrompt, 3);
    const pastSuccesses = this.getPastSuccesses();
    const pastFailures = this.getPastFailures();

    let systemContext = "";
    let userContext = "";

    // Add relevant memories to system context
    if (relevantMemories.length > 0) {
      systemContext += "\n--- Agent Memory Context ---\n";
      systemContext += "Relevant past experiences:\n";
      relevantMemories.forEach((memory, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(memory.content)}\n`;
      });
    }

    // Add success patterns to system context
    if (pastSuccesses.length > 0) {
      systemContext += "\nPast successful approaches:\n";
      pastSuccesses.slice(0, 2).forEach((success, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(success.content)}\n`;
      });
    }

    // Add failure patterns as warnings
    if (pastFailures.length > 0) {
      systemContext += "\nPast failures to avoid:\n";
      pastFailures.slice(0, 2).forEach((failure, index) => {
        systemContext += `${index + 1}. ${JSON.stringify(failure.content)}\n`;
      });
    }

    // Add agent identity context
    userContext += `\n--- Agent Context ---\n`;
    userContext += `Agent: ${this.name()}\n`;
    userContext += `Purpose: ${this.purpose()}\n`;
    userContext += `Provider: ${this.provider()}\n`;

    return { systemContext, userContext };
  }
}
