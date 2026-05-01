/**
 * Session AI summary generator.
 *
 * Produces a structured summary of a completed session by feeding
 * condensed step context to an LLM. Never throws — returns undefined
 * on any failure so session finalization is never blocked.
 *
 * @module
 */

import { repairJson } from "@atlas/agent-sdk";
import { type SessionAISummary, SessionAISummarySchema, type SessionView } from "@atlas/core";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { generateObject as defaultGenerateObject } from "ai";

/** Dependencies for `generateSessionSummary`. */
export interface GenerateSessionSummaryDeps {
  /** Platform model resolver — `classifier` role is used for summarization. */
  platformModels: PlatformModels;
  /** Optional override for the AI SDK generator (testing seam). */
  generateObject?: (...args: unknown[]) => Promise<{ object: unknown }>;
}

/**
 * Generate an AI summary for a completed session.
 *
 * @param view - The reduced session view (all events folded)
 * @param deps - Optional dependency overrides (testing)
 * @param jobDescription - Optional human-readable job description
 * @returns Structured summary, or undefined on failure/timeout
 */
export async function generateSessionSummary(
  view: SessionView,
  deps: GenerateSessionSummaryDeps,
  jobDescription?: string,
  workspaceName?: string,
): Promise<SessionAISummary | undefined> {
  const generate = deps.generateObject ?? defaultGenerateObject;

  try {
    const prompt = buildPrompt(view, jobDescription, workspaceName);

    const { object } = await generate({
      model: deps.platformModels.get("classifier"),
      schema: SessionAISummarySchema,
      prompt,
      maxOutputTokens: 300,
      maxRetries: 3,
      abortSignal: AbortSignal.timeout(5000),
      experimental_repairText: repairJson,
    });

    return SessionAISummarySchema.parse(object);
  } catch (error) {
    logger.warn("Session summary generation failed", {
      sessionId: view.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Build the LLM prompt from session view data.
 * Structure: condensed step list for context + final step output as the
 * deliverable. The last step's output is what the job produced — earlier
 * steps are implementation details.
 */
function buildPrompt(view: SessionView, jobDescription?: string, workspaceName?: string): string {
  const job = jobDescription ?? view.task;
  const steps = view.agentBlocks
    .map((b) => {
      const duration = b.durationMs ? `${(b.durationMs / 1000).toFixed(1)}s` : "?";
      return `- ${b.agentName} (${b.status}, ${duration}): "${b.task}"`;
    })
    .join("\n");

  const lastBlock = view.agentBlocks.at(-1);
  const resultSection = lastBlock
    ? `## Result
Agent: ${lastBlock.agentName}
Status: ${lastBlock.status}
Output: ${JSON.stringify(lastBlock.output)}${lastBlock.error ? `\nError: ${lastBlock.error}` : ""}`
    : "No steps executed.";

  const workspaceSection = workspaceName ? `\nWorkspace: ${workspaceName}` : "";

  return `Summarize this automated job. Focus on what was delivered, not the process.

Key details should be the concrete deliverables and artifacts produced (documents created, URLs, titles). Do NOT rehash intermediate steps or restate the job description.

## Job
${job}${workspaceSection}
Status: ${view.status}

## Steps
${steps || "No steps."}

${resultSection}`;
}
