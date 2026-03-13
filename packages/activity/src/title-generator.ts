import { smallLLM } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { truncateUnicode } from "@atlas/utils";

const MAX_TITLE_LENGTH = 80;
const MIN_TITLE_LENGTH = 3;

// ==============================================================================
// SESSION ACTIVITY TITLE
// ==============================================================================

export interface GenerateSessionActivityTitleInput {
  status: string;
  jobName: string;
  agentNames: string[];
  /** Final output from the last completed agent block */
  finalOutput?: string;
  error?: string;
  /** @internal Test-only: override LLM function */
  _llm?: typeof smallLLM;
}

export async function generateSessionActivityTitle(
  input: GenerateSessionActivityTitleInput,
): Promise<string> {
  const llm = input._llm ?? smallLLM;
  try {
    const parts: string[] = [];
    parts.push(`Job: ${input.jobName}`);
    parts.push(`Status: ${input.status}`);
    if (input.agentNames.length > 0) {
      parts.push(`Agents: ${input.agentNames.join(", ")}`);
    }
    if (input.finalOutput) {
      parts.push(`Last output: ${input.finalOutput.slice(-300)}`);
    }
    if (input.error) {
      parts.push(`Error: ${input.error}`);
    }

    const result = await llm({
      system: `You are a title generator. Generate a concise activity title summarizing what happened in this session.

CONSTRAINTS:
- Return ONLY the title text, no quotes, no explanation
- Max 80 characters
- Focus on what was accomplished or what failed
- Use past tense`,
      prompt: parts.join("\n"),
      maxOutputTokens: 250,
    });

    const title = result.trim();
    if (title.length < MIN_TITLE_LENGTH) {
      return sessionFallbackTitle(input);
    }
    return truncateUnicode(title, MAX_TITLE_LENGTH, "...");
  } catch (error) {
    logger.debug("Session activity title generation failed, using fallback", { error });
    return sessionFallbackTitle(input);
  }
}

function sessionFallbackTitle(input: GenerateSessionActivityTitleInput): string {
  const name = kebabToSentenceCase(input.jobName);
  const statusLabel = input.status === "completed" ? "completed" : "failed";
  return truncateUnicode(`${name} session ${statusLabel}`, MAX_TITLE_LENGTH, "...");
}

// ==============================================================================
// RESOURCE ACTIVITY TITLE
// ==============================================================================

export interface GenerateResourceActivityTitleInput {
  resourceName: string;
  resourceSlug: string;
  resourceType: string;
  /** @internal Test-only: override LLM function */
  _llm?: typeof smallLLM;
}

export async function generateResourceActivityTitle(
  input: GenerateResourceActivityTitleInput,
): Promise<string> {
  const llm = input._llm ?? smallLLM;
  try {
    const parts: string[] = [];
    parts.push(`Resource: ${input.resourceName}`);
    parts.push(`Type: ${input.resourceType}`);
    parts.push(`Slug: ${input.resourceSlug}`);

    const result = await llm({
      system: `You are a title generator. Generate a concise title describing a resource update.

CONSTRAINTS:
- Return ONLY the title text, no quotes, no explanation
- Max 80 characters
- Use past tense
- Focus on what resource was updated`,
      prompt: parts.join("\n"),
      maxOutputTokens: 250,
    });

    const title = result.trim();
    if (title.length < MIN_TITLE_LENGTH) {
      return resourceFallbackTitle(input);
    }
    return truncateUnicode(title, MAX_TITLE_LENGTH, "...");
  } catch (error) {
    logger.debug("Resource activity title generation failed, using fallback", { error });
    return resourceFallbackTitle(input);
  }
}

function resourceFallbackTitle(input: GenerateResourceActivityTitleInput): string {
  return truncateUnicode(`${input.resourceName} was updated`, MAX_TITLE_LENGTH, "...");
}

// ==============================================================================
// USER ACTIVITY TITLE
// ==============================================================================

export type UserActivityAction = "uploaded" | "replaced" | "deleted" | "linked";

export function generateUserActivityTitle(
  action: UserActivityAction,
  resourceName: string,
): string {
  return truncateUnicode(`{{user_id}} ${action} ${resourceName}`, MAX_TITLE_LENGTH, "...");
}

// ==============================================================================
// HELPERS
// ==============================================================================

function kebabToSentenceCase(str: string): string {
  return str
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}
