import type { AtlasTools } from "@atlas/agent-sdk";
import type { StopCondition } from "ai";
import z from "zod";
import { FSMCreatorSuccessDataSchema } from "../../agent-types/mod.ts";

/**
 * Stop condition for fsm-workspace-creator: stop only on success.
 * Direct invocation returns AgentPayload: { ok: true, data: FSMCreatorSuccessData }
 */
export const workspaceCreationComplete =
  (): StopCondition<AtlasTools> =>
  ({ steps }) => {
    for (const step of steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName !== "fsm-workspace-creator") {
          continue;
        }
        try {
          const result = z
            .object({
              output: z.object({ ok: z.literal(true), data: FSMCreatorSuccessDataSchema }),
            })
            .parse(toolResult);

          if (result.output.ok) {
            return true;
          }
        } catch {
          return false;
        }
      }
    }
    return false;
  };
