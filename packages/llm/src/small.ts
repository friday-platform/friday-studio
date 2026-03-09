import { logger } from "@atlas/logger";
import { generateText } from "ai";
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
    logger.error("Small LLM failed", { error: e });
    throw e;
  }
}
