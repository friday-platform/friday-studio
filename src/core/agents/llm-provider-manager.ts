import { type AnthropicProvider, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { type CoreMessage, generateText, streamText } from "ai";
import { z } from "zod";
import { logger } from "../../utils/logger.ts";

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

export type LLMProvider = z.infer<typeof LLMProviderSchema>;
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
export type LLMGenerationOptions = z.infer<typeof LLMGenerationOptionsSchema>;

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
export class LLMProviderManager {
  private static clients: Map<string, ProviderClient> = new Map();

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
    const startTime = Date.now();

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

      const { text } = await generateText({
        model: client(modelToUse),
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      logger.debug("LLM generation completed", {
        operation: options.operationContext?.operation || "unknown",
        provider: config.provider,
        model: modelToUse,
        duration,
        promptLength: userPrompt.length,
        responseLength: text.length,
        ...options.operationContext,
      });

      return text;
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
