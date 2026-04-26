import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const WorkspaceMcpStatusInput = z.object({});

interface ServerSummary {
  id: string;
  name: string;
  source: string;
  configured: boolean;
  agentIds?: string[];
  jobIds?: string[];
}

interface WorkspaceMcpStatusSuccess {
  enabled: ServerSummary[];
  available: ServerSummary[];
}

interface WorkspaceMcpStatusError {
  error: string;
}

/**
 * Build the `get_workspace_mcp_status` tool for workspace chat.
 *
 * Returns the partition of MCP servers for this workspace: enabled
 * (present in workspace.tools.mcp.servers) and available (catalog servers
 * not yet enabled). The LLM can use this to answer "which MCP servers are
 * active in this workspace?" or to decide whether to enable a server.
 */
export function createGetWorkspaceMcpStatusTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    get_workspace_mcp_status: tool({
      description:
        "Get the MCP server status for this workspace. Returns two lists: " +
        "'enabled' servers are currently wired into this workspace's agents, " +
        "'available' servers are in the platform catalog but not yet enabled here. " +
        "Use this when the user asks which MCP servers are active, or before enabling a server.",
      inputSchema: WorkspaceMcpStatusInput,
      execute: async (): Promise<WorkspaceMcpStatusSuccess | WorkspaceMcpStatusError> => {
        try {
          const res = await client.workspaceMcp(workspaceId).index.$get();
          const body = await res.json();

          if (!res.ok) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg =
              typeof errorBody === "object" && errorBody !== null && "message" in errorBody
                ? String(errorBody.message)
                : `Failed to get workspace MCP status: ${res.status}`;
            logger.warn("get_workspace_mcp_status failed", {
              workspaceId,
              status: res.status,
              error: errorMsg,
            });
            return { error: errorMsg };
          }

          const parsed = z
            .object({
              enabled: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  source: z.string(),
                  configured: z.boolean(),
                  agentIds: z.array(z.string()).optional(),
                  jobIds: z.array(z.string()).optional(),
                }),
              ),
              available: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  source: z.string(),
                  configured: z.boolean(),
                }),
              ),
            })
            .safeParse(body);

          if (!parsed.success) {
            logger.warn("get_workspace_mcp_status: unexpected response shape", {
              workspaceId,
              body,
              issues: parsed.error.issues,
            });
            return { error: "Unexpected response shape from workspace MCP status endpoint." };
          }

          const { enabled, available } = parsed.data;

          logger.info("get_workspace_mcp_status succeeded", {
            workspaceId,
            enabledCount: enabled.length,
            availableCount: available.length,
          });

          return { enabled, available };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("get_workspace_mcp_status threw", { workspaceId, error: message });
          return { error: `Failed to get workspace MCP status: ${message}` };
        }
      },
    }),
  };
}
