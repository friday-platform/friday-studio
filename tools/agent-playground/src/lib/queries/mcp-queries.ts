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
  description: z.string().optional(),
  vendor: z.string(),
  version: z.string().optional(),
  alreadyInstalled: z.boolean(),
  repositoryUrl: z.string().nullable().optional(),
});

export const SearchResponseSchema = z.object({
  servers: z.array(SearchResultSchema),
});

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
      select: (data) => ({
        ...data,
        // Upstream search can return multiple versions of the same canonical
        // name. Deduplicate by name — the install route always fetches latest.
        servers: data.servers.filter(
          (s, i, arr) => arr.findIndex((t) => t.name === s.name) === i,
        ),
      }),
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
};
