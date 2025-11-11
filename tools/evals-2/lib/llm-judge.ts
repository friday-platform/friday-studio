import { anthropic } from "@atlas/llm";
import { generateObject } from "ai";
import { createScorer } from "evalite";
import { z } from "zod";

const evaluationSchema = z.object({
  pass: z.boolean().describe("Did the agent meet the given criteria"),
  justification: z.string().describe("A detailed justification for the grade"),
});

export type Evaluation = z.infer<typeof evaluationSchema>;

/**
 * LLM Judge scorer using Claude Haiku 4.5.
 *
 * Usage:
 * - input: The original input to the agent (optional, not used in evaluation)
 * - expected: The criteria to evaluate against
 * - output: The agent's output to be evaluated
 *
 * Returns:
 * - score: 1 if the agent met the criteria, 0 otherwise
 * - metadata.justification: Detailed explanation of the evaluation
 */
export const LLMJudge = createScorer<unknown, unknown, string>({
  name: "LLMJudge",
  scorer: async ({ expected, output }) => {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: evaluationSchema,
      prompt: `
    <identity>
    You are an AI agent evaluator. Evaluate the following output from an AI agent its effectiveness at meeting the following criteria:
    </identity>

    <judging_criteria>
    ${expected}
    </judging_criteria>

    <agent_output>
    ${JSON.stringify(output, null, 2)}
    </agent_output>

    <grading_criteria>
    Did the agent meet the given criteria in a coherent manner? Provide a justification.
    </grading_criteria>
    `,
    });

    return { score: object.pass ? 1 : 0, metadata: { justification: object.justification } };
  },
});
