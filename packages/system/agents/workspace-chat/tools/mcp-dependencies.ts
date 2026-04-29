import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const McpDependenciesInput = z.object({});

interface ServerSummary {
  id: string;
  name: string;
  source: string;
  configured: boolean;
  agentIds?: string[];
  jobIds?: string[];
}

interface McpDependenciesSuccess {
  enabled: ServerSummary[];
  available: ServerSummary[];
}

interface McpDependenciesError {
  error: string;
}

/**
 * Build the `get_mcp_dependencies` tool for workspace chat.
 *
 * For each enabled MCP server in this workspace, returns the agents and jobs
 * that reference it. Use before disabling or removing a server to see what
 * would break.
 */
export function createMcpDependenciesTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    get_mcp_dependencies: tool({
      description:
        "For each enabled MCP server in this workspace, return the agents and jobs that reference it. " +
        "Use this before disabling or removing a server to see what would break. " +
        "Also lists catalog servers that are available but not yet enabled here.",
      inputSchema: McpDependenciesInput,
      execute: async (): Promise<McpDependenciesSuccess | McpDependenciesError> => {
        try {
          const res = await client.workspaceMcp(workspaceId).index.$get();
          const body = await res.json();

          if (!res.ok) {
            const errorBody = body as Record<string, unknown>;
            const errorMsg =
              typeof errorBody === "object" && errorBody !== null && "message" in errorBody
                ? String(errorBody.message)
                : `Failed to get MCP dependencies: ${res.status}`;
            logger.warn("get_mcp_dependencies failed", {
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
            logger.warn("get_mcp_dependencies: unexpected response shape", {
              workspaceId,
              body,
              issues: parsed.error.issues,
            });
            return { error: "Unexpected response shape from workspace MCP status endpoint." };
          }

          const { enabled, available } = parsed.data;

          logger.info("get_mcp_dependencies succeeded", {
            workspaceId,
            enabledCount: enabled.length,
            availableCount: available.length,
          });

          return { enabled, available };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("get_mcp_dependencies threw", { workspaceId, error: message });
          return { error: `Failed to get MCP dependencies: ${message}` };
        }
      },
    }),
  };
}
