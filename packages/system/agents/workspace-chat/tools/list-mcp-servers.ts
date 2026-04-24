import type { AtlasTools } from "@atlas/agent-sdk";
import {
  discoverMCPServers,
  type LinkSummary,
} from "@atlas/core/mcp-registry/discovery";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const ListMcpServersInput = z.object({
  filter: z
    .enum(["all", "configured", "unconfigured"])
    .optional()
    .describe("Filter by configuration status. Default: all."),
});

export interface MCPServerListItem {
  id: string;
  name: string;
  description?: string;
  source: string;
  securityRating: string;
  configured: boolean;
  constraints?: string;
}

export interface ListMcpServersSuccess {
  servers: MCPServerListItem[];
  total: number;
  configuredCount: number;
}

export interface ListMcpServersError {
  error: string;
}

/**
 * Build the `list_mcp_servers` tool for workspace chat.
 *
 * Lists all MCP servers available to the workspace (static blessed,
 * registry-imported, and workspace-only) with their configuration status.
 * The LLM can use this to discover capabilities and guide the user
 * through setup of unconfigured servers.
 */
export function createListMCPServersTool(
  workspaceId: string,
  workspaceConfig: WorkspaceConfig | undefined,
  linkSummary: LinkSummary | undefined,
  logger: Logger,
): AtlasTools {
  return {
    list_mcp_servers: tool({
      description:
        "List all MCP servers available to this workspace. Returns each server's id, name, " +
        "description, source (static, registry, workspace), security rating, and whether it is " +
        "fully configured. Use this to discover available capabilities or identify servers " +
        "that need credentials or setup.",
      inputSchema: ListMcpServersInput,
      execute: async ({ filter }): Promise<ListMcpServersSuccess | ListMcpServersError> => {
        try {
          const candidates = await discoverMCPServers(
            workspaceId,
            workspaceConfig,
            linkSummary,
          );

          let filtered = candidates;
          if (filter === "configured") {
            filtered = candidates.filter((c) => c.configured);
          } else if (filter === "unconfigured") {
            filtered = candidates.filter((c) => !c.configured);
          }

          const servers: MCPServerListItem[] = filtered.map((c) => ({
            id: c.metadata.id,
            name: c.metadata.name,
            description: c.metadata.description,
            source: c.metadata.source,
            securityRating: c.metadata.securityRating,
            configured: c.configured,
            constraints: c.metadata.constraints,
          }));

          logger.info("list_mcp_servers succeeded", {
            workspaceId,
            total: candidates.length,
            returned: servers.length,
            filter,
          });

          return {
            servers,
            total: candidates.length,
            configuredCount: candidates.filter((c) => c.configured).length,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("list_mcp_servers failed", { workspaceId, error: message });
          return { error: `list_mcp_servers failed: ${message}` };
        }
      },
    }),
  };
}
