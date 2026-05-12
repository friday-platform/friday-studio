import type { AtlasTools } from "@atlas/agent-sdk";
import { ElicitationStorage } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const ElicitationOptionInputSchema = z.object({
  label: z.string().min(1).describe("Human-readable option label"),
  value: z.string().min(1).describe("Machine-readable answer value returned to the agent"),
});

type HumanInputOption = z.infer<typeof ElicitationOptionInputSchema>;

const RequestHumanInputInput = z.object({
  question: z.string().min(1).describe("Question to show the user"),
  options: z
    .array(ElicitationOptionInputSchema)
    .min(1)
    .optional()
    .describe(
      "Optional flat selectable answers. Omit for free-form text input. " +
        "Do not pass multi_select. For repeated per-item choices, use labels like " +
        "'[1] Archive — Subject' and values like '1:archive'; the UI groups them " +
        "and returns the selected values as an answer string containing a JSON array.",
    ),
});

const DEFAULT_ELICITATION_TTL_MS = 30 * 60 * 1000;

export interface CreateRequestHumanInputToolOpts {
  workspaceId: string;
  /** Chat session id — used as the elicitation's `sessionId`. */
  sessionId: string;
  logger: Logger;
}

function optionsEqual(
  a: readonly HumanInputOption[] | undefined,
  b: readonly HumanInputOption[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (option, index) => option.label === right[index]?.label && option.value === right[index]?.value,
  );
}

// Idempotency for model retries: if a pending open-question elicitation
// with the same `(workspaceId, sessionId, question, options)` already
// exists, return its id instead of stacking a duplicate inline card.
// Mirrors `findReusablePendingElicitation` in the MCP factory.
async function findReusablePendingElicitation(input: {
  workspaceId: string;
  sessionId: string;
  question: string;
  options?: HumanInputOption[];
}) {
  const listed = await ElicitationStorage.list({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    status: "pending",
  });
  if (!listed.ok) return null;

  return (
    listed.data
      .filter(
        (elicitation) =>
          elicitation.kind === "open-question" &&
          elicitation.question === input.question &&
          optionsEqual(elicitation.options, input.options),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

/**
 * Chat-side `request_human_input` factory. Mirrors the MCP tool at
 * `packages/mcp-server/src/tools/platform/request-human-input.ts` so the
 * chat supervisor can ask the user a decision/approval/disambiguation
 * question directly, the same way FSM actions do.
 *
 * Why a chat factory rather than the MCP tool: chat composes `primaryTools`
 * from chat-side factories and doesn't pull from the atlas-platform MCP
 * server, so the MCP-registered tool never reaches a chat LLM. This factory
 * gives chat a direct in-process tool with the same observable shape as the
 * MCP version.
 *
 * Behaviour: creates an `open-question` elicitation via `ElicitationStorage`
 * and returns `{ ok: false, status: "pending", elicitationId, reason:
 * "pending_user_input" }`. The UI surfaces the inline `human-input-tool-card`
 * via `findMatchingHumanInputElicitation`; the user answers there and the
 * answer becomes visible on the next chat turn. No blocking wait — the chat
 * supervisor does not auto-suspend.
 */
export function createRequestHumanInputTool(opts: CreateRequestHumanInputToolOpts): AtlasTools {
  const { workspaceId, sessionId, logger } = opts;

  return {
    request_human_input: tool({
      description:
        "Ask the user a question when you need a decision, approval, or " +
        "disambiguation instead of guessing. Creates an Activity elicitation " +
        "and surfaces an inline answer card in chat. Returns `{ ok: false, " +
        'status: "pending", elicitationId, reason: "pending_user_input" }` ' +
        "immediately — acknowledge to the user and wait for the inline answer; " +
        "do not retry. For repeated per-item choices, use labels like " +
        "'[1] Archive — Subject' and values like '1:archive'.",
      inputSchema: RequestHumanInputInput,
      execute: async ({ question, options }) => {
        try {
          const reusable = await findReusablePendingElicitation({
            workspaceId,
            sessionId,
            question,
            ...(options && options.length > 0 ? { options } : {}),
          });
          if (reusable) {
            logger.info("request_human_input (chat) reusing pending elicitation", {
              workspaceId,
              sessionId,
              elicitationId: reusable.id,
            });
            return {
              ok: false,
              status: "pending" as const,
              elicitationId: reusable.id,
              reason: "pending_user_input" as const,
            };
          }

          const expiresAt = new Date(Date.now() + DEFAULT_ELICITATION_TTL_MS).toISOString();
          const created = await ElicitationStorage.create({
            workspaceId,
            sessionId,
            kind: "open-question",
            question,
            ...(options && options.length > 0 ? { options } : {}),
            expiresAt,
          });
          if (!created.ok) {
            logger.error("request_human_input (chat) elicitation create failed", {
              workspaceId,
              sessionId,
              error: created.error,
            });
            return { error: `Failed to create elicitation: ${created.error}` };
          }
          logger.info("request_human_input (chat) elicitation created", {
            workspaceId,
            sessionId,
            elicitationId: created.data.id,
          });
          return {
            ok: false,
            status: "pending" as const,
            elicitationId: created.data.id,
            reason: "pending_user_input" as const,
          };
        } catch (err) {
          logger.error("request_human_input (chat) threw", { workspaceId, sessionId, error: err });
          return { error: "Failed to create elicitation: network error" };
        }
      },
    }),
  };
}
