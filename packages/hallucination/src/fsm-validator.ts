/**
 * FSM Output Validator
 *
 * Adapts FSM LLM action traces to the hallucination detector's AgentResult format.
 * Enables validation of FSM-based agent outputs without modifying the detector.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { LLMActionTrace, LLMOutputValidationResult } from "@atlas/fsm-engine";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { type HallucinationDetectorConfig, validate } from "./detector.ts";
import { SupervisionLevel } from "./supervision-levels.ts";
import { getThresholdForLevel, statusFromConfidence } from "./verdict.ts";

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
    return () =>
      Promise.resolve({
        verdict: {
          status: statusFromConfidence(1, threshold),
          confidence: 1,
          threshold,
          issues: [],
          retryGuidance: "",
        },
      });
  }

  return async (
    trace: LLMActionTrace,
    abortSignal?: AbortSignal,
  ): Promise<LLMOutputValidationResult> => {
    const agentResult = traceToAgentResult(trace);

    const config: HallucinationDetectorConfig = {
      platformModels,
      logger: logger.child({ component: "fsm-output-validator" }),
    };

    const verdict = await validate(agentResult, supervisionLevel, config, abortSignal);
    return { verdict };
  };
}
