import type { WorkspaceSessionStatusType } from "@atlas/core";
import { logger } from "@atlas/logger";
import { truncateUnicode } from "@atlas/utils";
import { smallLLM } from "./small.ts";

const MAX_TITLE_LENGTH = 60;
const MIN_TITLE_LENGTH = 3;

export interface GenerateSessionTitleInput {
  signal: { type: string; id: string; data?: Record<string, unknown> };
  output: unknown;
  status: WorkspaceSessionStatusType;
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
      system: `You are a title generator. Generate a concise, descriptive title summarizing what was accomplished.

CONSTRAINTS:
- Return ONLY the title text, no quotes, no explanation
- Max 60 characters
- Focus on the ACTION and RESULT, not job names or workspace names
- Do NOT include status words like "completed", "failed", "success"
- Do NOT include generic prefixes like "Task:", "Job:", "Session:"`,
      prompt,
      maxOutputTokens: 30,
    });

    const title = result.trim();
    if (title.length < MIN_TITLE_LENGTH) {
      return generateFallbackTitle(input);
    }

    return formatTitle(title);
  } catch (error) {
    logger.debug("Title generation failed, using fallback", { error });
    return generateFallbackTitle(input);
  }
}

/**
 * Builds the prompt for title generation from input data.
 * Focuses on signal data and output - excludes job/workspace names to avoid redundant titles.
 */
function buildPrompt(input: GenerateSessionTitleInput): string {
  const parts: string[] = [];

  // Include signal type for context, but not job name (avoid "daily-report Daily Report" titles)
  parts.push(`Trigger: ${input.signal.type}`);

  // Signal data often contains the most meaningful context (intent, task, etc.)
  if (input.signal.data) {
    const dataStr = JSON.stringify(input.signal.data);
    parts.push(`Input: ${dataStr.slice(0, 200)}`);
  }

  if (input.output !== undefined && input.output !== null) {
    const outputStr =
      typeof input.output === "string" ? input.output : JSON.stringify(input.output);
    parts.push(`Result: ${outputStr.slice(0, 300)}`);
  }

  return parts.join("\n");
}

/**
 * Deterministic fallback title generation.
 * Priority: intent/task from signal data > jobName > signal type
 * Pattern: "daily-report" → "Daily report"
 */
function generateFallbackTitle(input: GenerateSessionTitleInput): string {
  // Prefer intent/task from signal data - these are most meaningful
  let base: string | undefined;

  if (input.signal.data && typeof input.signal.data === "object") {
    const data = input.signal.data as Record<string, unknown>;
    // Check common intent/task fields
    if (typeof data.intent === "string" && data.intent.length >= MIN_TITLE_LENGTH) {
      base = data.intent;
    } else if (typeof data.task === "string" && data.task.length >= MIN_TITLE_LENGTH) {
      base = data.task;
    } else if (typeof data.prompt === "string" && data.prompt.length >= MIN_TITLE_LENGTH) {
      base = data.prompt;
    }
  }

  // Fall back to jobName, then signal type
  if (!base) {
    base = input.jobName ?? input.signal.type;
    // Convert kebab-case/snake_case to sentence case
    base = base
      .replace(/[-_]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
      .toLowerCase()
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  return formatTitle(base);
}

/**
 * Applies formatting: truncation only.
 * Status is shown via UI badge, not in title.
 */
function formatTitle(title: string): string {
  return truncateUnicode(title, MAX_TITLE_LENGTH, "...");
}
