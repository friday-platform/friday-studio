/**
 * Wires the FSM engine's `runJudge` callback to the system-level
 * `judgeAgent` (Phase B7 of melodic-strolling-seal-pt2). The daemon owns
 * this seam: workspace can't import `@atlas/system` (layering), so the
 * daemon constructs the runner once at boot and passes it down via
 * WorkspaceRuntimeOptions.runJudge.
 *
 * Today the runner only knows how to dispatch to the bundled `judgeAgent`.
 * The schema's `validate.agent` override (B7) carries the agent id through
 * to fsm-engine's call site; if a future revision wants user-supplied
 * judges (e.g. `fin-judge`), this is the dispatch point — match the
 * `agentId` against a small registry / fall back to the default.
 */

import type { JudgeAgentRunner } from "@atlas/fsm-engine";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { judgeAgent } from "@atlas/system/agents";
import { stringifyError } from "@atlas/utils";

export function createJudgeRunner(platformModels: PlatformModels): JudgeAgentRunner {
  return async ({ agentId, handoff, abortSignal }) => {
    if (agentId !== "judge-agent") {
      logger.warn(
        "validate.agent override requested but only `judge-agent` is wired today; falling back",
        { requested: agentId },
      );
    }
    try {
      const payload = await judgeAgent.execute(handoff, {
        tools: {},
        env: {},
        session: {
          sessionId: `judge-${crypto.randomUUID()}`,
          workspaceId: "system",
          streamId: `judge-${Date.now()}`,
        },
        stream: undefined,
        logger: logger.child({ component: "judge-runner" }),
        platformModels,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (!payload.ok) {
        return { ok: false, error: payload.error.reason };
      }
      return { ok: true, verdict: payload.data };
    } catch (error) {
      // Propagate caller-driven aborts; treat anything else as a delegate
      // failure so the action still emits with an advisory verdict.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      return { ok: false, error: stringifyError(error) };
    }
  };
}
