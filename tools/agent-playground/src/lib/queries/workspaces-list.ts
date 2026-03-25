/**
 * TanStack Query hooks for fetching workspace data from the daemon.
 *
 * {@link useWorkspaces} enriches with config-derived display names and filters
 * system workspaces — use this in UI components.
 *
 * @module
 */
import { createQuery } from "@tanstack/svelte-query";
import { z } from "zod";

/** Workspaces that are internal system concerns and hidden from UI. */
const HIDDEN_WORKSPACES = new Set(["atlas-conversation", "friday-conversation"]);

const WorkspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(["ephemeral", "persistent"]),
  metadata: z
    .object({
      color: z.string().optional(),
    })
    .optional(),
});

/** Workspace summary as returned by `GET /api/daemon/api/workspaces`. */
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** Enriched workspace with a resolved display name. */
export type Workspace = WorkspaceSummary & {
  /** Human-friendly name (from workspace.yml config, falling back to daemon name, then ID). */
  displayName: string;
};

const WorkspacesResponseSchema = z.array(WorkspaceSummarySchema);

/**
 * Fetches workspaces enriched with config-derived display names.
 *
 * For each workspace, fetches the workspace config in parallel to resolve
 * `workspace.name` from the YAML. Falls back to daemon name, then ID.
 * System workspaces (atlas-conversation, friday-conversation) are filtered out.
 */
export function useWorkspaces() {
  return createQuery(() => ({
    queryKey: ["daemon", "workspaces", "enriched"],
    queryFn: async (): Promise<Workspace[]> => {
      const listRes = await fetch("/api/daemon/api/workspaces");
      if (!listRes.ok) throw new Error(`Failed to fetch workspaces: ${listRes.status}`);
      const workspaces = WorkspacesResponseSchema.parse(await listRes.json());

      const visible = workspaces.filter((ws) => !HIDDEN_WORKSPACES.has(ws.id));

      const enriched = await Promise.all(
        visible.map(async (ws): Promise<Workspace> => {
          try {
            const cfgRes = await fetch(`/api/daemon/api/workspaces/${encodeURIComponent(ws.id)}/config`);
            if (!cfgRes.ok) return { ...ws, displayName: ws.name || ws.id };
            const cfg = await cfgRes.json();
            const configName = cfg?.config?.workspace?.name;
            return { ...ws, displayName: configName || ws.name || ws.id };
          } catch {
            return { ...ws, displayName: ws.name || ws.id };
          }
        }),
      );

      return enriched;
    },
    staleTime: 30_000,
  }));
}

/** Job summary for the workspace picker. */
export type JobSummary = { id: string; title: string; description?: string };

/** Workspace enriched with its job list for the inspector picker. */
export type WorkspaceWithJobs = Workspace & { jobs: JobSummary[] };

/**
 * Fetches workspaces with their job lists for the inspector empty-state picker.
 *
 * Pulls config for each workspace to extract job titles and descriptions.
 */
export function useWorkspacesWithJobs() {
  return createQuery(() => ({
    queryKey: ["daemon", "workspaces", "with-jobs"],
    queryFn: async (): Promise<WorkspaceWithJobs[]> => {
      const listRes = await fetch("/api/daemon/api/workspaces");
      if (!listRes.ok) throw new Error(`Failed to fetch workspaces: ${listRes.status}`);
      const workspaces = WorkspacesResponseSchema.parse(await listRes.json());
      const visible = workspaces.filter((ws) => !HIDDEN_WORKSPACES.has(ws.id));

      return Promise.all(
        visible.map(async (ws): Promise<WorkspaceWithJobs> => {
          try {
            const cfgRes = await fetch(
              `/api/daemon/api/workspaces/${encodeURIComponent(ws.id)}/config`,
            );
            if (!cfgRes.ok) return { ...ws, displayName: ws.name || ws.id, jobs: [] };
            const cfg = await cfgRes.json();
            const wsCfg = cfg?.config?.workspace;
            const displayName = wsCfg?.name || ws.name || ws.id;
            const description = wsCfg?.description || ws.description;
            const jobsRecord = cfg?.config?.jobs as
              | Record<string, { title?: string; description?: string }>
              | undefined;
            const jobs: JobSummary[] = jobsRecord
              ? Object.entries(jobsRecord).map(([id, job]) => ({
                  id,
                  title: job.title ?? id,
                  description: job.description,
                }))
              : [];
            return { ...ws, displayName, description, jobs };
          } catch {
            return { ...ws, displayName: ws.name || ws.id, jobs: [] };
          }
        }),
      );
    },
    staleTime: 30_000,
  }));
}
