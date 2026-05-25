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
import { VariableDeclarationSchema } from "@atlas/config";
import type { WorkspaceIdentityPatch } from "@atlas/config/mutations";
import type { VariableState } from "@atlas/workspace";
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import {
  validateField,
  variableEnvKey,
  type VariableRequirement,
} from "../workspace-variables/validate.ts";
import { workspaceQueries } from "./workspace-queries.ts";

// ==============================================================================
// SCHEMAS
// ==============================================================================

const EnvListResponseSchema = z.object({
  success: z.literal(true),
  env: z.record(z.string(), z.string()),
});

const VariableSourceSchema = z.enum(["env", "default", "unset"]);

const VariableStateSchema = z.object({
  name: z.string(),
  declaration: VariableDeclarationSchema,
  value: z.string().nullable(),
  effective_value: z.string().nullable(),
  source: VariableSourceSchema,
  is_filled: z.boolean(),
  validation_error: z.string().optional(),
});

const VariablesListResponseSchema = z.object({
  success: z.literal(true),
  variables: z.array(VariableStateSchema),
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

export const workspaceVariableQueries = {
  /** Key-only entry for hierarchical invalidation of all workspace variable queries. */
  all: (workspaceId: string) => ["daemon", "workspace", workspaceId, "variables"] as const,

  /**
   * Fully-resolved variable rows for the workspace (declaration + value +
   * effective value + source). Accepts null to disable via skipToken.
   */
  list: (workspaceId: string | null) =>
    queryOptions({
      queryKey: workspaceId
        ? (["daemon", "workspace", workspaceId, "variables", "list"] as const)
        : (["daemon", "workspace", "variables", "list"] as const),
      queryFn: workspaceId
        ? async (): Promise<VariableState[]> => {
            const client = getDaemonClient();
            const res = await client.workspaceVariables(workspaceId).index.$get();
            if (!res.ok) {
              throw new Error(
                await errorMessage(res, `Failed to fetch workspace variables: ${res.status}`),
              );
            }
            return VariablesListResponseSchema.parse(await res.json()).variables;
          }
        : skipToken,
      staleTime: 30_000,
    }),
};

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Structured error thrown by {@link useSaveWorkspaceDetails}.
 *
 * - `fieldErrors` keys are variable names (NOT env keys) — the same names the
 *   caller passed in `variableSets` / `variableDeletes`. Populated on pre-flight
 *   validation failure and on commit-time HTTP failure for env writes.
 * - `commitResults` is present only when at least one HTTP commit was attempted
 *   before the failure surfaced. Each entry covers one attempted write
 *   (identity or env) and reports whether it landed.
 */
export class SaveWorkspaceDetailsError extends Error {
  fieldErrors: Record<string, string>;
  commitResults?: Array<{ key: string; status: "ok" | "error"; error?: string }>;

  constructor(
    message: string,
    fieldErrors: Record<string, string>,
    commitResults?: Array<{ key: string; status: "ok" | "error"; error?: string }>,
  ) {
    super(message);
    this.name = "SaveWorkspaceDetailsError";
    this.fieldErrors = fieldErrors;
    if (commitResults !== undefined) this.commitResults = commitResults;
  }
}

export interface SaveWorkspaceDetailsInput {
  workspaceId: string;
  identityPatch?: WorkspaceIdentityPatch;
  /** Variable name → raw env value. The hook derives the env key. */
  variableSets: Record<string, string>;
  /** Variable names whose env keys should be deleted (reset-to-default). */
  variableDeletes: string[];
}

/** Lift a `VariableState` into the requirement shape `validateField` expects. */
function toRequirement(state: VariableState): VariableRequirement {
  const req: VariableRequirement = {
    kind: "variable",
    name: state.name,
    schema: state.declaration.schema,
  };
  if (state.declaration.display_name !== undefined) {
    req.display_name = state.declaration.display_name;
  }
  if (state.declaration.description !== undefined) {
    req.description = state.declaration.description;
  }
  return req;
}

/**
 * Composite Save for the Settings → Workspace Details page.
 *
 * One mutation, one `isPending`, one error. The `mutationFn` runs three steps
 * internally:
 *
 * 1. **Pre-flight validation.** Every entry in `variableSets` is validated
 *    against its declaration via the shared `validateField`. Any failure throws
 *    {@link SaveWorkspaceDetailsError} with per-name `fieldErrors` BEFORE any
 *    HTTP write — identity is never touched on pre-flight failure.
 * 2. **Sequenced commit.** Identity PUT first (when present), then one
 *    `PUT /env/:key` per variable set (env key derived via `variableEnvKey`),
 *    then one `DELETE /env/:key` per variable delete.
 * 3. **Partial-failure surfacing.** If a commit step throws after pre-flight,
 *    the thrown error carries `fieldErrors` for the failing variable AND
 *    `commitResults` covering every write attempted so far (so the UI can show
 *    which fields landed).
 *
 * On success invalidates the workspace config query, the variables query, and
 * the workspace list (identity may have renamed the workspace).
 */
export function useSaveWorkspaceDetails() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: SaveWorkspaceDetailsInput) => {
      const client = getDaemonClient();
      const variableNames = Object.keys(input.variableSets);

      const fieldErrors: Record<string, string> = {};
      if (variableNames.length > 0) {
        const variables = await queryClient.ensureQueryData(
          workspaceVariableQueries.list(input.workspaceId),
        );
        const byName = new Map(variables.map((v) => [v.name, v]));
        for (const name of variableNames) {
          const state = byName.get(name);
          if (!state) {
            fieldErrors[name] = "Unknown variable.";
            continue;
          }
          const raw = input.variableSets[name];
          if (raw === undefined) continue;
          const result = validateField(toRequirement(state), raw);
          if (!result.ok) fieldErrors[name] = result.message;
        }
        if (Object.keys(fieldErrors).length > 0) {
          throw new SaveWorkspaceDetailsError(
            "One or more variables failed validation.",
            fieldErrors,
          );
        }
      }

      const commitResults: Array<{ key: string; status: "ok" | "error"; error?: string }> = [];

      const fail = (key: string, name: string | null, message: string): never => {
        commitResults.push({ key, status: "error", error: message });
        if (name !== null) fieldErrors[name] = message;
        throw new SaveWorkspaceDetailsError(message, fieldErrors, commitResults);
      };

      if (input.identityPatch !== undefined) {
        const res = await client.workspaceConfig(input.workspaceId).identity.$put({
          json: input.identityPatch,
        });
        if (!res.ok) {
          fail(
            "identity",
            null,
            await errorMessage(res, `Failed to update workspace: ${res.status}`),
          );
        }
        commitResults.push({ key: "identity", status: "ok" });
      }

      for (const name of variableNames) {
        const value = input.variableSets[name];
        if (value === undefined) continue;
        const envKey = variableEnvKey(name);
        const res = await client.workspaceEnv(input.workspaceId)[":key"].$put({
          param: { key: envKey },
          json: { value },
        });
        if (!res.ok) {
          fail(envKey, name, await errorMessage(res, `Failed to set '${envKey}': ${res.status}`));
        }
        commitResults.push({ key: envKey, status: "ok" });
      }

      for (const name of input.variableDeletes) {
        const envKey = variableEnvKey(name);
        const res = await client.workspaceEnv(input.workspaceId)[":key"].$delete({
          param: { key: envKey },
        });
        if (!res.ok) {
          fail(envKey, name, await errorMessage(res, `Failed to delete '${envKey}': ${res.status}`));
        }
        commitResults.push({ key: envKey, status: "ok" });
      }

      return { commitResults };
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", input.workspaceId, "config"],
      });
      queryClient.invalidateQueries({
        queryKey: workspaceVariableQueries.all(input.workspaceId),
      });
      queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
    },
  }));
}

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
 * Set one of an MCP server's env values for this workspace. Wraps
 * `PUT /api/workspaces/:workspaceId/mcp/:serverId/env/:key`, which writes the
 * value into the workspace `.env` and points the config copy at it
 * (`from_environment`) — migrating a legacy literal entry in the process.
 * Invalidates the workspace config + env queries on success.
 */
