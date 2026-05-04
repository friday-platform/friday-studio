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
 * (`{ type: "delegate-end" }`) so reducers downstream can recover any
 * non-terminal children still stuck in `input-streaming`/`input-available`.
 */

import type { AtlasTool, AtlasTools, AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { discoverMCPServers, type LinkSummary } from "@atlas/core/mcp-registry/discovery";
import { buildTemporalFacts, getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { truncateForLedger } from "@atlas/utils";
import type { ToolCallRepairFunction, UIMessageStreamWriter } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { rebindAgentTool } from "../../../workspace-chat/tools/bundled-agent-tools.ts";
import { createScrubber } from "../../lib/scrub-tool-output.ts";
import { FINISH_TOOL_NAME, type FinishInput, finishTool, parseFinishInput } from "./finish-tool.ts";
import { createDelegateProxyWriter } from "./proxy-writer.ts";

const DELEGATE_TOOL_NAME = "delegate";
const CHILD_STEP_BUDGET = 40;
const CHILD_MAX_OUTPUT_TOKENS = 20000;

const DelegateInputSchema = z.strictObject({
  goal: z.string().describe("What the sub-agent should accomplish."),
  handoff: z.string().describe("Distilled context the sub-agent needs to do the work."),
  mcpServers: z
    .array(z.string())
    .optional()
    .describe("List of MCP server IDs to make available to the sub-agent."),
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
  workspaceConfig?: WorkspaceConfig;
  linkSummary?: LinkSummary;
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

export type ServerFailure = { serverId: string; reason: string };

export type DelegateResult =
  | {
      ok: true;
      answer: string;
      toolsUsed: DelegateToolsUsedEntry[];
      serverFailures?: ServerFailure[];
    }
  | {
      ok: false;
      reason: string;
      toolsUsed: DelegateToolsUsedEntry[];
      serverFailures?: ServerFailure[];
    };

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
    execute: async ({ goal, handoff, mcpServers }, { toolCallId }): Promise<DelegateResult> => {
      const proxy = createDelegateProxyWriter({
        parent: writer,
        delegateToolCallId: toolCallId,
        logger,
      });

      // Accumulator keyed by the child's original (non-namespaced) toolCallId.
      // The outline projection (name+outcome) lands in the tool result;
      // the full entries ride on the out-of-band data-delegate-ledger event.
      const ledger = new Map<string, DelegateLedgerEntry>();

      let finishInput: FinishInput | undefined;
      let finalText = "";
      let textError: Error | undefined;
      let abortReason: string | undefined;
      let executionError: Error | undefined;
      let mcpDispose: (() => Promise<void>) | undefined;
      const serverFailures: ServerFailure[] = [];

      try {
        const inheritedTools = toolSetThunk();
        const { [DELEGATE_TOOL_NAME]: _drop, ...withoutDelegate } = inheritedTools;

        const childTools: AtlasTools = { [FINISH_TOOL_NAME]: finishTool };
        for (const [name, t] of Object.entries(withoutDelegate)) {
          childTools[name] = deps.rebindAgentTool
            ? deps.rebindAgentTool(t, proxy)
            : rebindAgentTool(t, proxy);
        }

        if (mcpServers && mcpServers.length > 0) {
          let candidates: import("@atlas/core/mcp-registry/discovery").MCPServerCandidate[];
          try {
            candidates = await discoverMCPServers(
              session.workspaceId,
              deps.workspaceConfig,
              deps.linkSummary,
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return { ok: false, reason: `MCP server discovery failed: ${reason}`, toolsUsed: [] };
          }

          const candidateMap = new Map(candidates.map((c) => [c.metadata.id, c]));
          const invalid = mcpServers.filter((id) => {
            const c = candidateMap.get(id);
            return !c || !c.configured;
          });
          if (invalid.length > 0) {
            return {
              ok: false,
              reason: `Unknown or unconfigured MCP server(s): ${invalid.join(", ")}`,
              toolsUsed: [],
            };
          }

          const selectedConfigs: Record<string, MCPServerConfig> = {};
          for (const id of mcpServers) {
            const c = candidateMap.get(id);
            if (c) selectedConfigs[id] = c.mergedConfig;
          }

          // Scrub binary out of MCP tool results before they enter the AI
          // SDK message buffer. Bytes get lifted to artifacts; the model
          // sees a short ref string. Avoids the prompt-token tax + chat
          // persistence MAX_PAYLOAD_EXCEEDED on attachment-bearing tools
          // (Gmail's `get_gmail_attachment_content` with return_base64=true,
          // image responses, etc.). Pre-persist scrubbing in the parent
          // agent acts as a backstop for anything that slips past.
          const scrubResult = createScrubber({
            workspaceId: session.workspaceId,
            chatId: session.streamId,
            logger,
          });

          const serverEntries = Object.entries(selectedConfigs);
          const serverResults = await Promise.allSettled(
            serverEntries.map(([serverId, config]) => {
              const prefix = serverEntries.length > 1 ? serverId : undefined;
              return createMCPTools({ [serverId]: config }, logger, {
                signal: abortSignal,
                toolPrefix: prefix,
                scrubResult,
              });
            }),
          );

          const mcpTools: AtlasTools = {};
          const disposes: Array<() => Promise<void>> = [];
          for (let i = 0; i < serverResults.length; i++) {
            const [serverId] = serverEntries[i]!;
            const result = serverResults[i]!;
            if (result.status === "fulfilled") {
              Object.assign(mcpTools, result.value.tools);
              disposes.push(result.value.dispose);
            } else {
              const reason =
                result.reason instanceof Error ? result.reason.message : String(result.reason);
              serverFailures.push({ serverId, reason });
              logger.warn("MCP server connection failed in delegate", {
                delegateToolCallId: toolCallId,
                serverId,
                error: reason,
              });
            }
          }

          if (disposes.length === 0) {
            return {
              ok: false,
              reason: "All requested MCP servers failed to connect.",
              toolsUsed: [],
              serverFailures,
            };
          }

          mcpDispose = async () => {
            await Promise.allSettled(disposes.map((d) => d()));
          };

          Object.assign(childTools, mcpTools);
        }

        const datetimeMessage = buildTemporalFacts(session.datetime);
        const childSystemPrompt = [
          `Goal: ${goal}`,
          `Handoff: ${handoff}`,
          datetimeMessage,
          `You are a terse back-end agent. Your output is consumed by another AI agent, not a human user. Do not narrate your actions, do not produce conversational filler, and do not emit markdown tables, section headers, or other human-facing formatting. Make tool calls directly without describing what you are doing. Gather the required facts with the fewest tool calls possible, then call the \`finish\` tool immediately with a concise, factual answer.`,
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
        const observerDone = observeChunkTimings(observerBranch, ledger);
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
          data: { delegateToolCallId: toolCallId, chunk: { type: "delegate-end" } },
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

        // Dispose any established MCP connections.
        try {
          await mcpDispose?.();
        } catch {
          // ignore cleanup errors
        }
      }

      const toolsUsed: DelegateToolsUsedEntry[] = [...ledger.values()].map(({ name, outcome }) => ({
        name,
        outcome,
      }));

      const resultBase = serverFailures.length > 0 ? { toolsUsed, serverFailures } : { toolsUsed };

      if (executionError) {
        return { ok: false, reason: executionError.message, ...resultBase };
      }
      if (finishInput) {
        if (finishInput.ok) {
          return { ok: true, answer: finishInput.answer, ...resultBase };
        }
        return { ok: false, reason: finishInput.reason, ...resultBase };
      }
      if (abortReason) {
        return { ok: false, reason: abortReason, ...resultBase };
      }
      if (textError) {
        return { ok: false, reason: textError.message, ...resultBase };
      }
      return { ok: true, answer: finalText, ...resultBase };
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
 * after this settles).
 */
async function observeChunkTimings(
  stream: ReadableStream<unknown>,
  ledger: Map<string, DelegateLedgerEntry>,
): Promise<void> {
  const startedAt = new Map<string, number>();
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
