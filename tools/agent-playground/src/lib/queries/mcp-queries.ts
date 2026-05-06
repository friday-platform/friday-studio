/**
 * Query option factories and mutations for MCP registry data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
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

const InstallResponseSchema = z.object({ server: MCPServerMetadataSchema });

const InstallErrorSchema = z.object({
  error: z.string(),
  suggestion: z.string().optional(),
  existingId: z.string().optional(),
});

const CheckUpdateResponseSchema = z.object({
  hasUpdate: z.boolean(),
  reason: z.string().optional(),
  remote: z.object({ updatedAt: z.string(), version: z.string() }).optional(),
});

const PullUpdateResponseSchema = z.object({ server: MCPServerMetadataSchema });

const DeleteErrorSchema = z.object({ error: z.string() });

const AddCustomResponseSchema = z.object({
  server: MCPServerMetadataSchema,
  warning: z.string().optional(),
});

const AddCustomErrorSchema = z.object({ error: z.string() });

export type SearchResult = z.infer<typeof SearchResultSchema>;
export type ToolsProbeResponse = z.infer<typeof ToolsProbeResponseSchema>;

export interface InstallMCPInput {
  registryName: string;
}

export interface AddCustomMCPInput {
  name: string;
  id?: string;
  description?: string;
  httpUrl?: string;
  configJson?: {
    transport:
      | { type: "stdio"; command: string; args?: string[] }
      | { type: "http"; url: string };
    envVars?: Array<{
      key: string;
      description?: string;
      exampleValue?: string;
    }>;
  };
}

/**
 * Fetch and parse the MCP tool probe response for a server. Exported so tests
 * can call it directly without going through TanStack's QueryFunction wrapper
 * (which requires a QueryFunctionContext arg this test doesn't need to mock).
 */
export async function fetchToolsProbe(id: string): Promise<ToolsProbeResponse> {
  const client = getDaemonClient();
  const res = await client.mcp[":id"].tools.$get({ param: { id } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Failed to probe MCP tools: ${res.status} ${JSON.stringify(body)}`);
  }
  return ToolsProbeResponseSchema.parse(await res.json());
}

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
                query: { q: query, limit: "20" },
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
      queryFn: () => fetchToolsProbe(id),
      staleTime: 0,
    }),
};

// ==============================================================================
// MUTATIONS
// ==============================================================================

/**
 * Mutation for installing an MCP server from the registry.
 * Wraps `POST /api/mcp-registry/install` via daemon client.
 * Invalidates catalog query on success.
 * Parses error response and throws with message for UI toast display.
 */
export function useInstallMCPServer() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: InstallMCPInput) => {
      const res = await client.mcp.install.$post({ json: { registryName: input.registryName } });
      const body = await res.json();

      if (!res.ok) {
        const parsed = InstallErrorSchema.safeParse(body);
        const msg = parsed.success ? parsed.data.error : `Install failed: ${res.status}`;
        throw new Error(msg);
      }

      return InstallResponseSchema.parse(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}

/**
 * Mutation for checking if an MCP server has an available update.
 * Wraps `GET /api/mcp-registry/:id/check-update` via daemon client.
 * Takes the server ID as a mutation variable so one instance can service
 * any registry-imported entry.
 */
export function useCheckMCPUpdate() {
  const client = getDaemonClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"]["check-update"].$get({ param: { id } });
      if (!res.ok) throw new Error(`Failed to check for update: ${res.status}`);
      return CheckUpdateResponseSchema.parse(await res.json());
    },
  }));
}

/**
 * Mutation for pulling an update for an MCP server.
 * Wraps `POST /api/mcp-registry/:id/update` via daemon client.
 * Invalidates catalog and detail queries on success.
 * Takes the server ID as a mutation variable so one instance can service
 * any registry-imported entry.
 */
export function usePullMCPUpdate() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"].update.$post({ param: { id } });
      if (!res.ok) throw new Error(`Failed to pull update: ${res.status}`);
      return PullUpdateResponseSchema.parse(await res.json());
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
      queryClient.invalidateQueries({ queryKey: mcpQueries.detail(id).queryKey });
    },
  }));
}

/**
 * Mutation for adding a custom MCP server.
 * Wraps `POST /api/mcp-registry/custom` via daemon client.
 * Invalidates catalog query on success.
 * Parses error response and throws with message for UI toast display.
 */
export function useAddCustomMCPServer() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: AddCustomMCPInput) => {
      const res = await client.mcp.custom.$post({ json: input });
      const body = await res.json();

      if (!res.ok) {
        const parsed = AddCustomErrorSchema.safeParse(body);
        const msg = parsed.success
          ? parsed.data.error
          : `Add custom server failed: ${res.status}`;
        throw new Error(msg);
      }

      return AddCustomResponseSchema.parse(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}

/**
 * Mutation for deleting an MCP registry entry.
 * Wraps `DELETE /api/mcp-registry/:id` via daemon client.
 * Invalidates catalog query on success.
 * Built-in (static) entries are rejected by the server with 403.
 */
export function useDeleteMCPServer() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"].$delete({ param: { id } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const parsed = DeleteErrorSchema.safeParse(body);
        const msg = parsed.success ? parsed.data.error : `Delete failed: ${res.status}`;
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}
