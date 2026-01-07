/**
 * FSM Output Validator
 *
 * Adapts FSM LLM action traces to the hallucination detector's AgentResult format.
 * Enables validation of FSM-based agent outputs without modifying the detector.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type { LLMActionTrace, LLMOutputValidationResult } from "@atlas/fsm-engine";
import { logger } from "@atlas/logger";
import {
  analyzeResults,
  containsSeverePatterns,
  getSevereIssues,
  type HallucinationDetectorConfig,
} from "./detector.ts";
import { SupervisionLevel } from "./supervision-levels.ts";

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
export function traceToAgentResult(trace: LLMActionTrace): AgentResult {
  return {
    agentId: "fsm-llm-action",
    task: trace.prompt,
    input: trace.prompt,
    output: trace.content,
    toolCalls: trace.toolCalls,
    toolResults: trace.toolResults,
    duration: 0, // Not tracked in FSM trace
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a validator function for FSM LLM actions.
 *
 * Uses existing hallucination detector infrastructure.
 * Adapts LLMActionTrace -> AgentResult at the boundary.
 *
 * @param supervisionLevel - Controls validation strictness (defaults to STANDARD)
 * @returns OutputValidator function for use in FSM execution
 */
export function createFSMOutputValidator(
  supervisionLevel: SupervisionLevel = SupervisionLevel.STANDARD,
): (trace: LLMActionTrace) => Promise<LLMOutputValidationResult> {
  return async (trace: LLMActionTrace): Promise<LLMOutputValidationResult> => {
    const agentResult = traceToAgentResult(trace);

    const config: HallucinationDetectorConfig = {
      logger: logger.child({ component: "fsm-output-validator" }),
    };

    const analysis = await analyzeResults([agentResult], supervisionLevel, config);

    // Same severity logic as validateAgentOutput in agent-helpers.ts
    const isSevere = analysis.averageConfidence < 0.3 || containsSeverePatterns(analysis.issues);

    if (isSevere) {
      const severeIssues = getSevereIssues(analysis.issues);
      return {
        valid: false,
        feedback: severeIssues.length > 0 ? severeIssues.join("; ") : analysis.issues.join("; "),
      };
    }

    return { valid: true };
  };
}
