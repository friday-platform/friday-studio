import { repairJson } from "@atlas/agent-sdk";
import { registry } from "@atlas/llm";
import { getTodaysDate } from "@atlas/utils";
import { generateObject } from "ai";
import { createScorer } from "evalite";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";

const evaluationSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Quality score from 0 to 1, where 0 is completely fails criteria and 1 is fully meets criteria",
    ),
  justification: z.string().describe("A detailed justification for the score"),
});

export type Evaluation = z.infer<typeof evaluationSchema>;

/**
 * LLM Judge scorer using GPT-OSS-120B via Groq.
 *
 * Usage:
 * - input: The original input to the agent (optional, not used in evaluation)
 * - expected: The criteria to evaluate against
 * - output: The agent's output to be evaluated
 *
 * Returns:
 * - score: 0-1 continuous score indicating how well criteria was met
 * - metadata.justification: Detailed explanation of the evaluation
 */
export const LLMJudge = createScorer<unknown, unknown, string>({
  name: "LLMJudge",
  scorer: async ({ expected, output }) => {
    const { object } = await generateObject({
      model: wrapAISDKModel(registry.languageModel("groq:openai/gpt-oss-120b")),
      schema: evaluationSchema,
      experimental_repairText: repairJson,
      maxOutputTokens: 2000,
      messages: [
        {
          role: "system",
          content: `
            You are an AI agent evaluator. Rate outputs from 0 to 1 based on how well they meet the criteria.

            Score 0 = completely fails to meet criteria
            Score 1 = fully meets criteria
            Use decimal values (e.g., 0.7, 0.85) for partial matches.`,
        },
        { role: "system", content: `Today: ${getTodaysDate()}` },
        {
          role: "user",
          content: `
            <criteria>${expected}</criteria>
            <output>${JSON.stringify(output, null, 2)}</output>`,
        },
      ],
    });

    return { score: object.score, metadata: { justification: object.justification } };
  },
});
