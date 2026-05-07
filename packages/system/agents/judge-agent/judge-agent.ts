/**
 * `@friday/judge-agent` — system-level external validator. Phase B7 of
 * melodic-strolling-seal-pt2; routed through the delegate primitive in K2
 * (pt3).
 *
 * Replaces the deleted `@atlas/hallucination` runtime hook
 * (`createFSMOutputValidator` + `validateWithLLM` + retry/error policy,
 * ~700 lines) with a bounded sub-agent call. The FSM engine hands the
 * agent a refs-not-bytes handoff (lifted artifacts carry only their id +
 * summary) and the agent emits a structured `validation-verdict`.
 *
 * Why delegate instead of `generateObject`:
 *   - Phase 8 budgets (max_input_tokens, max_wall_time_ms, etc.) cap the
 *     judge's resource use rather than running unbounded.
 *   - Phase 11 provenance: the child invocation surfaces in agentBlocks
 *     via the parent writer's `data-delegate-chunk` envelopes.
 *   - `artifacts_get` (and any other tool the runner injects) is available
 *     to the child, so the judge can selectively pull lifted bytes
 *     instead of relying on inline-quoted tool results.
 *
 * Structured-output contract preserved: the child is instructed to emit
 * the validation-verdict JSON via the synthetic `finish` tool's `answer`
 * string. We parse that answer with `repairJson` + `ValidationVerdictSchema`
 * so the verdict shape downstream consumers see is byte-for-byte the same
 * as the pre-K2 `generateObject` result.
 */

import {
  type AtlasTools,
  type AtlasUIMessage,
  type AtlasUIMessageChunk,
  createAgent,
  err,
  ok,
  repairJson,
  repairToolCall,
} from "@atlas/agent-sdk";
import type { DelegationBudget } from "@atlas/config";
import { createDelegateTool, type DelegateResult } from "@atlas/core/delegate";
import { type ValidationVerdict, ValidationVerdictSchema } from "@atlas/hallucination";
import { stringifyError } from "@atlas/utils";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import { JUDGE_SYSTEM_PROMPT } from "./prompt.ts";

/**
 * One tool-call projection in the judge handoff. Mirrors
 * `JudgeToolCallEntry` in `@atlas/fsm-engine` but kept structurally local
 * so the agent package doesn't pull a heavy fsm-engine dep just for the
 * type.
 */
const JudgeToolCallEntrySchema = z.object({
  toolName: z.string(),
  args: z.unknown().optional(),
  resultInline: z.string().optional(),
  resultArtifactId: z.string().optional(),
  resultSummary: z.string().optional(),
});

const JudgeInputSchema = z.object({
  actionInput: z.string(),
  actionOutput: z.string(),
  toolCalls: z.array(JudgeToolCallEntrySchema),
});

export type JudgeInput = z.infer<typeof JudgeInputSchema>;

/**
 * Optional `ctx.config` fields the judge consumes. Both are inherited
 * from the parent FSM/chat context via `judge-runner.ts`; absence falls
 * through to the delegate primitive's back-compat defaults.
 */
const JudgeConfigSchema = z.object({
  /** Phase 8 budget for the delegate child. */
  budget: z.unknown().optional(),
  /** Current delegation depth in the parent context (0 if top-level). */
  depth: z.number().int().nonnegative().optional(),
});

