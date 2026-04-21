/**
 * Query option factories for skill-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { SkillSummarySchema } from "@atlas/skills/schemas";
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";

const WorkspaceSkillsResponseSchema = z.object({
  skills: z.array(SkillSummarySchema),
});

const ClassifiedSkillsResponseSchema = z.object({
  assigned: z.array(SkillSummarySchema),
  global: z.array(SkillSummarySchema),
  other: z.array(SkillSummarySchema),
});

const JobSkillsResponseSchema = z.object({
  workspaceInherited: z.array(SkillSummarySchema),
  jobSpecific: z.array(SkillSummarySchema),
  friday: z.array(SkillSummarySchema),
  available: z.array(SkillSummarySchema),
});
export type JobSkillsResponse = z.infer<typeof JobSkillsResponseSchema>;

const JobSkillsBreakdownResponseSchema = z.object({
  byJob: z.array(
    z.object({ jobName: z.string(), skills: z.array(SkillSummarySchema) }),
  ),
});
export type JobSkillsBreakdown = z.infer<typeof JobSkillsBreakdownResponseSchema>;

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const SkillDetailSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  namespace: z.string(),
  name: z.string().nullable(),
  version: z.number(),
  description: z.string(),
  descriptionManual: z.boolean(),
  disabled: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});

const SkillDetailResponseSchema = z.object({ skill: SkillDetailSchema });

const SkillFileContentSchema = z.object({ path: z.string(), content: z.string() });

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const skillQueries = {
  /** Key-only entry for hierarchical invalidation of all skill queries. */
  all: () => ["daemon", "skills"] as const,

  /** All skills from the global catalog. */
  catalog: () =>
    queryOptions({
      queryKey: ["daemon", "skills", "catalog"] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.skills.index.$get({ query: { sort: "name", includeAll: "true" } });
        if (!res.ok) throw new Error(`Failed to fetch catalog skills: ${res.status}`);
        const data = await res.json();
        return data.skills;
      },
      staleTime: 60_000,
    }),

  /** Single skill detail from the catalog. */
  detail: (ns: string, name: string) =>
    queryOptions({
      queryKey: ["daemon", "skills", ns, name] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.skills[":namespace"][":name"].$get({
          param: { namespace: `@${ns}`, name },
          query: {},
        });
        if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status}`);
        return SkillDetailResponseSchema.parse(await res.json());
      },
      staleTime: 60_000,
    }),

  /** Archive file list for a skill. */
  files: (ns: string, name: string) =>
    queryOptions({
      queryKey: ["daemon", "skills", ns, name, "files"] as const,
      queryFn: async () => {
        const client = getDaemonClient();
        const res = await client.skills[":namespace"][":name"].files.$get({
          param: { namespace: `@${ns}`, name },
        });
        if (!res.ok) throw new Error(`Failed to fetch skill files: ${res.status}`);
        return res.json();
      },
      staleTime: 60_000,
    }),

  /** Single file content from a skill's archive (wildcard route — raw fetch). */
  fileContent: (ns: string, name: string, path: string) =>
    queryOptions({
      queryKey: ["daemon", "skills", ns, name, "files", path] as const,
      queryFn: async () => {
        const res = await fetch(
          `/api/daemon/api/skills/@${encodeURIComponent(ns)}/${encodeURIComponent(name)}/files/${path}`,
        );
        if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
        return SkillFileContentSchema.parse(await res.json());
      },
      staleTime: 60_000,
    }),

  /**
   * Skills visible to a workspace (unassigned ∪ directly assigned).
   * Accepts null to disable via skipToken.
   */
  workspaceSkills: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "workspace", workspaceId, "skills"] as const,
      queryFn: workspaceId
        ? async () => {
            const res = await fetch(
              `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/skills`,
            );
            if (!res.ok) throw new Error(`Failed to fetch workspace skills: ${res.status}`);
            return WorkspaceSkillsResponseSchema.parse(await res.json()).skills;
          }
        : skipToken,
      staleTime: 60_000,
    }),

  /**
   * Classified catalog for a workspace: assigned here / global (unassigned) / other workspaces.
   * Single round-trip replacement for per-skill assignment lookups.
   */
  classifiedWorkspaceSkills: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "workspace", workspaceId, "skills", "classified"] as const,
      queryFn: workspaceId
        ? async () => {
            const res = await fetch(
              `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/skills/classified`,
            );
            if (!res.ok) throw new Error(`Failed to fetch classified skills: ${res.status}`);
            return ClassifiedSkillsResponseSchema.parse(await res.json());
          }
        : skipToken,
      staleTime: 30_000,
    }),

  /**
   * Workspace IDs a skill is assigned to. Empty array ⇒ unassigned (global).
   * Used by the workspace Skills page to split Assigned / Global / Other.
   */
  assignments: (skillId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "skills", "assignments", skillId] as const,
      queryFn: skillId
        ? async () => {
            const client = getDaemonClient();
            const res = await client.skills.scoping[":skillId"].assignments.$get({
              param: { skillId },
            });
            if (!res.ok) throw new Error(`Failed to fetch skill assignments: ${res.status}`);
            const data = await res.json();
            return data.workspaceIds as string[];
          }
        : skipToken,
      staleTime: 30_000,
    }),

  /**
   * Four-bucket view of skills for a specific job inside a workspace:
   *   - `workspaceInherited` — baseline (workspace-level + global, ex-@friday)
   *   - `jobSpecific`        — rows pinned to (ws, jobName), editable here
   *   - `friday`             — @friday/* bypass set (always available)
   *   - `available`          — catalog candidates not yet in either layer
   *
   * Drives the /platform/:ws/jobs/:jobName Skills panel.
   */
  /**
   * Read-only per-job breakdown of job-specific skill assignments for a
   * workspace. Drives the "Job-scoped" section on the Workspace Skills page.
   * Writes flow through the per-job detail page (jobSkills).
   */
  jobSkillsBreakdown: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "workspace", workspaceId, "skills", "job-breakdown"] as const,
      queryFn: workspaceId
        ? async () => {
            const res = await fetch(
              `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/skills/job-breakdown`,
            );
            if (!res.ok)
              throw new Error(`Failed to fetch job skills breakdown: ${res.status}`);
            return JobSkillsBreakdownResponseSchema.parse(await res.json());
          }
        : skipToken,
      staleTime: 30_000,
    }),

  jobSkills: (workspaceId: string | null, jobName: string | null) =>
    queryOptions({
      queryKey: [
        "daemon",
        "workspace",
        workspaceId,
        "jobs",
        jobName,
        "skills",
      ] as const,
      queryFn:
        workspaceId && jobName
          ? async () => {
              const res = await fetch(
                `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobName)}/skills`,
              );
              if (!res.ok) throw new Error(`Failed to fetch job skills: ${res.status}`);
              return JobSkillsResponseSchema.parse(await res.json());
            }
          : skipToken,
      staleTime: 30_000,
    }),
};
