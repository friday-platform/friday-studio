import type { MemoryAdapter, NarrativeEntry } from "@atlas/agent-sdk";

export interface ReadSessionsOpts {
  limit?: number;
  since?: string;
}

export async function readRecentSessions(
  memoryAdapter: MemoryAdapter,
  targetWorkspaceId: string,
  opts?: ReadSessionsOpts,
): Promise<NarrativeEntry[]> {
  const sessions = await memoryAdapter.corpus(targetWorkspaceId, "sessions", "narrative");
  return sessions.read({ limit: opts?.limit, since: opts?.since });
}
