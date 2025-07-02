import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { logger } from "../../utils/logger.ts";

export interface ReasoningContext {
  task: string;
  context: string;
  complexity: number; // 0-1 scale
  requiresToolUse: boolean;
  qualityCritical: boolean;
  agentType: "workspace" | "session" | "agent";
  previousResults?: any[];
}

export interface ReasoningResult {
  solution: any; // Method-specific solution format
  reasoning: string; // Human-readable reasoning trace
  confidence: number;
  method: string;
  cost: number;
  duration: number;
  requiredCapabilities?: string[]; // What capabilities/tools are needed
  recommendations?: string[]; // Actionable recommendations
  selectionReasoning?: string;
  selectionConfidence?: number;
}

export abstract class BaseReasoningMethod {
  abstract name: string;
  abstract cost: "low" | "medium" | "high";
  abstract reliability: number;

  protected logger = logger;
  protected model = anthropic("claude-3-5-sonnet-20241022");

  abstract reason(context: ReasoningContext): Promise<ReasoningResult>;

  canSkip(context: ReasoningContext): boolean {
    return false;
  }

  protected async generateLLM(
    prompt: string,
  ): Promise<{ text: string; cost: number; duration: number }> {
    const startTime = Date.now();

    const result = await generateText({
      model: this.model,
      prompt,
      temperature: 0.1,
      maxTokens: 2000,
    });

    const duration = Date.now() - startTime;
    const cost = this.estimateCost(result.text.length);

    return {
      text: result.text,
      cost,
      duration,
    };
  }

  private estimateCost(outputTokens: number): number {
    // Rough cost estimation for Claude 3.5 Sonnet
    const inputCost = 0.003; // per 1k tokens
    const outputCost = 0.015; // per 1k tokens
    const inputTokens = 1000; // rough estimate

    return ((inputTokens * inputCost) + (outputTokens * outputCost)) / 1000;
  }
}
