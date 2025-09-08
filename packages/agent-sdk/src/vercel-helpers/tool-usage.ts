import type { AtlasTools, ToolCall, ToolResult } from "../types.ts";
import type { StepResult, TypedToolCall, TypedToolResult } from "ai";

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
