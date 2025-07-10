import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { type CoreMessage, generateText, streamText, Tool, ToolCall, ToolResult } from "ai";
import { z } from "zod/v4";
import { logger } from "../../utils/logger.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { Span } from "@opentelemetry/api";

// Import MCP Manager for tool integration
import { MCPManager, type MCPServerConfig } from "@atlas/mcp";

// Zod schemas for validation
const LLMProviderSchema = z.enum(["anthropic", "openai", "google"]);

const LLMConfigSchema = z.object({
  provider: LLMProviderSchema.optional().default("anthropic"),
  model: z.string(),
  apiKey: z.string().optional(),
  maxTokens: z.number().positive().optional().default(4000),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  timeout: z.number().positive().optional().default(30000),
});

const LLMGenerationOptionsSchema = z.object({
  includeMemoryContext: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  memoryContext: z.string().optional(),
  operationContext: z.record(z.string(), z.any()).optional(),
});

// Enhanced generation options with MCP tool support
const LLMGenerationOptionsWithToolsSchema = LLMGenerationOptionsSchema.extend({
  mcpServers: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.any()).optional(), // Additional AI SDK tools
  maxSteps: z.number().positive().optional(),
  toolChoice: z
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
});

export type LLMProviderType = z.infer<typeof LLMProviderSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type LLMGenerationOptions = z.infer<typeof LLMGenerationOptionsSchema>;
export type LLMGenerationOptionsWithTools = z.infer<typeof LLMGenerationOptionsWithToolsSchema>;

// Union type for provider clients
type ProviderClient = AnthropicProvider | OpenAIProvider | GoogleGenerativeAIProvider;

const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
} as const;

/**
 * Simplified multi-provider LLM manager using AI SDK patterns
 * Replaces complex abstraction layers with direct AI SDK usage
 */
export class LLMProvider {
  private static clients: Map<string, ProviderClient> = new Map();
  private static mcpManager = new MCPManager();

  private static defaultConfig: Partial<LLMConfig> = {
    provider: "anthropic",
    maxTokens: 4000,
    temperature: 0.7,
    timeout: 30000,
  };

  /**
   * Get provider client with caching
   */
  private static getProviderClient(provider: string, config?: LLMConfig): ProviderClient {
    const cacheKey = `${provider}:${config?.apiKey || "default"}`;

    let client = this.clients.get(cacheKey);
    if (client) {
      return client;
    }

    const apiKey = config?.apiKey ||
      Deno.env.get(PROVIDER_ENV_VARS[provider as keyof typeof PROVIDER_ENV_VARS]);

    if (!apiKey) {
      throw new Error(
        `${
          PROVIDER_ENV_VARS[provider as keyof typeof PROVIDER_ENV_VARS]
        } environment variable is required`,
      );
    }

    switch (provider) {
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
        throw new Error(`Unsupported provider: ${provider}`);
    }

    this.clients.set(cacheKey, client);

    return client;
  }

