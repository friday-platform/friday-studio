import { ElicitationStorage } from "@atlas/core/elicitations";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { deriveElicitationExpiresAt, waitForTerminalElicitation } from "../elicitations/wait.ts";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

const ElicitationOptionInputSchema = z.object({
  label: z.string().min(1).describe("Human-readable option label"),
  value: z.string().min(1).describe("Machine-readable answer value returned to the agent"),
});

type HumanInputOption = z.infer<typeof ElicitationOptionInputSchema>;

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

async function findReusablePendingElicitation(input: {
  workspaceId: string;
  sessionId: string;
  actionId?: string;
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
          (elicitation.actionId ?? "") === (input.actionId ?? "") &&
          optionsEqual(elicitation.options, input.options),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
}

export function registerRequestHumanInputTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "request_human_input",
    {
      description:
        "Ask the user a question when you need a decision, approval, or disambiguation " +
        "instead of guessing. Creates an Activity elicitation and blocks until the user " +
        "answers, declines, or the request expires. Returns the answer to the current run.",
      inputSchema: {
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
        // ── Scope-injected fields (do not provide; runtime overrides) ─────
        workspaceId: z.string().describe("(runtime-injected) workspace identity"),
        sessionId: z.string().optional().describe("(runtime-injected) session identity"),
        actionId: z.string().optional().describe("(runtime-injected) FSM action id"),
        jobTimeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("(runtime-injected) parent job timeout in ms"),
      },
    },
    async ({
      question,
      options,
      workspaceId,
      sessionId,
      actionId,
      jobTimeoutMs,
    }): Promise<CallToolResult> => {
      const expiresAt = deriveElicitationExpiresAt(jobTimeoutMs);
      if (!sessionId) {
        ctx.logger.warn("request_human_input: missing sessionId in scope — using 'unknown'", {
          workspaceId,
          actionId,
        });
      }

      try {
        const effectiveSessionId = sessionId ?? "unknown";
        const existing = await findReusablePendingElicitation({
          workspaceId,
          sessionId: effectiveSessionId,
          ...(actionId && { actionId }),
          question,
          ...(options && options.length > 0 ? { options } : {}),
        });

        let elicitation = existing;
        if (elicitation) {
          ctx.logger.info("request_human_input reusing pending elicitation", {
            workspaceId,
            sessionId,
            actionId,
            elicitationId: elicitation.id,
          });
        } else {
          const created = await ElicitationStorage.create({
            workspaceId,
            sessionId: effectiveSessionId,
            ...(actionId && { actionId }),
            kind: "open-question",
            question,
            ...(options && options.length > 0 ? { options } : {}),
            expiresAt,
          });
          if (!created.ok) {
            ctx.logger.error("request_human_input elicitation create failed", {
              workspaceId,
              sessionId,
              actionId,
              error: created.error,
            });
            return createErrorResponse("Failed to create elicitation", created.error);
          }
          elicitation = created.data;

          ctx.logger.info("request_human_input elicitation created", {
            workspaceId,
            sessionId,
            actionId,
            elicitationId: elicitation.id,
          });
        }

        const terminal = await waitForTerminalElicitation(ctx, {
          id: elicitation.id,
          workspaceId: elicitation.workspaceId,
          sessionId: elicitation.sessionId,
          expiresAt: elicitation.expiresAt,
        });

        if (terminal.status === "pending") {
          return createSuccessResponse({
            ok: false,
            status: "pending",
            elicitationId: elicitation.id,
            reason: "pending_user_input",
          });
        }
        if (terminal.status === "answered") {
          return createSuccessResponse({
            ok: true,
            status: "answered",
            elicitationId: elicitation.id,
            answer: terminal.value ?? "",
            ...(terminal.note ? { note: terminal.note } : {}),
          });
        }
        return createSuccessResponse({
          ok: false,
          status: terminal.status,
          elicitationId: elicitation.id,
          reason: terminal.status,
          ...(terminal.note ? { note: terminal.note } : {}),
        });
      } catch (err) {
        ctx.logger.error("request_human_input threw", { workspaceId, sessionId, error: err });
        return createErrorResponse("request_human_input failed", stringifyError(err));
      }
    },
  );
}
