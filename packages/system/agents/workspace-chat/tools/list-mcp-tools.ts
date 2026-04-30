import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const ListMcpToolsInput = z.object({
  serverId: z
    .string()
    .min(1)
    .describe(
      "ID of the MCP server to probe (e.g. 'google-gmail', 'github', 'com-notion-mcp'). " +
        "Use list_capabilities or search_mcp_servers to find valid IDs.",
    ),
});

const ToolItemSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
});

export interface ListMcpToolsSuccess {
  ok: true;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown> | null;
  }>;
}

export interface ListMcpToolsError {
  ok: false;
  error: string;
  phase: "dns" | "connect" | "auth" | "tools";
}

/**
 * Build the `list_mcp_tools` tool for workspace chat.
 *
 * Spins up an MCP server and returns tool names (prefixed with serverId/),
 * descriptions, and input schemas.
 *
 * **Name format:** returned names are prefixed — e.g. "google-gmail/search_gmail_messages".
 * Use the prefixed name verbatim in a type:llm agent's `config.tools` array so the
 * workspace validator can verify which server owns which tool. Strip the "{serverId}/"
 * prefix when writing Python agent code: ctx.tools.call("search_gmail_messages", args).
 */
export function createListMcpToolsTool(logger: Logger): AtlasTools {
  return {
    list_mcp_tools: tool({
      description:
        "Spin up an MCP server and list the tool names, descriptions, and input schemas it exposes. " +
        "Use this before writing agent code or workspace config that references MCP tools — " +
        "inputSchema shows the exact parameter names and types to pass. " +
        "Names are returned as '{serverId}/{toolName}' (e.g. 'google-gmail/search_gmail_messages'). " +
        "Use the full prefixed name in a type:llm agent config.tools array. " +
        "Strip the prefix for Python agent ctx.tools.call() — use just 'search_gmail_messages'. " +
        "The server is started temporarily and shut down immediately; no workspace state is modified.",
      inputSchema: ListMcpToolsInput,
      execute: async ({ serverId }): Promise<ListMcpToolsSuccess | ListMcpToolsError> => {
        try {
          const res = await client.mcpRegistry[":id"].tools.$get({ param: { id: serverId } });
          const body = await res.json();

          if (res.status === 200) {
            const parsed = z
              .object({ ok: z.literal(true), tools: z.array(ToolItemSchema) })
              .safeParse(body);

            if (parsed.success) {
              logger.info("list_mcp_tools succeeded", {
                serverId,
                toolCount: parsed.data.tools.length,
              });
              return {
                ok: true,
                tools: parsed.data.tools.map((t) => ({ ...t, name: `${serverId}/${t.name}` })),
              };
            }

            logger.warn("list_mcp_tools: unexpected success shape", { serverId, body });
            return {
              ok: false,
              error: "Unexpected response shape from MCP registry",
              phase: "tools",
            };
          }

          if (res.status === 404) {
            return {
              ok: false,
              error: `MCP server "${serverId}" not found in catalog. Use search_mcp_servers or list_capabilities to find valid IDs.`,
              phase: "connect",
            };
          }

          const fallback =
            typeof body === "object" && body !== null && "error" in body
              ? String(body.error)
              : `Probe failed: HTTP ${res.status}`;
          return { ok: false, error: fallback, phase: "tools" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("list_mcp_tools threw", { serverId, error: message });
          return { ok: false, error: `Probe failed: ${message}`, phase: "tools" };
        }
      },
    }),
  };
}
