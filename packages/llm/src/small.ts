import { logger } from "@atlas/logger";
import { generateText } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { registry } from "./registry.ts";

// Default model for small/fast LLM tasks - routes through LiteLLM when configured
const SMALL_LLM_MODEL = "groq:meta-llama/llama-4-maverick-17b-128e-instruct";

/**
 * Fast, small LLM for progress messages and summaries.
 * Routes through LiteLLM proxy when LITELLM_API_KEY is configured.
 */
export async function smallLLM(params: {
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
}): Promise<string> {
  try {
    const result = await generateText({
      model: wrapAISDKModel(registry.languageModel(SMALL_LLM_MODEL)),
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
    logger.error("Small LLM failed", { error: e });
    throw e;
  }
}
