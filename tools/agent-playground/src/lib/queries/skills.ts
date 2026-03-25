/**
 * TanStack Query hooks for fetching workspace skills and individual skill details.
 *
 * @module
 */
import type { InlineSkillConfig, SkillEntry } from "@atlas/config";
import { parseSkillRef } from "@atlas/config";
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";

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
// SKILL DETAIL (JSON shape returned by GET /skills/:namespace/:name)
// ==============================================================================

/** JSON-safe shape of a single skill returned from the daemon API (archive excluded). */
const SkillDetailSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  namespace: z.string(),
  name: z.string().nullable(),
  version: z.number(),
  title: z.string().nullable(),
  description: z.string(),
  descriptionManual: z.boolean(),
  disabled: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});

const SkillDetailResponseSchema = z.object({ skill: SkillDetailSchema });


// ==============================================================================
// QUERY HOOKS
// ==============================================================================

/**
 * Derives the skill list from the workspace config query.
 * Separates global catalog refs from inline skill definitions.
 *
 * @param workspaceId - Reactive getter returning the workspace ID, or null
 */
export function useWorkspaceSkills(workspaceId: () => string | null) {
  const client = getDaemonClient();

  return createQuery(() => {
    const id = workspaceId();
    return {
      queryKey: ["daemon", "workspace", id, "skills"],
      queryFn: async (): Promise<DerivedWorkspaceSkills> => {
        if (!id) throw new Error("No workspace selected");
        const res = await client.workspace[":workspaceId"].config.$get({
          param: { workspaceId: id },
        });
        if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
        const config = await res.json();
        return deriveWorkspaceSkills(config.config.skills);
      },
      enabled: id !== null,
    };
  });
}

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
      queryClient.invalidateQueries({ queryKey: ["daemon", "workspace", id, "skills"] });
      queryClient.invalidateQueries({ queryKey: ["daemon", "workspace", id, "config"] });
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
      queryClient.invalidateQueries({ queryKey: ["daemon", "workspace", id, "skills"] });
      queryClient.invalidateQueries({ queryKey: ["daemon", "workspace", id, "config"] });
    },
  }));
}

/** Catalog skill summary (from GET /api/skills/) */
export interface CatalogSkill {
  id: string;
  skillId: string;
  namespace: string;
  name: string | null;
  title: string | null;
  description: string;
  disabled: boolean;
  latestVersion: number;
  createdAt: string;
}

/**
 * Fetches all skills from the global catalog.
 */
export function useCatalogSkills() {
  const client = getDaemonClient();

  return createQuery(() => ({
    queryKey: ["daemon", "skills", "catalog"],
    queryFn: async (): Promise<CatalogSkill[]> => {
      const res = await client.skills.index.$get({ query: { sort: "name", includeAll: "true" } });
      if (!res.ok) throw new Error(`Failed to fetch catalog skills: ${res.status}`);
      const data = await res.json();
      return data.skills;
    },
  }));
}

/**
 * Fetches a single skill's full details from the catalog via the daemon proxy.
 *
 * @param namespace - Reactive getter returning the skill namespace
 * @param name - Reactive getter returning the skill name
 */
export function useSkill(namespace: () => string, name: () => string) {
  const client = getDaemonClient();

  return createQuery(() => {
    const ns = namespace();
    const n = name();
    return {
      queryKey: ["daemon", "skills", ns, n],
      queryFn: async () => {
        const res = await client.skills[":namespace"][":name"].$get({
          param: { namespace: `@${ns}`, name: n },
          query: {},
        });
        if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status}`);
        return SkillDetailResponseSchema.parse(await res.json());
      },
      enabled: ns.length > 0 && n.length > 0,
    };
  });
}

/**
 * Fetches the list of archive files for a skill.
 *
 * @param namespace - Reactive getter returning the skill namespace
 * @param name - Reactive getter returning the skill name
 */
export function useSkillFiles(namespace: () => string, name: () => string) {
  const client = getDaemonClient();

  return createQuery(() => {
    const ns = namespace();
    const n = name();
    return {
      queryKey: ["daemon", "skills", ns, n, "files"],
      queryFn: async () => {
        const res = await client.skills[":namespace"][":name"].files.$get({
          param: { namespace: `@${ns}`, name: n },
        });
        if (!res.ok) throw new Error(`Failed to fetch skill files: ${res.status}`);
        return res.json();
      },
      enabled: ns.length > 0 && n.length > 0,
    };
  });
}

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/** Input for publishing a new skill version */
export interface PublishSkillInput {
  namespace: string;
  name: string;
  title?: string;
  description?: string;
  instructions: string;
  descriptionManual?: boolean;
}

/** Input for toggling skill disabled state */
export interface DisableSkillInput {
  skillId: string;
  disabled: boolean;
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
      if (!res.ok) throw new Error(`Failed to publish skill: ${res.status}`);
      return res.json();
    },
    onSuccess: (_data: unknown, variables: PublishSkillInput) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", variables.namespace, variables.name],
      });
      queryClient.invalidateQueries({ queryKey: ["daemon", "skills"] });
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
      queryClient.invalidateQueries({ queryKey: ["daemon", "skills"] });
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
      queryClient.invalidateQueries({ queryKey: ["daemon", "skills"] });
    },
  }));
}

interface SkillFileContent {
  path: string;
  content: string;
}

/**
 * Fetches a single file's content from a skill's archive.
 * Disabled when no path is selected (lazy fetch on click).
 *
 * @param namespace - Reactive getter returning the skill namespace
 * @param name - Reactive getter returning the skill name
 * @param path - Reactive getter returning the file path, or null when none selected
 */
export function useSkillFileContent(
  namespace: () => string,
  name: () => string,
  path: () => string | null,
) {
  return createQuery(() => {
    const ns = namespace();
    const n = name();
    const p = path();
    return {
      queryKey: ["daemon", "skills", ns, n, "files", p],
      queryFn: async (): Promise<SkillFileContent> => {
        const res = await fetch(
          `/api/daemon/api/skills/@${encodeURIComponent(ns)}/${encodeURIComponent(n)}/files/${p}`,
        );
        if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
        return res.json() as Promise<SkillFileContent>;
      },
      enabled: ns.length > 0 && n.length > 0 && p !== null,
    };
  });
}

/** Input for updating a single file in a skill's archive */
export interface UpdateSkillFileInput {
  namespace: string;
  name: string;
  path: string;
  content: string;
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
      return res.json() as Promise<{ path: string; version: number }>;
    },
    onSuccess: (_data: unknown, variables: UpdateSkillFileInput) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", variables.namespace, variables.name, "files"],
      });
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", variables.namespace, variables.name],
      });
    },
  }));
}