export function useSetMCPServerEnvVar() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: {
      workspaceId: string;
      serverId: string;
      key: string;
      value: string;
    }) => {
      const client = getDaemonClient();
      const res = await client.workspaceMcp(input.workspaceId)[":serverId"].env[":key"].$put({
        param: { serverId: input.serverId, key: input.key },
        json: { value: input.value },
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to set '${input.key}': ${res.status}`));
      }
      return res.json();
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", input.workspaceId, "config"],
      });
      queryClient.invalidateQueries({ queryKey: workspaceEnvQueries.all(input.workspaceId) });
    },
  }));
}

/**
 * Point an MCP server's Link-backed env var at a different credential.
 * Wraps `PUT /api/workspaces/:workspaceId/config/credentials/mcp:serverId:envVar`,
 * which validates the credential against Link before rewriting the config copy.
 * Invalidates the workspace config query on success.
 */
export function useUpdateMCPCredential() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: {
      workspaceId: string;
      serverId: string;
      envVar: string;
      credentialId: string;
    }) => {
      const client = getDaemonClient();
      const path = `mcp:${input.serverId}:${input.envVar}`;
      const res = await client.workspaceConfig(input.workspaceId).credentials[":path"].$put({
        param: { path },
        json: { credentialId: input.credentialId },
      });
      if (!res.ok) {
        throw new Error(await errorMessage(res, `Failed to update credential: ${res.status}`));
      }
      return res.json();
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", input.workspaceId, "config"],
      });
    },
  }));
}
