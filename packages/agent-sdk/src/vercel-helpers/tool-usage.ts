import { ArtifactSchema } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import type { StepResult, ToolSet, TypedToolCall, TypedToolResult } from "ai";
import type { ArtifactRef, AtlasTools, ToolCall, ToolResult } from "../types.ts";

/**
 * Find a tool call by name and return its input if it's an object.
 * Returns undefined if not found or input is null/primitive.
 */
export function extractToolCallInput<T extends Record<string, unknown> = Record<string, unknown>>(
  toolCalls: ToolCall[],
  toolName: string,
): T | undefined {
  const call = toolCalls.find((tc) => tc.toolName === toolName);
  if (!call || typeof call.input !== "object" || call.input === null) {
    return undefined;
  }
  return call.input as T;
}

/**
 * Flatten tool calls/results from AI SDK multi-step responses.
 * Prefers per-step data, falls back to top-level arrays.
 */
export function collectToolUsageFromSteps<T extends ToolSet = AtlasTools>(res: {
  steps?: Array<StepResult<T>>;
  toolCalls?: Array<TypedToolCall<T>>;
  toolResults?: Array<TypedToolResult<T>>;
}): { assembledToolCalls: ToolCall[]; assembledToolResults: ToolResult[] } {
  const steps: Array<StepResult<T>> = Array.isArray(res.steps) ? res.steps : [];

  const stepToolCalls: Array<TypedToolCall<T>> = steps.flatMap((step) => step.toolCalls ?? []);
  const stepToolResults: Array<TypedToolResult<T>> = steps.flatMap(
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

/** Extract artifact references from tool results */
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
      } catch (error) {
        logger.debug("failed to parse artifact refs from tool result", {
          error,
          toolResult: result,
        });
      }
    }
  }

  return refs;
}
