import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const SearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Search query string to find MCP servers in the official registry."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(10)
    .describe("Maximum number of results to return (1-20)."),
});

interface SearchResultItem {
  name: string;
  displayName?: string;
  description?: string;
  vendor: string;
  version: string;
  alreadyInstalled: boolean;
  isOfficial: boolean;
  repositoryUrl: string | null;
}

interface SearchMcpServersSuccess {
  servers: SearchResultItem[];
}

interface SearchMcpServersError {
  error: string;
}

/**
 * Build the `search_mcp_servers` tool for workspace chat.
 *
 * Searches the official MCP registry for servers matching a query string.
 * Returns results with metadata, version, and whether each is already installed.
 */
export function createSearchMcpServersTool(logger: Logger): AtlasTools {
  return {
    search_mcp_servers: tool({
      description:
        "Search the official MCP registry for servers. Returns matching servers with their " +
        "canonical names, descriptions, versions, and whether they are already installed. " +
        "Use this to discover new MCP servers before installing them.",
      inputSchema: SearchInputSchema,
      execute: async ({
        query,
        limit,
      }): Promise<SearchMcpServersSuccess | SearchMcpServersError> => {
        try {
          const res = await client.mcpRegistry.search.$get({
            query: { q: query, limit: String(limit) },
          });
          const body = await res.json();

          if (!res.ok) {
            const errorMsg =
              typeof body === "object" && body !== null && "error" in body
                ? String(body.error)
                : `Search failed: ${res.status}`;
            logger.warn("search_mcp_servers failed", {
              query,
              limit,
              status: res.status,
              error: errorMsg,
            });
            return { error: errorMsg };
          }

          if (
            typeof body !== "object" ||
            body === null ||
            !("servers" in body) ||
            !Array.isArray(body.servers)
          ) {
            logger.warn("search_mcp_servers returned unexpected shape", { query, limit, body });
            return { error: "Search returned unexpected response format." };
          }

          const servers: SearchResultItem[] = body.servers.map((entry: unknown) => {
            const e = entry as Record<string, unknown>;
            return {
              name: String(e.name ?? ""),
              displayName: e.displayName ? String(e.displayName) : undefined,
              description: e.description ? String(e.description) : undefined,
              vendor: String(e.vendor ?? ""),
              version: String(e.version ?? ""),
              alreadyInstalled: Boolean(e.alreadyInstalled),
              isOfficial: Boolean(e.isOfficial),
              repositoryUrl: e.repositoryUrl ? String(e.repositoryUrl) : null,
            };
          });

          logger.info("search_mcp_servers succeeded", {
            query,
            limit,
            resultCount: servers.length,
          });

          return { servers };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("search_mcp_servers threw", { query, limit, error: message });
          return { error: `Search failed: ${message}` };
        }
      },
    }),
  };
}
