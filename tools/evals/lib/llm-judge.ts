import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod/v4";

const evaluationSchema = z.object({
  pass: z.boolean().describe("Did the agent meet the given criteria"),
  justification: z.string().describe("A detailed justification for the grade"),
});

export type Evaluation = z.infer<typeof evaluationSchema>;

type LLMJudgeInput = { criteria: string; agentOutput: unknown };

export async function llmJudge(input: LLMJudgeInput): Promise<Evaluation> {
  const { object } = await generateObject({
    model: anthropic("claude-3-5-haiku-latest"),
    schema: evaluationSchema,
    prompt: `
    <identity>
    You are an expert AI agent evaluator. Evaluate the following output from an AI agent its effectiveness at meeting the following criteria:
    </identity>

    <judging_criteria>
    ${input.criteria}
    </judging_criteria>

    <agent_output>
    ${JSON.stringify(input.agentOutput, null, 2)}
    </agent_output>

    <grading_criteria>
    Did the agent meet the given criteria in a coherent manner? Provide a justification.
    </grading_criteria>
    `,
  });
  return object;
}
