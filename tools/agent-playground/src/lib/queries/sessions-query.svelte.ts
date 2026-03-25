/**
 * TanStack Query hook for fetching workspace sessions from the daemon.
 *
 * Polls active sessions on a short interval for live progress.
 *
 * @module
 */

import { SessionSummarySchema, type SessionSummary } from "@atlas/core/session/session-events";
import { createQuery } from "@tanstack/svelte-query";
import { getDaemonClient } from "$lib/daemon-client";
import { z } from "zod";

/**
 * @param workspaceId - Reactive getter for the selected workspace ID
 * @returns TanStack query result with sessions data
 */
export function useSessionsQuery(workspaceId: () => string | null) {
  return createQuery<SessionSummary[]>(() => ({
    queryKey: ["sessions", workspaceId()],
    queryFn: async () => {
      const id = workspaceId();
      if (!id) return [];

      const client = getDaemonClient();
      const res = await client.sessions.index.$get({ query: { workspaceId: id } });
      if (!res.ok) return [];

      const data = await res.json();
      return z.array(SessionSummarySchema).parse(data.sessions);
    },
    enabled: !!workspaceId(),
    refetchInterval: 5_000,
  }));
}
