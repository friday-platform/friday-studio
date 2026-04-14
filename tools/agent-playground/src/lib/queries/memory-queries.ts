import { queryOptions } from "@tanstack/svelte-query";
import {
  fetchCorpora,
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

  corpora: (workspaceId: string) =>
    queryOptions({
      queryKey: ["memory", workspaceId, "corpora"] as const,
      queryFn: () => fetchCorpora(workspaceId),
      staleTime: 15_000,
    }),

  narrativeEntries: (workspaceId: string, corpusName: string) =>
    queryOptions({
      queryKey: ["memory", workspaceId, "narrative", corpusName] as const,
      queryFn: () => fetchNarrativeCorpus(workspaceId, corpusName),
      staleTime: 10_000,
    }),
};
