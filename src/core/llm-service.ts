import {
  type LLMConfig,
  type LLMGenerationOptions,
  LLMProviderManager,
} from "./agents/llm-provider-manager.ts";
import { logger } from "../utils/logger.ts";

/**
 * Centralized service for LLM generation across Atlas
 * Now delegates to LLMProviderManager for multi-provider support
 */
export class LLMService {
  /**
   * Generate text with multi-provider support
   */
  static async generateText(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> & {
      operationContext?: { operation: string; [key: string]: any };
    } = {},
  ): Promise<string> {
    return await LLMProviderManager.generateText(userPrompt, options);
  }

  /**
   * Generate streaming text with multi-provider support
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> = {},
  ): AsyncGenerator<string> {
    yield* LLMProviderManager.generateTextStream(userPrompt, options);
  }

  /**
   * Analyze intent using LLM with standardized prompting
   */
  static async analyzeIntent(
    signal: any,
    payload: any,
    config?: Partial<LLMConfig>,
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
    LLMProviderManager.updateDefaultConfig(config);
  }

  /**
   * Clear client cache (useful for config changes)
   */
  static clearClient(): void {
    LLMProviderManager.clearClients();
  }
}
