import {
  BaseReasoningMethod,
  type ReasoningContext,
  type ReasoningResult,
} from "./base-reasoning.ts";

export class ChainOfThoughtReasoning extends BaseReasoningMethod {
  name = "chain-of-thought";
  cost = "low" as const;
  reliability = 0.85;

  async reason(context: ReasoningContext): Promise<ReasoningResult> {
    const prompt = `
Let's think step by step about this task:

Task: ${context.task}
Context: ${context.context}

Step 1: What is the core goal?
Step 2: What are the key constraints?
Step 3: What is the optimal approach?
Step 4: What could go wrong?
Step 5: What is the final plan?

Please provide a clear, step-by-step solution.`;

    const { text, cost, duration } = await this.generateLLM(prompt);

    // Parse the result - look for structured plan
    const solution = this.parseChainOfThought(text);

    return {
      solution,
      reasoning: text,
      confidence: 0.85,
      method: this.name,
      cost,
      duration,
    };
  }

  override canSkip(context: ReasoningContext): boolean {
    // Skip CoT for very simple, pattern-matched tasks
    return context.complexity < 0.2;
  }

  private parseChainOfThought(text: string): any {
    // Extract the final plan/solution from the step-by-step reasoning
    const lines = text.split("\n");
    const planLines = lines.filter((line) =>
      line.toLowerCase().includes("plan") ||
      line.toLowerCase().includes("solution") ||
      line.toLowerCase().includes("approach")
    );

    return {
      type: "chain-of-thought-plan",
      steps: planLines.map((line) => line.trim()).filter((line) => line.length > 0),
      fullReasoning: text,
    };
  }
}
