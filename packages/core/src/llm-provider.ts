import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { type WorkspaceTimeoutConfig, WorkspaceTimeoutConfigSchema } from "@atlas/config";
import { ANTHROPIC_CACHE_BREAKPOINT, createAnthropicWithOptions } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { MCPManager } from "@atlas/mcp";
import { stringifyError } from "@atlas/utils";
import {
  createProviderRegistry,
  generateText,
  type ModelMessage,
  stepCountIs,
  streamText,
  type Tool,
} from "ai";
import { z } from "zod";
import { createErrorCause, throwWithCause } from "./errors.ts";
import { WatchdogTimer } from "./watchdog-timer.ts";

export { ANTHROPIC_CACHE_BREAKPOINT, anthropic } from "@atlas/llm";

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
      z.object({ type: z.literal("tool"), toolName: z.string() }),
    ])
    .optional(),
  apiKey: z.string().optional(),
  timeout: WorkspaceTimeoutConfigSchema.optional(),
  systemPrompt: z.string().optional(),
  memoryContext: z.string().optional(),
  operationContext: z.record(z.string(), z.unknown()).optional(),
  tools: z.record(z.string(), z.unknown()).optional(),
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
 * Using Pick to extract only the fields we need from AI SDK's return type,
 * avoiding deep type instantiation from generic parameters
 */
export type LLMResponse = Pick<
  Awaited<ReturnType<typeof generateText<Record<string, Tool>, never>>>,
  "text" | "toolCalls" | "toolResults" | "steps"
>;

const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

// Create provider registry for centralized provider management
function createLLMRegistry() {
  return createProviderRegistry({
    anthropic: createAnthropicWithOptions(),
    openai: createOpenAI({ apiKey: Deno.env.get(PROVIDER_ENV_VARS.openai) }),
    google: createGoogleGenerativeAI({ apiKey: Deno.env.get(PROVIDER_ENV_VARS.google) }),
  });
}

/**
 * Unified LLM provider that automatically detects when tools are needed.
 * Design principle: One method, consistent returns, automatic tool wrapping.
 * @FIXME this method is deprecated and should be removed.
 * @deprecated
 */

// biome-ignore lint/complexity/noStaticOnlyClass: see above.
export class LLMProvider {
  private static registry = createLLMRegistry();
  private static mcpManager = new MCPManager();

  /**
   * Gets the MCPManager instance for server registration
   */
  static getMCPManager(): MCPManager {
    return LLMProvider.mcpManager;
  }

