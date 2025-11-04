import { ArtifactSchema } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import type { StepResult, TypedToolCall, TypedToolResult } from "ai";
import type { ArtifactRef, AtlasTools, ToolCall, ToolResult } from "../types.ts";

/**
 * Collect tool usage from AI SDK responses, preferring per-step data when available.
 *
 * - Flattens steps[].toolCalls and steps[].toolResults to capture dynamic tool usage
 * - Falls back to top-level toolCalls/toolResults if no per-step entries exist
 */
export function collectToolUsageFromSteps(res: {
  steps?: Array<StepResult<AtlasTools>>;
  toolCalls?: Array<TypedToolCall<AtlasTools>>;
  toolResults?: Array<TypedToolResult<AtlasTools>>;
}): { assembledToolCalls: ToolCall[]; assembledToolResults: ToolResult[] } {
  const steps: Array<StepResult<AtlasTools>> = Array.isArray(res.steps) ? res.steps : [];

  const stepToolCalls: Array<TypedToolCall<AtlasTools>> = steps.flatMap(
    (step) => step.toolCalls ?? [],
  );
  const stepToolResults: Array<TypedToolResult<AtlasTools>> = steps.flatMap(
    (step) => step.toolResults ?? [],
  );

  const assembledToolCalls: ToolCall[] =
    stepToolCalls.length > 0 ? stepToolCalls : Array.isArray(res.toolCalls) ? res.toolCalls : [];

  const assembledToolResults: ToolResult[] =
    stepToolResults.length > 0
      ? stepToolResults
      : Array.isArray(res.toolResults)
        ? res.toolResults
        : [];

  return { assembledToolCalls, assembledToolResults };
}

/**
 * Extract artifact references with full metadata from tool results
 * @param toolResults - Tool results
 * @returns Artifact references with id, type, and summary
 */
export function extractArtifactRefsFromToolResults(toolResults: ToolResult[]): ArtifactRef[] {
  const refs: ArtifactRef[] = [];

  for (const result of toolResults) {
    if (result.toolName === "artifacts_create") {
      // Skip error results
      if (result.output.isError) {
        logger.debug("skipping error tool result", { toolResult: result });
        continue;
      }

      try {
        const parsedText = JSON.parse(result.output.content[0].text);
        const outputArtifact = ArtifactSchema.safeParse(parsedText);
        if (outputArtifact.success && outputArtifact.data) {
          refs.push({
            id: outputArtifact.data.id,
            type: outputArtifact.data.type,
            summary: outputArtifact.data.summary,
          });
        }
      } catch (_error) {
        // Skip results that aren't valid JSON
        logger.debug("failed to parse artifact refs from tool result", {
          error: _error,
          toolResult: result,
        });
      }
    }
  }

  return refs;
}
