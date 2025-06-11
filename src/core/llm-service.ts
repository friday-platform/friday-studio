import { createAnthropic } from "npm:@ai-sdk/anthropic";
import { type CoreMessage, generateText, streamText } from "npm:ai";
import { logger } from "../utils/logger.ts";

export interface LLMConfig {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface LLMGenerationOptions {
  includeMemoryContext?: boolean;
  systemPrompt?: string;
  memoryContext?: string;
}

/**
 * Centralized service for LLM generation across Atlas
 * Consolidates Anthropic client initialization and common generation patterns
 */
export class LLMService {
  private static anthropicClient?: any;
  private static defaultConfig: LLMConfig = {
    model: Deno.env.get("ATLAS_DEFAULT_MODEL") || "claude-4-sonnet-20250514",
    maxTokens: 4000,
    temperature: 0.7,
  };

  /**
   * Get or create Anthropic client with consistent configuration
   */
  private static getAnthropicClient(config?: LLMConfig): any {
    if (!this.anthropicClient) {
      const apiKey = config?.apiKey || Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is required");
      }

      this.anthropicClient = createAnthropic({
        apiKey,
      });
    }
    return this.anthropicClient;
  }

  /**
   * Generate text with standardized error handling and logging
   */
  static async generateText(
    userPrompt: string,
    options: LLMGenerationOptions & LLMConfig = {},
  ): Promise<string> {
    const startTime = Date.now();
    const config = { ...this.defaultConfig, ...options };

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutMs = options.timeout || 30000; // 30 second default timeout
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const anthropic = this.getAnthropicClient(config);

      // Build messages array
      const messages: CoreMessage[] = [];

      // Add system context if provided
      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      // Add memory context if provided
      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      const { text } = await generateText({
        model: anthropic(config.model!),
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      logger.debug("LLM generation completed", {
        model: config.model,
        duration,
        promptLength: userPrompt.length,
        responseLength: text.length,
      });

      return text;
    } catch (error) {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it was a timeout
      if (error instanceof Error && error.name === "AbortError") {
        logger.error("LLM generation timed out", {
          model: config.model,
          duration,
          timeoutMs,
          promptLength: userPrompt.length,
        });
        throw new Error(`LLM generation timed out after ${timeoutMs}ms`);
      }

      logger.error("LLM generation failed", {
        model: config.model,
        duration,
        error: errorMessage,
        promptLength: userPrompt.length,
      });

      throw new Error(`LLM generation failed: ${errorMessage}`);
    }
  }

  /**
   * Generate streaming text with standardized patterns
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMGenerationOptions & LLMConfig = {},
  ): AsyncGenerator<string> {
    const startTime = Date.now();
    const config = { ...this.defaultConfig, ...options };

    try {
      const anthropic = this.getAnthropicClient(config);

      // Build messages array
      const messages: CoreMessage[] = [];

      // Add system context if provided
      if (options.systemPrompt) {
        messages.push({
          role: "system",
          content: options.systemPrompt,
        });
      }

      // Add memory context if provided
      let contextualPrompt = userPrompt;
      if (options.memoryContext) {
        contextualPrompt = `${options.memoryContext}\n\nUser request: ${userPrompt}`;
      }

      messages.push({
        role: "user",
        content: contextualPrompt,
      });

      const { textStream } = await streamText({
        model: anthropic(config.model!),
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
        model: config.model,
        duration,
        promptLength: userPrompt.length,
        responseLength: totalLength,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error("LLM streaming failed", {
        model: config.model,
        duration,
        error: errorMessage,
        promptLength: userPrompt.length,
      });

      throw new Error(`LLM streaming failed: ${errorMessage}`);
    }
  }

  /**
   * Analyze intent using LLM with standardized prompting
   */
  static async analyzeIntent(
    signal: any,
    payload: any,
    config?: LLMConfig,
  ): Promise<{ intent: string; goals: string[]; strategy: string }> {
    const systemPrompt =
      `You are a WorkspaceSupervisor analyzing incoming signals to understand user intent.

Analyze the signal and payload to determine:
1. The user's primary intent
2. Specific goals they want to achieve
3. The best strategy to accomplish these goals

Return your analysis as JSON with this structure:
{
  "intent": "brief description of user intent",
  "goals": ["goal1", "goal2", "goal3"],
  "strategy": "recommended approach"
}`;

    const userPrompt = `Signal: ${JSON.stringify(signal)}
Payload: ${JSON.stringify(payload)}

Please analyze this signal and provide your assessment.`;

    try {
      const response = await this.generateText(userPrompt, {
        systemPrompt,
        ...config,
      });

      return JSON.parse(response);
    } catch (error) {
      logger.error("Intent analysis failed", { error });

      // Fallback response
      return {
        intent: "Process user request",
        goals: ["Complete the requested task"],
        strategy: "Sequential agent execution",
      };
    }
  }

  /**
   * Update default configuration
   */
  static updateDefaultConfig(config: Partial<LLMConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Clear client cache (useful for config changes)
   */
  static clearClient(): void {
    this.anthropicClient = undefined;
  }
}
