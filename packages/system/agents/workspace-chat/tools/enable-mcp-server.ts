import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const EnableInputSchema = z.object({
  serverId: z
    .string()
    .min(1)
    .describe("ID of the MCP server to enable in this workspace (e.g. 'github', 'slack')."),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Optional target workspace ID. Defaults to the current session workspace. " +
        "Use this after create_workspace to enable a server in the new workspace.",
    ),
});

interface EnableSuccess {
  success: true;
  server: { id: string; name: string };
  message: string;
}

interface EnableFailure {
  success: false;
  error: string;
}

type EnableResult = EnableSuccess | EnableFailure;

/**
 * Build the `enable_mcp_server` tool for workspace chat.
 *
 * Idempotently enables a catalog MCP server in the current workspace by
 * copying its configTemplate into workspace.yml. Handles 200 (success or
 * already enabled), 404 (unknown server), 409 (validation conflict), and
 * 422 (blueprint workspace).
 */
export function createEnableMcpServerTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    enable_mcp_server: tool({
      description:
        "Enable an MCP server in this workspace. The server must already exist in the platform catalog " +
        "(use search_mcp_servers or list_mcp_servers to find it). Idempotent — calling again succeeds with no mutation.",
      inputSchema: EnableInputSchema,
      execute: async ({ serverId, workspaceId: targetWorkspaceId }): Promise<EnableResult> => {
        const effectiveWorkspaceId = targetWorkspaceId ?? workspaceId;

        try {
          const res = await client
            .workspaceMcp(effectiveWorkspaceId)
            [":serverId"].$put({ param: { serverId } });
          const body = await res.json();

          if (res.status === 200) {
            const parsed = z
              .object({ server: z.object({ id: z.string(), name: z.string() }).optional() })
              .safeParse(body);

            const name = parsed.success && parsed.data.server ? parsed.data.server.name : serverId;
            logger.info("enable_mcp_server succeeded", {
              workspaceId: effectiveWorkspaceId,
              serverId,
              name,
            });
            return {
              success: true,
              server: { id: serverId, name },
              message: `MCP server '${name}' is now enabled in this workspace.`,
            };
          }

          if (res.status === 404) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.message ?? `Server "${serverId}" not found in catalog.`,
            );
            logger.info("enable_mcp_server: not found", {
              workspaceId: effectiveWorkspaceId,
              serverId,
            });
            return { success: false, error: errorMsg };
          }

          if (res.status === 409) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(errorBody.message ?? "Conflict enabling MCP server.");
            logger.info("enable_mcp_server: conflict", {
              workspaceId: effectiveWorkspaceId,
              serverId,
              error: errorMsg,
            });
            return { success: false, error: errorMsg };
          }

          if (res.status === 422) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg = String(
              errorBody.message ??
                "This workspace uses a blueprint — direct config mutations are not supported.",
            );
            logger.info("enable_mcp_server: blueprint rejected", {
              workspaceId: effectiveWorkspaceId,
              serverId,
            });
            return { success: false, error: errorMsg };
          }

          const errorMsg =
            typeof body === "object" && body !== null && "message" in body
              ? String(body.message)
              : `Enable failed: ${res.status}`;
          logger.warn("enable_mcp_server failed", {
            workspaceId: effectiveWorkspaceId,
            serverId,
            status: res.status,
            error: errorMsg,
          });
          return { success: false, error: errorMsg };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("enable_mcp_server threw", {
            workspaceId: effectiveWorkspaceId,
            serverId,
            error: message,
          });
          return { success: false, error: `Enable failed: ${message}` };
        }
      },
    }),
  };
}
