import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { MCPManager } from "@atlas/mcp";
import { type CoreMessage, generateText, streamText, Tool, ToolCall, ToolResult } from "ai";
import { z } from "zod";
import { logger } from "../../../src/utils/logger.ts";

// Runtime validation schemas
const LLMProviderSchema = z.enum(["anthropic", "openai", "google"]);

const LLMOptionsSchema = z.object({
  provider: LLMProviderSchema.optional().default("google"),
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
  timeout: z.number().positive().optional(),
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
  timeout?: number;
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
  toolCalls: ToolCall<string, unknown>[];
  toolResults: ToolResult<string, unknown, unknown>[];
  steps: unknown[];
}

type ProviderClient = AnthropicProvider | OpenAIProvider | GoogleGenerativeAIProvider;

const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

/**
 * Unified LLM provider that automatically detects when tools are needed.
 * Design principle: One method, consistent returns, automatic tool wrapping.
 */
export class LLMProvider {
  private static clients: Map<string, ProviderClient> = new Map();
  private static mcpManager = new MCPManager();

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
    });

    try {
      const model = this.getModel(providerConfig);

      const messages = this.buildMessages(userPrompt, runtimeContext);

      const hasTools = !!(runtimeContext.tools && Object.keys(runtimeContext.tools).length > 0);
      const hasMcpServers = !!(runtimeContext.mcpServers && runtimeContext.mcpServers.length > 0);
      const needsTools = hasTools || hasMcpServers;

      const tools: Record<string, Tool> | undefined = needsTools
        ? await this.prepareTools(runtimeContext)
        : undefined;

      if (tools) {
        logger.debug("Tools structure before AI SDK call", {
          toolCount: Object.keys(tools).length,
          toolNames: Object.keys(tools),
          firstToolStructure: tools[Object.keys(tools)[0]]
            ? {
              type: typeof tools[Object.keys(tools)[0]],
              keys: Object.keys(tools[Object.keys(tools)[0]]),
              hasDescription: !!tools[Object.keys(tools)[0]].description,
              hasParameters: !!tools[Object.keys(tools)[0]].parameters,
              hasExecute: !!tools[Object.keys(tools)[0]].execute,
            }
            : null,
        });
      }

      // Enhanced logging before AI SDK call
      if (tools?.stream_reply) {
        logger.info("stream_reply tool details before AI SDK call", {
          hasParameters: !!tools.stream_reply.parameters,
          parametersType: tools.stream_reply.parameters?.constructor.name,
          parameterSchema: tools.stream_reply.parameters?._def
            ? {
              typeName: tools.stream_reply.parameters._def.typeName,
              shape: tools.stream_reply.parameters._def.shape
                ? (typeof tools.stream_reply.parameters._def.shape === "function"
                  ? Object.keys(tools.stream_reply.parameters._def.shape() || {})
                  : Object.keys(tools.stream_reply.parameters._def.shape || {}))
                : "no shape",
            }
            : "no _def",
        });
      }

      const result = await generateText({
        model,
        messages,
        tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
        toolChoice: providerConfig.tool_choice,
        maxSteps: providerConfig.max_steps,
        maxTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        abortSignal: AbortSignal.timeout(providerConfig.timeout || 30000),
      });

      // Log the raw result from AI SDK
      logger.info("AI SDK generateText result", {
        hasText: !!result.text,
        textLength: result.text?.length || 0,
        toolCallsCount: result.toolCalls?.length || 0,
        toolCalls: result.toolCalls?.map((tc) => ({
          toolName: tc.toolName,
          hasArgs: !!tc.args,
          argsType: typeof tc.args,
          args: tc.args,
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
      logger.error("LLM generation failed", {
        error: error instanceof Error ? error.message : String(error),
        provider: providerConfig.provider,
        model: providerConfig.model,
        duration: Date.now() - startTime,
      });
      throw error;
    } finally {
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
      provider: options.provider || "google",
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

    try {
      const model = this.getModel(providerConfig);
      const messages = this.buildMessages(validatedPrompt, runtimeContext);

      const stream = await streamText({
        model,
        messages,
        maxTokens: providerConfig.max_tokens,
        temperature: providerConfig.temperature,
        abortSignal: AbortSignal.timeout(providerConfig.timeout || 30000),
      });

      for await (const chunk of stream.textStream) {
        yield chunk;
      }
    } catch (error) {
      logger.error("LLM stream generation failed", {
        error: error instanceof Error ? error.message : String(error),
        provider: providerConfig.provider,
        model: providerConfig.model,
      });
      throw error;
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
      timeout?: number;
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
      provider: options.provider || "google",
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
  ): CoreMessage[] {
    const messages: CoreMessage[] = [];

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
          hasParameters: !!allTools.stream_reply.parameters,
          parametersType: allTools.stream_reply.parameters?.constructor.name,
          parameterKeys: allTools.stream_reply.parameters?._def?.shape
            ? (typeof allTools.stream_reply.parameters._def.shape === "function"
              ? Object.keys(allTools.stream_reply.parameters._def.shape() || {})
              : Object.keys(allTools.stream_reply.parameters._def.shape || {}))
            : "no shape available",
        }
        : "stream_reply not found",
    });

    return allTools;
  }

  /**
   * Provider clients are cached by API key to avoid recreation
   * Returns a model instance ready for generation
   */
  private static getModel(
    config: {
      provider: "anthropic" | "openai" | "google";
      model: string;
      apiKey?: string;
    },
  ) {
    const cacheKey = `${config.provider}:${config.apiKey || "env"}`;

    let client: ProviderClient;
    if (this.clients.has(cacheKey)) {
      client = this.clients.get(cacheKey)!;
    } else {
      const apiKey = config.apiKey || Deno.env.get(PROVIDER_ENV_VARS[config.provider]);
      if (!apiKey) {
        throw new Error(
          `API key not found for ${config.provider}. ` +
            `Set ${
              PROVIDER_ENV_VARS[config.provider]
            } environment variable or provide apiKey in config.`,
        );
      }

      switch (config.provider) {
        case "anthropic":
          client = createAnthropic({ apiKey });
          break;
        case "openai":
          client = createOpenAI({ apiKey });
          break;
        case "google":
          client = createGoogleGenerativeAI({ apiKey });
          break;
        default:
          throw new Error(`Unsupported provider: ${config.provider}`);
      }

      this.clients.set(cacheKey, client);
    }

    // Provider clients are callable functions: client(modelName) => LanguageModelV1
    return client(config.model);
  }

  /**
   * Clears provider cache - useful for testing or API key rotation
   */
  static clearClients(): void {
    this.clients.clear();
    logger.debug("Provider client cache cleared");
  }
}
