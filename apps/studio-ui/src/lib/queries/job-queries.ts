/**
 * Query option factories for job-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

/** Schema for FSM step entries from the jobs endpoint. */
export const FsmStepSchema = z.object({
  id: z.string(),
  stateId: z.string(),
  agentId: z.string().optional(),
  prompt: z.string().optional(),
}).passthrough();

/** A single FSM step definition within a job config. */
export type FsmStep = z.infer<typeof FsmStepSchema>;

const JobConfigResponseSchema = z.object({
  agents: z.array(FsmStepSchema),
}).passthrough();

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const jobQueries = {
  /** Key-only entry for hierarchical invalidation of all job queries. */
  all: () => ["daemon", "jobs"] as const,

  /** Job FSM config (step definitions). Accepts null params to disable via skipToken. */
  config: (jobId: string | null, workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "jobs", jobId, workspaceId, "config"] as const,
      queryFn: jobId && workspaceId
        ? async (): Promise<FsmStep[]> => {
            const client = getDaemonClient();
            const res = await client.jobs[":jobId"][":workspaceId"].$get({
              param: { jobId, workspaceId },
            });
            if (!res.ok) return [];
            const parsed = JobConfigResponseSchema.safeParse(await res.json());
            if (!parsed.success) {
              console.error("Invalid job config response:", parsed.error);
            }
            return parsed.success ? parsed.data.agents : [];
          }
        : skipToken,
      staleTime: 60_000,
    }),
};
