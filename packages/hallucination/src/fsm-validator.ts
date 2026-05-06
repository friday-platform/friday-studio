/**
 * FSM Output Validator
 *
 * Adapts FSM LLM action traces to the hallucination detector's AgentResult format.
 * Enables validation of FSM-based agent outputs without modifying the detector.
 */

import type { AgentResult, ToolResult } from "@atlas/agent-sdk";
import type { LLMActionTrace, LLMOutputValidationResult } from "@atlas/fsm-engine";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { z } from "zod";
import { type HallucinationDetectorConfig, validate } from "./detector.ts";
import { SupervisionLevel } from "./supervision-levels.ts";
import { getThresholdForLevel, statusFromConfidence, type ValidationVerdict } from "./verdict.ts";

/**
 * MCP CallToolResult content shape — duplicated locally so we can extract
 * text from a tool-result `output` field (typed `unknown`) without importing
 * detector internals. Kept narrow on purpose: only the `content[].text` arm
 * is needed for trivial-echo detection.
 */
const McpToolOutputSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});

/**
 * Extract a string representation of a tool result's output.
 *
 * Mirrors `extractOutputText()` in detector.ts — string passthrough, MCP
 * text content, or JSON.stringify fallback. Inlined here to keep the skip
 * decision a pure function in this file.
 */
function extractToolResultText(output: unknown): string {
  if (typeof output === "string") return output;

  const parsed = McpToolOutputSchema.safeParse(output);
  if (parsed.success && parsed.data.content) {
    const texts = parsed.data.content.map((item) => item.text ?? "").filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }

  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Decide whether a trace is a tool-call passthrough — i.e. the LLM did not
 * synthesize new prose, it just bubbled a tool result up via `outputTo`.
 *
 * Conservative on purpose: returns a non-null reason only when we're confident
 * there is no LLM-generated text to fabricate against. When in doubt, returns
 * null and the live judge runs.
 *
 * @returns A short reason string when the judge should be skipped, or null
 *   to proceed with judging.
 */
export function tracePassthroughReason(trace: LLMActionTrace): string | null {
  const content = trace.content?.trim() ?? "";

  if (content.length === 0) {
    return "empty content";
  }

  const toolResults: ToolResult[] | undefined = trace.toolResults;
  if (!toolResults || toolResults.length === 0) return null;

  // Trivial-echo: content equals one of the tool results' text or its JSON form.
  for (const tr of toolResults) {
    const text = extractToolResultText(tr.output).trim();
    if (text.length > 0 && content === text) {
      return "content trivially echoes tool result";
    }
    // Also check raw JSON.stringify of the entire output, since some agents
    // emit the JSON envelope rather than the unwrapped MCP text.
    try {
      const json = JSON.stringify(tr.output);
      if (json && content === json.trim()) {
        return "content trivially echoes tool result (json)";
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * Build a synthetic pass verdict — used both for the no-op fallback and the
 * tool-passthrough skip path so consumers see a uniform shape.
 */
function syntheticPassVerdict(threshold: number): ValidationVerdict {
  return {
    status: statusFromConfidence(1, threshold),
    confidence: 1,
    threshold,
    issues: [],
    retryGuidance: "",
  };
}

/**
 * Convert FSM LLM action trace to AgentResult for hallucination detection.
 *
 * The hallucination detector expects AgentResult with toolCalls/toolResults.
 * Since LLMActionTrace now uses AI SDK types directly, we can pass them through.
 *
 * @internal Exported for testing only
 * @param trace - LLM action trace from FSM engine execution
 * @returns AgentResult compatible with hallucination detector
 */
export function traceToAgentResult(trace: LLMActionTrace): AgentResult<string, string> {
  return {
    agentId: "fsm-llm-action",
    timestamp: new Date().toISOString(),
    input: trace.prompt,
    ok: true,
    data: trace.content,
    toolCalls: trace.toolCalls,
    toolResults: trace.toolResults,
    durationMs: 0, // Not tracked in FSM trace
  };
}

/**
 * Create a validator function for FSM LLM actions.
 *
 * Uses existing hallucination detector infrastructure.
 * Adapts LLMActionTrace -> AgentResult at the boundary.
 *
 * When `platformModels` is omitted, returns a no-op validator that reports a
 * synthetic `pass` verdict for every trace. Callers still being migrated onto
 * the DI seam use this fallback; production paths (workspace runtime) always
 * pass a resolver.
 *
 * @param supervisionLevel - Controls validation strictness (defaults to STANDARD)
 * @param platformModels - Platform model resolver; `classifier` role drives validation
 * @returns OutputValidator function for use in FSM execution
 */
export function createFSMOutputValidator(
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
  platformModels?: PlatformModels,
): (trace: LLMActionTrace, abortSignal?: AbortSignal) => Promise<LLMOutputValidationResult> {
  const threshold = getThresholdForLevel(supervisionLevel);

  if (!platformModels) {
    // No-op validator: synthesize a pass verdict at confidence 1.0 so consumers
    // see a well-formed shape without paying for a judge call.
    return () => Promise.resolve({ verdict: syntheticPassVerdict(threshold) });
  }

  const validatorLogger = logger.child({ component: "fsm-output-validator" });

  return async (
    trace: LLMActionTrace,
    abortSignal?: AbortSignal,
  ): Promise<LLMOutputValidationResult> => {
    // Skip the judge on tool-call passthroughs: the LLM emitted no prose, it
    // just bubbled a tool result up. There's nothing for it to fabricate.
    const skipReason = tracePassthroughReason(trace);
    if (skipReason !== null) {
      validatorLogger.debug("Skipping validation for tool-passthrough trace", {
        reason: skipReason,
      });
      return { verdict: syntheticPassVerdict(threshold) };
    }

    const agentResult = traceToAgentResult(trace);

    const config: HallucinationDetectorConfig = { platformModels, logger: validatorLogger };

    const verdict = await validate(agentResult, supervisionLevel, config, abortSignal);
    return { verdict };
  };
}
