/**
 * Query option factories and mutations for MCP registry data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { DoctorReportSchema, MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { parseSSEStream } from "@atlas/utils/sse";
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
  updatedAt: z.string(),
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
  // JSON Schema for the tool's arguments — drives the raw invocation form.
  // `null` when the server declared no input schema.
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
});

const ToolsProbeSuccessSchema = z.object({
  ok: z.literal(true),
  tools: z.array(ToolProbeSchema),
});

const ToolsProbeFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  // `phase` is set on terminal probe failures (DNS, connect, auth, tools).
  // `retryable: true` is set when the server is still warming up (cold
  // npx/uvx install in progress) — the next click will most likely succeed.
  // Exactly one of the two is set on a given failure response.
  phase: z.enum(["dns", "connect", "auth", "tools"]).optional(),
  retryable: z.boolean().optional(),
});

const ToolsProbeResponseSchema = z.union([ToolsProbeSuccessSchema, ToolsProbeFailureSchema]);

/** Result of a raw tool invocation — the real output, or a classified error. */
const ToolInvokeResponseSchema = z.union([
  z.object({ ok: z.literal(true), output: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    phase: z.enum(["dns", "connect", "auth", "tools"]).optional(),
  }),
]);

/** Result of a raw tool invocation. */
export type ToolInvokeResponse = z.infer<typeof ToolInvokeResponseSchema>;

const InstallResponseSchema = z.object({
  server_id: z.string(),
  status: z.enum(["ready", "setting_up"]),
  warning: z.string().optional(),
});

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

/** A typed event from the doctor's SSE progress stream. */
const DoctorProgressEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("phase"),
    phase: z.enum(["fetching-readme", "prompting-llm", "validating"]),
  }),
  z.object({ type: z.literal("result"), report: DoctorReportSchema }),
]);
export type DoctorProgressEvent = z.infer<typeof DoctorProgressEventSchema>;

const CommitResponseSchema = z.object({
  server_id: z.string(),
  status: z.literal("ready"),
  warning: z.string().optional(),
});

const ManualConfigResponseSchema = z.object({
  server_id: z.string(),
  warning: z.string().optional(),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;
export type ToolsProbeResponse = z.infer<typeof ToolsProbeResponseSchema>;

/** One reviewed env var sent to the install-commit step. */
export interface CommitEnvVar {
  name: string;
  description?: string;
  isRequired: boolean;
  isSecret: boolean;
  default?: string;
}

/** Payload for the manual-config step — credentials and plain settings, split by the user. */
export interface ManualConfigInput {
  credentials: Array<{ name: string; description?: string; isRequired: boolean }>;
  settings: Array<{ name: string; description?: string; default?: string }>;
}

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
      const res = await client.mcp.install.preflight.$post({
        json: { registryName: input.registryName },
      });
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
 * Mutation for invoking a single MCP tool directly — connects to the server,
 * calls `tools/call` with the given args, returns the real output. Wraps
 * `POST /api/mcp-registry/:id/invoke`. Always workspace-scoped: the invocation
 * runs against that workspace's merged server config, and the route checks
 * workspace membership.
 */
export function useInvokeMCPTool() {
  const client = getDaemonClient();

  return createMutation(() => ({
    mutationFn: async (input: {
      id: string;
      toolName: string;
      args: Record<string, unknown>;
      workspaceId: string;
    }): Promise<ToolInvokeResponse> => {
      const res = await client.mcp[":id"].invoke.$post({
        param: { id: input.id },
        query: { workspaceId: input.workspaceId },
        json: { toolName: input.toolName, args: input.args },
      });
      const body = await res.json().catch(() => ({}));
      // A classified failure (404, connect error) still parses into the
      // `ok: false` shape — only a totally unexpected body throws.
      const parsed = ToolInvokeResponseSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      throw new Error(`Tool invocation failed: ${res.status}`);
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

/**
 * Mutation for committing an `awaiting_confirm` entry's reviewed env var list.
 * Wraps `POST /api/mcp-registry/install/commit/:id` — translates with the
 * confirmed vars, creates the Link provider, and flips the entry to `ready`.
 */
export function useCommitMCPInstall() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { id: string; envVars: CommitEnvVar[] }) => {
      const res = await client.mcp.install.commit[":id"].$post({
        param: { id: input.id },
        json: { env_vars: input.envVars },
      });
      const body = await res.json();
      if (!res.ok) {
        const parsed = InstallErrorSchema.safeParse(body);
        throw new Error(parsed.success ? parsed.data.error : `Commit failed: ${res.status}`);
      }
      return CommitResponseSchema.parse(body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
      queryClient.invalidateQueries({ queryKey: mcpQueries.detail(input.id).queryKey });
    },
  }));
}

/**
 * Mutation for cancelling an in-progress install.
 * Wraps `POST /api/mcp-registry/install/cancel/:id` — discards the entry.
 */
export function useCancelMCPInstall() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp.install.cancel[":id"].$post({ param: { id } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const parsed = DeleteErrorSchema.safeParse(body);
        throw new Error(parsed.success ? parsed.data.error : `Cancel failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}

/**
 * Mutation for applying a user-supplied schema to a no-provider entry
 * (verdict `clean` or `unknown`). Wraps `POST /api/mcp-registry/manual-config/:id`
 * — credentials become a Link provider, settings become plain-string env.
 */
export function useManualConfigMCP() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { id: string; config: ManualConfigInput }) => {
      const res = await client.mcp["manual-config"][":id"].$post({
        param: { id: input.id },
        json: input.config,
      });
      const body = await res.json();
      if (!res.ok) {
        const parsed = InstallErrorSchema.safeParse(body);
        throw new Error(
          parsed.success ? parsed.data.error : `Manual configuration failed: ${res.status}`,
        );
      }
      return ManualConfigResponseSchema.parse(body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
      queryClient.invalidateQueries({ queryKey: mcpQueries.detail(input.id).queryKey });
    },
  }));
}

/**
 * Async generator that consumes the doctor's SSE progress stream for an
 * installing server. Yields `phase` events while the doctor runs, then a
 * terminal `result` event carrying the persisted {@link DoctorReport}.
 * For an already-terminal entry the server replays just the `result`.
 */
export async function* doctorProgressStream(
  serverId: string,
): AsyncGenerator<DoctorProgressEvent> {
  const url = new URL(
    `/api/daemon/api/mcp-registry/${encodeURIComponent(serverId)}/stream`,
    globalThis.location?.origin ?? "http://localhost",
  );

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });

  if (!response.ok) {
    throw new Error(`Doctor progress stream failed: ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Doctor progress stream has no body");
  }

  for await (const message of parseSSEStream(response.body)) {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      continue;
    }
    const parsed = DoctorProgressEventSchema.safeParse(data);
    if (parsed.success) yield parsed.data;
  }
}
