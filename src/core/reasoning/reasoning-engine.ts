import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { logger } from "../../utils/logger.ts";
import { ChainOfThoughtReasoning } from "./chain-of-thought.ts";
import { ReActReasoning } from "./react.ts";
import { SelfRefineReasoning } from "./self-refine.ts";
import type { BaseReasoningMethod, ReasoningContext, ReasoningResult } from "./base-reasoning.ts";

export interface ReasoningEngineConfig {
  defaultMethod?: string;
  enablePatternMatching?: boolean;
  allowLLMSelection?: boolean;
  customMethods?: Record<string, BaseReasoningMethod>;
  selectionModel?: string;
}

export interface ReasoningSelection {
  method: string;
  confidence: number;
  reasoning: string;
}

export class ReasoningEngine {
  private methods = new Map<string, BaseReasoningMethod>();
  private config: ReasoningEngineConfig;
  private model = anthropic("claude-3-5-sonnet-20241022");
  private logger = logger;

  constructor(config: ReasoningEngineConfig = {}) {
    this.config = {
      defaultMethod: "chain-of-thought",
      enablePatternMatching: true,
      allowLLMSelection: true,
      ...config,
    };

    // Register built-in methods
    this.registerMethod("chain-of-thought", new ChainOfThoughtReasoning());
    this.registerMethod("react", new ReActReasoning());
    this.registerMethod("self-refine", new SelfRefineReasoning());

    // Register custom methods if provided
    if (config.customMethods) {
      for (const [name, method] of Object.entries(config.customMethods)) {
        this.registerMethod(name, method);
      }
    }
  }

  registerMethod(name: string, method: BaseReasoningMethod): void {
    this.methods.set(name, method);
    this.logger.info("Registered reasoning method", { method: name });
  }

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    // Step 1: Select the best reasoning method
    const selection = await this.selectMethod(context);

    // Step 2: Get the method and execute
    const method = this.methods.get(selection.method);
    if (!method) {
      throw new Error(`Unknown reasoning method: ${selection.method}`);
    }

    // Step 3: Check if we can skip expensive reasoning
    if (method.canSkip(context)) {
      this.logger.info("Skipping expensive reasoning (fast path)", { method: selection.method });
      return this.createFastPathResult(context, method);
    }

    // Step 4: Execute the selected method
    this.logger.info("Executing reasoning method", {
      method: selection.method,
      confidence: selection.confidence,
    });

    const result = await method.reason(context);

    // Add selection metadata
    return {
      ...result,
      selectionReasoning: selection.reasoning,
      selectionConfidence: selection.confidence,
    };
  }

  private async selectMethod(context: ReasoningContext): Promise<ReasoningSelection> {
    // Use configured default if LLM selection is disabled
    if (!this.config.allowLLMSelection) {
      return {
        method: this.config.defaultMethod!,
        confidence: 1.0,
        reasoning: "Using configured default method",
      };
    }

    // Use heuristics by default - no LLM call for method selection
    return this.selectMethodHeuristically(context);
  }

  private selectMethodHeuristically(context: ReasoningContext): ReasoningSelection {
    // Fallback heuristic selection
    let method = this.config.defaultMethod!;
    let reasoning = "Using heuristic selection: ";

    if (context.qualityCritical) {
      method = "self-refine";
      reasoning += "Quality critical task requires iterative refinement";
    } else if (context.requiresToolUse) {
      method = "react";
      reasoning += "Tool use requires reasoning-action-observation loops";
    } else if (context.complexity < 0.4) {
      method = "chain-of-thought";
      reasoning += "Simple task suitable for step-by-step reasoning";
    } else {
      method = "self-refine";
      reasoning += "Complex task benefits from iterative improvement";
    }

    return {
      method,
      confidence: 0.8,
      reasoning,
    };
  }

  private getMethodDescription(name: string): string {
    const descriptions = {
      "chain-of-thought": "Step-by-step reasoning for clear problem solving",
      "react": "Reasoning → Action → Observation loops for tool use and debugging",
      "self-refine": "Generate → Critique → Improve cycles for high-quality outputs",
    };
    return descriptions[name as keyof typeof descriptions] || "Custom reasoning method";
  }

  private createFastPathResult(
    context: ReasoningContext,
    method: BaseReasoningMethod,
  ): ReasoningResult {
    return {
      solution: {
        type: "fast-path",
        message: "Task was simple enough to skip expensive reasoning",
        context,
      },
      reasoning: "Fast path taken - task complexity below threshold",
      confidence: 0.95,
      method: method.name + "-fast",
      cost: 0,
      duration: 0,
    };
  }

  getAvailableMethods(): string[] {
    return Array.from(this.methods.keys());
  }

  getMethodInfo(name: string): { cost: string; reliability: number } | null {
    const method = this.methods.get(name);
    return method ? { cost: method.cost, reliability: method.reliability } : null;
  }
}
