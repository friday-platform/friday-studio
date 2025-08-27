import { targetedResearchAgent } from "@atlas/bundled-agents";
import { evalite } from "evalite";
import { AgentContextAdapter } from "../lib/context.ts";
import { llmScorer } from "../lib/llm-scorer.ts";

// Define test case type
type TestCase = { prompt: string; expected: string; mockTools?: string[] };

// Run the evaluation
evalite("Targeted research agent", {
  data: () => {
    const cases: TestCase[] = [];

    // Add edge cases
    cases.push(
      {
        prompt:
          "Find me good Airbnbs in either Boulder, CO or Mexico City that can fit 4 people, focus on trendy neighborhoods.",
        expected: "Airbnbs in Boulder or Mexico City that can fit 4 people",
      },
      {
        prompt:
          "What are recent trends on gravel bikes with wide tire clearance? Look on reddit. Start with /r/gravelcycling, /r/bikepacking, and /r/cyclocross",
        expected: "A summary of posts about gravel bikes with wide tire clearance",
      },
    );

    // Return in evalite format
    return cases.map((tc) => ({ input: tc, expected: tc.expected }));
  },

  task: async (input: TestCase) => {
    // Create context
    const adapter = new AgentContextAdapter();
    const context = adapter.createContext();

    try {
      const start = performance.now();
      const result = await targetedResearchAgent.execute(input.prompt, context);
      const duration = performance.now() - start;
      return { output: result, success: true, duration_ms: duration };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), success: false };
    }
  },

  scorers: [llmScorer],
});
