/**
 * LLM-as-judge scorer for semantic evaluation.
 *
 * Uses a fast model (Groq) to evaluate agent output against criteria,
 * returning a normalized 0-1 score with justification.
 */

import { repairJson } from "@atlas/agent-sdk";
import { registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import { generateObject } from "ai";
import { z } from "zod";
import { createScore, type Score } from "./scoring.ts";

const evaluationSchema = z.object({
  score: z.number().min(0).max(1).describe("0-1, how well output meets criteria"),
  justification: z.string().describe("Reasoning for the score"),
});

/**
 * Evaluates output against criteria using an LLM judge.
 *
 * @param output - The agent's output to evaluate
 * @param criteria - The criteria to evaluate against
 * @returns Score with justification in metadata
 */
export async function llmJudge(output: unknown, criteria: string): Promise<Score> {
  const { object } = await generateObject({
    model: traceModel(registry.languageModel("groq:openai/gpt-oss-120b")),
    schema: evaluationSchema,
    experimental_repairText: repairJson,
    maxOutputTokens: 2000,
    messages: [
      {
        role: "system",
        content: `You are an AI agent evaluator. Rate outputs from 0 to 1 based on how well they meet the criteria.

Score 0 = completely fails to meet criteria
Score 1 = fully meets criteria
Use decimal values (e.g., 0.7, 0.85) for partial matches.`,
      },
      temporalGroundingMessage(),
      {
        role: "user",
        content: `<criteria>${criteria}</criteria>
<output>${JSON.stringify(output, null, 2)}</output>`,
      },
    ],
  });

  return {
    ...createScore("LLMJudge", object.score),
    metadata: { justification: object.justification },
  };
}