  /**
   * Single entry point for all LLM operations - tools are detected automatically
   */
  static async generateText(userPrompt: string, options: LLMOptions): Promise<LLMResponse> {
    const validatedOptions = LLMOptionsSchema.parse(options) as LLMOptions;

    // Check if we should use mocks
    const shouldUseMocks =
      Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true" || Deno.env.get("NODE_ENV") === "test";

    if (shouldUseMocks) {
      return LLMProvider.generateMockResponse(userPrompt, validatedOptions);
    }

    const startTime = Date.now();
    const { providerConfig, runtimeContext } = LLMProvider.extractProviderConfig(validatedOptions);

    // Log detailed LLM input for monitoring
    logger.info("LLM Input Details", {
      provider: providerConfig.provider,
      model: providerConfig.model,
      temperature: providerConfig.temperature,
      maxTokens: providerConfig.max_tokens,
      userPromptLength: userPrompt.length,
      userPrompt: userPrompt.substring(0, 1000) + (userPrompt.length > 1000 ? "..." : ""),
      systemPromptLength: runtimeContext.systemPrompt?.length || 0,
      systemPrompt: runtimeContext.systemPrompt
        ? runtimeContext.systemPrompt.substring(0, 500) +
          (runtimeContext.systemPrompt.length > 500 ? "..." : "")
        : null,
      memoryContextLength: runtimeContext.memoryContext?.length || 0,
      hasTools: !!(runtimeContext.tools && Object.keys(runtimeContext.tools).length > 0),
      toolsAvailable: runtimeContext.tools ? Object.keys(runtimeContext.tools) : [],
      hasMcpServers: !!(runtimeContext.mcpServers && runtimeContext.mcpServers.length > 0),
      mcpServerList: runtimeContext.mcpServers || [],
      operationContext: runtimeContext.operationContext,
    });

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
      const model = LLMProvider.getModel(providerConfig);

      const messages = LLMProvider.buildMessages(userPrompt, {
        ...runtimeContext,
        provider: providerConfig.provider,
      });

      const hasTools = !!(runtimeContext.tools && Object.keys(runtimeContext.tools).length > 0);
      const hasMcpServers = !!(runtimeContext.mcpServers && runtimeContext.mcpServers.length > 0);
      const needsTools = hasTools || hasMcpServers;

      const tools: Record<string, Tool> | undefined = needsTools
        ? await LLMProvider.prepareTools(runtimeContext)
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

      // Log usage including cache statistics
      logger.debug("LLM generation completed", {
        provider: providerConfig.provider,
        model: providerConfig.model,
        usage: result.usage,
        hasText: !!result.text,
        textLength: result.text?.length || 0,
        toolCallsCount: result.toolCalls?.length || 0,
        toolCalls: result.toolCalls?.map((tc) => ({
          toolName: tc.toolName,
          hasInput: !!tc.input,
          inputType: typeof tc.input,
          input: tc.input,
        })),
        toolResultsCount: result.toolResults?.length || 0,
        toolResults: result.toolResults?.map((tr) => ({
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          // toolResult can be DynamicToolResult or StaticToolResult
          // DynamicToolResult has 'output', StaticToolResult has 'result'
          output: "output" in tr ? tr.output : undefined,
          result: "result" in tr ? tr.result : undefined,
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
      const errorCause = createErrorCause(error);

      // Check if this is an inactivity timeout (graceful shutdown scenario)
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("Operation timed out due to inactivity")) {
        logger.info("LLM generation ended due to inactivity timeout", {
          provider: providerConfig.provider,
          model: providerConfig.model,
          duration: Date.now() - startTime,
          reason: "No activity for configured timeout period - graceful shutdown",
        });
        // Return empty response for graceful shutdown
        return { text: "", toolCalls: [], toolResults: [], steps: [] };
      }

      // Log with structured error cause
      logger.error("LLM generation failed", {
        error: stringifyError(error),
        errorCause,
        provider: providerConfig.provider,
        model: providerConfig.model,
        duration: Date.now() - startTime,
      });

      // Provide context-aware error message based on error type
      if (errorCause.type === "api") {
        const retryMessage = errorCause.isRetryable
          ? " The request will be automatically retried."
          : "";

        if (errorCause.code === "RATE_LIMIT_ERROR") {
          throwWithCause(
            `${providerConfig.provider} rate limit exceeded.${errorCause.retryAfter ? ` Please wait ${errorCause.retryAfter} seconds.` : ""}${retryMessage}`,
            error,
          );
        } else if (errorCause.code === "AUTHENTICATION_ERROR") {
          const providerHint =
            errorCause.providerMessage ?? "Please check your API key configuration.";
          throwWithCause(
            `Authentication failed for ${providerConfig.provider}: ${providerHint}`,
            error,
          );
        } else if (errorCause.code === "OVERLOADED_ERROR") {
          throwWithCause(
            `${providerConfig.provider} service is currently overloaded.${retryMessage}`,
            error,
          );
        } else if (errorCause.statusCode && errorCause.statusCode >= 500) {
          throwWithCause(
            `${providerConfig.provider} service is temporarily unavailable.${retryMessage}`,
            error,
          );
        }
      } else if (errorCause.type === "network") {
        throwWithCause(
          `Failed to connect to ${providerConfig.provider} API. Please check your network connection.`,
          error,
        );
      }

      // Re-throw with original error for unknown cases
      throw error;
    } finally {
      // Always clean up watchdog timer
      watchdog.abort("Operation finished");

      logger.debug("LLM generation completed", { duration: Date.now() - startTime });
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

    logger.debug("LLM generation completed", { duration: 100, mock: true });

    return Promise.resolve({ text: mockText, toolCalls: [], toolResults: [], steps: [] });
  }

  /**
   * Streaming variant for real-time responses
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMOptions,
  ): AsyncGenerator<string> {
    const validatedOptions = LLMOptionsSchema.parse(options) as LLMOptions;

    // Check if we should use mocks
    const shouldUseMocks =
      Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true" || Deno.env.get("NODE_ENV") === "test";

    if (shouldUseMocks) {
      const mockResponse = await LLMProvider.generateMockResponse(userPrompt, validatedOptions);
      yield mockResponse.text;
      return;
    }
    const validatedPrompt = z.string().parse(userPrompt);

    const { providerConfig, runtimeContext } = LLMProvider.extractProviderConfig(validatedOptions);

    logger.info("LLM stream generation started", {
      provider: providerConfig.provider,
      model: providerConfig.model,
    });

    // Always use watchdog timer (defaults applied by schema if not configured)
    const watchdog = new WatchdogTimer(providerConfig.timeout);

    try {
      const model = LLMProvider.getModel(providerConfig);
      const messages = LLMProvider.buildMessages(validatedPrompt, {
        ...runtimeContext,
        provider: providerConfig.provider,
      });

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

      // Log usage after stream completes
      const finalResult = await stream;
      logger.debug("LLM stream completed", {
        provider: providerConfig.provider,
        model: providerConfig.model,
        usage: finalResult.usage,
        textLength: (await finalResult.text).length,
      });
    } catch (error) {
      logger.error("LLM stream generation failed", {
        error: stringifyError(error),
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
   * Optimized for Anthropic prompt caching: static content first with cache breakpoints
   */
  private static buildMessages(
    userPrompt: string,
    context: {
      systemPrompt?: string;
      memoryContext?: string;
      operationContext?: Record<string, unknown>;
      provider?: string; // Optional provider hint for caching
    },
  ): ModelMessage[] {
    const messages: ModelMessage[] = [];

    // Reordered for optimal Anthropic prompt caching:
    // Static content first (cached), variable content after (not cached)
    // Only apply caching for Anthropic to avoid provider-specific options on other providers
    const isAnthropic = context.provider === "anthropic";

    // System prompt (static per agent/session)
    if (context.systemPrompt) {
      messages.push({
        role: "system",
        content: context.systemPrompt,
        ...(isAnthropic ? { providerOptions: ANTHROPIC_CACHE_BREAKPOINT } : {}),
      });
    }

    // Memory context (semi-static, changes slowly)
    if (context.memoryContext) {
      messages.push({
        role: "system",
        content: `Memory Context:\n${context.memoryContext}`,
        ...(isAnthropic ? { providerOptions: ANTHROPIC_CACHE_BREAKPOINT } : {}),
      });
    }

    // Datetime (variable, changes every call) - moved after cached content
    const nowUtcIso = new Date().toISOString();
    messages.push({ role: "system", content: `Current datetime (UTC): ${nowUtcIso}` });

    // Operation context (variable per agent call)
    if (context.operationContext && Object.keys(context.operationContext).length > 0) {
      messages.push({
        role: "system",
        content: `Operation Context:\n${JSON.stringify(context.operationContext, null, 2)}`,
      });
    }

    // User prompt (always variable)
    if (userPrompt.length > 0) {
      messages.push({ role: "user", content: userPrompt });
    }

    return messages;
  }

  /**
   * Aggregate tools from all sources - all tools are already AI SDK-compatible
   */
  private static async prepareTools(context: {
    tools?: Record<string, Tool>;
    mcpServers?: string[];
  }): Promise<Record<string, Tool>> {
    const allTools: Record<string, Tool> = {};

    // All tools are already AI SDK Tools - no conversion needed
    if (context.tools) {
      Object.assign(allTools, context.tools);
    }

    // MCP tools already return AI SDK Tools
    if (context.mcpServers && context.mcpServers.length > 0) {
      try {
        const mcpTools = await LLMProvider.mcpManager.getToolsForServers(context.mcpServers);
        Object.assign(allTools, mcpTools);
      } catch (error) {
        logger.error("Failed to get MCP tools", {
          servers: context.mcpServers,
          error: stringifyError(error),
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
  private static getModel(config: {
    provider: "anthropic" | "openai" | "google";
    model: string;
    apiKey?: string;
  }) {
    // If a custom API key is provided, create a new registry instance
    if (config.apiKey) {
      const customRegistry = createProviderRegistry({
        [config.provider]: (() => {
          switch (config.provider) {
            case "anthropic":
              return createAnthropicWithOptions({ apiKey: config.apiKey });
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

    return LLMProvider.registry.languageModel(`${config.provider}:${config.model}`);
  }

  /**
   * Recreates the provider registry - useful for testing or API key rotation
   */
  static clearClients(): void {
    LLMProvider.registry = createLLMRegistry();
    logger.debug("Provider registry recreated");
  }
}
