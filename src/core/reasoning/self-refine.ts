import {
  BaseReasoningMethod,
  type ReasoningContext,
  type ReasoningResult,
} from "./base-reasoning.ts";

export interface RefinementStep {
  approach: string;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  qualityCriteria: string[];
}

/**
 * Self-Refine reasoning provides iterative improvement of approaches.
 * It generates, critiques, and refines thinking about a problem.
 */
export class SelfRefineReasoning extends BaseReasoningMethod {
  name = "self-refine";
  cost = "low" as const; // Single LLM call now
  reliability = 0.89;

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    const startTime = Date.now();

    // Single LLM call that does the refinement process internally
    const refinementPrompt = `Analyze this problem using self-refinement methodology.

Task: ${context.task}
Context: ${context.context}

Think through multiple approaches and refine them. For each approach:
1. Describe the approach
2. Identify its strengths
3. Identify its weaknesses  
4. Suggest improvements
5. Define quality criteria for success

Provide your analysis as a JSON array of refinement steps:
[
  {
    "approach": "Initial approach description",
    "strengths": ["What works well"],
    "weaknesses": ["What could be better"],
    "improvements": ["How to make it better"],
    "qualityCriteria": ["How to measure success"]
  },
  ...
]

Considerations:
- Quality Critical: ${context.qualityCritical}
- Complexity: ${context.complexity}
- Generate 2-3 refinement iterations
- Each iteration should improve on the previous`;

    const result = await this.generateLLM(refinementPrompt);

    try {
      const refinements: RefinementStep[] = JSON.parse(result.text);

      // Extract insights from refinements
      const finalApproach = refinements[refinements.length - 1];
      const allImprovements = refinements.flatMap((r) => r.improvements);
      const qualityCriteria = [...new Set(refinements.flatMap((r) => r.qualityCriteria))];

      // Determine required capabilities from the approaches
      const requiredCapabilities = this.extractCapabilitiesFromRefinements(refinements);

      return {
        solution: {
          refinementChain: refinements,
          finalApproach: finalApproach.approach,
          qualityCriteria,
          keyImprovements: allImprovements,
        },
        reasoning: refinements.map((r, i) =>
          `Iteration ${i + 1}: ${r.approach}\nStrengths: ${r.strengths.join(", ")}\nWeaknesses: ${
            r.weaknesses.join(", ")
          }`
        ).join("\n\n"),
        confidence: this.calculateRefinementConfidence(refinements),
        method: this.name,
        cost: result.cost,
        duration: Date.now() - startTime,
        requiredCapabilities,
        recommendations: allImprovements,
      };
    } catch (error) {
      // Fallback
      return {
        solution: {
          refinementChain: [{
            approach: "Direct problem solving",
            strengths: ["Straightforward"],
            weaknesses: ["May miss nuances"],
            improvements: ["Add validation steps"],
            qualityCriteria: ["Task completion"],
          }],
          finalApproach: "Direct problem solving with validation",
          qualityCriteria: ["Task completion", "Validation passed"],
        },
        reasoning: "Single-pass analysis with basic refinement",
        confidence: 0.7,
        method: this.name,
        cost: result.cost,
        duration: Date.now() - startTime,
        requiredCapabilities: ["execution", "validation"],
        recommendations: ["Execute task", "Validate results"],
      };
    }
  }

  private extractCapabilitiesFromRefinements(refinements: RefinementStep[]): string[] {
    const capabilities = new Set<string>();

    refinements.forEach((r) => {
      // Analyze approach text for capability hints
      const text = `${r.approach} ${r.improvements.join(" ")}`;

      if (text.includes("analyze") || text.includes("examine")) {
        capabilities.add("analysis");
      }
      if (text.includes("search") || text.includes("find")) {
        capabilities.add("search");
      }
      if (text.includes("modify") || text.includes("change")) {
        capabilities.add("modification");
      }
      if (text.includes("validate") || text.includes("verify")) {
        capabilities.add("validation");
      }
      if (text.includes("monitor") || text.includes("observe")) {
        capabilities.add("monitoring");
      }
    });

    return Array.from(capabilities);
  }

  private calculateRefinementConfidence(refinements: RefinementStep[]): number {
    if (refinements.length === 0) return 0.5;

    let confidence = 0.7;

    // Bonus for iterative improvement
    if (refinements.length > 1) {
      confidence += 0.1;
    }

    // Bonus for specific quality criteria
    const lastRefinement = refinements[refinements.length - 1];
    if (lastRefinement.qualityCriteria.length > 2) {
      confidence += 0.1;
    }

    // Bonus if weaknesses decrease over iterations
    if (refinements.length > 1) {
      const firstWeaknesses = refinements[0].weaknesses.length;
      const lastWeaknesses = lastRefinement.weaknesses.length;
      if (lastWeaknesses < firstWeaknesses) {
        confidence += 0.1;
      }
    }

    return Math.min(confidence, 1.0);
  }
}
