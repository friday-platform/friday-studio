/**
 * Skill mutations and types.
 *
 * Query hooks have been replaced by `skillQueries` factories in `skill-queries.ts`.
 * Mutations for the global skill catalog remain here.
 *
 * @module
 */
import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
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
 * Mutation to assign a skill to a workspace.
 * Wraps `POST /api/skills/scoping/:skillId/assignments` with {workspaceIds: [workspaceId]}.
 */
export function useAssignSkill() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { skillId: string; workspaceId: string }) => {
      const res = await client.skills.scoping[":skillId"].assignments.$post({
        param: { skillId: input.skillId },
        json: { workspaceIds: [input.workspaceId] },
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Failed to assign skill: ${res.status}`,
        );
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", "assignments", variables.skillId] as const,
      });
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", variables.workspaceId, "skills"] as const,
      });
    },
  }));
}

/**
 * Mutation to unassign a skill from a workspace.
 * Wraps `DELETE /api/skills/scoping/:skillId/assignments/:workspaceId`.
 */
export function useUnassignSkill() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { skillId: string; workspaceId: string }) => {
      const res = await client.skills.scoping[":skillId"].assignments[":workspaceId"].$delete({
        param: { skillId: input.skillId, workspaceId: input.workspaceId },
      });
      if (!res.ok) throw new Error(`Failed to unassign skill: ${res.status}`);
      return null;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", "assignments", variables.skillId] as const,
      });
      queryClient.invalidateQueries({
        queryKey: ["daemon", "workspace", variables.workspaceId, "skills"] as const,
      });
    },
  }));
}

/**
 * Search skills.sh via the daemon proxy.
 * Wraps `GET /api/skills/search?q=&limit=`.
 * Not a TanStack query factory because callers typically debounce input.
 */
export async function searchSkillsSh(query: string, limit = 10) {
  const res = await fetch(
    `/api/daemon/api/skills/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
  );
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const data = (await res.json()) as {
    query: string;
    count: number;
    durationMs: number;
    skills: Array<{
      id: string;
      skillId: string;
      name: string;
      installs: number;
      source: string;
      tier: "official" | "community";
    }>;
  };
  return data;
}

export interface InstallSkillInput {
  source: string;
  workspaceId?: string;
  targetNamespace?: string;
}

/**
 * Mutation to install a skill from skills.sh.
 * Wraps `POST /api/skills/install`.
 * Invalidates the workspace-skills query on success so the Skills page
 * picks up the new assignment without a manual reload.
 */
export function useInstallSkill() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: InstallSkillInput) => {
      const res = await fetch("/api/daemon/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg =
          typeof body.error === "string" ? body.error : `Install failed: ${String(res.status)}`;
        const err = new Error(msg) as Error & { data?: Record<string, unknown>; status?: number };
        err.data = body;
        err.status = res.status;
        throw err;
      }
      return body;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
      if (variables.workspaceId) {
        queryClient.invalidateQueries({
          queryKey: ["daemon", "workspace", variables.workspaceId, "skills"] as const,
        });
        queryClient.invalidateQueries({
          queryKey: [
            "daemon",
            "workspace",
            variables.workspaceId,
            "skills",
            "classified",
          ] as const,
        });
      }
    },
  }));
}

export interface SkillVersion {
  version: number;
  createdAt: string;
  createdBy: string;
}

/**
 * Version history for a skill. Every publish (including the auto-bump
 * that happens when Save is clicked in the editor) creates a new row in
 * the `skills` table keyed by (skill_id, version), so this is just a
 * `listVersions` read of that history.
 */
