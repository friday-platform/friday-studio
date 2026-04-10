/**
 * Triage classifier for job failures.
 *
 * Lightweight LLM call that classifies a job failure as EXTERNAL (not fixable
 * via blueprint changes) or WORKSPACE (fixable by revising the blueprint).
 * The reasoning field is stored regardless of classification for debugging.
 */

import { repairJson } from "@atlas/agent-sdk";
import type { FSMActionEvent, SessionHistoryEvent, SessionHistoryTimeline } from "@atlas/core";
import { registry, traceModel } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { generateObject } from "ai";
import { z } from "zod";

const log = createLogger({ component: "triage-classifier" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const TriageClassification = { EXTERNAL: "EXTERNAL", WORKSPACE: "WORKSPACE" } as const;

export const TriageResultSchema = z.object({
  classification: z.enum(["EXTERNAL", "WORKSPACE"]),
  reasoning: z.string(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export interface TriageInput {
  /** Error message from the failed session */
  errorMessage: string;
  /** Job ID that failed */
  jobId: string;
  /** Step ID where the failure occurred, if known */
  failedStepId?: string;
  /** Brief transcript excerpt (last events before failure) */
  transcriptExcerpt: string;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const TRIAGE_MODEL = "anthropic:claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a job failure classifier for an AI agent orchestration platform.

Your task is to classify whether a job failure is:

**EXTERNAL** — caused by factors outside the workspace configuration:
- HTTP 401/403 authentication errors
- Connection refused, DNS resolution failures
- Rate limits (HTTP 429)
- Timeouts to third-party APIs
- Malformed responses from external services
- Service outages or downtime
- Expired or revoked credentials

**WORKSPACE** — caused by issues in the workspace configuration that could be fixed by revising the blueprint:
- Agent produced wrong output format
- Missing context from an upstream job step
- Prompt didn't instruct the agent to use the right tool
- Schema mismatch between steps
- Agent hallucinated a tool that doesn't exist
- Incorrect prepare mappings or transforms
- Wrong output schema definition

**Grey area guidance:** When an error spans both categories (e.g., agent sends a malformed API request → 400 response), look at the root cause. If the agent constructed the request wrong, that's WORKSPACE. If the service changed its API, that's EXTERNAL.

Respond with your classification and a concise explanation of why.`;

/**
 * Classify a job failure as EXTERNAL or WORKSPACE using a fast LLM call.
 *
 * Returns null if the LLM call fails (non-fatal — the improvement loop
 * simply doesn't fire).
 */
export async function classifyFailure(input: TriageInput): Promise<TriageResult | null> {
  const userPrompt = buildUserPrompt(input);

  try {
    const result = await generateObject({
      model: traceModel(registry.languageModel(TRIAGE_MODEL)),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      schema: TriageResultSchema,
      temperature: 0.1,
      maxOutputTokens: 500,
      experimental_repairText: repairJson,
    });

    log.info("Triage classification complete", {
      jobId: input.jobId,
      classification: result.object.classification,
      usage: result.usage,
    });

    return result.object;
  } catch (error) {
    log.error("Triage classification failed", {
      jobId: input.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript extraction
// ---------------------------------------------------------------------------

const MAX_EXCERPT_EVENTS = 20;

/**
 * Build a transcript excerpt from session history for the triage classifier.
 * Extracts the last N relevant events (FSM actions, tool calls, finish).
 */
export function buildTranscriptExcerpt(timeline: SessionHistoryTimeline): string {
  const events = timeline.events;
  if (events.length === 0) return "(no events recorded)";

  // Take the last N events, focusing on actionable ones
  const relevant = events.filter(isRelevantEvent).slice(-MAX_EXCERPT_EVENTS);

  if (relevant.length === 0) return "(no relevant events)";

  return relevant.map(formatEvent).join("\n");
}

/**
 * Extract the failed step ID from session events, if identifiable.
 */
export function extractFailedStepId(timeline: SessionHistoryTimeline): string | undefined {
  // Walk events backwards to find the last failed FSM action
  for (let i = timeline.events.length - 1; i >= 0; i--) {
    const event = timeline.events[i];
    if (!event || event.type !== "fsm-action") continue;
    if (event.data.status === "failed") {
      return event.data.actionId ?? event.data.state;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUserPrompt(input: TriageInput): string {
  const parts = [`**Job:** ${input.jobId}`];
  if (input.failedStepId) {
    parts.push(`**Failed Step:** ${input.failedStepId}`);
  }
  parts.push(
    `**Error:** ${input.errorMessage}`,
    "",
    "**Transcript excerpt (last events before failure):**",
    "```",
    input.transcriptExcerpt,
    "```",
  );
  return parts.join("\n");
}

function isRelevantEvent(event: SessionHistoryEvent): boolean {
  switch (event.type) {
    case "fsm-action":
    case "agent-tool-call":
    case "agent-tool-result":
    case "session-finish":
      return true;
    default:
      return false;
  }
}

function formatEvent(event: SessionHistoryEvent): string {
  switch (event.type) {
    case "fsm-action":
      return formatFSMAction(event.data);
    case "agent-tool-call":
      return `[tool-call] ${formatToolCall(event.data.toolCall)}`;
    case "agent-tool-result":
      return `[tool-result] ${truncate(JSON.stringify(event.data.toolResult), 200)}`;
    case "session-finish":
      return `[session-finish] status=${event.data.status}${event.data.failureReason ? ` reason="${event.data.failureReason}"` : ""}`;
    default:
      return `[${event.type}]`;
  }
}

function formatFSMAction(data: FSMActionEvent["data"]): string {
  const parts = [
    `[fsm-action] ${data.jobName}/${data.state} (${data.actionType}) status=${data.status}`,
  ];
  if (data.error) {
    parts.push(`error="${truncate(data.error, 300)}"`);
  }
  return parts.join(" ");
}

function formatToolCall(toolCall: unknown): string {
  if (typeof toolCall !== "object" || toolCall === null) {
    return truncate(JSON.stringify(toolCall), 200);
  }
  const name =
    ("toolName" in toolCall ? String(toolCall.toolName) : undefined) ??
    ("name" in toolCall ? String(toolCall.name) : "unknown");
  const input =
    "input" in toolCall ? toolCall.input : "args" in toolCall ? toolCall.args : undefined;
  return `${name}(${truncate(JSON.stringify(input), 200)})`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}…`;
}
