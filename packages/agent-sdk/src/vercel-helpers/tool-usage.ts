import type { StepResult, TypedToolCall, TypedToolResult } from "ai";
import type { AtlasTools, ToolCall, ToolResult } from "../types.ts";
import { ArtifactSchema } from "@atlas/core/artifacts";

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
 * Extract artifact ids from tool results
 * @param toolResults - Tool results
 * @returns Artifact IDs
 */
export function extractArtifactIdsFromToolResults(toolResults: ToolResult[]): string[] {
  return toolResults
    .filter((result) => result.toolName === "artifacts_create")
    .map((result) => {
      const outputArtifact = ArtifactSchema.safeParse(JSON.parse(result.output.content[0].text));
      if (outputArtifact.success) {
        return outputArtifact.data?.id;
      }
      return undefined;
    })
    .filter((id) => id !== undefined);
}
