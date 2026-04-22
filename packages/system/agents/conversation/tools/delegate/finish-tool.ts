/**
 * The synthetic `finish` tool injected into a delegate child's tool set.
 *
 * The child LLM calls this tool exactly once when it's done. The delegate
 * inspects `result.toolResults` for the finish call and uses its payload
 * to drive the discriminated-union return value to the parent LLM.
 *
 * `execute()` is identity — finish is a pass-through tool whose sole purpose
 * is to give the child a structured termination signal.
 */

import { tool } from "ai";
import { z } from "zod";

const FinishInputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), answer: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type FinishInput = z.infer<typeof FinishInputSchema>;

export const FINISH_TOOL_NAME = "finish";

export const finishTool = tool({
  description:
    "Call this when done to return a structured result. Use { ok: true, answer } when the task succeeded; use { ok: false, reason } when the task failed or was impossible.",
  inputSchema: FinishInputSchema,
  execute: (input: FinishInput) => input,
});
