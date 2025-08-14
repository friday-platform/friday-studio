import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { MCPManager } from "@atlas/mcp";
import {
  createProviderRegistry,
  generateText,
  type ModelMessage,
  stepCountIs,
  streamText,
  Tool,
  ToolCallUnion,
  ToolResultUnion,
} from "ai";
import { z } from "zod/v4";
import { logger } from "@atlas/logger";
import { WatchdogTimer } from "./watchdog-timer.ts";
import { type WorkspaceTimeoutConfig, WorkspaceTimeoutConfigSchema } from "@atlas/config";

// Runtime validation schemas
const LLMProviderSchema = z.enum(["anthropic", "openai", "google"]);

const LLMOptionsSchema = z.object({
  provider: LLMProviderSchema.optional().default("anthropic"),
  model: z.string(),
  temperature: z.number().min(0).max(1).optional(),
  max_tokens: z.number().positive().optional(),
  max_steps: z.number().positive().optional(),
  tool_choice: z
    .union([
      z.literal("auto"),
      z.literal("required"),
      z.literal("none"),
      z.object({
        type: z.literal("tool"),
        toolName: z.string(),
      }),
    ])
    .optional(),
  apiKey: z.string().optional(),
  timeout: WorkspaceTimeoutConfigSchema.optional(),
  systemPrompt: z.string().optional(),
  memoryContext: z.string().optional(),
  operationContext: z.record(z.string(), z.unknown()).optional(),
  tools: z.record(z.string(), z.any()).optional(),
  mcpServers: z.array(z.string()).optional(),
});

/**
 * Unified options for LLM operations - separates provider config from runtime context
 */
export interface LLMOptions {
  provider?: "anthropic" | "openai" | "google";
  model: string;
  temperature?: number;
  max_tokens?: number;
  max_steps?: number;
  tool_choice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
  apiKey?: string;
  timeout?: WorkspaceTimeoutConfig;
  systemPrompt?: string;
  memoryContext?: string;
  operationContext?: Record<string, unknown>;
  tools?: Record<string, Tool>;
  mcpServers?: string[];
}

/**
 * Always returns the same shape whether tools are used or not
 */
export interface LLMResponse {
  text: string;
  toolCalls: ToolCallUnion<Record<string, Tool>>[];
  toolResults: ToolResultUnion<Record<string, Tool>>[];
  steps: unknown[];
}

const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

// Create provider registry for centralized provider management
function createLLMRegistry() {
  return createProviderRegistry({
    anthropic: createAnthropic({
      apiKey: Deno.env.get(PROVIDER_ENV_VARS.anthropic),
    }),
    openai: createOpenAI({
      apiKey: Deno.env.get(PROVIDER_ENV_VARS.openai),
    }),
    google: createGoogleGenerativeAI({
      apiKey: Deno.env.get(PROVIDER_ENV_VARS.google),
    }),
  });
}

/**
 * Unified LLM provider that automatically detects when tools are needed.
 * Design principle: One method, consistent returns, automatic tool wrapping.
 */
export class LLMProvider {
  private static registry = createLLMRegistry();
  private static mcpManager = new MCPManager();

