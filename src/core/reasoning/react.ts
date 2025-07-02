import {
  BaseReasoningMethod,
  type ReasoningContext,
  type ReasoningResult,
} from "./base-reasoning.ts";

export interface ReActThought {
  thought: string;
  actionType: string; // Type of action needed (e.g., "analyze", "search", "read", "modify")
  requiredCapability: string; // What capability is needed (e.g., "file-access", "web-search")
  expectedInfoNeeded: string; // What information this action should provide
}

/**
 * ReAct (Reasoning + Acting) provides a thinking strategy for problems that require
 * interleaved reasoning and action. It generates thought-action pairs that describe
 * how to approach a problem, without executing anything.
 */
export class ReActReasoning extends BaseReasoningMethod {
  name = "react";
  cost = "low" as const; // Single LLM call
  reliability = 0.92;

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    const startTime = Date.now();

    // Generate ReAct-style reasoning about the problem
    const reasoningPrompt =
      `You are helping solve a problem using ReAct (Reasoning + Acting) methodology.

Task: ${context.task}
Context: ${context.context}

Think through this problem step by step. For each step:
1. Describe your current thought/reasoning
2. Identify what type of action would help (e.g., "search", "read", "analyze", "modify")
3. What capability is needed (e.g., "file-access", "code-analysis", "web-search")
4. What information you expect to gain

Considerations:
- Problem complexity: ${context.complexity} (0-1 scale)
- Quality critical: ${context.qualityCritical}
- Tool use likely needed: ${context.requiresToolUse}

Provide your reasoning as a JSON array of thought steps:
[
  {
    "thought": "First, I need to understand X because Y",
    "actionType": "search",
    "requiredCapability": "file-access",
    "expectedInfoNeeded": "List of files containing Z"
  },
  ...
]

Generate 2-5 thought steps based on the problem complexity. Focus on the reasoning process, not implementation details.`;

    const result = await this.generateLLM(reasoningPrompt);

    try {
      const thoughtSteps: ReActThought[] = JSON.parse(result.text);

      // Extract required capabilities and recommendations
      const requiredCapabilities = [...new Set(thoughtSteps.map((s) => s.requiredCapability))];
      const recommendations = thoughtSteps.map((s) => `${s.actionType}: ${s.expectedInfoNeeded}`);

      return {
        solution: {
          thoughtProcess: thoughtSteps,
          summary:
            `ReAct analysis identified ${thoughtSteps.length} steps requiring ${requiredCapabilities.length} different capabilities`,
        },
        reasoning: thoughtSteps.map((s, i) =>
          `Step ${i + 1}: ${s.thought} [Needs: ${s.actionType} via ${s.requiredCapability}]`
        ).join("\n"),
        confidence: this.calculateConfidence(thoughtSteps),
        method: this.name,
        cost: result.cost,
        duration: Date.now() - startTime,
        requiredCapabilities,
        recommendations,
      };
    } catch (error) {
      // Fallback for parsing errors
      return {
        solution: {
          thoughtProcess: [{
            thought: "Need to analyze and solve the given task",
            actionType: "analyze",
            requiredCapability: "general-processing",
            expectedInfoNeeded: "Understanding of the task requirements",
          }],
          summary: "Basic analysis required",
        },
        reasoning: "Single-step analysis of the task",
        confidence: 0.6,
        method: this.name,
        cost: result.cost,
        duration: Date.now() - startTime,
        requiredCapabilities: ["general-processing"],
        recommendations: ["Analyze the task requirements"],
      };
    }
  }

  private calculateConfidence(steps: ReActThought[]): number {
    // Higher confidence if steps are well-defined and build on each other
    let confidence = 0.7;

    // Bonus for clear action types
    const clearActions =
      steps.filter((s) => ["search", "read", "analyze", "modify", "verify"].includes(s.actionType))
        .length;
    confidence += (clearActions / steps.length) * 0.2;

    // Bonus for specific capabilities
    const specificCapabilities =
      steps.filter((s) => s.requiredCapability !== "general-processing").length;
    confidence += (specificCapabilities / steps.length) * 0.1;

    return Math.min(confidence, 1.0);
  }
}
