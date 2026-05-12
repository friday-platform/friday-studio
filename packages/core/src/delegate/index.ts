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
import type { DelegationBudget, MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { buildTemporalFacts, getDefaultProviderOpts, type PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { truncateForLedger } from "@atlas/utils";
import type { ToolCallRepairFunction, UIMessageStreamWriter } from "ai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { liftAnswerForModel } from "../artifacts/scrubber.ts";
import { discoverMCPServers, type LinkSummary } from "../mcp-registry/discovery.ts";
import { FINISH_TOOL_NAME, type FinishInput, finishTool, parseFinishInput } from "./finish-tool.ts";
import { createDelegateProxyWriter } from "./proxy-writer.ts";
import {
  formatDelegateSkillsBlock,
  resolveDelegateSkills,
  type SkillArchiveCache,
} from "./skills-resolver.ts";

const DELEGATE_TOOL_NAME = "delegate";
/**
 * Default delegation budget constants. Exported so callers (notably
 * `fsm-engine`'s pre-strip gate) reference the same values rather than
 * hardcoding their own copy.
 */
export const DEFAULT_MAX_STEPS_PER_CALL = 40;
export const DEFAULT_MAX_OUTPUT_TOKENS = 20000;
export const DEFAULT_MAX_DEPTH = 1;

// Re-export the system-prompt helpers from their zero-import module so
// callers can `import { ... } from "@atlas/core/delegate"`. The same
// helpers are also reachable directly via `@atlas/core/delegate/system-prompt`,
// which QA evals prefer because it avoids pulling in this module's
// runtime-heavy transitive imports (streamText, MCP, etc.).
export { buildDelegateScopeDirective, DELEGATE_MCP_ERROR_CONTRACT } from "./system-prompt.ts";

import { buildDelegateScopeDirective, DELEGATE_MCP_ERROR_CONTRACT } from "./system-prompt.ts";

const DelegateSkillRequestSchema = z.strictObject({
  name: z
    .string()
    .describe("Skill ref in @namespace/skill-name form — must be one of your visible skills."),
  refs: z
    .array(z.string())
    .optional()
    .describe(
      "Specific reference file paths inside the skill archive (e.g. references/phrases.md). When omitted, the full SKILL.md body is injected.",
    ),
});

const DelegateInputSchema = z.strictObject({
  goal: z.string().describe("What the sub-agent should accomplish."),
  handoff: z.string().describe("Distilled context the sub-agent needs to do the work."),
  mcpServers: z
    .array(z.string())
    .optional()
    .describe("List of MCP server IDs to make available to the sub-agent."),
  skills: z
    .array(DelegateSkillRequestSchema)
    .optional()
    .describe(
      "Skills to inject into the sub-agent's system prompt. Must be drawn from your own visible skills; out-of-scope refs are dropped. Pass `refs` to surgically include only specific reference files rather than the entire skill body.",
    ),
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
  /**
   * Resolved delegation budget (per-job merged over workspace).
   * Each unset field falls through to the back-compat defaults above
   * (DEFAULT_MAX_STEPS_PER_CALL, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_DEPTH;
   * wall-clock and input-token are unbounded by default).
   *
   * `max_cost_usd` is plumbed through but not enforced — reserved for the
   * cost-tracking phase.
   */
  budget?: DelegationBudget;
  /**
   * Current delegation depth at the time the parent LLM invokes delegate.
   * 0 for top-level, parent's depth + 1 for nested.
   * Compared against `budget?.max_depth ?? DEFAULT_MAX_DEPTH` and used to
   * decide whether the child's tool set keeps `delegate` (allowing
   * further nesting up to the cap) or strips it (today's behavior at
   * depth = max_depth - 1).
   */
  depth?: number;
  /**
   * Optional per-session skill-archive cache. When omitted,
   * `createDelegateTool` instantiates a fresh one. Forwarded into the
   * nested delegate at depth + 1 so re-delegated children share the
   * parent's already-extracted tarballs.
   */
  archiveCache?: SkillArchiveCache;
  /**
   * When true (default), large successful-answer strings are lifted to an
   * artifact before `execute` returns. The returned `answer` is the marker
   * text; `answerArtifactId` carries the structured signal. Persistence
   * short-circuits on the marker prefix, so a single artifact represents
   * the answer end-to-end.
   *
   * Direct-execute callers that consume the answer themselves (the judge
   * agent's verdict parser) opt out with `false` — they need the raw text,
   * not a marker. Setting this on a code path that feeds the answer into
   * another LLM is almost always wrong; keep the default.
   */
  liftAnswer?: boolean;
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
      /**
       * Structured "answer was lifted to an artifact" signal. Stamped by
       * `execute` when the child's answer exceeded the text-lift threshold
       * and a successful upload happened. Downstream consumers (stop
       * predicates, display-artifact callers, judges) should branch on the
       * presence of this field rather than parsing marker text out of
       * `answer` — the marker is a human-readable rendering, this is the
       * machine signal.
       */
      answerArtifactId?: string;
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
  const budget = deps.budget;
  const depth = deps.depth ?? 0;
  const maxDepth = budget?.max_depth ?? DEFAULT_MAX_DEPTH;
  const maxStepsPerCall = budget?.max_steps_per_call ?? DEFAULT_MAX_STEPS_PER_CALL;
  const maxOutputTokens = budget?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const maxInputTokens = budget?.max_input_tokens ?? Number.POSITIVE_INFINITY;
  const maxWallTimeMs = budget?.max_wall_time_ms ?? Number.POSITIVE_INFINITY;
  const liftAnswer = deps.liftAnswer ?? true;

  // Per-tool-instance archive cache. Lifetime matches the parent agent's
  // session: a chat that delegates 6× with the same skill ref pays the
  // tarball-extraction cost once. Re-delegated children (depth > 0) share
  // the same cache via `{ ...deps }` propagation below.
  const archiveCache: SkillArchiveCache =
    deps.archiveCache ?? new Map<string, Promise<Record<string, string>>>();

  return tool({
    description:
      "Spawn a sub-agent that runs in-process and inherits all of your tools (except delegate itself). Use for arbitrary multi-step work that doesn't map to a more specific tool. Provide a clear goal and a distilled handoff summary — the sub-agent does NOT see your conversation history. Pass `skills: [{name, refs?}]` to thread skills from your visible set into the sub-agent's system prompt; use `refs` to scope to specific reference files within a skill instead of injecting the whole body.",
    inputSchema: DelegateInputSchema,
    execute: async (
      { goal, handoff, mcpServers, skills },
      { toolCallId },
    ): Promise<DelegateResult> => {
      // Depth budget. Fail before spawning the child when the
      // parent's depth is already at the cap. The fsm-engine wiring also
      // strips `delegate` from the child's tool set at this depth, so this
      // path is reachable only via a non-FSM caller (chat) or a
      // miswired/stale tool-list snapshot. Either way, we refuse to spawn.
      if (depth >= maxDepth) {
        return { ok: false, reason: "budget_exhausted: max_depth", toolsUsed: [] };
      }

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
      // Track which budget triggered an abort. Set when `wallTimeSignal`
      // fires or when the per-step input-token watchdog
      // aborts `internalAbort`. Promoted to the result's `reason` field
      // ahead of generic abort/text errors so the parent LLM gets the
      // specific budget that exhausted.
      let budgetExhaustedReason: string | undefined;
      const internalAbort = new AbortController();
      // Compose external abort + wall-clock timeout + internal abort (for
      // input-token enforcement) into a single signal handed to streamText.
      const composedSignals: AbortSignal[] = [internalAbort.signal];
      if (abortSignal) composedSignals.push(abortSignal);
      let wallTimeSignal: AbortSignal | undefined;
      if (Number.isFinite(maxWallTimeMs)) {
        wallTimeSignal = AbortSignal.timeout(maxWallTimeMs);
        composedSignals.push(wallTimeSignal);
      }
      const childAbortSignal =
        composedSignals.length === 1 ? composedSignals[0] : AbortSignal.any(composedSignals);

      try {
        const inheritedTools = toolSetThunk();
        // When the child's effective depth (`depth + 1`) is still below
        // `max_depth`, keep `delegate` in the tool set so the child
        // can re-delegate. Otherwise strip it (today's behavior at the
        // single-level cap). Splitting the destructure makes the keep/strip
        // decision explicit without two near-duplicate code paths.
        const childCanDelegate = depth + 1 < maxDepth;
        const { [DELEGATE_TOOL_NAME]: _parentDelegate, ...withoutDelegate } = inheritedTools;
        // When the child can re-delegate, build a fresh delegate tool bound
        // to `depth + 1`. We reuse the parent's deps (writer,
        // session, platformModels, etc. — already in this function's
        // closure) and the same `toolSetThunk` so the grandchild also
        // inherits properly. Without this rebind, the inherited
        // `parentDelegate` would carry the parent's depth=N closure, and
        // the grandchild's depth check would pass on `N >= maxDepth`
        // forever — the loophole called out in the 2026-05-06 review.
        const inheritedForChild: AtlasTools = childCanDelegate
          ? {
              ...withoutDelegate,
              // Forward `archiveCache` explicitly: `deps.archiveCache` is
              // undefined on the first call (the local `archiveCache`
              // closure-variable is the freshly-instantiated Map), so a
              // bare `{...deps}` would give the grandchild its own empty
              // cache and defeat the per-session sharing.
              [DELEGATE_TOOL_NAME]: createDelegateTool(
                { ...deps, depth: depth + 1, archiveCache },
                toolSetThunk,
              ),
            }
          : withoutDelegate;

        const childTools: AtlasTools = { [FINISH_TOOL_NAME]: finishTool };
        for (const [name, t] of Object.entries(inheritedForChild)) {
          // When `rebindAgentTool` is supplied, callers (chat) use it to
          // re-route nested agent-tool stream events through the delegate
          // proxy. Otherwise (FSM, callers without bundled-agent tools) the
          // inherited tool passes through unchanged — its writer stays
          // whatever the caller wired at construction time. The proxy still
          // wraps anything streamed via the AI SDK message stream, so the
          // happy path is intact even without a rebind hook.
          childTools[name] = deps.rebindAgentTool ? deps.rebindAgentTool(t, proxy) : t;
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

          // Do not lift MCP results before the child LLM sees them. The lift's
          // value is persistence + parent-handoff compactness, not child-LLM
          // context shrinkage; persistence paths scrub/lift the delegate's final
          // answer and ledger before they become durable parent-visible state.
          const serverEntries = Object.entries(selectedConfigs);
          const serverResults = await Promise.allSettled(
            serverEntries.map(([serverId, config]) => {
              const prefix = serverEntries.length > 1 ? serverId : undefined;
              return createMCPTools({ [serverId]: config }, logger, {
                // Use the parent's abort signal (not the composed one) for
                // MCP startup — wall-clock budget is for the LLM call, not
                // the connection handshake. Connection failures bubble up
                // as a `serverFailures` entry on their own.
                signal: abortSignal,
                toolPrefix: prefix,
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

        // Resolve any skills the parent threaded through. Authority is the
        // parent's visible-skill set — anything outside is dropped and
        // logged, so a hallucinated name cannot escalate the child's reach.
        // An empty / missing `skills` arg returns [] and contributes no
        // text to the prompt.
        const resolvedSkills = skills
          ? await resolveDelegateSkills(skills, {
              workspaceId: session.workspaceId,
              logger,
              archiveCache,
            })
          : [];
        const skillsBlock = formatDelegateSkillsBlock(resolvedSkills);

        const datetimeMessage = buildTemporalFacts(session.datetime);

        const childSystemPrompt = [
          skillsBlock,
          `Goal: ${goal}`,
          `Handoff: ${handoff}`,
          datetimeMessage,
          `You are a terse back-end agent. Your output is consumed by another AI agent, not a human user. Do not narrate your actions, do not produce conversational filler. Make tool calls directly without describing what you are doing. Gather the required facts with the fewest tool calls possible, then emit your final answer.`,
          buildDelegateScopeDirective(mcpServers),
          DELEGATE_MCP_ERROR_CONTRACT,
          `Emit your final answer as plain text content — your text reply IS the answer. Do not call the \`finish\` tool on success; do not write the answer inside a tool call argument and then again as text. Call \`finish\` ONLY when the task is impossible to complete, with \`{ ok: false, reason }\` — the supervisor needs the structured failure signal in that case.`,
        ]
          .filter((s) => s.length > 0)
          .join("\n\n");

        const conversationalModel = platformModels.get("conversational");

        // Input-token watchdog. The AI SDK's `onStepFinish` fires after
        // each child step with `usage.inputTokens` for that
        // step. Sum across steps; when the running total exceeds the
        // budget, abort the internal controller so streamText terminates
        // cleanly. Recording `budgetExhaustedReason` lets us return the
        // specific budget that fired ahead of the generic abort path.
        let cumulativeInputTokens = 0;
        const result = streamText({
          model: conversationalModel,
          experimental_repairToolCall: repairToolCall,
          system: childSystemPrompt,
          messages: [{ role: "user", content: goal }],
          tools: childTools,
          toolChoice: "auto",
          stopWhen: [stepCountIs(maxStepsPerCall)],
          maxOutputTokens,
          abortSignal: childAbortSignal,
          providerOptions: getDefaultProviderOpts("anthropic"),
          onStepFinish: ({ usage }) => {
            const stepInput = usage?.inputTokens;
            if (typeof stepInput === "number" && stepInput > 0) {
              cumulativeInputTokens += stepInput;
            }
            if (cumulativeInputTokens > maxInputTokens && !internalAbort.signal.aborted) {
              budgetExhaustedReason = "max_input_tokens";
              internalAbort.abort();
            }
          },
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
        // Distinguish budget-driven aborts from caller-driven aborts.
        // Wall-clock fires its own AbortSignal.timeout; the
        // input-token watchdog flips `internalAbort` and stamps
        // `budgetExhaustedReason`. We treat both as the budget reason on
        // the final result; only fall through to the generic
        // "delegate aborted" string when the parent's external signal
        // fired without any budget triggering first.
        if (!budgetExhaustedReason && wallTimeSignal?.aborted) {
          budgetExhaustedReason = "max_wall_time_ms";
        }
        // If the parent's abortSignal fired, capture a stable reason. We do
        // this here (not in catch) because streamText may not throw on abort —
        // it can simply truncate the stream cleanly.
        if (!executionError && !budgetExhaustedReason && abortSignal?.aborted) {
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

      // Budget exhaustion takes precedence over caller-driven aborts and
      // over text-stream errors (the AI SDK surfaces aborts as
      // AbortError on `result.text`; we want the structured reason, not
      // the wrapped message).
      if (budgetExhaustedReason) {
        return { ok: false, reason: `budget_exhausted: ${budgetExhaustedReason}`, ...resultBase };
      }
      if (executionError) {
        return { ok: false, reason: executionError.message, ...resultBase };
      }
      // Successful answers above the shared text threshold are uploaded
      // to an artifact and stamped with `answerArtifactId`. The raw
      // `answer` stays in the execute return so chat persistence, the
      // UI's `tool-delegate` part renderer, and direct-execute callers
      // (judge) keep getting the full text. The supervisor LLM's view
      // is the artifact marker — substituted by `toModelOutput` below,
      // not by mutating execute's return.
      const stampLift = async (
        raw: string,
      ): Promise<{ answer: string; answerArtifactId?: string }> => {
        if (!liftAnswer) return { answer: raw };
        const { value, artifactId } = await liftAnswerForModel(raw, {
          workspaceId: session.workspaceId,
          chatId: session.sessionId,
          logger,
          serverId: "pre-model",
          toolName: DELEGATE_TOOL_NAME,
        });
        return artifactId ? { answer: value, answerArtifactId: artifactId } : { answer: raw };
      };

      if (finishInput) {
        if (finishInput.ok) {
          const lifted = await stampLift(finishInput.answer);
          return { ok: true, ...lifted, ...resultBase };
        }
        return { ok: false, reason: finishInput.reason, ...resultBase };
      }
      if (abortReason) {
        return { ok: false, reason: abortReason, ...resultBase };
      }
      if (textError) {
        return { ok: false, reason: textError.message, ...resultBase };
      }
      const lifted = await stampLift(finalText);
      return { ok: true, ...lifted, ...resultBase };
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
