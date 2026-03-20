import { logger } from "@atlas/logger";
import { APICallError, generateText } from "ai";
import { registry } from "./registry.ts";
import { traceModel } from "./tracing.ts";

// Default model for small/fast LLM tasks - routes through LiteLLM when configured
const SMALL_LLM_MODEL = "groq:openai/gpt-oss-120b";

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
      model: traceModel(registry.languageModel(SMALL_LLM_MODEL)),
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt },
      ],
      abortSignal: params.abortSignal,
      temperature: 0.4,
      maxOutputTokens: params.maxOutputTokens ?? 250,
    });
    return result.text;
  } catch (e) {
    // 400s from the LiteLLM proxy or upstream providers (budget exceeded, model not
    // found, parameter rejection, gpt-oss tool hallucination, etc.) are logged at
    // warn to avoid Sentry noise. Call sites must handle errors with fallbacks.
    if (APICallError.isInstance(e) && e.statusCode === 400) {
      logger.warn("Small LLM request rejected (400)", { error: e });
      throw e;
    }
    logger.error("Small LLM failed", { error: e });
    throw e;
  }
}
