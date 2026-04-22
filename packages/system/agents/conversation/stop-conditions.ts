import type { StopCondition } from "ai";
import z from "zod";

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
