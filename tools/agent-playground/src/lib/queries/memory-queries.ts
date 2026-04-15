import { queryOptions } from "@tanstack/svelte-query";
import {
  fetchMemories,
  fetchNarrativeCorpus,
  fetchWorkspacesWithMemory,
} from "$lib/api/memory.ts";

export const memoryQueries = {
  all: () => ["memory"] as const,

  workspaces: () =>
    queryOptions({
      queryKey: ["memory", "workspaces"] as const,
      queryFn: fetchWorkspacesWithMemory,
      staleTime: 30_000,
    }),

  memories: (workspaceId: string) =>
    queryOptions({
      queryKey: ["memory", workspaceId, "memories"] as const,
      queryFn: () => fetchMemories(workspaceId),
      staleTime: 15_000,
    }),

  narrativeEntries: (workspaceId: string, memoryName: string) =>
    queryOptions({
      queryKey: ["memory", workspaceId, "narrative", memoryName] as const,
      queryFn: () => fetchNarrativeCorpus(workspaceId, memoryName),
      staleTime: 10_000,
    }),
};