export function useSkillVersions(namespace: () => string, name: () => string) {
  return createQuery(() => ({
    queryKey: ["daemon", "skills", namespace(), name(), "versions"] as const,
    queryFn: async (): Promise<SkillVersion[]> => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(namespace())}/${encodeURIComponent(name())}/versions`,
      );
      if (!res.ok) throw new Error(`Failed to load versions: ${res.status}`);
      const data = (await res.json()) as { versions: SkillVersion[] };
      return data.versions;
    },
    enabled: namespace().length > 0 && name().length > 0,
    staleTime: 30_000,
  }));
}

/**
 * Restore an older version by re-publishing its snapshot as a NEW version.
 * We don't rewind — the history chain is append-only, so reverting to v2
 * produces v5 with v2's content. Keeps audit clean.
 */
export function useRestoreSkillVersion() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (input: {
      namespace: string;
      name: string;
      version: number;
    }): Promise<{ published: { version: number } }> => {
      const getRes = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/${String(input.version)}`,
      );
      if (!getRes.ok) throw new Error(`Failed to load v${String(input.version)}: ${getRes.status}`);
      const { skill } = (await getRes.json()) as {
        skill: { description: string; instructions: string; frontmatter: Record<string, unknown> };
      };
      const publishRes = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: skill.description,
            instructions: skill.instructions,
            descriptionManual: true,
          }),
        },
      );
      if (!publishRes.ok) {
        const body: unknown = await publishRes.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Restore failed: ${publishRes.status}`,
        );
      }
      return (await publishRes.json()) as { published: { version: number } };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
      queryClient.invalidateQueries({
        queryKey: skillQueries.detail(variables.namespace, variables.name).queryKey,
      });
    },
  }));
}

export interface LintFinding {
  rule: string;
  message: string;
  severity: "info" | "warn" | "error";
}

export interface LintResult {
  warnings: LintFinding[];
  errors: LintFinding[];
}

/**
 * Re-runs the publish-time linter against the currently-stored skill.
 * Surfaces warnings/errors in the UI without needing a re-upload. Kept
 * as a `createQuery` because lint output is stable between edits and
 * benefits from being invalidated when a publish succeeds.
 */
export function useSkillLint(namespace: () => string, name: () => string) {
  return createQuery(() => ({
    queryKey: ["daemon", "skills", namespace(), name(), "lint"] as const,
    queryFn: async (): Promise<LintResult> => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(namespace())}/${encodeURIComponent(name())}/lint`,
      );
      if (!res.ok) throw new Error(`Lint failed: ${res.status}`);
      return (await res.json()) as LintResult;
    },
    enabled: namespace().length > 0 && name().length > 0,
    staleTime: 60_000,
  }));
}

/**
 * Rules the daemon knows how to auto-fix. All other rules surface in the
 * lint panel without a "Fix" action.
 */
export const FIXABLE_RULES = new Set([
  "path-style",
  "description-length",
  "description-person",
  "description-trigger",
  "description-missing",
  "first-person",
  "time-sensitive",
]);

export function useAutofixSkill() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (input: {
      namespace: string;
      name: string;
      rule: string;
    }): Promise<{
      rule: string;
      fixedBy: "deterministic" | "llm";
      published: { version: number };
    }> => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/autofix`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule: input.rule }),
        },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Autofix failed: ${res.status}`,
        );
      }
      return (await res.json()) as {
        rule: string;
        fixedBy: "deterministic" | "llm";
        published: { version: number };
      };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
      queryClient.invalidateQueries({
        queryKey: skillQueries.detail(variables.namespace, variables.name).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", variables.namespace, variables.name, "lint"] as const,
      });
      queryClient.invalidateQueries({
        queryKey: ["daemon", "skills", variables.namespace, variables.name, "versions"] as const,
      });
    },
  }));
}

export interface CheckUpdateResult {
  hasUpdate: boolean;
  source: string | null;
  localHash: string | null;
  remote: { hash: string } | null;
}

/**
 * Ask the daemon whether a newer version of this skill exists on skills.sh.
 * Locally-authored skills always return `hasUpdate=false`. This is a
 * mutation (not a query) because it's user-triggered — a background poll
 * would burn rate limit on the skills.sh API and offers no benefit when
 * the user doesn't have the skill open.
 */
export function useCheckSkillUpdate() {
  return createMutation(() => ({
    mutationFn: async (input: { namespace: string; name: string }): Promise<CheckUpdateResult> => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/check-update`,
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Failed to check for updates: ${res.status}`,
        );
      }
      return (await res.json()) as CheckUpdateResult;
    },
  }));
}

/**
 * Pull the latest skills.sh archive for an already-installed skill and
 * publish it as a new version under the same namespace/name. Invalidates
 * catalog + detail + file queries so the UI picks up the bump.
 */
export function useUpdateSkillFromSource() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { namespace: string; name: string }) => {
      const res = await fetch(
        `/api/daemon/api/skills/@${encodeURIComponent(input.namespace)}/${encodeURIComponent(input.name)}/update`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        throw new Error(
          typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
            ? body.error
            : `Update failed: ${res.status}`,
        );
      }
      return (await res.json()) as { updated: { version: number; sourceHash: string } };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: skillQueries.all() });
      queryClient.invalidateQueries({
        queryKey: skillQueries.detail(variables.namespace, variables.name).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: skillQueries.files(variables.namespace, variables.name).queryKey,
      });
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