  /**
   * Generate text with multi-provider support
   */
  static async generateText(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> = {},
  ): Promise<string> {
    // Validate and parse configuration
    const configResult = LLMConfigSchema.safeParse({ ...this.defaultConfig, ...options });
    if (!configResult.success) {
      const error = new Error(`Invalid LLM configuration: ${configResult.error.message}`);
      logger.error("LLM configuration validation failed", {
        providedOptions: options,
        validationErrors: configResult.error.issues,
        operation: options.operationContext?.operation || "unknown",
      });
      throw error;
    }
    const config = configResult.data;

    // Use telemetry to track the LLM operation
    return await AtlasTelemetry.withLLMSpan(
      config.provider,
      config.model,
      "generate_text",
      async (span) => {
        return await this._generateTextInternal(userPrompt, options, config, span);
      },
      {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
    );
  }

  /**
   * Internal implementation of generateText with telemetry support
   */
  private static async _generateTextInternal(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig>,
    config: LLMConfig,
    span: Span | null,
  ): Promise<string> {
    const startTime = Date.now();

    // Add telemetry attributes
    span?.setAttribute("llm.prompt_length", userPrompt.length);
    span?.setAttribute("llm.operation_context", options.operationContext?.operation || "unknown");

    // Log resolved configuration for debugging
    logger.debug("LLM generation starting", {
      operation: options.operationContext?.operation || "unknown",
      provider: config.provider,
      model: config.model,
      requestedModel: options.model, // Log what was originally requested
      hasApiKey: !!(options.apiKey ||
        Deno.env.get(PROVIDER_ENV_VARS[config.provider as keyof typeof PROVIDER_ENV_VARS])),
      promptLength: userPrompt.length,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      ...options.operationContext,
    });

    // Validate generation options
    const optionsResult = LLMGenerationOptionsSchema.safeParse(options);
    if (!optionsResult.success) {
      const error = new Error(`Invalid generation options: ${optionsResult.error.message}`);
      logger.error("LLM generation options validation failed", {
        providedOptions: options,
        validationErrors: optionsResult.error.issues,
        provider: config.provider,
        model: config.model,
      });
      throw error;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const client = this.getProviderClient(config.provider, config);

      const messages: CoreMessage[] = [];

      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      const modelToUse = config.model;

      logger.debug("Calling AI SDK generateText", {
        provider: config.provider,
        model: modelToUse,
        messageCount: messages.length,
        operation: options.operationContext?.operation || "unknown",
      });

      const result = await generateText({
        model: client(modelToUse),
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Add telemetry attributes from generation result
      span?.setAttribute("llm.response_length", result.text.length);
      span?.setAttribute("llm.finish_reason", result.finishReason || "unknown");

      // Add token usage if available
      if (result.usage) {
        span?.setAttribute("llm.input_tokens", result.usage.promptTokens);
        span?.setAttribute("llm.output_tokens", result.usage.completionTokens);
        span?.setAttribute("llm.total_tokens", result.usage.totalTokens);
      }

      logger.debug("LLM generation completed", {
        operation: options.operationContext?.operation || "unknown",
        provider: config.provider,
        model: modelToUse,
        duration,
        promptLength: userPrompt.length,
        responseLength: result.text.length,
        finishReason: result.finishReason,
        usage: result.usage,
        ...options.operationContext,
      });

      return result.text;
    } catch (error) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "UnknownError";

      // Enhanced error context
      const errorContext = {
        provider: config.provider,
        model: config.model,
        requestedModel: options.model,
        duration,
        promptLength: userPrompt.length,
        operation: options.operationContext?.operation || "unknown",
        errorType: errorName,
        hasApiKey: !!(options.apiKey ||
          Deno.env.get(PROVIDER_ENV_VARS[config.provider as keyof typeof PROVIDER_ENV_VARS])),
        timeout: config.timeout,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        ...options.operationContext,
      };

      if (error instanceof Error && error.name === "AbortError") {
        logger.error("LLM generation timed out", {
          ...errorContext,
          timeoutMs: config.timeout,
        });
        const timeoutError = new Error(
          `LLM generation timed out after ${config.timeout}ms [${config.provider}/${config.model}]`,
        );
        timeoutError.cause = error;
        throw timeoutError;
      }

      // Log detailed error information
      logger.error("LLM generation failed", {
        ...errorContext,
        error: errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
        // Try to extract additional details from AI SDK errors
        aiSdkError: error instanceof Error && "response" in error
          ? (error as any).response
          : undefined,
        statusCode: error instanceof Error && "status" in error ? (error as any).status : undefined,
      });

      // Create enhanced error with full context
      const enhancedError = new Error(
        `LLM generation failed [${config.provider}/${config.model}]: ${errorMessage}`,
      );
      enhancedError.cause = error;
      // Add custom properties for structured error handling
      (enhancedError as any).context = errorContext;

      throw enhancedError;
    }
  }

  /**
   * Generate streaming text with multi-provider support
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> = {},
  ): AsyncGenerator<string> {
    const startTime = Date.now();

    // Validate and parse configuration
    const configResult = LLMConfigSchema.safeParse({ ...this.defaultConfig, ...options });
    if (!configResult.success) {
      throw new Error(`Invalid LLM configuration: ${configResult.error.message}`);
    }
    const config = configResult.data;

    // Validate generation options
    const optionsResult = LLMGenerationOptionsSchema.safeParse(options);
    if (!optionsResult.success) {
      throw new Error(`Invalid generation options: ${optionsResult.error.message}`);
    }

    try {
      const client = this.getProviderClient(config.provider, config);

      const messages: CoreMessage[] = [];

      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      const modelToUse = config.model;

      const { textStream } = streamText({
        model: client(modelToUse),
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });

      let totalLength = 0;
      for await (const chunk of textStream) {
        totalLength += chunk.length;
        yield chunk;
      }

      const duration = Date.now() - startTime;
      logger.debug("LLM streaming completed", {
        provider: config.provider,
        model: modelToUse,
        duration,
        promptLength: userPrompt.length,
        responseLength: totalLength,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : "UnknownError";

      // Enhanced error context for streaming
      const errorContext = {
        provider: config.provider,
        model: config.model,
        requestedModel: options.model,
        duration,
        promptLength: userPrompt.length,
        operation: options.operationContext?.operation || "streaming",
        errorType: errorName,
        hasApiKey: !!(options.apiKey ||
          Deno.env.get(PROVIDER_ENV_VARS[config.provider as keyof typeof PROVIDER_ENV_VARS])),
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      };

      logger.error("LLM streaming failed", {
        ...errorContext,
        error: errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
        aiSdkError: error instanceof Error && "response" in error
          ? (error as any).response
          : undefined,
        statusCode: error instanceof Error && "status" in error ? (error as any).status : undefined,
      });

      const enhancedError = new Error(
        `LLM streaming failed [${config.provider}/${config.model}]: ${errorMessage}`,
      );
      enhancedError.cause = error;
      (enhancedError as any).context = errorContext;

      throw enhancedError;
    }
  }

  /**
   * Initialize MCP servers for tool integration
   * @param servers Array of MCP server configurations
   */
  static async initializeMCPServers(servers: MCPServerConfig[]): Promise<void> {
    logger.info("Initializing MCP servers", {
      operation: "mcp_initialization",
      serverCount: servers.length,
      serverIds: servers.map((s) => s.id),
    });

    for (const serverConfig of servers) {
      try {
        await this.mcpManager.registerServer(serverConfig);
        logger.debug(`MCP server initialized: ${serverConfig.id}`, {
          operation: "mcp_server_init",
          serverId: serverConfig.id,
          transport: serverConfig.transport.type,
        });
      } catch (error) {
        logger.error(`Failed to initialize MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_init",
          serverId: serverConfig.id,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    logger.info("MCP servers initialization completed", {
      operation: "mcp_initialization",
      successCount: servers.length,
    });
  }

  /**
   * Generate text with MCP tool support using AI SDK's native tool calling
   * @param userPrompt The user prompt
   * @param options Generation options including MCP server references
   * @returns Generation result with tool calls and results
   */
  static async generateTextWithTools(
    userPrompt: string,
    options: LLMGenerationOptionsWithTools & Partial<LLMConfig> = {},
  ): Promise<{
    text: string;
    toolCalls: ToolCall<string, unknown>[];
    toolResults: ToolResult<string, unknown, unknown>[];
    steps: unknown[];
  }> {
    // Validate and parse configuration
    const configResult = LLMConfigSchema.safeParse({
      ...this.defaultConfig,
      ...options,
    });
    if (!configResult.success) {
      throw new Error(
        `Invalid LLM configuration: ${configResult.error.message}`,
      );
    }
    const config = configResult.data;

    // Use composite LLM+MCP telemetry span
    return await AtlasTelemetry.withLLMToolSpan(
      config.provider,
      config.model,
      options.mcpServers || [],
      async (span, mcpSpanCreator) => {
        return await this._generateTextWithToolsInternal(
          userPrompt,
          options,
          config,
          span,
          mcpSpanCreator,
        );
      },
      {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        maxSteps: options.maxSteps,
      },
    );
  }

  /**
   * Internal implementation of generateTextWithTools with telemetry support
   */
  private static async _generateTextWithToolsInternal(
    userPrompt: string,
    options: LLMGenerationOptionsWithTools & Partial<LLMConfig>,
    config: LLMConfig,
    span: Span | null,
    mcpSpanCreator: (
      serverName: string,
      operation: "initialize" | "tool_call" | "cleanup",
      toolFn: (span: Span | null) => Promise<unknown>,
      attributes?: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<{
    text: string;
    toolCalls: ToolCall<string, unknown>[];
    toolResults: ToolResult<string, unknown, unknown>[];
    steps: unknown[];
  }> {
    const startTime = Date.now();

    // Add telemetry attributes
    span?.setAttribute("llm.prompt_length", userPrompt.length);
    span?.setAttribute(
      "llm.operation_context",
      options.operationContext?.operation || "tool_generation",
    );

    // Validate generation options
    const optionsResult = LLMGenerationOptionsWithToolsSchema.safeParse(options);
    if (!optionsResult.success) {
      throw new Error(
        `Invalid generation options: ${optionsResult.error.message}`,
      );
    }

    // Prepare tools - combine provided tools with MCP tools
    const allTools: Record<string, Tool> = { ...options.tools };

    // Add MCP tools if servers are specified
    if (options.mcpServers && options.mcpServers.length > 0) {
      // Track MCP tool loading with a child span
      for (const serverName of options.mcpServers) {
        await mcpSpanCreator(serverName, "initialize", async (mcpSpan: any) => {
          // This initialization span will be created for visibility
          mcpSpan?.setAttribute("mcp.server_name", serverName);
        });
      }

      try {
        const mcpTools = await this.mcpManager.getToolsForServers(
          options.mcpServers,
        );
        Object.assign(allTools, mcpTools);

        // Add MCP tool count to parent span
        span?.setAttribute("mcp.tool_count", Object.keys(mcpTools).length);
        span?.setAttribute("mcp.total_tool_count", Object.keys(allTools).length);

        logger.debug("MCP tools loaded", {
          operation: "mcp_tools_loading",
          mcpServers: options.mcpServers,
          mcpToolCount: Object.keys(mcpTools).length,
          totalToolCount: Object.keys(allTools).length,
        });
      } catch (error) {
        logger.error("Failed to load MCP tools", {
          operation: "mcp_tools_loading",
          mcpServers: options.mcpServers,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    try {
      const client = this.getProviderClient(config.provider, config);

      const messages: CoreMessage[] = [];

      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      logger.debug("LLM generation with MCP tools starting", {
        operation: options.operationContext?.operation || "tool_generation",
        provider: config.provider,
        model: config.model,
        toolCount: Object.keys(allTools).length,
        toolNames: Object.keys(allTools),
        mcpServerCount: options.mcpServers?.length || 0,
        maxSteps: options.maxSteps || 1,
        toolChoice: options.toolChoice,
        ...options.operationContext,
      });

      // Log first tool structure for debugging
      const firstToolName = Object.keys(allTools)[0];
      if (firstToolName) {
        const firstTool = allTools[firstToolName];
        logger.debug("First tool structure before AI SDK call", {
          name: firstToolName,
          type: typeof firstTool,
          keys: Object.keys(firstTool || {}),
          hasDescription: !!firstTool?.description,
          hasParameters: !!firstTool?.parameters,
          hasInputSchema: !!firstTool?.input_schema,
          hasExecute: !!firstTool?.execute,
          parametersType: typeof firstTool?.parameters,
          inputSchemaType: typeof firstTool?.input_schema,
        });
      }

      // Use actual AI SDK tool calling with MCP tools
      let result;
      try {
        logger.debug("Calling AI SDK generateText", {
          hasTools: Object.keys(allTools).length > 0,
          messageCount: messages.length,
        });

        // Log the exact structure we're passing
        if (Object.keys(allTools).length > 0) {
          logger.debug("Tools being passed to AI SDK", {
            toolNames: Object.keys(allTools),
            toolStructure: JSON.stringify(
              Object.entries(allTools).map(([name, tool]) => ({
                name,
                keys: Object.keys(tool),
                hasDescription: !!tool.description,
                hasInputSchema: !!tool.input_schema,
                hasParameters: !!tool.parameters,
                hasExecute: typeof tool.execute === "function",
              })),
            ),
          });
        }

        result = await generateText({
          model: client(config.model),
          messages,
          tools: Object.keys(allTools).length > 0 ? allTools : undefined,
          toolChoice: options.toolChoice,
          maxSteps: options.maxSteps || 10,
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          abortSignal: controller.signal,
        });
      } catch (genError) {
        // Extract more detailed error information
        const errorDetails: any = {
          error: genError instanceof Error ? genError.message : String(genError),
          errorName: genError instanceof Error ? genError.constructor.name : typeof genError,
          stack: genError instanceof Error ? genError.stack : undefined,
          // Check for specific AI SDK error properties
          statusCode: (genError as any)?.statusCode,
          statusText: (genError as any)?.statusText,
          responseBody: (genError as any)?.responseBody,
          data: (genError as any)?.data,
        };

        // Check for validation errors
        if (genError instanceof Error && genError.message.includes("Field required")) {
          errorDetails.validationError = true;
          errorDetails.errorPattern = genError.message;
        }

        logger.error("generateText call failed", errorDetails);
        throw genError;
      }

      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Use actual AI SDK tool response data
      const toolResponse = {
        text: result.text,
        toolCalls: result.toolCalls || [],
        toolResults: result.toolResults || [],
        steps: result.steps || [],
      };

      // Add telemetry attributes from generation result
      span?.setAttribute("llm.response_length", result.text.length);
      span?.setAttribute("llm.finish_reason", result.finishReason || "unknown");
      span?.setAttribute("llm.tool_calls_count", toolResponse.toolCalls.length);
      span?.setAttribute("llm.steps_count", toolResponse.steps.length);

      // Add token usage if available
      if (result.usage) {
        span?.setAttribute("llm.input_tokens", result.usage.promptTokens);
        span?.setAttribute("llm.output_tokens", result.usage.completionTokens);
        span?.setAttribute("llm.total_tokens", result.usage.totalTokens);
      }

      // Track tool usage for each call
      if (toolResponse.toolCalls.length > 0) {
        const toolNames = toolResponse.toolCalls.map((call) => call.toolName);
        span?.setAttribute("llm.tools_used", toolNames);

        // Create child spans for individual tool calls
        for (const toolCall of toolResponse.toolCalls) {
          const serverName = options.mcpServers?.find((server) =>
            toolCall.toolName.includes(server)
          ) || "unknown";

          await mcpSpanCreator(serverName, "tool_call", async (toolSpan: any) => {
            toolSpan?.setAttribute("mcp.tool_name", toolCall.toolName);
            toolSpan?.setAttribute("mcp.tool_call_id", toolCall.toolCallId);
            if (toolCall.args) {
              toolSpan?.setAttribute("mcp.tool_args_size", JSON.stringify(toolCall.args).length);
            }
          }, {
            toolsUsed: [toolCall.toolName],
          });
        }
      }

      logger.debug("LLM generation with MCP tools completed", {
        operation: options.operationContext?.operation || "tool_generation",
        provider: config.provider,
        model: config.model,
        duration,
        toolCallCount: toolResponse.toolCalls.length,
        stepCount: toolResponse.steps.length,
        responseLength: result.text.length,
        finishReason: result.finishReason,
        usage: result.usage,
        ...options.operationContext,
      });

      return toolResponse;
    } catch (error) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      logger.error("LLM generation with MCP tools failed", {
        operation: options.operationContext?.operation || "tool_generation",
        provider: config.provider,
        model: config.model,
        duration,
        mcpServerCount: options.mcpServers?.length || 0,
        toolCount: Object.keys(allTools).length,
        toolNames: Object.keys(allTools),
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        fullError: String(error),
        cause: error instanceof Error && (error as any).cause
          ? String((error as any).cause)
          : undefined,
        responseBody: error instanceof Error && (error as any).response
          ? JSON.stringify((error as any).response)
          : undefined,
        ...options.operationContext,
      });

      throw error;
    }
  }

  /**
   * Dispose MCP resources
   */
  static async disposeMCPResources(): Promise<void> {
    try {
      await this.mcpManager.dispose();
      logger.info("MCP resources disposed", {
        operation: "mcp_cleanup",
      });
    } catch (error) {
      logger.error("Failed to dispose MCP resources", {
        operation: "mcp_cleanup",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get MCP server status
   * @returns Map of server IDs to connection status
   */
  static getMCPServerStatus(): Map<string, boolean> {
    return this.mcpManager.getServerStatus();
  }

  /**
   * List registered MCP servers
   * @returns Array of server IDs
   */
  static listMCPServers(): string[] {
    return this.mcpManager.listServers();
  }

  /**
   * Get supported providers
   */
  static getSupportedProviders(): readonly string[] {
    return LLMProviderSchema.options;
  }

  /**
   * Update default configuration
   */
  static updateDefaultConfig(config: Partial<LLMConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Clear client cache
   */
  static clearClients(): void {
    this.clients.clear();
  }
}
