/**
 * TanStack Query hook for fetching workspace configuration from the daemon.
 *
 * @module
 */
import { createQuery } from "@tanstack/svelte-query";
import { getDaemonClient } from "../daemon-client.ts";

/**
 * Fetches workspace config via the daemon proxy.
 * Enabled only when a workspaceId is provided.
 */
export function useWorkspaceConfig(workspaceId: () => string | null) {
  const client = getDaemonClient();

  return createQuery(() => {
    const id = workspaceId();
    return {
      queryKey: ["daemon", "workspace", id, "config"],
      queryFn: async () => {
        if (!id) throw new Error("No workspace selected");
        const res = await client.workspace[":workspaceId"].config.$get({
          param: { workspaceId: id },
        });
        if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
        return res.json();
      },
      enabled: id !== null,
    };
  });
}
