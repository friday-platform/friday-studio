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
 * Alongside the compact result, the delegate emits one `data-delegate-ledger`
 * event before returning. The ledger carries per-child `{toolCallId, name,
 * input, outcome, summary, stepIndex, durationMs}` — full richness for a
 * future reflection layer — while the tool result stays outline-only
 * (`{name, outcome}`) so future LLM turns don't pay for the ledger in tokens.
 *
 * Task #6 will move the ledger emission into a `finally` block so it also
 * fires on abort/throw, along with the `delegate-end` terminator.
 */

import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { buildTemporalFacts, getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { truncateForLedger } from "@atlas/utils";
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

/**
 * Full ledger entry — one per child tool call (excluding `finish`).
 * Rides on `data-delegate-ledger` out-of-band so future LLM turns don't
 * pay for it in tokens.
 */
export interface DelegateLedgerEntry {
  toolCallId: string;
  name: string;
  input: unknown;
  outcome: "success" | "error";
  summary?: string;
  stepIndex: number;
  durationMs: number;
}

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

      // Accumulator keyed by the child's original (non-namespaced) toolCallId.
      // The outline projection (name+outcome) lands in the tool result;
      // the full entries ride on the out-of-band data-delegate-ledger event.
      const ledger = new Map<string, DelegateLedgerEntry>();
      // Per-call start timestamps (captured from `tool-input-available` chunks).
      const startedAt = new Map<string, number>();

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

        // Tee the child's UIMessage stream: one branch flows through the proxy
        // to the parent (and eventually to the SSE sink); the other drains
        // in-process so we can stamp `durationMs` from `tool-input-available`
        // arrival to the first terminal chunk per call. Tee decouples the
        // branches, so in-process observation does not back-pressure the
        // parent's writer (and vice-versa).
        const uiStream = result.toUIMessageStream<AtlasUIMessage>();
        const [observerBranch, parentBranch] = uiStream.tee();
        const observerDone = observeChunkTimings(observerBranch, startedAt, ledger);
        proxy.merge(parentBranch);

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

        // Wait for the observer to finish so every `tool-output-available` /
        // `tool-output-error` chunk has landed before we emit the ledger.
        await observerDone;

        // Walk steps to fill name / input / stepIndex / outcome / summary.
        // Steps are the authoritative source for these (chunks can be reordered
        // or duplicated on replay); chunks only contributed timing.
        let finishInput: FinishInput | undefined;
        for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
          const step = steps[stepIndex];
          if (!step) continue;
          for (const part of step.content) {
            if (part.type === "tool-call" && part.toolName !== FINISH_TOOL_NAME) {
              const existing = ledger.get(part.toolCallId);
              ledger.set(part.toolCallId, {
                toolCallId: part.toolCallId,
                name: part.toolName,
                input: part.input,
                outcome: existing?.outcome ?? "success",
                summary: existing?.summary,
                stepIndex,
                durationMs: existing?.durationMs ?? 0,
              });
            } else if (part.type === "tool-result" && part.toolName !== FINISH_TOOL_NAME) {
              const existing = ledger.get(part.toolCallId);
              if (existing) {
                existing.outcome = "success";
                existing.summary = truncateForLedger(part.output, 200);
              }
            } else if (part.type === "tool-error" && part.toolName !== FINISH_TOOL_NAME) {
              const existing = ledger.get(part.toolCallId);
              if (existing) {
                existing.outcome = "error";
                existing.summary = truncateForLedger(part.error, 200);
              } else {
                ledger.set(part.toolCallId, {
                  toolCallId: part.toolCallId,
                  name: part.toolName,
                  input: part.input,
                  outcome: "error",
                  summary: truncateForLedger(part.error, 200),
                  stepIndex,
                  durationMs: 0,
                });
              }
            } else if (part.type === "tool-result" && part.toolName === FINISH_TOOL_NAME) {
              finishInput = parseFinishInput(part.output);
            }
          }
        }

        // Emit the full ledger out-of-band before returning. Task #6 will
        // move this into a `finally` so abort/throw also flush it.
        const ledgerEntries = [...ledger.values()];
        writer.write({
          type: "data-delegate-ledger",
          data: { delegateToolCallId: toolCallId, toolsUsed: ledgerEntries },
        });

        const toolsUsed: DelegateToolsUsedEntry[] = ledgerEntries.map(({ name, outcome }) => ({
          name,
          outcome,
        }));

        if (finishInput) {
          if (finishInput.ok) {
            return { ok: true, answer: finishInput.answer, toolsUsed };
          }
          return { ok: false, reason: finishInput.reason, toolsUsed };
        }
        if (textError) {
          return { ok: false, reason: textError.message, toolsUsed };
        }
        return { ok: true, answer: finalText, toolsUsed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("delegate execute caught error", { delegateToolCallId: toolCallId, message });
        const toolsUsed: DelegateToolsUsedEntry[] = [...ledger.values()].map(
          ({ name, outcome }) => ({ name, outcome }),
        );
        return { ok: false, reason: message, toolsUsed };
      } finally {
        proxy.close();
      }
    },
  });
}

/**
 * Drain the child's UIMessage stream in-process, stamping `durationMs` from
 * `tool-input-available` arrival to the first terminal chunk per child tool
 * call. Skips the synthetic `finish` tool — it never appears in the ledger.
 *
 * Writes directly into `ledger` so timing is present whether or not the
 * matching step has been walked yet (step walking populates name/input/etc.
 * after this settles).
 */
async function observeChunkTimings(
  stream: ReadableStream<unknown>,
  startedAt: Map<string, number>,
  ledger: Map<string, DelegateLedgerEntry>,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (typeof value !== "object" || value === null) continue;
      if (!("type" in value) || !("toolCallId" in value)) continue;
      const { type, toolCallId } = value;
      if (typeof type !== "string" || typeof toolCallId !== "string") continue;
      if ("toolName" in value && value.toolName === FINISH_TOOL_NAME) continue;
      if (type === "tool-input-available") {
        if (!startedAt.has(toolCallId)) startedAt.set(toolCallId, Date.now());
      } else if (type === "tool-output-available" || type === "tool-output-error") {
        const start = startedAt.get(toolCallId);
        if (start === undefined) continue;
        const existing = ledger.get(toolCallId);
        if (existing && existing.durationMs > 0) continue;
        const durationMs = Math.max(0, Date.now() - start);
        if (existing) {
          existing.durationMs = durationMs;
        } else {
          // Placeholder — step walking will fill the rest. stepIndex left at 0
          // until the step loop overwrites it.
          const toolName =
            "toolName" in value && typeof value.toolName === "string" ? value.toolName : "";
          ledger.set(toolCallId, {
            toolCallId,
            name: toolName,
            input: undefined,
            outcome: type === "tool-output-error" ? "error" : "success",
            stepIndex: 0,
            durationMs,
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
