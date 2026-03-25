/**
 * TanStack Query hook for fetching the bundled agents list.
 *
 * Replaces the ad-hoc fetch in `AgentSelector` with a cached, reactive query.
 * Also exports the `AgentMetadata` type derived from the Hono API response.
 *
 * @module
 */
import { createQuery } from "@tanstack/svelte-query";
import type { InferResponseType } from "hono/client";
import { getClient, type Client } from "../client.ts";

type AgentsEndpoint = Client["api"]["agents"]["$get"];
type AgentsResponse = InferResponseType<AgentsEndpoint>;

/** Metadata for a single bundled agent, as returned by GET /api/agents. */
export type AgentMetadata = AgentsResponse["agents"][number];

/**
 * Fetches all bundled agents from the playground API.
 *
 * @returns TanStack Query result with `data` as the sorted agents array.
 */
export function useAgentsList() {
  return createQuery(() => ({
    queryKey: ["agents"],
    queryFn: async (): Promise<AgentMetadata[]> => {
      const res = await getClient().api.agents.$get();
      if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
      const data = await res.json();
      return data.agents;
    },
    staleTime: 60_000,
  }));
}
