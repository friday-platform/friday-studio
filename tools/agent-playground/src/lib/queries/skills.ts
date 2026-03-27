/**
 * Skill mutations, types, and derivation logic.
 *
 * Query hooks have been replaced by `skillQueries` factories in `skill-queries.ts`.
 * Mutations remain here with invalidation keys referencing the factory.
 *
 * @module
 */
import type { InlineSkillConfig, SkillEntry } from "@atlas/config";
import { parseSkillRef } from "@atlas/config";
import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { skillQueries } from "./skill-queries.ts";
import { workspaceQueries } from "./workspace-queries.ts";

// ==============================================================================
// DERIVATION — extract skills from workspace config
// ==============================================================================

/** A global skill ref parsed into its namespace/name components */
export interface ParsedGlobalRef {
  ref: string;
  namespace: string;
  name: string;
  version: number | undefined;
}

/** An inline skill extracted from workspace config */
export interface ParsedInlineSkill {
  name: string;
  description: string;
  instructions: string;
}

export interface DerivedWorkspaceSkills {
  globalRefs: ParsedGlobalRef[];
  inlineSkills: ParsedInlineSkill[];
}

/**
 * Separates a workspace config's skills array into global catalog refs
 * and inline skill definitions.
 *
 * @param skills - The `skills` array from workspace config (may be undefined)
 */
export function deriveWorkspaceSkills(skills: SkillEntry[] | undefined): DerivedWorkspaceSkills {
  if (!skills || skills.length === 0) {
    return { globalRefs: [], inlineSkills: [] };
  }

  const globalRefs: ParsedGlobalRef[] = [];
  const inlineSkills: ParsedInlineSkill[] = [];

  for (const entry of skills) {
    if (isInlineSkill(entry)) {
      inlineSkills.push({
        name: entry.name,
        description: entry.description,
        instructions: entry.instructions,
      });
    } else {
      const { namespace, name } = parseSkillRef(entry.name);
      globalRefs.push({ ref: entry.name, namespace, name, version: entry.version });
    }
  }

  return { globalRefs, inlineSkills };
}

function isInlineSkill(entry: SkillEntry): entry is InlineSkillConfig {
  return "inline" in entry && (entry as InlineSkillConfig).inline === true;
}

// ==============================================================================
// TYPES
// ==============================================================================

/** Catalog skill summary (from GET /api/skills/) */
export interface CatalogSkill {
  id: string;
  skillId: string;
  namespace: string;
  name: string | null;
  description: string;
  disabled: boolean;
  latestVersion: number;
  createdAt: string;
}

/** Input for publishing a new skill version */
export interface PublishSkillInput {
  namespace: string;
  name: string;
  description?: string;
  instructions: string;
  descriptionManual?: boolean;
}

/** Input for toggling skill disabled state */
export interface DisableSkillInput {
  skillId: string;
  disabled: boolean;
}

/** Input for updating a single file in a skill's archive */
export interface UpdateSkillFileInput {
  namespace: string;
  name: string;
  path: string;
  content: string;
}

const UpdateSkillFileResponseSchema = z.object({ path: z.string(), version: z.number() });

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Mutation for removing a skill binding from the workspace config.
 * Wraps `DELETE /api/workspaces/:workspaceId/config/skills/:skillName` via daemon client.
 * Invalidates workspace config and skills queries on success.
 *
 * @param workspaceId - Reactive getter returning the workspace ID
 */
export function useRemoveWorkspaceSkill(workspaceId: () => string | null) {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (skillName: string) => {
      const id = workspaceId();
      if (!id) throw new Error("No workspace selected");
      const configClient = client.workspaceConfig(id);
      const res = await configClient.skills[":skillName"].$delete({ param: { skillName } });
      if (!res.ok) throw new Error(`Failed to remove skill: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      const id = workspaceId();
      if (id) {
        queryClient.invalidateQueries({ queryKey: skillQueries.workspaceSkills(id).queryKey });
        queryClient.invalidateQueries({ queryKey: workspaceQueries.config(id).queryKey });
      }
    },
  }));
}

/**
 * Mutation for adding a catalog skill binding to the workspace config.
 * Wraps `POST /api/workspaces/:workspaceId/config/skills` via daemon client.
 * Invalidates workspace config and skills queries on success.
 *
 * @param workspaceId - Reactive getter returning the workspace ID
 */
export function useAddWorkspaceSkill(workspaceId: () => string | null) {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (skillRef: string) => {
      const id = workspaceId();
      if (!id) throw new Error("No workspace selected");
      const configClient = client.workspaceConfig(id);
      const res = await configClient.skills.$post({ json: { skillRef } });
      if (!res.ok) throw new Error(`Failed to add skill: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      const id = workspaceId();
      if (id) {
        queryClient.invalidateQueries({ queryKey: skillQueries.workspaceSkills(id).queryKey });
        queryClient.invalidateQueries({ queryKey: workspaceQueries.config(id).queryKey });
      }
    },
  }));
}

/**
 * Mutation for publishing a new version of a skill.
 * Wraps `POST /api/skills/:namespace/:name` via daemon client.
 * Invalidates skill detail and list queries on success.
 */
export function usePublishSkill() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: PublishSkillInput) => {
      const { namespace, name, ...body } = input;
      const res = await client.skills[":namespace"][":name"].$post({
        param: { namespace: `@${namespace}`, name },
        json: body,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Failed to publish skill: ${res.status}` }));
        throw new Error(typeof body.error === "string" ? body.error : `Failed to publish skill: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_data: unknown, variables: PublishSkillInput) => {
      queryClient.invalidateQueries({
        queryKey: skillQueries.detail(variables.namespace, variables.name).queryKey,
      });
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
    },
  }));
}

/**
 * Mutation for enabling or disabling a skill.
 * Wraps `PATCH /api/skills/:skillId/disable` via daemon client.
 * Invalidates skill queries on success.
 */
export function useDisableSkill() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: DisableSkillInput) => {
      const res = await client.skills[":skillId"].disable.$patch({
        param: { skillId: input.skillId },
        json: { disabled: input.disabled },
      });
      if (!res.ok) throw new Error(`Failed to update skill: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
    },
  }));
}

/**
 * Mutation for deleting a skill (all versions).
 * Wraps `DELETE /api/skills/:skillId` via daemon client.
 * Invalidates skill list queries on success.
 */
export function useDeleteSkill() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (skillId: string) => {
      const res = await client.skills[":skillId"].$delete({ param: { skillId } });
      if (!res.ok) throw new Error(`Failed to delete skill: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
    },
  }));
}

/**
 * Mutation for updating a single file within a skill's archive.
 * Wraps `PUT /api/skills/:namespace/:name/files/:path` via daemon proxy.
 * Invalidates file content and skill queries on success.
 */
export function useUpdateSkillFile() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: UpdateSkillFileInput) => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/files/${input.path}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: input.content }),
        },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Failed to save file: ${res.status}`,
        );
      }
      return UpdateSkillFileResponseSchema.parse(await res.json());
    },
    onSuccess: (_data: unknown, variables: UpdateSkillFileInput) => {
      queryClient.invalidateQueries({
        queryKey: skillQueries.files(variables.namespace, variables.name).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: skillQueries.detail(variables.namespace, variables.name).queryKey,
      });
    },
  }));
}
