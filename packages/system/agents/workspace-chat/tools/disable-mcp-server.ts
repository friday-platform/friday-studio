import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const DisableInputSchema = z.object({
  serverId: z
    .string()
    .min(1)
    .describe("ID of the MCP server to disable in this workspace (e.g. 'github', 'slack')."),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, forcibly removes the server and strips all references from agents and jobs. " +
        "If false (default), the call fails with a conflict listing referencing agents/jobs.",
    ),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Optional target workspace ID. Defaults to the current session workspace. " +
        "Use this to disable a server in a workspace other than the current chat session.",
    ),
});

interface DisableSuccess {
  success: true;
  removed: string;
  message: string;
}

interface DisableConflict {
  success: false;
  error: string;
  willUnlinkFrom?: Array<{ type: string; id: string }>;
}

interface DisableFailure {
  success: false;
  error: string;
}

type DisableResult = DisableSuccess | DisableConflict | DisableFailure;

/**
 * Build the `disable_mcp_server` tool for workspace chat.
 *
 * Disables an MCP server from the current workspace. Without `force`, the call
 * is safe — it refuses if any agent or job step still references the server and
 * returns a conflict listing so the LLM can ask the user to confirm. With
 * `force: true`, it cascades: removes the server from workspace config and strips
 * all references from agent tools arrays and FSM job step tools arrays.
 */
export function createDisableMcpServerTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    disable_mcp_server: tool({
      description:
        "Disable an MCP server from this workspace. The server remains in the platform catalog. " +
        "Safe by default — if agents or jobs still reference it, the call fails and lists them. " +
        "Set force=true to override and strip all references automatically.",
      inputSchema: DisableInputSchema,
      execute: async ({ serverId, force, workspaceId: targetWorkspaceId }): Promise<DisableResult> => {
        const effectiveWorkspaceId = targetWorkspaceId ?? workspaceId;

        try {
          const res = await client
            .workspaceMcp(effectiveWorkspaceId)
            [":serverId"].$delete({
              param: { serverId },
              query: force ? { force: "true" as const } : {},
            });
          const body = await res.json();

          if (res.status === 200) {
            logger.info("disable_mcp_server succeeded", { workspaceId: effectiveWorkspaceId, serverId, force });
            return {
              success: true,
              removed: serverId,
              message: `MCP server '${serverId}' has been disabled from this workspace.`,
            };
          }

          if (res.status === 404) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.message ?? `Server "${serverId}" is not enabled in this workspace.`,
            );
            logger.info("disable_mcp_server: not enabled", { workspaceId: effectiveWorkspaceId, serverId });
            return { success: false, error: errorMsg };
          }

          if (res.status === 409) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.message ?? "Server is referenced by workspace entities.",
            );
            const willUnlinkFromRaw = errorBody.willUnlinkFrom;
            const willUnlinkFrom = Array.isArray(willUnlinkFromRaw)
              ? willUnlinkFromRaw.map((entry: unknown) => {
                  const e = entry as Record<string, string>;
                  return { type: String(e.type ?? "unknown"), id: String(e.id ?? "") };
                })
              : undefined;

            logger.info("disable_mcp_server: conflict", { workspaceId: effectiveWorkspaceId, serverId, willUnlinkFrom });
            return {
              success: false,
              error: errorMsg,
              ...(willUnlinkFrom !== undefined && { willUnlinkFrom }),
            };
          }

          if (res.status === 422) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.message ??
                "This workspace uses a blueprint — direct config mutations are not supported.",
            );
            logger.info("disable_mcp_server: blueprint rejected", { workspaceId: effectiveWorkspaceId, serverId });
            return { success: false, error: errorMsg };
          }

          const errorMsg =
            typeof body === "object" && body !== null && "message" in body
              ? String(body.message)
              : `Disable failed: ${res.status}`;
          logger.warn("disable_mcp_server failed", {
            workspaceId: effectiveWorkspaceId,
            serverId,
            status: res.status,
            error: errorMsg,
          });
          return { success: false, error: errorMsg };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("disable_mcp_server threw", { workspaceId: effectiveWorkspaceId, serverId, error: message });
          return { success: false, error: `Disable failed: ${message}` };
        }
      },
    }),
  };
}
