/**
 * Query + mutation factories for the workspace settings page.
 *
 * Covers the two stores the settings page edits:
 * - **Workspace identity** — name / description / timeout, via the config
 *   route `PUT /config/identity`.
 * - **Workspace `.env`** — the per-workspace non-secret value store, via the
 *   per-key routes `GET /env`, `PUT /env/:key`, `DELETE /env/:key`.
 *
 * @module
 */
import type { WorkspaceIdentityPatch } from "@atlas/config/mutations";
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { workspaceQueries } from "./workspace-queries.ts";

// ==============================================================================
// SCHEMAS
// ==============================================================================

const EnvListResponseSchema = z.object({
  success: z.literal(true),
  env: z.record(z.string(), z.string()),
});

const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
});

/** Workspace `.env` map: env var name → raw value. */
export type WorkspaceEnv = z.infer<typeof EnvListResponseSchema>["env"];

/** Pull a human-readable message out of a daemon error body, or fall back. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => ({}));
  const parsed = ErrorResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.message ?? parsed.data.error) : fallback;
}

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const workspaceEnvQueries = {
  /** Key-only entry for hierarchical invalidation of all workspace env queries. */
  all: (workspaceId: string) => ["daemon", "workspace", workspaceId, "env"] as const,

  /** The workspace's `.env` contents. Accepts null to disable via skipToken. */
  list: (workspaceId: string | null) =>
    queryOptions({
      queryKey: workspaceId
        ? (["daemon", "workspace", workspaceId, "env", "list"] as const)
        : (["daemon", "workspace", "env", "list"] as const),
      queryFn: workspaceId
        ? async (): Promise<WorkspaceEnv> => {
            const client = getDaemonClient();
            const res = await client.workspaceEnv(workspaceId).index.$get();
            if (!res.ok) {
              throw new Error(await errorMessage(res, `Failed to fetch workspace env: ${res.status}`));
            }
            return EnvListResponseSchema.parse(await res.json()).env;
          }
        : skipToken,
      staleTime: 30_000,
    }),
};

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Patch the workspace identity block (name / description / timeout).
 * Wraps `PUT /api/workspaces/:workspaceId/config/identity`.
 * Invalidates the workspace config query on success.
 */
export function useUpdateWorkspaceIdentity() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; patch: WorkspaceIdentityPatch }) => {
      const client = getDaemonClient();
      const res = await client.workspaceConfig(input.workspaceId).identity.$put({
        json: input.patch,
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to update workspace: ${res.status}`));
      }
      return res.json();
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", input.workspaceId, "config"],
      });
      queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
    },
  }));
}

/**
 * Set (create or overwrite) a single workspace `.env` var.
 * Wraps `PUT /api/workspaces/:workspaceId/env/:key`.
 * Invalidates the workspace env query on success.
 */
export function useSetWorkspaceEnvVar() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; key: string; value: string }) => {
      const client = getDaemonClient();
      const res = await client.workspaceEnv(input.workspaceId)[":key"].$put({
        param: { key: input.key },
        json: { value: input.value },
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to set '${input.key}': ${res.status}`));
      }
      return res.json();
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: workspaceEnvQueries.all(input.workspaceId) });
    },
  }));
}

/**
 * Delete a single workspace `.env` var.
 * Wraps `DELETE /api/workspaces/:workspaceId/env/:key`.
 * Invalidates the workspace env query on success.
 */
export function useDeleteWorkspaceEnvVar() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; key: string }) => {
      const client = getDaemonClient();
      const res = await client.workspaceEnv(input.workspaceId)[":key"].$delete({
        param: { key: input.key },
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to delete '${input.key}': ${res.status}`));
      }
      return res.json();
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: workspaceEnvQueries.all(input.workspaceId) });
    },
  }));
}
