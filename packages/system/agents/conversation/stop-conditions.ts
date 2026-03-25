import type { AtlasTools } from "@atlas/agent-sdk";
import type { StopCondition } from "ai";
import z from "zod";
import { FSMCreatorSuccessDataSchema } from "../../agent-types/mod.ts";

/**
 * Stop when connect_service returns a provider (not an error).
 * Error results (e.g. missing prerequisite) let the agent continue
 * so it can act on the error — typically by connecting the prerequisite first.
 */
const ConnectServiceSuccessSchema = z.object({
  output: z.object({ provider: z.string(), error: z.undefined() }),
});

export const connectServiceSucceeded =
  // deno-lint-ignore no-explicit-any
    (): StopCondition<any> =>
    ({ steps }) => {
      for (const step of steps) {
        for (const toolResult of step.toolResults) {
          if (toolResult.toolName !== "connect_service") continue;
          const parsed = ConnectServiceSuccessSchema.safeParse(toolResult);
          if (parsed.success) return true;
        }
      }
      return false;
    };

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
