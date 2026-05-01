/**
 * The synthetic `finish` tool injected into a delegate child's tool set.
 *
 * The child LLM calls this tool exactly once when it's done. The delegate
 * inspects `result.toolResults` for the finish call and uses its payload
 * to drive the discriminated-union return value to the parent LLM.
 *
 * `execute()` is identity — finish is a pass-through tool whose sole purpose
 * is to give the child a structured termination signal.
 *
 * Authoring note: the input shape is `{ ok, answer? } | { ok, reason? }`
 * but expressed as a flat object schema with both `answer` and `reason`
 * optional — `z.discriminatedUnion` would produce a top-level `oneOf` JSON
 * Schema, which Anthropic rejects with `tools.<n>.custom.input_schema.type:
 * Field required`. The runtime parser (`FinishInputSchema`) re-validates
 * with the discriminated shape so the delegate gets a clean tagged union.
 */

import { jsonSchema, tool } from "ai";
import { z } from "zod";

const FinishInputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), answer: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type FinishInput = z.infer<typeof FinishInputSchema>;

export const FINISH_TOOL_NAME = "finish";

export const finishTool = tool({
  description:
    "Call this when done to return a structured result. When the task succeeded, call with { ok: true, answer: '...' }. When the task failed or was impossible, call with { ok: false, reason: '...' }. Always set `ok` and exactly one of `answer` or `reason`.",
  inputSchema: jsonSchema<FinishInput>({
    type: "object",
    properties: {
      ok: {
        type: "boolean",
        description: "true when the task succeeded, false when it failed or was impossible.",
      },
      answer: {
        type: "string",
        description: "The final answer to return to the parent. Required when ok=true.",
      },
      reason: {
        type: "string",
        description: "Why the task failed or was impossible. Required when ok=false.",
      },
    },
    required: ["ok"],
    additionalProperties: false,
  }),
  execute: (input: FinishInput) => input,
});

/** Re-validate a finish call's input against the strict discriminated shape. */
export function parseFinishInput(input: unknown): FinishInput | undefined {
  const parsed = FinishInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
