/**
 * `record_validation` — platform tool the LLM calls to record its inline
 * self-check verdict before emitting.
 *
 * Conditional injection: the FSM runtime adds this to an action's tool
 * catalog only when the resolved validation decision is `"self"`. The
 * `validating-llm-outputs` system skill (composed into the prompt at the
 * same time) instructs the LLM to call this tool with one of three verdicts:
 *
 *   - `pass`      — sourced and emit-ready
 *   - `advisory`  — sourced but flag specific concerns (issues[])
 *   - `blocking`  — not sourced; do NOT emit (runtime treats as failStep)
 *
 * Capture mechanism mirrors `complete` and `failStep`: this is a local
 * AI-SDK `Tool` rather than an MCP-server-side registration. The runtime
 * inspects the LLM result's `toolCalls` post-call (see
 * `findRecordValidationToolArgs` in `fsm-engine.ts`) and reads args off the
 * `record_validation` call.
 *
 * @module
 */

import type { Tool } from "ai";
import { z } from "zod";

/**
 * Issue shape for the tool's input. Matches `StepValidationIssueSchema` in
 * `@atlas/core/session-events` so captured args can flow into
 * `step:complete.validation.issues` without a transform. Severity / category
 * stay loose on input — the session-events schema narrows severity to a
 * small enum but tolerates absence; the runtime re-parses through that
 * schema before emit.
 */
const RecordValidationIssueSchema = z.object({
  category: z
    .string()
    .optional()
    .describe("Category of the issue (e.g. 'sourcing', 'no-tools-called', 'judge-uncertain')."),
  claim: z.string().describe("The specific claim or sentence you flagged."),
  reasoning: z
    .string()
    .optional()
    .describe("Why you flagged it — what source is missing or contradicted."),
  severity: z
    .enum(["low", "medium", "high", "info", "warn", "error"])
    .optional()
    .describe("Severity of the concern."),
  citation: z.string().nullable().optional().describe("Optional source pointer if one exists."),
});

const RecordValidationInputSchema = z.object({
  verdict: z
    .enum(["pass", "advisory", "blocking"])
    .describe(
      "Your inline self-check outcome. `pass` = all claims sourced, emit normally. " +
        "`advisory` = sourced but you have specific concerns (list them in issues). " +
        "`blocking` = you cannot source your output — DO NOT emit; the runtime will " +
        "fail the action.",
    ),
  issues: z
    .array(RecordValidationIssueSchema)
    .optional()
    .describe(
      "Optional list of specific concerns. Required for `blocking` verdicts. " +
        "Each issue describes one unsourced claim you found in your draft.",
    ),
});

/**
 * Re-export the input schema so tests and other capture-side helpers can
 * round-trip through the same shape the LLM sees.
 */
export const RecordValidationInputZodSchema = RecordValidationInputSchema;

/**
 * Strict input shape captured off the tool call. The runtime treats the
 * captured args as `Record<string, unknown>` and re-parses through this
 * schema before promoting them onto `step:complete.validation`.
 */
export type RecordValidationInput = z.infer<typeof RecordValidationInputSchema>;

/**
 * The tool's static name. Importers across packages should reference this
 * constant rather than the bare string so renames stay typed.
 */
export const RECORD_VALIDATION_TOOL_NAME = "record_validation" as const;

/**
 * Build the AI-SDK `Tool` instance the FSM runtime injects into a
 * `decision === "self"` action's tool catalog. The `execute` body returns a
 * minimal acknowledgement — the verdict is captured by inspecting the LLM's
 * `toolCalls` post-call (mirrors `complete`'s capture path), not by reading
 * a return value.
 */
export function createRecordValidationTool(): Tool {
  return {
    description:
      "Record your inline self-check verdict before emitting your final output. " +
      "Call exactly once. Use `pass` if every factual claim in your draft is sourced, " +
      "`advisory` if sourced but you have specific concerns, or `blocking` if you " +
      "cannot source your output (the runtime fails the action). Required when the " +
      "validating-llm-outputs skill is loaded.",
    inputSchema: RecordValidationInputSchema,
    execute: () => ({ recorded: true }),
  };
}