function buildHandoffMessage(input: JudgeInput): string {
  const sections: string[] = [];
  sections.push(`## Action Input\n\n${input.actionInput || "(no input recorded)"}`);
  sections.push(`## Action Output\n\n${input.actionOutput || "(empty output)"}`);

  if (input.toolCalls.length === 0) {
    sections.push(`## Tool Calls\n\nNONE — agent called no tools.`);
  } else {
    const lines: string[] = [];
    for (let i = 0; i < input.toolCalls.length; i++) {
      const tc = input.toolCalls[i];
      if (!tc) continue;
      const argsBlock =
        tc.args !== undefined ? ` | args: ${JSON.stringify(tc.args).slice(0, 500)}` : "";
      lines.push(`### Tool ${i + 1}: ${tc.toolName}${argsBlock}`);
      if (tc.resultArtifactId) {
        lines.push(
          `Result lifted to artifact ${tc.resultArtifactId} (${tc.resultSummary ?? "no summary"}). Use artifacts_get only if a specific claim depends on the artifact's contents.`,
        );
      } else if (tc.resultInline) {
        lines.push("Result (inline):");
        lines.push(tc.resultInline);
      } else {
        lines.push("(no result captured)");
      }
    }
    sections.push(`## Tool Calls\n\n${lines.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * The child's goal — instructs it to finish with a JSON-encoded
 * validation-verdict, preserving the pre-K2 structured-output contract.
 */
const JUDGE_DELEGATE_GOAL =
  "Read the action's input, output, and tool-call manifest. Decide whether each factual claim in the output is sourced from the inputs or tool results. Then call the `finish` tool exactly once with `{ ok: true, answer: <verdict-json> }`, where `<verdict-json>` is a single JSON object conforming to the `validation-verdict` schema (top-level `verdict` discriminator: `pass` | `advisory` | `blocking`). Do not narrate. Do not produce any text outside the `finish` call.";

/**
 * Bridge `StreamEmitter` → `UIMessageStreamWriter` so the delegate's
 * envelope-wrapped chunks (`data-delegate-chunk`, `data-delegate-ledger`)
 * can flow upstream when the judge runs inside a chat context. When
 * `ctx.stream` is undefined (e.g. the daemon's `judge-runner` invoking
 * the judge detached from any UI), we sink chunks into a no-op writer —
 * budget enforcement and verdict parsing still work; only the SSE
 * surfacing is dropped on the floor.
 */
function buildBridgedWriter(
  emit: ((chunk: AtlasUIMessageChunk) => void) | undefined,
): UIMessageStreamWriter<AtlasUIMessage> {
  return {
    write(chunk) {
      emit?.(chunk);
    },
    async merge(stream) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value !== undefined) emit?.(value);
        }
      } finally {
        reader.releaseLock();
      }
    },
    onError: undefined,
  };
}

async function parseVerdict(answer: string): Promise<ValidationVerdict | undefined> {
  // Strip Markdown fences the LLM occasionally wraps JSON in.
  const trimmed = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstErr) {
    // Fall back to the agent-sdk's text-repair helper used by the AI SDK's
    // `experimental_repairText` hook — handles trailing commas, missing
    // closing braces, and the common LLM JSON foibles. If repair returns
    // null (unrepairable), surface as undefined.
    try {
      const repaired = await repairJson({ text: trimmed, error: firstErr as never });
      if (!repaired) return undefined;
      parsed = JSON.parse(repaired);
    } catch {
      return undefined;
    }
  }
  const result = ValidationVerdictSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export const judgeAgent = createAgent<JudgeInput, ValidationVerdict>({
  id: "judge-agent",
  displayName: "Judge Agent",
  version: "1.0.0",
  description:
    "External-validation judge for FSM `validate: external` actions. Reads action output + tool-call manifest and emits a structured validation-verdict via the delegate primitive (Phase 8 budgets, Phase 11 provenance, on-demand artifacts_get). Internal platform agent, not exposed to users.",
  expertise: { examples: [] },
  inputSchema: JudgeInputSchema,
  handler: async (input, ctx) => {
    const { logger, abortSignal, platformModels, stream, session, tools, config } = ctx;
    try {
      // Pull budget + depth from `ctx.config` when the runner threaded
      // them through; absence ⇒ delegate primitive uses its built-in
      // back-compat defaults (max_depth=1, max_steps_per_call=40, etc.).
      const cfg = config ? JudgeConfigSchema.safeParse(config) : undefined;
      const budget = cfg?.success ? (cfg.data.budget as DelegationBudget | undefined) : undefined;
      const depth = cfg?.success ? cfg.data.depth : undefined;

      // Bridged writer: forwards delegate envelopes into the agent's
      // StreamEmitter when present (Phase 11 provenance), no-ops when
      // running detached.
      const bridged = buildBridgedWriter(stream?.emit?.bind(stream));

      // The child inherits whichever tools the runner provided —
      // notably `artifacts_get` for selective lifted-byte fetches. We
      // pass the map by reference; `createDelegateTool` strips
      // `delegate` (the parent's tool) automatically, so a runner that
      // forwards its full chat-style tool set won't accidentally grant
      // re-delegation.
      const childTools: AtlasTools = (tools ?? {}) as AtlasTools;

      const delegateTool = createDelegateTool(
        {
          writer: bridged,
          session: {
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
            // The judge runs detached from any chat stream; reuse
            // sessionId as the correlation key for envelope wiring.
            // Same fallback fsm-engine uses.
            streamId: session.streamId ?? session.sessionId,
            ...(session.userId ? { userId: session.userId } : {}),
            ...(session.datetime ? { datetime: session.datetime } : {}),
          },
          platformModels,
          logger,
          ...(abortSignal ? { abortSignal } : {}),
          // Reuse the agent-sdk's repair helper so malformed tool args
          // from the child get the same heal pass the parent path uses.
          repairToolCall,
          ...(budget ? { budget } : {}),
          ...(depth !== undefined ? { depth } : {}),
        },
        () => childTools,
      );

      // Drive the delegate directly. We bypass the AI SDK's tool wrapper
      // because the judge agent is the orchestrator here — there is no
      // outer LLM that would have called `delegate` for us.
      const execute = delegateTool.execute;
      if (!execute) {
        return err("delegate tool has no execute handler");
      }

      const handoff = [JUDGE_SYSTEM_PROMPT, "---", buildHandoffMessage(input)].join("\n\n");
      // The AI SDK's `tool().execute` is typed as returning the value or an
      // AsyncIterable (for streaming tools); the delegate primitive only
      // ever resolves to a single `DelegateResult`. Cast through the
      // exported type so the discriminated union narrows correctly below.
      const result = (await execute(
        { goal: JUDGE_DELEGATE_GOAL, handoff },
        {
          toolCallId: `judge-${session.sessionId}`,
          messages: [],
          abortSignal: abortSignal as AbortSignal,
        },
      )) as DelegateResult;

      if (!result.ok) {
        // budget_exhausted, max_depth, MCP failure, or child threw —
        // surface the structured reason so the runner's caller can
        // synthesize an advisory verdict with the budget reason intact.
        logger.warn("judge-agent delegate failed to produce verdict", {
          agent: "judge-agent",
          reason: result.reason,
        });
        return err(result.reason);
      }

      const verdict = await parseVerdict(result.answer);
      if (!verdict) {
        logger.warn("judge-agent delegate answer did not parse as validation-verdict", {
          agent: "judge-agent",
          answerPreview: result.answer.slice(0, 200),
        });
        return err("judge delegate answer did not parse as validation-verdict");
      }

      logger.debug("judge-agent delegate completed", {
        agent: "judge-agent",
        verdict: verdict.verdict,
        issueCount: verdict.issues?.length ?? 0,
        toolsUsed: result.toolsUsed.length,
      });

      return ok(verdict);
    } catch (error) {
      logger.warn("judge-agent failed to produce verdict", { error: stringifyError(error) });
      return err(stringifyError(error));
    }
  },
  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
