import {
  BaseReasoningMethod,
  type ReasoningContext,
  type ReasoningResult,
} from "./base-reasoning.ts";

export class SelfRefineReasoning extends BaseReasoningMethod {
  name = "self-refine";
  cost = "medium" as const;
  reliability = 0.89;

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    let totalCost = 0;
    let totalDuration = 0;
    const refinements: any[] = [];

    // Generate initial solution
    const initialPrompt = `
Task: ${context.task}
Context: ${context.context}

Generate an initial solution to this task. Focus on correctness and completeness.
Initial Solution:`;

    const initialResult = await this.generateLLM(initialPrompt);
    totalCost += initialResult.cost;
    totalDuration += initialResult.duration;

    let currentSolution = initialResult.text.trim();
    refinements.push({ iteration: 0, solution: currentSolution, critique: "Initial solution" });

    // Iterative refinement (3 iterations max)
    for (let iteration = 1; iteration <= 3; iteration++) {
      // Critique current solution
      const critiquePrompt = `
Task: ${context.task}
Current Solution: ${currentSolution}

Critically analyze this solution. What are its weaknesses? What could be improved?
Is it good enough as-is, or does it need refinement?

Critique:`;

      const critiqueResult = await this.generateLLM(critiquePrompt);
      totalCost += critiqueResult.cost;
      totalDuration += critiqueResult.duration;

      const critique = critiqueResult.text.trim();

      // Check if good enough
      if (this.isGoodEnough(critique)) {
        refinements.push({ iteration, critique, solution: currentSolution, status: "accepted" });
        break;
      }

      // Improve based on critique
      const improvePrompt = `
Task: ${context.task}
Current Solution: ${currentSolution}
Critique: ${critique}

Based on this critique, provide an improved solution that addresses the identified issues.
Improved Solution:`;

      const improveResult = await this.generateLLM(improvePrompt);
      totalCost += improveResult.cost;
      totalDuration += improveResult.duration;

      currentSolution = improveResult.text.trim();
      refinements.push({
        iteration,
        critique,
        solution: currentSolution,
        status: "refined",
      });
    }

    return {
      solution: {
        type: "self-refined-solution",
        finalSolution: currentSolution,
        refinements,
        iterationCount: refinements.length,
      },
      reasoning: refinements.map((r) =>
        `Iteration ${r.iteration}: ${r.critique} → ${r.solution.substring(0, 100)}...`
      ).join("\n"),
      confidence: 0.89,
      method: this.name,
      cost: totalCost,
      duration: totalDuration,
    };
  }

  private isGoodEnough(critique: string): boolean {
    const goodIndicators = [
      "good enough",
      "satisfactory",
      "adequate",
      "no major issues",
      "acceptable",
      "well done",
      "solid solution",
    ];

    const lowerCritique = critique.toLowerCase();
    return goodIndicators.some((indicator) => lowerCritique.includes(indicator));
  }
}
