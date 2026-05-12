import type { StopCondition } from "ai";
import z from "zod";

/**
 * Stop when a delegate call returned a substantial answer that the child
 * already streamed to the user. The lift walker in `createDelegateTool`
 * replaces large answers with an `[attachment lifted to artifact ...]`
 * marker before the supervisor's tool-result view; presence of that
 * marker means the answer is big enough that the user has seen the full
 * prose via `data-delegate-chunk` text-deltas, and the supervisor's
 * next step would only re-decode the same content. Stop and let the
 * delegate's stream be the assistant's answer.
 *
 * Short delegate answers (under the lift threshold) do NOT trigger this
 * — they leave room for the supervisor to wrap them in context, ask a
 * follow-up, or add a short prose preamble.
 */
const DelegateLiftedAnswerSchema = z.object({
  output: z.object({
    ok: z.literal(true),
    answer: z.string().startsWith("[attachment lifted to artifact "),
  }),
});

export const delegateAnsweredUser =
  // deno-lint-ignore no-explicit-any
    (): StopCondition<any> =>
    ({ steps }) => {
      for (const step of steps) {
        for (const toolResult of step.toolResults) {
          if (toolResult.toolName !== "delegate") continue;
          const parsed = DelegateLiftedAnswerSchema.safeParse(toolResult);
          if (parsed.success) return true;
        }
      }
      return false;
    };

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
 * Stop when connect_communicator returns a kind (not an error). The chat-side
 * form drives credential creation + wiring; the agent must wait for that
 * roundtrip before continuing or it would talk over the form.
 */
const ConnectCommunicatorSuccessSchema = z.object({
  output: z.object({ kind: z.string(), error: z.undefined() }),
});

export const connectCommunicatorSucceeded =
  // deno-lint-ignore no-explicit-any
    (): StopCondition<any> =>
    ({ steps }) => {
      for (const step of steps) {
        for (const toolResult of step.toolResults) {
          if (toolResult.toolName !== "connect_communicator") continue;
          const parsed = ConnectCommunicatorSuccessSchema.safeParse(toolResult);
          if (parsed.success) return true;
        }
      }
      return false;
    };
