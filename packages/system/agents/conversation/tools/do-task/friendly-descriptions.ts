import { type PlatformModels, smallLLM } from "@atlas/llm";

/**
 * Generate friendly descriptions for all steps in a single batch.
 * Falls back to raw descriptions on error.
 */
export async function generateFriendlyDescriptions(
  platformModels: PlatformModels,
  steps: Array<{ agentId?: string; description: string }>,
  intent: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  if (steps.length === 0) return [];

  try {
    const stepList = steps
      .map((s, i) => `${i + 1}. [${s.agentId || "llm"}] ${s.description}`)
      .join("\n");

    const result = await smallLLM({
      platformModels,
      system:
        "Generate brief, friendly progress messages (≤10 words each) for what an AI assistant is doing. One per line, matching input order. Be specific but concise. No numbering, no punctuation at end. NEVER include UUIDs, artifact IDs, or technical identifiers - use filenames or descriptive terms instead.",
      prompt: `User intent: ${intent}\n\nSteps:\n${stepList}`,
      maxOutputTokens: Math.max(250, 50 * steps.length),
      abortSignal,
    });

    const lines = result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return steps.map((step, i) => lines[i] || step.description);
  } catch {
    return steps.map((s) => s.description);
  }
}
