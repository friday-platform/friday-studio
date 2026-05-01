import { logger } from "@atlas/logger";
import { APICallError, generateText } from "ai";
import type { PlatformModels } from "./platform-models.ts";

/**
 * Fast, small LLM for progress messages, titles, and short summaries.
 * Resolves via the injected `platformModels.get("labels")` — all provider
 * selection and credential fallback lives in `createPlatformModels`.
 */
export async function smallLLM(params: {
  platformModels: PlatformModels;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
}): Promise<string> {
  try {
    const result = await generateText({
      model: params.platformModels.get("labels"),
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
    // warn. Call sites must handle errors with fallbacks.
    if (APICallError.isInstance(e) && e.statusCode === 400) {
      logger.warn("Small LLM request rejected (400)", { error: e });
      throw e;
    }
    logger.error("Small LLM failed", { error: e });
    throw e;
  }
}
