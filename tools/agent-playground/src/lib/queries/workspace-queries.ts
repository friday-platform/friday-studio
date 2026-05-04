/**
 * Query option factories for workspace-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

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

/** Job summary for the workspace picker. */
export type JobSummary = { id: string; title: string; description?: string };

/** Workspace enriched with its job list for the inspector picker. */
export type WorkspaceWithJobs = Workspace & { jobs: JobSummary[] };

const WorkspacesResponseSchema = z.array(WorkspaceSummarySchema);

/** Schema for workspace-level agent definitions from workspace config. */
export const WorkspaceAgentDefSchema = z.object({
  type: z.string().optional(),
  agent: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

/** A single workspace agent definition. */
export type WorkspaceAgentDef = z.infer<typeof WorkspaceAgentDefSchema>;

/** Schema for extracting agent definitions from workspace config response. */
export const WorkspaceAgentDefsResponseSchema = z.object({
  config: z.object({ agents: z.record(z.string(), WorkspaceAgentDefSchema) }).passthrough(),
}).passthrough();

/** Map raw workspace agent types to user-friendly labels. */
export const AGENT_TYPE_LABELS: Record<string, string> = {
  atlas: "built-in",
  llm: "llm",
  system: "system",
};

/** Workspaces that are internal system concerns and hidden from UI. */
// NOTE: Do NOT add "system" here — we explicitly want the kernel workspace
// visible in the playground when FRIDAY_EXPOSE_KERNEL=1 is set. The daemon's
// workspace list endpoint handles the kernel filter server-side.
const HIDDEN_WORKSPACES = new Set(["friday-conversation"]);

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const workspaceQueries = {
  /** Key-only entry for hierarchical invalidation of all workspace queries. */
  all: () => ["daemon", "workspaces"] as const,

  /** Raw workspace list from daemon (no enrichment, no filtering). */
  list: () =>
    queryOptions({
      queryKey: ["daemon", "workspaces", "list"] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.workspace.index.$get();
        if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
        return WorkspacesResponseSchema.parse(await res.json());
      },
      staleTime: 30_000,
    }),

  /** Workspaces enriched with config-derived display names, system workspaces filtered out. */
  enriched: () =>
    queryOptions({
      queryKey: ["daemon", "workspaces", "enriched"] as const,
      queryFn: async (): Promise<Workspace[]> => {
        const client = getDaemonClient();
        const res = await client.workspace.index.$get();
        if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
        const workspaces = WorkspacesResponseSchema.parse(await res.json());

        const visible = workspaces.filter((ws) => !HIDDEN_WORKSPACES.has(ws.id));

        return Promise.all(
          visible.map(async (ws): Promise<Workspace> => {
            try {
              const cfgRes = await client.workspace[":workspaceId"].config.$get({
                param: { workspaceId: ws.id },
              });
              if (!cfgRes.ok) return { ...ws, displayName: ws.name || ws.id };
              const cfg = await cfgRes.json();
              const configName = cfg?.config?.workspace?.name;
              return { ...ws, displayName: configName || ws.name || ws.id };
            } catch {
              return { ...ws, displayName: ws.name || ws.id };
            }
          }),
        );
      },
      staleTime: 30_000,
    }),

  /** Workspaces with their job lists for the inspector empty-state picker. */
  withJobs: () =>
    queryOptions({
      queryKey: ["daemon", "workspaces", "with-jobs"] as const,
      queryFn: async (): Promise<WorkspaceWithJobs[]> => {
        const client = getDaemonClient();
        const res = await client.workspace.index.$get();
        if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
        const workspaces = WorkspacesResponseSchema.parse(await res.json());
        const visible = workspaces.filter((ws) => !HIDDEN_WORKSPACES.has(ws.id));

        return Promise.all(
          visible.map(async (ws): Promise<WorkspaceWithJobs> => {
            try {
              const cfgRes = await client.workspace[":workspaceId"].config.$get({
                param: { workspaceId: ws.id },
              });
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
    }),

  /** Workspace config for a single workspace. Accepts null to disable via skipToken. */
  config: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "workspace", workspaceId, "config"] as const,
      queryFn: workspaceId
        ? async () => {
            const client = getDaemonClient();
            const res = await client.workspace[":workspaceId"].config.$get({
              param: { workspaceId },
            });
            if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
            return res.json();
          }
        : skipToken,
      staleTime: 60_000,
    }),

  /** Signal configuration within a workspace. */
  signal: (workspaceId: string, signalId: string) =>
    queryOptions({
      queryKey: ["daemon", "workspace", workspaceId, "config", "signal", signalId] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const configClient = client.workspaceConfig(workspaceId);
        const res = await configClient.signals[":signalId"].$get({ param: { signalId } });
        if (!res.ok) throw new Error(`Failed to fetch signal: ${res.status}`);
        return res.json();
      },
      staleTime: 60_000,
    }),
};

// ==============================================================================
// MUTATIONS
// ==============================================================================

/** Deletes a workspace via the daemon API. */
export function useDeleteWorkspace() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (workspaceId: string) => {
      const res = await client.workspace[":workspaceId"].$delete({
        param: { workspaceId },
      });
      if (!res.ok) throw new Error(`Failed to delete workspace: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
    },
  }));
}
