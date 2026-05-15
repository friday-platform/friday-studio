/**
 * MCP server / tool discovery tools.
 *
 * Adds list_mcp_servers / describe_mcp_server / describe_mcp_tool to fill
 * the per-domain matrix gap. describe_mcp_server scope='workspace' subsumes
 * the old `get_mcp_dependencies` shape (returns the agent/job back-references
 * plus the server config); scope='catalog' returns the registry metadata.
 *
 * The existing `list_capabilities` (cross-domain router) and `list_mcp_tools`
 * (per-server tool list) keep their roles; this file fills the remaining
 * cells in the audit's matrix.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client } from "@atlas/client/v2";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { Logger } from "@atlas/logger";
import { discardBody } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const McpScope = z
  .enum(["workspace", "catalog", "all"])
  .default("workspace")
  .describe(
    "Where to look. 'workspace' (default) — servers enabled or available on this chat's " +
      "workspace. 'catalog' — every server in the global MCP registry. 'all' — both.",
  );

interface CatalogServerEntry {
  id: string;
  name: string;
  description?: string;
  urlDomains?: string[];
  source?: string;
}

function catalogEntries(): CatalogServerEntry[] {
  return Object.entries(mcpServersRegistry.servers)
    .map(([id, entry]) => ({
      id,
      name: entry?.name ?? id,
      ...(entry?.description ? { description: entry.description } : {}),
      ...(entry?.urlDomains ? { urlDomains: [...entry.urlDomains] } : {}),
      ...(entry?.source ? { source: String(entry.source) } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createListMcpServersTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    list_mcp_servers: tool({
      description:
        "List MCP servers. Default scope='workspace' returns enabled servers (configured on this " +
        "chat's workspace) plus available ones (in the catalog with credentials ready but not " +
        "yet enabled). scope='catalog' returns every server in the global MCP registry. " +
        "scope='all' returns both. For per-server tool inventory, follow up with `list_mcp_tools`. " +
        "For dependency info (which agents/jobs use a server), use describe_mcp_server scope=workspace.",
      inputSchema: z.object({ scope: McpScope.optional() }),
      execute: async ({ scope }) => {
        const target = scope ?? "workspace";
        if (target === "catalog") {
          const servers = catalogEntries();
          return { ok: true as const, scope: target, servers, count: servers.length };
        }

        const wsRes = await client.workspaceMcp(workspaceId).index.$get();
        if (!wsRes.ok) {
          await discardBody(wsRes);
          logger.warn("list_mcp_servers: workspace fetch failed", {
            workspaceId,
            status: wsRes.status,
          });
          return { ok: false as const, error: `list_mcp_servers failed: HTTP ${wsRes.status}` };
        }
        const body = (await wsRes.json()) as {
          enabled?: Array<Record<string, unknown>>;
          available?: Array<Record<string, unknown>>;
        };
        const enabled = body.enabled ?? [];
        const available = body.available ?? [];

        if (target === "workspace") {
          return {
            ok: true as const,
            scope: target,
            enabled,
            available,
            count: enabled.length + available.length,
          };
        }
        // 'all': workspace view + catalog entries not already in either list
        const seen = new Set<string>([
          ...enabled.map((e) => String(e.id)),
          ...available.map((a) => String(a.id)),
        ]);
        const catalog = catalogEntries().filter((c) => !seen.has(c.id));
        return {
          ok: true as const,
          scope: target,
          enabled,
          available,
          catalog,
          count: enabled.length + available.length + catalog.length,
        };
      },
    }),
  };
}

export function createDescribeMcpServerTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_mcp_server: tool({
      description:
        "Return full details for a single MCP server. scope='workspace' (default) returns the " +
        "wired config, enabled state, and the agents/jobs that reference it (subsumes the old " +
        "`get_mcp_dependencies` shape — call this before disabling/removing a server to see " +
        "what would break). scope='catalog' returns the global registry metadata only.",
      inputSchema: z.object({
        id: z.string().min(1).describe("MCP server id, e.g. 'gmail', 'github', 'notion'."),
        scope: z
          .enum(["workspace", "catalog"])
          .default("workspace")
          .optional()
          .describe(
            "Where to look. 'workspace' (default) returns wiring + dependencies; " +
              "'catalog' returns the registry metadata only.",
          ),
      }),
      execute: async ({ id, scope }) => {
        const target = scope ?? "workspace";
        if (target === "catalog") {
          const entry = mcpServersRegistry.servers[id];
          if (!entry) {
            return {
              ok: false as const,
              error: `MCP server "${id}" not found in the global registry.`,
            };
          }
          return { ok: true as const, scope: target, server: { ...entry, id } };
        }

        const wsRes = await client.workspaceMcp(workspaceId).index.$get();
        if (!wsRes.ok) {
          await discardBody(wsRes);
          return { ok: false as const, error: `describe_mcp_server failed: HTTP ${wsRes.status}` };
        }
        const body = (await wsRes.json()) as {
          enabled?: Array<{ id: string }>;
          available?: Array<{ id: string }>;
        };
        const found =
          body.enabled?.find((e) => e.id === id) ?? body.available?.find((a) => a.id === id);
        if (!found) {
          return {
            ok: false as const,
            error: `MCP server "${id}" not enabled or available on this workspace.`,
          };
        }
        const catalog = mcpServersRegistry.servers[id];
        const isEnabled = body.enabled?.some((e) => e.id === id) ?? false;
        logger.info("describe_mcp_server succeeded", { workspaceId, id, enabled: isEnabled });
        return {
          ok: true as const,
          scope: target,
          server: { ...found, enabled: isEnabled, ...(catalog ? { catalog } : {}) },
        };
      },
    }),
  };
}

export function createDescribeMcpToolTool(logger: Logger): AtlasTools {
  return {
    describe_mcp_tool: tool({
      description:
        "Return name + description + inputSchema for a single MCP tool on a given server. " +
        "Cheaper than list_mcp_tools when you already know which tool you're after. The full " +
        "inputSchema is required for correct invocation — names alone caused tool-name and " +
        "parameter hallucinations in earlier iterations.",
      inputSchema: z.object({
        serverId: z.string().min(1).describe("MCP server id."),
        toolName: z
          .string()
          .min(1)
          .describe(
            "Tool name without the '{serverId}/' prefix — list_mcp_tools returns names " +
              "prefixed; pass just the suffix here.",
          ),
      }),
      execute: async ({ serverId, toolName }) => {
        const res = await client.mcpRegistry[":id"].tools.$get({ param: { id: serverId } });
        if (res.status === 404) {
          await discardBody(res);
          return { ok: false as const, error: `MCP server "${serverId}" not found in catalog.` };
        }
        if (!res.ok) {
          await discardBody(res);
          return { ok: false as const, error: `describe_mcp_tool failed: HTTP ${res.status}` };
        }
        const body = (await res.json()) as unknown;
        const parsed = z
          .object({
            ok: z.literal(true),
            tools: z.array(
              z.object({
                name: z.string(),
                description: z.string().optional(),
                inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
              }),
            ),
          })
          .safeParse(body);
        if (!parsed.success) {
          logger.warn("describe_mcp_tool: unexpected response shape", { serverId });
          return {
            ok: false as const,
            error: "describe_mcp_tool: unexpected response shape from MCP registry",
          };
        }
        const match = parsed.data.tools.find((t) => t.name === toolName);
        if (!match) {
          return {
            ok: false as const,
            error: `Tool "${toolName}" not found on server "${serverId}". Use list_mcp_tools to see valid names.`,
          };
        }
        return { ok: true as const, tool: { ...match, name: `${serverId}/${match.name}` } };
      },
    }),
  };
}
