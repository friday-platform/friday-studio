/**
 * Skill mutations and types.
 *
 * Query hooks have been replaced by `skillQueries` factories in `skill-queries.ts`.
 * Mutations for the global skill catalog remain here.
 *
 * @module
 */
import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { skillQueries } from "./skill-queries.ts";

// ==============================================================================
// TYPES
// ==============================================================================

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
