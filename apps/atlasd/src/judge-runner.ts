/**
 * Wires the FSM engine's `runJudge` callback to the system-level judge agent.
 *
 * The daemon owns this seam: workspace cannot import `@atlas/system`
 * directly (layering), so the daemon constructs the runner once at boot and
 * passes it down via `WorkspaceRuntimeOptions.runJudge`.
 *
 * The runner currently dispatches to the bundled `judgeAgent`. If user-supplied
 * judges become supported, this is the dispatch point for matching
 * `validate.agent` against a small registry. The judge receives the parent
 * workspace/session context plus artifact-inspection tools so lifted tool
 * results can be fetched on demand.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { JudgeAgentRunner } from "@atlas/fsm-engine";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { judgeAgent } from "@atlas/system/agents";
import { stringifyError } from "@atlas/utils";

const JUDGE_TOOL_NAMES = ["get_artifact", "parse_artifact"] as const;

async function createJudgeToolMap(
  abortSignal?: AbortSignal,
): Promise<{ tools: AtlasTools; dispose: () => Promise<void> }> {
  const result = await createMCPTools(
    { "atlas-platform": getAtlasPlatformServerConfig() },
    logger.child({ component: "judge-tools" }),
    { signal: abortSignal },
  );
  const tools: AtlasTools = {};
  for (const name of JUDGE_TOOL_NAMES) {
    const tool = result.tools[name];
    if (tool) tools[name] = tool;
  }
  return { tools, dispose: result.dispose };
}

export function createJudgeRunner(platformModels: PlatformModels): JudgeAgentRunner {
  return async ({ agentId, handoff, workspaceId, sessionId, abortSignal }) => {
    if (agentId !== "judge-agent") {
      logger.warn(
        "validate.agent override requested but only `judge-agent` is wired today; falling back",
        { requested: agentId },
      );
    }
    let dispose: (() => Promise<void>) | undefined;
    try {
      let tools: AtlasTools = {};
      try {
        const created = await createJudgeToolMap(abortSignal);
        tools = created.tools;
        dispose = created.dispose;
      } catch (toolError) {
        logger.warn("Failed to create artifact-aware judge tools", {
          error: stringifyError(toolError),
        });
      }

      const judgeSessionId = sessionId ? `judge-${sessionId}` : `judge-${crypto.randomUUID()}`;
      const payload = await judgeAgent.execute(handoff, {
        tools,
        env: {},
        session: {
          sessionId: judgeSessionId,
          workspaceId: workspaceId ?? "system",
          streamId: judgeSessionId,
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
      // Propagate caller-driven aborts; treat anything else as a judge failure
      // so the action still emits with an advisory verdict.
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      return { ok: false, error: stringifyError(error) };
    } finally {
      if (dispose) {
        try {
          await dispose();
        } catch (error) {
          logger.warn("Failed to dispose judge tools", { error: stringifyError(error) });
        }
      }
    }
  };
}
