/**
 * Workspace identity mutation — partial updates to the `workspace:` block.
 *
 * Pure function over WorkspaceConfig, returning MutationResult. The settings
 * page edits the user-facing identity fields (name, description, timeout);
 * `id` and `version` are not patchable here — `id` is the workspace's stable
 * identity and `version` is managed elsewhere.
 */

import { produce } from "immer";
import { z } from "zod";
import { WorkspaceIdentitySchema, WorkspaceTimeoutConfigSchema } from "../base.ts";
import type { WorkspaceConfig } from "../workspace.ts";
import { type MutationResult, validationError } from "./types.ts";

/**
 * Patchable workspace identity fields. Every field is optional — an absent
 * field is left untouched. `name` keeps its non-empty constraint when present.
 */
export const WorkspaceIdentityPatchSchema = z
  .strictObject({
    name: z.string().min(1, "Workspace name cannot be empty").optional(),
    description: z.string().optional(),
    timeout: WorkspaceTimeoutConfigSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Identity patch must set at least one field",
  });

export type WorkspaceIdentityPatch = z.infer<typeof WorkspaceIdentityPatchSchema>;

/**
 * Merge an identity patch into the workspace config's `workspace:` block.
 * Validates the merged identity against WorkspaceIdentitySchema before
 * committing, so a bad timeout duration or empty name is rejected.
 *
 * @param config - Current workspace configuration
 * @param patch - Partial identity fields to merge
 * @returns MutationResult with updated config or validation error
 */
export function updateWorkspaceIdentity(
  config: WorkspaceConfig,
  patch: WorkspaceIdentityPatch,
): MutationResult<WorkspaceConfig> {
  const merged = { ...config.workspace, ...patch };

  const parseResult = WorkspaceIdentitySchema.safeParse(merged);
  if (!parseResult.success) {
    return {
      ok: false,
      error: validationError("Invalid workspace identity after merge", parseResult.error.issues),
    };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      draft.workspace = parseResult.data;
    }),
  };
}
