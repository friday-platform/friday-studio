import process from "node:process";
import { logger } from "@atlas/logger";
import { APICallError, generateText } from "ai";
import { registry } from "./registry.ts";
import { traceModel } from "./tracing.ts";

// Groq is preferred for speed/cost, but falls back to Haiku when no Groq key is available
const GROQ_MODEL = "groq:openai/gpt-oss-120b";
const FALLBACK_MODEL = "anthropic:claude-haiku-4-5";

function getSmallModel(): typeof GROQ_MODEL | typeof FALLBACK_MODEL {
  if (process.env.LITELLM_API_KEY || process.env.GROQ_API_KEY) {
    return GROQ_MODEL;
  }
  return FALLBACK_MODEL;
}

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
      model: traceModel(registry.languageModel(getSmallModel())),
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
