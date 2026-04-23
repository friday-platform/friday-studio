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
 * event from a `finally` block so it always fires — clean finish, abort, or
 * thrown error. The `finally` also writes a single synthetic terminator chunk
 * (`{type: "delegate-end", pendingToolCallIds: string[]}`) listing any child
 * `toolCallId`s that started but never received a terminal chunk, so reducers
 * downstream can recover children stuck in `input-streaming`/`input-available`.
 */

import type { AtlasTool, AtlasTools, AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { buildTemporalFacts, getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { truncateForLedger } from "@atlas/utils";
import type { ToolCallRepairFunction, UIMessageStreamWriter } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { rebindAgentTool } from "../../../workspace-chat/tools/bundled-agent-tools.ts";
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
  /**
   * Optional hook to rebind inherited agent tools so their inner stream events
   * route through the delegate proxy instead of leaking to the parent writer.
   */
  rebindAgentTool?: (
    inheritedTool: AtlasTool,
    proxyWriter: UIMessageStreamWriter<AtlasUIMessage>,
  ) => AtlasTool;
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
      // Per-call terminal arrival flag (`tool-output-available`/`tool-output-error`).
      // A child id present in `startedAt` but absent here at finally-time is "pending"
      // and lands in `delegate-end.pendingToolCallIds` (namespaced).
      const terminated = new Set<string>();

      let finishInput: FinishInput | undefined;
      let finalText = "";
      let textError: Error | undefined;
      let abortReason: string | undefined;
      let executionError: Error | undefined;

      try {
        const inheritedTools = toolSetThunk();
        const { [DELEGATE_TOOL_NAME]: _drop, ...withoutDelegate } = inheritedTools;

        const childTools: AtlasTools = { [FINISH_TOOL_NAME]: finishTool };
        for (const [name, t] of Object.entries(withoutDelegate)) {
          childTools[name] = deps.rebindAgentTool
            ? deps.rebindAgentTool(t, proxy)
            : rebindAgentTool(t, proxy);
        }

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
        //
        // The parent branch is forwarded chunk-by-chunk (not via `proxy.merge`)
        // so we can `await` the forwarding's completion. Without that await,
        // the synthetic `delegate-end` written in `finally` could be enqueued
        // before the merge promise has finished draining, breaking the
        // "delegate-end is the final data-delegate-chunk" invariant.
        const uiStream = result.toUIMessageStream<AtlasUIMessage>();
        const [observerBranch, parentBranch] = uiStream.tee();
        const observerDone = observeChunkTimings(observerBranch, startedAt, terminated, ledger);
        const forwardDone = forwardThroughProxy(parentBranch, proxy);

        // Resolve steps first so we can populate `toolsUsed` even when
        // `result.text` rejects (e.g. AI_NoOutputGeneratedError from a
        // tool-call-only stream).
        const steps = await result.steps;
        try {
          finalText = await result.text;
        } catch (err) {
          textError = err instanceof Error ? err : new Error(String(err));
        }

        // Wait for the observer AND the parent forward to finish so every
        // child chunk has been enqueued upstream before we emit the terminator.
        await observerDone;
        await forwardDone;

        // Walk steps to fill name / input / stepIndex / outcome / summary.
        // Steps are the authoritative source for these (chunks can be reordered
        // or duplicated on replay); chunks only contributed timing.
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
      } catch (err) {
        executionError = err instanceof Error ? err : new Error(String(err));
        logger.warn("delegate execute caught error", {
          delegateToolCallId: toolCallId,
          message: executionError.message,
        });
      } finally {
        // Compute pending child toolCallIds (started but never terminated).
        // Emit them in namespaced form to match the on-wire envelope shape.
        const pendingToolCallIds: string[] = [];
        for (const childId of startedAt.keys()) {
          if (!terminated.has(childId)) {
            pendingToolCallIds.push(`${toolCallId}::${childId}`);
          }
        }

        // If the parent's abortSignal fired, capture a stable reason. We do
        // this here (not in catch) because streamText may not throw on abort —
        // it can simply truncate the stream cleanly.
        if (!executionError && abortSignal?.aborted) {
          abortReason = "delegate aborted";
        }

        // Single synthetic terminator. Always the final data-delegate-chunk
        // for this delegateToolCallId on the non-crash path. We write directly
        // to the parent (bypassing the proxy's per-chunk wrap) because the
        // delegate-end envelope is its own wire shape — the proxy is what we
        // emit it *as*, not what we route it through.
        writer.write({
          type: "data-delegate-chunk",
          data: {
            delegateToolCallId: toolCallId,
            chunk: { type: "delegate-end", pendingToolCallIds },
          },
        });

        // Full ledger ridealong. Always emitted, even with partial accumulator
        // contents on abort/throw — downstream truthsource for "what ran".
        const ledgerEntries = [...ledger.values()];
        writer.write({
          type: "data-delegate-ledger",
          data: { delegateToolCallId: toolCallId, toolsUsed: ledgerEntries },
        });

        // Terminal — late writes/merges from any straggler are silently dropped.
        proxy.close();
      }

      const toolsUsed: DelegateToolsUsedEntry[] = [...ledger.values()].map(({ name, outcome }) => ({
        name,
        outcome,
      }));

      if (executionError) {
        return { ok: false, reason: executionError.message, toolsUsed };
      }
      if (finishInput) {
        if (finishInput.ok) {
          return { ok: true, answer: finishInput.answer, toolsUsed };
        }
        return { ok: false, reason: finishInput.reason, toolsUsed };
      }
      if (abortReason) {
        return { ok: false, reason: abortReason, toolsUsed };
      }
      if (textError) {
        return { ok: false, reason: textError.message, toolsUsed };
      }
      return { ok: true, answer: finalText, toolsUsed };
    },
  });
}

/**
 * Drain `stream` and forward each chunk through `proxy.write` in order. We
 * use the proxy (rather than `proxy.merge`) so we can `await` completion —
 * `merge` is fire-and-forget per the AI SDK contract, which would race the
 * synthetic `delegate-end` we emit afterwards.
 */
async function forwardThroughProxy(
  stream: ReadableStream<AtlasUIMessageChunk>,
  proxy: { write(chunk: AtlasUIMessageChunk): void },
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) proxy.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Drain the child's UIMessage stream in-process, stamping `durationMs` from
 * `tool-input-available` arrival to the first terminal chunk per child tool
 * call. Skips the synthetic `finish` tool — it never appears in the ledger.
 *
 * Writes directly into `ledger` so timing is present whether or not the
 * matching step has been walked yet (step walking populates name/input/etc.
 * after this settles). Also marks `terminated` so the delegate's `finally`
 * can compute `pendingToolCallIds` for the synthetic `delegate-end` chunk.
 */
async function observeChunkTimings(
  stream: ReadableStream<unknown>,
  startedAt: Map<string, number>,
  terminated: Set<string>,
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
        terminated.add(toolCallId);
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
