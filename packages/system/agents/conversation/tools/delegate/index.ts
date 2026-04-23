/**
 * The `delegate` tool — runs a nested `streamText` sub-agent in-process.
 *
 * The child inherits the parent's tool set (minus `delegate`, plus a synthetic
 * `finish` tool) and streams through a proxy `UIMessageStreamWriter` that
 * envelope-wraps every chunk as `data-delegate-chunk`. The tool returns a
 * compact discriminated union to the parent LLM:
 *
 *   { ok: true,  answer, toolsUsed: [{name, outcome}] } — task succeeded
 *   { ok: false, reason, toolsUsed: [{name, outcome}] } — task failed/impossible
 *
 * This is the tracer-bullet implementation. Task #5 will add the full
 * `data-delegate-ledger` event; Task #6 will add abort handling and the
 * `delegate-end` terminator.
 */

import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { buildTemporalFacts, getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { ToolCallRepairFunction, UIMessageStreamWriter } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { FINISH_TOOL_NAME, type FinishInput, finishTool, parseFinishInput } from "./finish-tool.ts";
import { createDelegateProxyWriter } from "./proxy-writer.ts";

const DELEGATE_TOOL_NAME = "delegate";
const CHILD_STEP_BUDGET = 40;
const CHILD_MAX_OUTPUT_TOKENS = 20000;

const DelegateInputSchema = z.strictObject({
  goal: z.string().describe("What the sub-agent should accomplish."),
  handoff: z.string().describe("Distilled context the sub-agent needs to do the work."),
});

interface DatetimeContext {
  timezone: string;
  timestamp: string;
  localDate: string;
  localTime: string;
  timezoneOffset: string;
}

export interface DelegateDeps {
  /** Parent's UIMessageStreamWriter — child chunks land here as data-delegate-chunk envelopes. */
  writer: UIMessageStreamWriter<AtlasUIMessage>;
  /** Session metadata; tracer only uses `datetime` for the child's preamble. */
  session: {
    sessionId: string;
    workspaceId: string;
    streamId: string;
    userId?: string;
    datetime?: DatetimeContext;
  };
  /** Parent's PlatformModels — child uses the same conversational model. */
  platformModels: PlatformModels;
  logger: Logger;
  /** Forwarded to the child's streamText so abort propagates. */
  abortSignal?: AbortSignal;
  /** Same repair function the parent uses, so the child handles malformed tool args identically. */
  repairToolCall: ToolCallRepairFunction<AtlasTools>;
}

export type DelegateToolsUsedEntry = { name: string; outcome: "success" | "error" };

export type DelegateResult =
  | { ok: true; answer: string; toolsUsed: DelegateToolsUsedEntry[] }
  | { ok: false; reason: string; toolsUsed: DelegateToolsUsedEntry[] };

/**
 * Build the `delegate` tool. The child's tool set is computed lazily via
 * `toolSetThunk` so the parent's `composeTools()` can run before the child
 * needs to inherit the result.
 */
export function createDelegateTool(deps: DelegateDeps, toolSetThunk: () => AtlasTools) {
  const { writer, session, platformModels, logger, abortSignal, repairToolCall } = deps;

  return tool({
    description:
      "Spawn a sub-agent that runs in-process and inherits all of your tools (except delegate itself). Use for arbitrary multi-step work that doesn't map to a more specific tool. Provide a clear goal and a distilled handoff summary — the sub-agent does NOT see your conversation history.",
    inputSchema: DelegateInputSchema,
    execute: async ({ goal, handoff }, { toolCallId }): Promise<DelegateResult> => {
      const proxy = createDelegateProxyWriter({
        parent: writer,
        delegateToolCallId: toolCallId,
        logger,
      });

      const collectedToolsUsed: DelegateToolsUsedEntry[] = [];

      try {
        const inheritedTools = toolSetThunk();
        const { [DELEGATE_TOOL_NAME]: _drop, ...withoutDelegate } = inheritedTools;
        const childTools: AtlasTools = { ...withoutDelegate, [FINISH_TOOL_NAME]: finishTool };

        const datetimeMessage = buildTemporalFacts(session.datetime);
        const childSystemPrompt = [
          `Goal: ${goal}`,
          `Handoff: ${handoff}`,
          datetimeMessage,
          `When you have produced a final answer (or determined the task is impossible), call the \`finish\` tool with { ok: true, answer } or { ok: false, reason }. Do not return free-form text after calling \`finish\`.`,
        ].join("\n\n");

        const conversationalModel = platformModels.get("conversational");

        const result = streamText({
          model: conversationalModel,
          experimental_repairToolCall: repairToolCall,
          system: childSystemPrompt,
          messages: [{ role: "user", content: goal }],
          tools: childTools,
          toolChoice: "auto",
          stopWhen: [stepCountIs(CHILD_STEP_BUDGET)],
          maxOutputTokens: CHILD_MAX_OUTPUT_TOKENS,
          abortSignal,
          providerOptions: getDefaultProviderOpts("anthropic"),
        });

        proxy.merge(result.toUIMessageStream<AtlasUIMessage>());

        // Resolve steps first so we can populate `toolsUsed` even when
        // `result.text` rejects (e.g. AI_NoOutputGeneratedError from a
        // tool-call-only stream).
        const steps = await result.steps;
        let finalText = "";
        let textError: Error | undefined;
        try {
          finalText = await result.text;
        } catch (err) {
          textError = err instanceof Error ? err : new Error(String(err));
        }

        // Build an outcome map keyed by toolCallId so we can promote a
        // success to error if the same call later surfaces as `tool-error`.
        const outcomeByCallId = new Map<string, DelegateToolsUsedEntry>();
        let finishInput: FinishInput | undefined;
        for (const step of steps) {
          for (const part of step.content) {
            if (part.type === "tool-call") {
              if (part.toolName === FINISH_TOOL_NAME) continue;
              outcomeByCallId.set(part.toolCallId, { name: part.toolName, outcome: "success" });
            } else if (part.type === "tool-error") {
              outcomeByCallId.set(part.toolCallId, { name: part.toolName, outcome: "error" });
            } else if (part.type === "tool-result" && part.toolName === FINISH_TOOL_NAME) {
              finishInput = parseFinishInput(part.output);
            }
          }
        }
        for (const entry of outcomeByCallId.values()) {
          collectedToolsUsed.push(entry);
        }

        if (finishInput) {
          if (finishInput.ok) {
            return { ok: true, answer: finishInput.answer, toolsUsed: collectedToolsUsed };
          }
          return { ok: false, reason: finishInput.reason, toolsUsed: collectedToolsUsed };
        }
        if (textError) {
          return { ok: false, reason: textError.message, toolsUsed: collectedToolsUsed };
        }
        return { ok: true, answer: finalText, toolsUsed: collectedToolsUsed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("delegate execute caught error", { delegateToolCallId: toolCallId, message });
        return { ok: false, reason: message, toolsUsed: collectedToolsUsed };
      } finally {
        proxy.close();
      }
    },
  });
}
