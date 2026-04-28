/**
 * Query option factories for MCP registry data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const CatalogResponseSchema = z.object({
  servers: z.array(MCPServerMetadataSchema),
  metadata: z.object({
    version: z.string(),
    staticCount: z.number(),
    dynamicCount: z.number(),
  }),
});

const SearchResultSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  vendor: z.string(),
  version: z.string(),
  alreadyInstalled: z.boolean(),
  isOfficial: z.boolean(),
  repositoryUrl: z.string().nullable().optional(),
});

const SearchResponseSchema = z.object({
  servers: z.array(SearchResultSchema),
});

const ToolProbeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const ToolsProbeSuccessSchema = z.object({
  ok: z.literal(true),
  tools: z.array(ToolProbeSchema),
});

const ToolsProbeFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  phase: z.enum(["dns", "connect", "auth", "tools"]),
});

const ToolsProbeResponseSchema = z.union([ToolsProbeSuccessSchema, ToolsProbeFailureSchema]);

export type SearchResult = z.infer<typeof SearchResultSchema>;

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const mcpQueries = {
  /** Key-only entry for hierarchical invalidation of all MCP registry queries. */
  all: () => ["daemon", "mcp"] as const,

  /** All servers from the MCP registry (static + dynamic). */
  catalog: () =>
    queryOptions({
      queryKey: ["daemon", "mcp", "catalog"] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.mcp.index.$get();
        if (!res.ok) throw new Error(`Failed to fetch MCP catalog: ${res.status}`);
        return CatalogResponseSchema.parse(await res.json());
      },
      staleTime: 60_000,
    }),

  /**
   * Search upstream MCP registry.
   * Uses skipToken when query is null or less than 2 characters.
   */
  search: (query: string | null) =>
    queryOptions({
      queryKey: ["daemon", "mcp", "search", query] as const,
      queryFn:
        query && query.length >= 2
          ? async () => {
              const client = getDaemonClient();
              const res = await client.mcp.search.$get({
                query: { q: query, limit: 20 },
              });
              if (!res.ok) throw new Error(`Failed to search MCP registry: ${res.status}`);
              return SearchResponseSchema.parse(await res.json());
            }
          : skipToken,
      staleTime: 30_000,
      // Upstream returns only latest versions when version=latest is passed.
      // No client-side deduplication needed.
    }),

  /** Single server detail by ID. */
  detail: (id: string) =>
    queryOptions({
      queryKey: ["daemon", "mcp", "detail", id] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.mcp[":id"].$get({ param: { id } });
        if (!res.ok) throw new Error(`Failed to fetch MCP server: ${res.status}`);
        return MCPServerMetadataSchema.parse(await res.json());
      },
      staleTime: 60_000,
    }),

  /**
   * MCP tool probe — tests whether a server can connect and lists its tools.
   * Returns success with tool names/descriptions, or failure with error phase.
   */
  toolsProbe: (id: string) =>
    queryOptions({
      queryKey: ["daemon", "mcp", "tools", id] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.mcp[":id"].tools.$get({ param: { id } });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(`Failed to probe MCP tools: ${res.status} ${JSON.stringify(body)}`);
        }
        return ToolsProbeResponseSchema.parse(await res.json());
      },
      staleTime: 0,
    }),
};
