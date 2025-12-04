import { logger } from "@atlas/logger";
import { generateText } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { createGroqWithOptions } from "./groq.ts";

/**
 * Fast, small LLM for progress messages and summaries.
 */
export async function smallLLM(params: {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
}): Promise<string> {
  const groq = createGroqWithOptions();
  try {
    const result = await generateText({
      model: wrapAISDKModel(groq("meta-llama/llama-4-maverick-17b-128e-instruct")),
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt },
      ],
      abortSignal: params.abortSignal,
      temperature: 0.4,
      maxOutputTokens: params.maxOutputTokens ?? 100,
    });
    return result.text;
  } catch (e) {
    logger.error("Small LL failed", { error: e });
    throw e;
  }
}
