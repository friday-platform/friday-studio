/**
 * `request_workspace_setup` — agent-driven re-setup tool for workspace-chat.
 *
 * Decision 4: re-setup post-import is agent-driven. The chat supervisor calls
 * this tool when it wants to surface the full setup form mid-conversation
 * (multiple gaps to fix, or the user explicitly asks for the form). The tool
 * fetches a fresh derivation from the daemon and emits a `workspace-setup`
 * elicitation scoped to the current chat session. The same answer handler
 * that processes import-time pre-seeded forms (Jinju's #10 dispatcher) commits
 * the answer — this is the second emission site, not a second handler.
 *
 * The current chat session id is used as-is; this tool never touches the
 * workspace's `active_setup_session_id` pointer (that's reserved for the
 * import bootstrap session).
 *
 * The chat turn cannot block on the user, so the tool returns
 * `pending_confirmation` after creating the elicitation. The daemon commits
 * env writes + credential pins when the user submits the form.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { emitWorkspaceSetupElicitation, SetupRequirementSchema } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

export interface CreateRequestWorkspaceSetupToolOpts {
  /** Current workspace — derivation scope and elicitation target. */
  workspaceId: string;
  /** Current chat session — the elicitation lands here so the form renders in this conversation. */
  sessionId: string;
  logger: Logger;
}

const WorkspaceSetupRequirementsResponseSchema = z.object({
  setup_requirements: z.array(SetupRequirementSchema),
});

export function createRequestWorkspaceSetupTool(
  opts: CreateRequestWorkspaceSetupToolOpts,
): AtlasTools {
  const { workspaceId, sessionId, logger } = opts;

  return {
    request_workspace_setup: tool({
      description:
        "Open the full workspace setup form in this chat. Use when the workspace has multiple " +
        "unfilled variables and/or unresolved credentials that the user should resolve at once, " +
        "or when the user explicitly asks for the form rather than answering item-by-item. The " +
        "form is rendered as a card in the current chat session; the user fills it in and " +
        "submits. Returns immediately as `pending_confirmation` — the form is non-blocking from " +
        "the agent's perspective. If the workspace has nothing left to set up, returns " +
        "`no_setup_required` and does NOT raise a card.",
      inputSchema: z.object({}),
      execute: async () => {
        logger.info("request_workspace_setup invoked", { workspaceId, sessionId });

        const wsResult = await parseResult(
          client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
        );
        if (!wsResult.ok) {
          logger.warn("request_workspace_setup: workspace fetch failed", {
            workspaceId,
            error: wsResult.error,
          });
          return {
            error: `Failed to load workspace setup state: ${stringifyError(wsResult.error)}`,
          };
        }

        const parsed = WorkspaceSetupRequirementsResponseSchema.safeParse(wsResult.data);
        if (!parsed.success) {
          logger.warn("request_workspace_setup: response shape unexpected", {
            workspaceId,
            issues: parsed.error.issues,
          });
          return { error: "Workspace setup payload from daemon did not match expected shape" };
        }

        const setupRequirements = parsed.data.setup_requirements;
        if (setupRequirements.length === 0) {
          return {
            status: "no_setup_required",
            message:
              "This workspace has no unfilled variables and no unresolved credentials. Nothing to set up.",
          };
        }

        try {
          const created = await emitWorkspaceSetupElicitation({
            workspaceId,
            sessionId,
            setupRequirements,
          });
          if (!created.ok) {
            logger.error("request_workspace_setup: elicitation create failed", {
              workspaceId,
              sessionId,
              error: created.error,
            });
            return { error: `Failed to raise workspace setup form: ${created.error}` };
          }
          return {
            status: "pending_confirmation",
            elicitationId: created.data.id,
            requirementCount: setupRequirements.length,
            message:
              "Workspace setup form raised in this chat. The user fills it in and submits — " +
              "the daemon then writes env vars and pins credentials.",
          };
        } catch (err) {
          logger.error("request_workspace_setup threw", { workspaceId, sessionId, error: err });
          return { error: `request_workspace_setup failed: ${stringifyError(err)}` };
        }
      },
    }),
  };
}