  /**
   * Gets the MCPManager instance for server registration
   */
  static getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  /**
   * Single entry point for all LLM operations - tools are detected automatically
   */
  static async generateText(
    userPrompt: string,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    const validatedOptions = LLMOptionsSchema.parse(options);

    // Check if we should use mocks
    const shouldUseMocks = Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true" ||
      Deno.env.get("NODE_ENV") === "test";

    if (shouldUseMocks) {
      return this.generateMockResponse(userPrompt, validatedOptions);
    }

    const startTime = Date.now();
    const { providerConfig, runtimeContext } = this.extractProviderConfig(validatedOptions);

    logger.info("LLM generation started", {
      provider: providerConfig.provider,
      model: providerConfig.model,
      hasTools: !!(runtimeContext.tools && Object.keys(runtimeContext.tools).length > 0),
      hasMcpServers: !!(runtimeContext.mcpServers && runtimeContext.mcpServers.length > 0),
      mcpServerList: runtimeContext.mcpServers || [],
    });

    // Always use watchdog timer (defaults applied by schema if not configured)
    const watchdog = new WatchdogTimer(providerConfig.timeout);

    try {
      const model = this.getModel(providerConfig);

      const messages = this.buildMessages(userPrompt, runtimeContext);

      const hasTools = !!(runtimeContext.tools && Object.keys(runtimeContext.tools).length > 0);
      const hasMcpServers = !!(runtimeContext.mcpServers && runtimeContext.mcpServers.length > 0);
      const needsTools = hasTools || hasMcpServers;

      const tools: Record<string, Tool> | undefined = needsTools
        ? await this.prepareTools(runtimeContext)
        : undefined;

      // Report progress after tool preparation
      if (tools) {
        watchdog.reportProgress();
      }

      // Debug logging for tools
      logger.info("Tools prepared for LLM execution", {
        needsTools,
        hasTools,
        hasMcpServers,
        toolCount: tools ? Object.keys(tools).length : 0,
        toolNames: tools ? Object.keys(tools) : [],
        mcpServers: runtimeContext.mcpServers || [],
      });

      const result = await generateText({
        model,
        messages,
        tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
        toolChoice: providerConfig.tool_choice,
        stopWhen: stepCountIs(providerConfig.max_steps || 10),
        maxOutputTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
        abortSignal: watchdog.signal,
      });

      // Report progress after LLM generation completes
      watchdog.reportProgress();

      // Log the raw result from AI SDK
      logger.info("AI SDK generateText result", {
        hasText: !!result.text,
        textLength: result.text?.length || 0,
        toolCallsCount: result.toolCalls?.length || 0,
        toolCalls: result.toolCalls?.map((tc) => ({
          toolName: tc.toolName,
          hasInput: !!tc.input,
          inputType: typeof tc.input,
          input: tc.input,
        })),
        steps: result.steps?.length || 0,
      });

      return {
        text: result.text,
        toolCalls: result.toolCalls || [],
        toolResults: result.toolResults || [],
        steps: result.steps || [],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if this is an inactivity timeout (graceful shutdown scenario)
      if (errorMessage.includes("Operation timed out due to inactivity")) {
        logger.info("LLM generation ended due to inactivity timeout", {
          provider: providerConfig.provider,
          model: providerConfig.model,
          duration: Date.now() - startTime,
          reason: "No activity for configured timeout period - graceful shutdown",
        });
        // Return empty response for graceful shutdown
        return {
          text: "",
          toolCalls: [],
          toolResults: [],
          steps: [],
        };
      }

      // For other errors, log as error and throw
      logger.error("LLM generation failed", {
        error: errorMessage,
        provider: providerConfig.provider,
        model: providerConfig.model,
        duration: Date.now() - startTime,
      });
      throw error;
    } finally {
      // Always clean up watchdog timer
      watchdog.abort("Operation finished");

      logger.info("LLM generation completed", {
        duration: Date.now() - startTime,
      });
    }
  }

  /**
   * Generate mock response for testing
   */
  private static generateMockResponse(
    userPrompt: string,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    logger.info("LLM generation started", {
      provider: options.provider || "anthropic",
      model: options.model,
      mock: true,
    });

    // Generate appropriate mock response based on prompt content

    // Mock response for reasoning machine
    let mockText =
      'I need to complete this task step by step.\n\nACTION: complete\nPARAMETERS: {"answer": 42}';

    // Customize mock response based on prompt content
    if (userPrompt.includes("Calculate 25 + 17")) {
      mockText =
        'I need to calculate 25 + 17.\n\n25 + 17 = 42\n\nACTION: complete\nPARAMETERS: {"answer": "42"}';
    } else if (
      userPrompt.includes("Read the number from data.txt") &&
      userPrompt.includes("Recent Observations: None yet")
    ) {
      // First step - read the file
      mockText =
        'I need to read the file, multiply by 4, and add 2.\n\nFirst, let me read the file:\nACTION: tool_call\nTOOL_NAME: file_reader\nPARAMETERS: {"path": "data.txt"}';
    } else if (
      userPrompt.includes("Successfully read file: The secret number is 10") &&
      !userPrompt.includes("Multiplied")
    ) {
      // Second step - multiply by 4
      mockText =
        'I got the number 10 from the file. Now I need to multiply by 4:\nACTION: tool_call\nTOOL_NAME: calculator\nPARAMETERS: {"operation": "multiply", "a": 10, "b": 4}';
    } else if (userPrompt.includes("Multiplied 10 × 4 = 40") && !userPrompt.includes("Added")) {
      // Third step - add 2
      mockText =
        'I got 40 from multiplication. Now I need to add 2:\nACTION: tool_call\nTOOL_NAME: calculator\nPARAMETERS: {"operation": "add", "a": 40, "b": 2}';
    } else if (userPrompt.includes("Added 40 + 2 = 42")) {
      // Final step - complete
      mockText =
        'I got 42 from addition. Task complete:\nACTION: complete\nPARAMETERS: {"answer": 42}';
    }

    logger.info("LLM generation completed", {
      duration: 100,
      mock: true,
    });

    return Promise.resolve({
      text: mockText,
      toolCalls: [],
      toolResults: [],
      steps: [],
    });
  }

  /**
   * Streaming variant for real-time responses
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMOptions,
  ): AsyncGenerator<string> {
    const validatedOptions = LLMOptionsSchema.parse(options);

    // Check if we should use mocks
    const shouldUseMocks = Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true" ||
      Deno.env.get("NODE_ENV") === "test";

    if (shouldUseMocks) {
      const mockResponse = await this.generateMockResponse(userPrompt, validatedOptions);
      yield mockResponse.text;
      return;
    }
    const validatedPrompt = z.string().parse(userPrompt);

    const { providerConfig, runtimeContext } = this.extractProviderConfig(validatedOptions);

    logger.info("LLM stream generation started", {
      provider: providerConfig.provider,
      model: providerConfig.model,
    });

    // Always use watchdog timer (defaults applied by schema if not configured)
    const watchdog = new WatchdogTimer(providerConfig.timeout);

    try {
      const model = this.getModel(providerConfig);
      const messages = this.buildMessages(validatedPrompt, runtimeContext);

      const stream = streamText({
        model,
        messages,
        maxOutputTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
        abortSignal: watchdog.signal,
      });

      for await (const chunk of stream.textStream) {
        // Report progress for each streaming chunk
        watchdog.reportProgress();
        yield chunk;
      }
    } catch (error) {
      logger.error("LLM stream generation failed", {
        error: error instanceof Error ? error.message : String(error),
        provider: providerConfig.provider,
        model: providerConfig.model,
      });
      throw error;
    } finally {
      // Always clean up watchdog timer
      watchdog.abort("Streaming finished");
    }
  }

  /**
   * Design pattern: Separate immutable provider config from per-request context
   */
  private static extractProviderConfig(options: LLMOptions): {
    providerConfig: {
      provider: "anthropic" | "openai" | "google";
      model: string;
      temperature?: number;
      max_tokens?: number;
      max_steps?: number;
      tool_choice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
      apiKey?: string;
      timeout?: WorkspaceTimeoutConfig;
    };
    runtimeContext: {
      systemPrompt?: string;
      memoryContext?: string;
      operationContext?: Record<string, unknown>;
      tools?: Record<string, Tool>;
      mcpServers?: string[];
    };
  } {
    const providerConfig = {
      provider: options.provider || "anthropic",
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      max_steps: options.max_steps,
      tool_choice: options.tool_choice,
      apiKey: options.apiKey,
      timeout: options.timeout,
    };

    const runtimeContext = {
      systemPrompt: options.systemPrompt,
      memoryContext: options.memoryContext,
      operationContext: options.operationContext,
      tools: options.tools,
      mcpServers: options.mcpServers,
    };

    return { providerConfig, runtimeContext };
  }

  /**
   * Constructs the conversation with system prompts, memory, and user input
   */
  private static buildMessages(
    userPrompt: string,
    context: {
      systemPrompt?: string;
      memoryContext?: string;
      operationContext?: Record<string, unknown>;
    },
  ): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // Always provide current datetime to the model for time awareness
    const nowUtcIso = new Date().toISOString();
    messages.push({
      role: "system",
      content: `Current datetime (UTC): ${nowUtcIso}`,
    });

    if (context.systemPrompt) {
      messages.push({
        role: "system",
        content: context.systemPrompt,
      });
    }

    if (context.memoryContext) {
      messages.push({
        role: "system",
        content: `Memory Context:\n${context.memoryContext}`,
      });
    }

    if (context.operationContext && Object.keys(context.operationContext).length > 0) {
      messages.push({
        role: "system",
        content: `Operation Context:\n${JSON.stringify(context.operationContext, null, 2)}`,
      });
    }

    if (userPrompt.length > 0) {
      messages.push({
        role: "user",
        content: userPrompt,
      });
    }

    return messages;
  }

