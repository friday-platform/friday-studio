/**
 * Query option factories for session-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { SessionSummarySchema, type SessionSummary } from "@atlas/core/session/session-events";
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { fetchSessionView } from "../utils/session-event-stream.ts";

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const sessionQueries = {
  /** Key-only entry for hierarchical invalidation of all session queries. */
  all: () => ["daemon", "sessions"] as const,

  /** Sessions for a workspace. Accepts null to disable via skipToken. */
  list: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "sessions", workspaceId] as const,
      queryFn: workspaceId
        ? async (): Promise<SessionSummary[]> => {
            const client = getDaemonClient();
            const res = await client.sessions.index.$get({ query: { workspaceId } });
            if (!res.ok) return [];
            const data = await res.json();
            return z.array(SessionSummarySchema).parse(data.sessions);
          }
        : skipToken,
      staleTime: 5_000,
    }),

  /** Full session view (JSON endpoint, not SSE). Accepts null to disable via skipToken. */
  view: (sessionId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "sessions", "view", sessionId] as const,
      queryFn: sessionId ? () => fetchSessionView(sessionId) : skipToken,
      staleTime: 60_000,
    }),
};
