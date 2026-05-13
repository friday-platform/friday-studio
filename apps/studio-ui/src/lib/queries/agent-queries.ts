/**
 * Query option factories for agent-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * Note: `.list()` and `.bundledWithSchemas()` both hit the playground's `/api/agents`
 * endpoint (not the daemon proxy) since bundled agent metadata is served by the
 * playground server.
 *
 * @module
 */
import type { QueryClient } from "@tanstack/svelte-query";
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import type { InferResponseType } from "hono/client";
import { z } from "zod";
import { getClient, type Client } from "../client.ts";

type AgentsEndpoint = Client["api"]["agents"]["$get"];
type AgentsResponse = InferResponseType<AgentsEndpoint>;

/** Metadata for a single bundled agent, as returned by GET /api/agents. */
export type AgentMetadata = AgentsResponse["agents"][number];

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const CredentialStatusSchema = z.object({
  envKey: z.string(),
  required: z.boolean(),
  provider: z.string().nullable(),
  status: z.enum(["connected", "disconnected"]),
  source: z.enum(["link", "env"]).nullable(),
  label: z.string().nullable(),
  linkRef: z.object({ provider: z.string(), key: z.string() }).nullable(),
});

/** Credential status for a single env key in agent preflight. */
export type AgentPreflightCredential = z.infer<typeof CredentialStatusSchema>;

const AgentPreflightResponseSchema = z.object({
  agentId: z.string(),
  credentials: z.array(CredentialStatusSchema),
});

/** Full preflight response for an agent. */
export type AgentPreflightResponse = z.infer<typeof AgentPreflightResponseSchema>;

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const agentQueries = {
  /** Key-only entry for hierarchical invalidation of all agent queries. */
  all: () => ["playground", "agents"] as const,

  /** Bundled agents list (playground route). */
  list: () =>
    queryOptions({
      queryKey: ["playground", "agents", "list"] as const,
      queryFn: async () => {
        const res = await getClient().api.agents.$get();
        if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
        const data = await res.json();
        return data.agents;
      },
      staleTime: 60_000,
    }),

  /** Bundled agents with I/O schemas (same endpoint, separate cache entry for schema consumers). */
  bundledWithSchemas: () =>
    queryOptions({
      queryKey: ["playground", "agents", "bundled-with-schemas"] as const,
      queryFn: async () => {
        const res = await getClient().api.agents.$get();
        if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
        const data = await res.json();
        return data.agents;
      },
      staleTime: 60_000,
    }),

  /** Per-agent credential preflight status (daemon route, untyped — raw fetch). Accepts null to disable via skipToken. */
  preflight: (agentId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "agents", "preflight", agentId] as const,
      queryFn: agentId
        ? async (): Promise<AgentPreflightResponse> => {
            const res = await fetch(`/api/daemon/api/agents/${agentId}/preflight`);
            if (!res.ok) throw new Error(`Agent preflight: ${res.status}`);
            const data: unknown = await res.json();
            return AgentPreflightResponseSchema.parse(data);
          }
        : skipToken,
      staleTime: 30_000,
      retry: false,
    }),
};

/**
 * Invalidates the agent preflight query, triggering a re-fetch.
 * Call after OAuth callback completes to refresh credential status.
 */
export function invalidateAgentPreflight(queryClient: QueryClient, agentId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: agentQueries.preflight(agentId).queryKey });
}