  /**
   * Aggregate tools from all sources - all tools are already AI SDK-compatible
   */
  private static async prepareTools(
    context: {
      tools?: Record<string, Tool>;
      mcpServers?: string[];
    },
  ): Promise<Record<string, Tool>> {
    const allTools: Record<string, Tool> = {};

    // All tools are already AI SDK Tools - no conversion needed
    if (context.tools) {
      Object.assign(allTools, context.tools);
    }

    // MCP tools already return AI SDK Tools
    if (context.mcpServers && context.mcpServers.length > 0) {
      try {
        const mcpTools = await this.mcpManager.getToolsForServers(context.mcpServers);
        Object.assign(allTools, mcpTools);
      } catch (error) {
        logger.error("Failed to get MCP tools", {
          servers: context.mcpServers,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Debug logging for prepared tools
    logger.info("Prepared tools for LLM", {
      toolCount: Object.keys(allTools).length,
      toolNames: Object.keys(allTools),
      // Detailed logging for stream_reply tool
      streamReplyDetails: allTools.stream_reply
        ? {
          hasParameters: !!allTools.stream_reply.inputSchema,
          parametersType: allTools.stream_reply.inputSchema?.constructor.name,
          parameterKeys: allTools.stream_reply.inputSchema,
        }
        : "stream_reply not found",
    });

    return allTools;
  }

  /**
   * Returns a model instance ready for generation using the provider registry
   */
  private static getModel(
    config: {
      provider: "anthropic" | "openai" | "google";
      model: string;
      apiKey?: string;
    },
  ) {
    // If a custom API key is provided, create a new registry instance
    if (config.apiKey) {
      const customRegistry = createProviderRegistry({
        [config.provider]: (() => {
          switch (config.provider) {
            case "anthropic":
              return createAnthropic({ apiKey: config.apiKey });
            case "openai":
              return createOpenAI({ apiKey: config.apiKey });
            case "google":
              return createGoogleGenerativeAI({ apiKey: config.apiKey });
            default:
              throw new Error(`Unsupported provider: ${config.provider}`);
          }
        })(),
      });
      return customRegistry.languageModel(`${config.provider}:${config.model}`);
    }

    // Use the default registry for environment-based API keys
    const apiKey = Deno.env.get(PROVIDER_ENV_VARS[config.provider]);
    if (!apiKey) {
      throw new Error(
        `API key not found for ${config.provider}. ` +
          `Set ${
            PROVIDER_ENV_VARS[config.provider]
          } environment variable or provide apiKey in config.`,
      );
    }

    return this.registry.languageModel(`${config.provider}:${config.model}`);
  }

  /**
   * Recreates the provider registry - useful for testing or API key rotation
   */
  static clearClients(): void {
    this.registry = createLLMRegistry();
    logger.debug("Provider registry recreated");
  }
}
