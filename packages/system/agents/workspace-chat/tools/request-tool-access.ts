import process from "node:process";
import type { AtlasTools } from "@atlas/agent-sdk";
import { type PermissionsConfig, resolvePermissions } from "@atlas/config/permissions";
import { ElicitationStorage } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const RequestToolAccessInput = z.object({
  toolName: z.string().min(1).describe("Name of the tool you want to call"),
  reason: z
    .string()
    .min(1)
    .describe("Short rationale for the user — why you need this tool right now"),
});

const DEFAULT_ELICITATION_TTL_MS = 30 * 60 * 1000;

export interface CreateRequestToolAccessToolOpts {
  workspaceId: string;
  /** Chat session id — used as the elicitation's `sessionId`. */
  sessionId: string;
  /**
   * Workspace-level permissions config (from workspace.yml). Chat doesn't
   * carry per-job permissions; the resolver merges this with the daemon
   * env-var floor.
   */
  workspacePermissions?: PermissionsConfig | undefined;
  logger: Logger;
}

/**
 * Chat-side `request_tool_access` factory. Mirrors the MCP tool at
 * `packages/mcp-server/src/tools/permissions/request-tool-access.ts` so
 * the chat supervisor can elicit tool-access on behalf of the user — the
 * headline use case for Phase 12.
 *
 * Why a chat factory rather than the MCP tool: chat composes `primaryTools`
 * from chat-side factories and doesn't pull from the atlas-platform MCP
 * server, so the MCP-registered tool never reaches a chat LLM. This factory
 * gives chat a direct in-process tool with the same observable behavior.
 *
 * Behavior matches the MCP tool: bypass branch returns
 * `{ ok: true, granted: true, reason: "bypass" }`; otherwise emits a
 * `tool-allowlist` elicitation via `ElicitationStorage` and returns a
 * structured denial. No auto-suspend — the LLM acknowledges and either
 * routes around or asks the user via the response stream.
 */
export function createRequestToolAccessTool(opts: CreateRequestToolAccessToolOpts): AtlasTools {
  const { workspaceId, sessionId, workspacePermissions, logger } = opts;

  return {
    request_tool_access: tool({
      description:
        "Request permission to call a tool that isn't in your allowlist. " +
        "Use when you need a capability you don't currently have. " +
        'Returns immediately with `{ granted: true, reason: "bypass" }` if the ' +
        "current workspace has `permissions.dangerouslySkipAllowlist`. " +
        "Otherwise emits a user-facing elicitation (visible on the Activity " +
        'page) and returns `{ granted: false, reason: "pending_user_approval", ' +
        "elicitationId }` — acknowledge to the user and either route around " +
        "the missing capability or wait for them to answer.",
      inputSchema: RequestToolAccessInput,
      execute: async ({ toolName, reason }) => {
        const daemonDangerouslySkipAllowlist =
          process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS === "1";
        const effective = resolvePermissions({
          workspace: workspacePermissions,
          daemonDangerouslySkipAllowlist,
        });

        if (effective.dangerouslySkipAllowlist) {
          logger.info("request_tool_access bypass (chat)", {
            toolName,
            reason,
            workspaceId,
            sessionId,
          });
          return { ok: true, granted: true, reason: "bypass" };
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + DEFAULT_ELICITATION_TTL_MS).toISOString();

        try {
          const created = await ElicitationStorage.create({
            workspaceId,
            sessionId,
            kind: "tool-allowlist",
            question: `Allow agent to call \`${toolName}\`? ${reason}`,
            options: [
              { label: "Allow once", value: "allow_once" },
              { label: "Allow always", value: "allow_always" },
              { label: "Deny", value: "deny" },
            ],
            pendingTool: { name: toolName, args: {} },
            expiresAt,
          });
          if (!created.ok) {
            logger.error("request_tool_access (chat) elicitation create failed", {
              toolName,
              workspaceId,
              error: created.error,
            });
            return { error: `Failed to create elicitation: ${created.error}` };
          }
          logger.info("request_tool_access (chat) elicitation created", {
            toolName,
            reason,
            workspaceId,
            sessionId,
            elicitationId: created.data.id,
          });
          return {
            ok: false,
            granted: false,
            elicitationId: created.data.id,
            reason: "pending_user_approval",
          };
        } catch (err) {
          logger.error("request_tool_access (chat) threw", { toolName, workspaceId, error: err });
          return { error: "Failed to create elicitation: network error" };
        }
      },
    }),
  };
}
