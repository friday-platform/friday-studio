import { logger } from "@atlas/logger";
import { smallLLM } from "./small.ts";

const MAX_TITLE_LENGTH = 60;
const MIN_TITLE_LENGTH = 3;

export interface GenerateSessionTitleInput {
  signal: { type: string; id: string; data?: Record<string, unknown> };
  output: unknown;
  status: "completed" | "failed";
  jobName?: string;
  /** @internal Test-only: override LLM function */
  _llm?: typeof smallLLM;
}

/**
 * Generates a human-readable title for a session using LLM.
 * Never throws - returns fallback title on any error.
 */
export async function generateSessionTitle(input: GenerateSessionTitleInput): Promise<string> {
  const llm = input._llm ?? smallLLM;
  try {
    const prompt = buildPrompt(input);
    const result = await llm({
      system:
        "You are a title generator. Generate a concise, descriptive title for a completed task. Return ONLY the title, no quotes, no explanation. Max 60 characters.",
      prompt,
      maxOutputTokens: 30,
    });

    const title = result.trim();
    if (title.length < MIN_TITLE_LENGTH) {
      return generateFallbackTitle(input);
    }

    return formatTitle(title, input.status);
  } catch (error) {
    logger.debug("Title generation failed, using fallback", { error });
    return generateFallbackTitle(input);
  }
}

/**
 * Builds the prompt for title generation from input data.
 */
function buildPrompt(input: GenerateSessionTitleInput): string {
  const parts: string[] = [];

  if (input.jobName) {
    parts.push(`Job: ${input.jobName}`);
  }

  parts.push(`Signal type: ${input.signal.type}`);
  parts.push(`Signal ID: ${input.signal.id}`);

  if (input.signal.data) {
    const dataStr = JSON.stringify(input.signal.data);
    // Truncate data if too long
    parts.push(`Signal data: ${dataStr.slice(0, 200)}`);
  }

  if (input.output !== undefined && input.output !== null) {
    const outputStr =
      typeof input.output === "string" ? input.output : JSON.stringify(input.output);
    parts.push(`Output: ${outputStr.slice(0, 300)}`);
  }

  parts.push(`Status: ${input.status}`);

  return parts.join("\n");
}

/**
 * Deterministic fallback title generation.
 * Pattern: "daily-report" → "Daily report"
 */
function generateFallbackTitle(input: GenerateSessionTitleInput): string {
  // Use jobName if available, otherwise signal type
  const base = input.jobName ?? input.signal.type;

  // Convert kebab-case/snake_case to sentence case
  const title = base
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

  return formatTitle(title, input.status);
}

/**
 * Applies formatting: truncation and failed prefix.
 */
function formatTitle(title: string, status: "completed" | "failed"): string {
  const prefix = status === "failed" ? "Failed: " : "";
  const maxContentLength = MAX_TITLE_LENGTH - prefix.length;

  let truncated = title;
  if (truncated.length > maxContentLength) {
    truncated = truncated.slice(0, maxContentLength - 3) + "...";
  }

  return prefix + truncated;
}
