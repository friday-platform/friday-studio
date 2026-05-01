/**
 * Query option factories for session-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import {
  initialSessionView,
  reduceSessionEvent,
} from "@atlas/core/session/session-reducer";
import {
  SessionSummarySchema,
  type SessionStreamEvent,
  type EphemeralChunk,
  type SessionSummary,
} from "@atlas/core/session/session-events";
import { experimental_streamedQuery, queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { sessionEventStream } from "../utils/session-event-stream.ts";

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

  /** Live session view via SSE stream. Handles both running and completed sessions. */
  view: (sessionId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "sessions", "view", sessionId] as const,
      queryFn: sessionId
        ? experimental_streamedQuery<SessionStreamEvent | EphemeralChunk, ReturnType<typeof initialSessionView>>({
          streamFn: () => sessionEventStream(sessionId),
          reducer: reduceSessionEvent,
          initialValue: initialSessionView(),
        })
        : skipToken,
      staleTime: 60_000,
    }),
};
