import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { createScorer } from "evalite";
import { z } from "zod";

export const llmScorer = createScorer({
  name: "LLM Judge",
  description: "LLM evaluates agent response quality",
  scorer: async ({ input, output, expected }) => {
    try {
      const { object } = await generateObject({
        model: anthropic("claude-3-5-sonnet-20241022"),
        prompt: `You are evaluating an AI agent's response quality.

[BEGIN DATA]
************
[User Prompt]: ${input || "No prompt"}
************
[Expected Behavior]: ${expected || "Handle appropriately"}
************
[Agent Response]: ${JSON.stringify(output)}
************
[END DATA]

Evaluate the agent's response based on these criteria:
1. Understanding: Did the agent correctly understand the prompt?
2. Relevance: Is the response relevant and helpful?
3. Tool Usage: Did the agent use appropriate tools if available?
4. Edge Cases: Did the agent handle edge cases gracefully?

Provide a score from 0 to 1 where:
- 0.0-0.2: Poor - Failed to understand or respond appropriately
- 0.2-0.4: Below Average - Partially understood but significant issues
- 0.4-0.6: Average - Basic understanding with some gaps
- 0.6-0.8: Good - Solid response with minor issues
- 0.8-1.0: Excellent - Complete understanding and appropriate response`,
        schema: z.object({
          score: z.number().min(0).max(1).describe("Overall quality score from 0 to 1"),
          rationale: z.string().describe("Detailed explanation of the score"),
          criteria: z.object({
            understanding: z.boolean().describe("Agent understood the prompt"),
            relevance: z.boolean().describe("Response was relevant and helpful"),
            toolUsage: z
              .boolean()
              .nullable()
              .describe("Appropriate tool usage (null if no tools available)"),
            edgeCases: z.boolean().describe("Handled edge cases well"),
          }),
        }),
      });

      return object.score;
    } catch (error) {
      console.error("LLM scorer error:", error);
      // Return 0 for errors instead of null
      return 0;
    }
  },
});
