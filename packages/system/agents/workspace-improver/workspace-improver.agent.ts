/**
 * Workspace Improver Agent
 *
 * Diagnoses WORKSPACE-classified failures and proposes constrained blueprint
 * revisions. Takes triage result, session transcript, current blueprint, and
 * artifact revision history as input. Outputs a new blueprint artifact revision
 * that passes validateRevisionScope().
 *
 * Separate from workspace-planner: planner creates from user intent, improver
 * fixes from failure evidence. Different prompts, different guardrails.
 */

import { createAgent, err, ok, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { registry, traceModel } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import {
  type RevisionScopeResult,
  validateRevisionScope,
  type WorkspaceBlueprint,
  WorkspaceBlueprintSchema,
} from "@atlas/workspace-builder";
import { generateObject } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

const WorkspaceImproverInputSchema = z.object({
  /** Blueprint artifact ID to revise */
  artifactId: z.string().describe("WorkspacePlan artifact ID"),
  /** Workspace ID (for context) */
  workspaceId: z.string().describe("Workspace ID"),
  /** Job that failed */
  jobId: z.string().describe("Job ID that failed"),
  /** Step where failure occurred, if known */
  failedStepId: z.string().optional().describe("Failed step ID"),
  /** Error message from the failed session */
  errorMessage: z.string().describe("Error message from the failed session"),
  /** Triage classification reasoning */
  triageReasoning: z.string().describe("Reasoning from triage classifier"),
  /** Transcript excerpt (formatted session events) */
  transcriptExcerpt: z.string().describe("Formatted transcript excerpt"),
});

type WorkspaceImproverInput = z.infer<typeof WorkspaceImproverInputSchema>;

interface WorkspaceImproverSuccessData {
  artifactId: string;
  revision: number;
  summary: string;
  changedFields: string[];
}

// ---------------------------------------------------------------------------
// LLM schemas
// ---------------------------------------------------------------------------

const IMPROVER_MODEL = "anthropic:claude-sonnet-4-5";

const BlueprintRevisionSchema = z.object({
  revisedBlueprint: WorkspaceBlueprintSchema,
  whatBroke: z.string().describe("1-2 sentence diagnosis of the root cause"),
  whatChanged: z.string().describe("1-2 sentence summary of what was changed in the blueprint"),
  changedFields: z
    .array(z.string())
    .describe("List of specific fields that were modified (e.g., 'jobs[0].steps[1].description')"),
});

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a workspace blueprint debugger for an AI agent orchestration platform.

A job in a workspace has failed, and the failure has been classified as WORKSPACE — meaning it can be fixed by revising the workspace blueprint configuration, not by fixing external services.

Your task is to analyze the failure evidence and produce a MINIMAL revision of the blueprint that fixes the root cause.

## What you CAN change (tunable fields):
- workspace.purpose, workspace.details — clarify intent
- Signal title, description, displayLabel — improve documentation
- Agent description, capabilities — clarify agent behavior expectations
- Job title — improve naming
- Step description — fix/improve instructions given to agents
- Step tools — adjust available tools list
- Document contract schemas — fix type mismatches between steps
- Prepare mapping sources and constants — fix data flow between steps
- Resource name, description, schema — clarify resource expectations

## What you MUST NOT change (structural fields):
- Signal IDs, signal types, payload schemas, signal configs
- Agent IDs, bundled IDs, MCP server bindings, agent configuration
- Job IDs, trigger signal IDs
- Step IDs, agent assignments, depends_on edges, execution type/ref
- Document contract identity (producerStepId, documentId, documentType)
- Prepare mapping identity (consumerStepId, documentId, documentType)
- Conditional structure (stepId, field, branches)
- Credential bindings
- Resource identity (type, slug) and external refs

## Guidelines:
1. Make the SMALLEST change that fixes the issue. Don't rewrite prompts that are working.
2. Focus on the failed step and its immediate dependencies.
3. If the error is about wrong output format, fix the relevant schema or step description.
4. If the error is about missing context, fix the prepare mapping or upstream step description.
5. If the error is about wrong tool usage, clarify the step description to guide tool selection.
6. Preserve the original blueprint structure exactly — only modify field values.
7. Your revision WILL be validated by a programmatic scope guard. Structural changes will be rejected.`;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const MAX_RETRIES = 1;

export const workspaceImproverAgent = createAgent<string, WorkspaceImproverSuccessData>({
  id: "workspace-improver",
  displayName: "Workspace Improver",
  version: "1.0.0",
  description:
    "Diagnoses WORKSPACE-classified job failures and proposes constrained blueprint revisions. " +
    "Takes failure context and current blueprint, outputs a revised blueprint artifact that " +
    "passes structural validation.",
  expertise: { examples: [] },

  handler: async (rawInput, { logger, stream, abortSignal }) => {
    const inputParse = WorkspaceImproverInputSchema.safeParse(JSON.parse(rawInput));
    if (!inputParse.success) {
      return err(`Invalid input: ${z.prettifyError(inputParse.error)}`);
    }
    const input = inputParse.data;

    logger.info("Starting workspace improvement", {
      artifactId: input.artifactId,
      jobId: input.jobId,
      failedStepId: input.failedStepId,
    });

    try {
      // 1. Load current blueprint
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Improver", content: "Loading current blueprint" },
      });

      const { blueprint: originalBlueprint, revision: currentRevision } = await loadBlueprint(
        input.artifactId,
      );

      logger.info("Loaded blueprint", {
        revision: currentRevision,
        jobs: originalBlueprint.jobs.length,
        agents: originalBlueprint.agents.length,
      });

      // 2. Load revision history for context
      const revisionHistory = await loadRevisionHistory(input.artifactId, currentRevision, logger);

      // 3. Generate revised blueprint
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Improver", content: "Analyzing failure and generating fix" },
      });

      const userPrompt = buildUserPrompt(input, originalBlueprint, revisionHistory);

      let revisedResult = await generateRevision(userPrompt, abortSignal, logger);

      // 4. Validate revision scope
      let validation = validateRevisionScope(originalBlueprint, revisedResult.revisedBlueprint);

      // If validation fails, retry once with violation feedback
      if (!validation.ok && MAX_RETRIES > 0) {
        logger.warn("Revision scope validation failed, retrying with feedback", {
          violations: validation.violations,
        });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Workspace Improver", content: "Fixing scope violations, retrying" },
        });

        const retryPrompt = buildRetryPrompt(userPrompt, validation);
        revisedResult = await generateRevision(retryPrompt, abortSignal, logger);
        validation = validateRevisionScope(originalBlueprint, revisedResult.revisedBlueprint);
      }

      if (!validation.ok) {
        logger.error("Revision scope validation failed after retry", {
          violations: validation.violations,
        });
        return err(
          `Blueprint revision violates scope constraints: ${validation.violations.join("; ")}`,
        );
      }

      // 5. Build summary (whatBroke + whatChanged are already 1-2 sentences each from the LLM)
      const summary = `${revisedResult.whatBroke} ${revisedResult.whatChanged}`;

      // 6. Store revised blueprint as new artifact revision
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Improver", content: "Saving revised blueprint" },
      });

      const response = await parseResult(
        client.artifactsStorage[":id"].$put({
          param: { id: input.artifactId },
          json: {
            type: "workspace-plan",
            data: { type: "workspace-plan", version: 2, data: revisedResult.revisedBlueprint },
            summary,
            revisionMessage: summary,
          },
        }),
      );

      if (!response.ok) {
        throw new Error(`Failed to store revised artifact: ${stringifyError(response.error)}`);
      }

      logger.info("Workspace improvement complete", {
        artifactId: response.data.artifact.id,
        revision: response.data.artifact.revision,
        changedFields: revisedResult.changedFields,
      });

      return ok({
        artifactId: response.data.artifact.id,
        revision: response.data.artifact.revision,
        summary,
        changedFields: revisedResult.changedFields,
      });
    } catch (error) {
      logger.error("Workspace improvement failed", { error: stringifyError(error) });
      return err(stringifyError(error));
    }
  },
});

// ---------------------------------------------------------------------------
// Blueprint loading (same pattern as fsm-workspace-creator)
// ---------------------------------------------------------------------------

async function loadBlueprint(
  artifactId: string,
): Promise<{ blueprint: WorkspaceBlueprint; revision: number }> {
  const response = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: artifactId } }),
  );

  if (!response.ok || response.data.artifact.type !== "workspace-plan") {
    throw new Error("Failed to load workspace plan artifact");
  }

  const { revision } = response.data.artifact;
  const artifactData = response.data.artifact.data;

  if (artifactData.version !== 2) {
    throw new Error(
      `Unsupported workspace plan version: ${(artifactData as { version: unknown }).version}`,
    );
  }

  const validationResult = WorkspaceBlueprintSchema.safeParse(artifactData.data);
  if (!validationResult.success) {
    throw new Error(`Invalid workspace blueprint data: ${validationResult.error.message}`);
  }

  return { blueprint: validationResult.data, revision };
}

// ---------------------------------------------------------------------------
// Revision history loading
// ---------------------------------------------------------------------------

async function loadRevisionHistory(
  artifactId: string,
  currentRevision: number,
  logger: Logger,
): Promise<string[]> {
  // Load up to 5 recent revisions for context (parallel)
  const maxHistory = Math.min(currentRevision, 5);
  const revisions = Array.from({ length: maxHistory }, (_, i) => currentRevision - i).filter(
    (rev) => rev >= 1,
  );

  const results = await Promise.allSettled(
    revisions.map((rev) =>
      parseResult(
        client.artifactsStorage[":id"].$get({
          param: { id: artifactId },
          query: { revision: String(rev) },
        }),
      ),
    ),
  );

  const messages: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const rev = revisions[i];
    if (
      result?.status === "fulfilled" &&
      result.value.ok &&
      result.value.data.artifact.revisionMessage
    ) {
      messages.push(`Revision ${rev}: ${result.value.data.artifact.revisionMessage}`);
    } else if (result?.status === "rejected") {
      logger.debug("Failed to load revision history", { artifactId, revision: rev });
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------

async function generateRevision(
  userPrompt: string,
  abortSignal: AbortSignal | undefined,
  logger: Logger,
): Promise<z.infer<typeof BlueprintRevisionSchema>> {
  const result = await generateObject({
    model: traceModel(registry.languageModel(IMPROVER_MODEL)),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: BlueprintRevisionSchema,
    temperature: 0.2,
    maxOutputTokens: 16000,
    experimental_repairText: repairJson,
    abortSignal,
  });

  logger.info("Revision generation complete", { usage: result.usage });
  return result.object;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildUserPrompt(
  input: WorkspaceImproverInput,
  blueprint: WorkspaceBlueprint,
  revisionHistory: string[],
): string {
  const parts = ["## Failure Context", "", `**Job:** ${input.jobId}`];

  if (input.failedStepId) {
    parts.push(`**Failed Step:** ${input.failedStepId}`);
  }

  parts.push(
    `**Error:** ${input.errorMessage}`,
    `**Triage Reasoning:** ${input.triageReasoning}`,
    "",
    "## Transcript (last events before failure)",
    "```",
    input.transcriptExcerpt,
    "```",
  );

  if (revisionHistory.length > 0) {
    parts.push("", "## Recent Revision History", ...revisionHistory);
  }

  parts.push(
    "",
    "## Current Blueprint",
    "```json",
    JSON.stringify(blueprint, null, 2),
    "```",
    "",
    "Analyze the failure and produce a minimal revision of the blueprint that fixes the root cause.",
    "Return the COMPLETE blueprint (not just the changed parts) with your fixes applied.",
  );

  return parts.join("\n");
}

function buildRetryPrompt(originalPrompt: string, validation: RevisionScopeResult): string {
  return [
    originalPrompt,
    "",
    "## IMPORTANT: Your previous revision was REJECTED by the scope guard",
    "",
    "The following structural violations were detected:",
    ...validation.violations.map((v) => `- ${v}`),
    "",
    "You MUST NOT change structural fields. Only modify tunable fields (descriptions, schemas,",
    "prepare mapping sources/constants, tools, capabilities). Try again with a more constrained fix.",
  ].join("\n");
}
