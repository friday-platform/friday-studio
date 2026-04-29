/**
 * Query option factories for the Discover page.
 *
 * Lists workspace folders from a public GitHub repo and fetches per-folder
 * detail (README + workspace.yml manifest). Defaults point at
 * vercel/examples/main/starter — see lib/server/routes/discover.ts.
 *
 * @module
 */
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";
import { getClient } from "../client.ts";

const SignalSummarySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  provider: z.string().optional(),
});

const AgentSummarySchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
});

const JobSummarySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

const DiscoverItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  hasWorkspaceYml: z.boolean(),
});

const DiscoverListResponseSchema = z.object({
  source: z.object({ repo: z.string(), path: z.string(), ref: z.string() }),
  items: z.array(DiscoverItemSchema),
});

const DiscoverDetailResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  hasWorkspaceYml: z.boolean(),
  signals: z.array(SignalSummarySchema),
  agents: z.array(AgentSummarySchema),
  jobs: z.array(JobSummarySchema),
  readme: z.string(),
  source: z.object({
    repo: z.string(),
    ref: z.string(),
    path: z.string(),
    htmlUrl: z.string(),
  }),
});

export type DiscoverDetail = z.infer<typeof DiscoverDetailResponseSchema>;

export const discoverQueries = {
  all: () => ["discover"] as const,

  list: () =>
    queryOptions({
      queryKey: ["discover", "list"] as const,
      queryFn: async () => {
        const res = await getClient().api.discover.list.$get();
        if (!res.ok) throw new Error(`Failed to load discover list: ${res.status}`);
        const data = await res.json();
        if ("error" in data && typeof data.error === "string") throw new Error(data.error);
        return DiscoverListResponseSchema.parse(data);
      },
      staleTime: 60_000,
    }),

  detail: (slug: string | null) =>
    queryOptions({
      queryKey: ["discover", "detail", slug] as const,
      queryFn: slug
        ? async () => {
            const res = await getClient().api.discover.item.$get({ query: { slug } });
            if (!res.ok) throw new Error(`Failed to load ${slug}: ${res.status}`);
            const data = await res.json();
            if ("error" in data && typeof data.error === "string") throw new Error(data.error);
            return DiscoverDetailResponseSchema.parse(data);
          }
        : skipToken,
      staleTime: 60_000,
    }),
};
