/**
 * `@friday/judge-agent` — system-level external validator. Phase B7 of
 * melodic-strolling-seal-pt2.
 *
 * Replaces the deleted `@atlas/hallucination` runtime hook
 * (`createFSMOutputValidator` + `validateWithLLM` + retry/error policy,
 * ~700 lines) with a bounded sub-agent call. The FSM engine hands the
 * agent a refs-not-bytes handoff (lifted artifacts carry only their id +
 * summary) and the agent emits a structured `validation-verdict`.
 *
 * The handler runs `generateObject` with a small focused prompt and the
 * `ValidationVerdictSchema` shape. Tools are intentionally absent today —
 * the handoff already carries everything most claims need to be verified.
 * If a future revision wants `artifacts_get` / `parse_artifact` (so the
 * judge can fetch lifted artifact bytes only when a claim depends on
 * them), wire them at the same layer workspace-chat does.
 */

import { createAgent, err, ok, repairJson } from "@atlas/agent-sdk";
import { type ValidationVerdict, ValidationVerdictSchema } from "@atlas/hallucination";
import { getDefaultProviderOpts } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateObject } from "ai";
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

export const judgeAgent = createAgent<JudgeInput, ValidationVerdict>({
  id: "judge-agent",
  displayName: "Judge Agent",
  version: "1.0.0",
  description:
    "External-validation judge for FSM `validate: external` actions. Reads action output + tool-call manifest and emits a structured validation-verdict. Internal platform agent, not exposed to users.",
  expertise: { examples: [] },
  inputSchema: JudgeInputSchema,
  handler: async (input, { logger, abortSignal, platformModels }) => {
    try {
      const result = await generateObject({
        model: platformModels.get("classifier"),
        experimental_repairText: repairJson,
        schema: ValidationVerdictSchema,
        // role:"system" used so we can attach providerOptions (cache-control)
        // to the static system block. Same idiom as session-supervisor.
        allowSystemInMessages: true,
        messages: [
          {
            role: "system",
            content: JUDGE_SYSTEM_PROMPT,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          { role: "user", content: buildHandoffMessage(input) },
        ],
        temperature: 0.05,
        maxOutputTokens: 1500,
        maxRetries: 2,
        abortSignal,
      });

      logger.debug("judge-agent generateObject completed", {
        agent: "judge-agent",
        verdict: result.object.verdict,
        issueCount: result.object.issues?.length ?? 0,
        usage: result.usage,
      });

      return ok(result.object);
    } catch (error) {
      logger.warn("judge-agent failed to produce verdict", { error: stringifyError(error) });
      return err(stringifyError(error));
    }
  },
  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
