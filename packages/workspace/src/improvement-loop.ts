/**
 * Self-improvement loop for workspace job failures.
 *
 * Async, non-blocking pipeline that fires after a job session fails:
 * 1. Build transcript excerpt from session history
 * 2. Run triage classifier (fast LLM) → EXTERNAL or WORKSPACE
 * 3. If WORKSPACE → invoke workspace-improver agent (via callback)
 * 4. Store pending revision proposal on workspace metadata (via HTTP)
 *
 * The entire pipeline is fire-and-forget. Failures are logged but never
 * propagate back to the caller.
 */

import { client, parseResult } from "@atlas/client/v2";
import type { SessionHistoryTimeline } from "@atlas/core";
import { createLogger } from "@atlas/logger";
import { z } from "zod";
import {
  buildTranscriptExcerpt,
  classifyFailure,
  extractFailedStepId,
  TriageClassification,
} from "./triage-classifier.ts";
import type { WorkspaceMetadata } from "./types.ts";

const log = createLogger({ component: "improvement-loop" });

// ---------------------------------------------------------------------------
// Pending revision — derived from WorkspaceMetadataSchema single source of truth
// ---------------------------------------------------------------------------

export type PendingRevision = NonNullable<WorkspaceMetadata["pendingRevision"]>;

// ---------------------------------------------------------------------------
// Workspace-improver agent result shape
// ---------------------------------------------------------------------------

export interface ImproverAgentInput {
  artifactId: string;
  workspaceId: string;
  workspaceName: string;
  jobId: string;
  failedStepId?: string;
  errorMessage: string;
  triageReasoning: string;
  transcriptExcerpt: string;
}

export const ImproverResultDataSchema = z.object({
  artifactId: z.string(),
  revision: z.number(),
  summary: z.string(),
  changedFields: z.array(z.string()),
});

export type ImproverAgentResult =
  | { ok: true; data: z.infer<typeof ImproverResultDataSchema> }
  | { ok: false; error?: string };

// ---------------------------------------------------------------------------
// Pipeline input
// ---------------------------------------------------------------------------

export interface ImprovementLoopInput {
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  jobName: string;
  errorMessage: string;
  blueprintArtifactId: string;
  timeline: SessionHistoryTimeline;
  /** Callback to invoke the workspace-improver agent */
  invokeImprover: (input: ImproverAgentInput) => Promise<ImproverAgentResult>;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full improvement loop pipeline. Fire-and-forget — catches all errors
 * and logs them without propagating.
 */
export async function runImprovementLoop(input: ImprovementLoopInput): Promise<void> {
  try {
    await runImprovementLoopInternal(input);
  } catch (error) {
    log.error("Improvement loop failed (non-fatal)", {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      jobName: input.jobName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runImprovementLoopInternal(input: ImprovementLoopInput): Promise<void> {
  const {
    workspaceId,
    workspaceName,
    sessionId,
    jobName,
    errorMessage,
    blueprintArtifactId,
    timeline,
    invokeImprover,
  } = input;

  // 1. Build transcript excerpt
  const transcriptExcerpt = buildTranscriptExcerpt(timeline);
  const failedStepId = extractFailedStepId(timeline);

  log.info("Starting improvement loop", {
    workspaceId,
    workspaceName,
    sessionId,
    jobName,
    failedStepId,
  });

  // 2. Run triage classifier
  const triageResult = await classifyFailure({
    errorMessage,
    jobId: jobName,
    failedStepId,
    transcriptExcerpt,
  });

  if (!triageResult) {
    log.warn("Triage classification returned null, skipping improvement loop", {
      workspaceId,
      sessionId,
    });
    return;
  }

  log.info("Triage classification complete", {
    workspaceId,
    sessionId,
    classification: triageResult.classification,
    reasoning: triageResult.reasoning,
  });

  // 3. Only proceed for WORKSPACE failures
  if (triageResult.classification === TriageClassification.EXTERNAL) {
    log.info("Failure classified as EXTERNAL, skipping improvement loop", {
      workspaceId,
      sessionId,
      reasoning: triageResult.reasoning,
    });
    return;
  }

  // 4. Invoke workspace-improver agent
  log.info("Invoking workspace-improver agent", { workspaceId, blueprintArtifactId });

  const result = await invokeImprover({
    artifactId: blueprintArtifactId,
    workspaceId,
    workspaceName,
    jobId: jobName,
    failedStepId,
    errorMessage,
    triageReasoning: triageResult.reasoning,
    transcriptExcerpt,
  });

  if (!result.ok) {
    log.error("Workspace improver agent failed", { workspaceId, sessionId, error: result.error });
    return;
  }

  // 5. Store pending revision on workspace metadata
  const pendingRevision: PendingRevision = {
    artifactId: result.data.artifactId,
    revision: result.data.revision,
    summary: result.data.summary,
    triageReasoning: triageResult.reasoning,
    createdAt: new Date().toISOString(),
  };

  const metadataResponse = await parseResult(
    client.workspace[":workspaceId"].metadata.$patch({
      param: { workspaceId },
      json: { pendingRevision },
    }),
  );

  if (!metadataResponse.ok) {
    log.error("Failed to store pending revision on workspace metadata", {
      workspaceId,
      sessionId,
      error: metadataResponse.error,
    });
    return;
  }

  log.info("Improvement loop complete — pending revision stored", {
    workspaceId,
    sessionId,
    artifactId: result.data.artifactId,
    revision: result.data.revision,
    summary: result.data.summary,
  });
}
