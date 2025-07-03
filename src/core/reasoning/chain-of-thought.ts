import {
  BaseReasoningMethod,
  type ReasoningContext,
  type ReasoningResult,
} from "./base-reasoning.ts";

export interface ChainOfThoughtStep {
  step: number;
  description: string;
  reasoning: string;
  dependencies?: number[]; // Which previous steps this depends on
  requiredInfo?: string[]; // What information is needed
}

/**
 * Chain-of-Thought reasoning breaks down complex problems into logical steps.
 * It provides step-by-step thinking without execution.
 */
export class ChainOfThoughtReasoning extends BaseReasoningMethod {
  name = "chain-of-thought";
  cost = "low" as const;
  reliability = 0.85;

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    const startTime = Date.now();

    const prompt = `Break down this problem using step-by-step reasoning.

Task: ${context.task}
Context: ${context.context}

Provide a structured analysis as a JSON array of steps:
[
  {
    "step": 1,
    "description": "What needs to be done",
    "reasoning": "Why this step is necessary",
    "dependencies": [],
    "requiredInfo": ["What information/capability this step needs"]
  },
  ...
]

Considerations:
- Complexity: ${context.complexity}
- Quality Critical: ${context.qualityCritical}
- Break down into 3-7 logical steps
- Identify dependencies between steps
- Focus on the reasoning process, not implementation`;

    const result = await this.generateLLM(prompt);

    try {
      const steps: ChainOfThoughtStep[] = JSON.parse(result.text);

      // Extract insights from the chain of thought
      const requiredCapabilities = this.extractRequiredCapabilities(steps);
      const recommendations = this.generateRecommendations(steps);

      return {
        solution: {
          thoughtChain: steps,
          summary: `${steps.length}-step logical breakdown of the problem`,
          criticalPath: this.findCriticalPath(steps),
        },
        reasoning: steps.map((s) => `Step ${s.step}: ${s.description} (${s.reasoning})`).join("\n"),
        confidence: this.calculateChainConfidence(steps),
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
          thoughtChain: [
            {
              step: 1,
              description: "Analyze the problem",
              reasoning: "Need to understand requirements",
              dependencies: [],
              requiredInfo: ["Problem context"],
            },
            {
              step: 2,
              description: "Execute solution",
              reasoning: "Apply appropriate approach",
              dependencies: [1],
              requiredInfo: ["Execution capability"],
            },
          ],
          summary: "Basic 2-step approach",
        },
        reasoning: "Simplified chain-of-thought analysis",
        confidence: 0.6,
        method: this.name,
        cost: result.cost,
        duration: Date.now() - startTime,
        requiredCapabilities: ["analysis", "execution"],
        recommendations: ["Analyze then execute"],
      };
    }
  }

  override canSkip(context: ReasoningContext): boolean {
    // Skip CoT for very simple tasks
    return context.complexity < 0.2;
  }

  private extractRequiredCapabilities(steps: ChainOfThoughtStep[]): string[] {
    const capabilities = new Set<string>();

    steps.forEach((step) => {
      step.requiredInfo?.forEach((info) => {
        // Map information needs to capabilities
        if (info.includes("file") || info.includes("code")) {
          capabilities.add("file-access");
        }
        if (info.includes("web") || info.includes("search")) {
          capabilities.add("web-search");
        }
        if (info.includes("database") || info.includes("query")) {
          capabilities.add("database-access");
        }
        if (info.includes("analyze") || info.includes("process")) {
          capabilities.add("computation");
        }
      });
    });

    return Array.from(capabilities);
  }

  private generateRecommendations(steps: ChainOfThoughtStep[]): string[] {
    return steps.map((s) => s.description);
  }

  private findCriticalPath(steps: ChainOfThoughtStep[]): number[] {
    // Simple critical path: steps with no dependents
    const dependents = new Set<number>();
    steps.forEach((s) => s.dependencies?.forEach((d) => dependents.add(d)));

    return steps
      .filter((s) => !dependents.has(s.step))
      .map((s) => s.step);
  }

  private calculateChainConfidence(steps: ChainOfThoughtStep[]): number {
    let confidence = 0.7;

    // Bonus for clear dependencies
    const withDeps = steps.filter((s) => s.dependencies && s.dependencies.length > 0).length;
    confidence += (withDeps / steps.length) * 0.15;

    // Bonus for specific information needs
    const withInfo = steps.filter((s) => s.requiredInfo && s.requiredInfo.length > 0).length;
    confidence += (withInfo / steps.length) * 0.15;

    return Math.min(confidence, 1.0);
  }
}
