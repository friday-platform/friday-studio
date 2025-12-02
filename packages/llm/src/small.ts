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
  const result = await generateText({
    model: wrapAISDKModel(groq("llama-3.1-8b-instant")),
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.prompt },
    ],
    abortSignal: params.abortSignal,
    temperature: 0.4,
    maxOutputTokens: params.maxOutputTokens ?? 100,
  });
  return result.text;
}
