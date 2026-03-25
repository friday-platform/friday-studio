/**
 * TanStack Query hook for fetching per-agent credential preflight status.
 * Checks credential resolution (Link, env vars) for a single bundled agent.
 *
 * @module
 */
import type { QueryClient } from "@tanstack/svelte-query";
import { createQuery } from "@tanstack/svelte-query";
import { z } from "zod";

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
export type AgentPreflightCredential = z.infer<typeof CredentialStatusSchema>;

const AgentPreflightResponseSchema = z.object({
  agentId: z.string(),
  credentials: z.array(CredentialStatusSchema),
});
export type AgentPreflightResponse = z.infer<typeof AgentPreflightResponseSchema>;

// ==============================================================================
// HOOK
// ==============================================================================

const QUERY_KEY_PREFIX = "agent-preflight";

/**
 * Fetches per-agent credential preflight status from the daemon.
 * Reports credential resolution status for each env key the agent needs.
 *
 * @param agentId - Reactive getter returning the current agent ID, or null when none is selected
 */
export function useAgentPreflight(agentId: () => string | null) {
  return createQuery(() => {
    const id = agentId();
    return {
      queryKey: [QUERY_KEY_PREFIX, id],
      queryFn: async (): Promise<AgentPreflightResponse> => {
        const res = await fetch(`/api/daemon/api/agents/${id}/preflight`);
        if (!res.ok) throw new Error(`Agent preflight: ${res.status}`);
        const data: unknown = await res.json();
        return AgentPreflightResponseSchema.parse(data);
      },
      enabled: id !== null,
      staleTime: 30_000,
      retry: false,
    };
  });
}

/**
 * Invalidates the agent preflight query, triggering a re-fetch.
 * Call after OAuth callback completes to refresh credential status.
 *
 * @param queryClient - TanStack QueryClient instance
 * @param agentId - The agent ID whose preflight data should be invalidated
 */
export function invalidateAgentPreflight(queryClient: QueryClient, agentId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [QUERY_KEY_PREFIX, agentId] });
}
