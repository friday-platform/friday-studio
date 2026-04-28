import process from "node:process";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const REPO = process.env.DISCOVER_REPO ?? "vercel/examples";
const PATH = process.env.DISCOVER_PATH ?? "starter";
const REF = process.env.DISCOVER_REF ?? "main";

const GH_TOKEN = process.env.GITHUB_TOKEN ?? "";

const ghHeaders: Record<string, string> = {
  accept: "application/vnd.github+json",
  "user-agent": "friday-discover",
  ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}),
};

const ContentsEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "symlink", "submodule"]),
});
const ContentsResponseSchema = z.array(ContentsEntrySchema);

// Loose schema — workspaces in the wild may carry extra fields we don't model
// here. We only pull out what the discover UI needs and let everything else
// pass through.
const WorkspaceYmlMetaSchema = z
  .object({
    workspace: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        version: z.string().optional(),
      })
      .partial()
      .optional(),
    signals: z
      .record(
        z.string(),
        z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            provider: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    agents: z
      .record(
        z.string(),
        z
          .object({
            type: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    jobs: z
      .record(
        z.string(),
        z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

interface SignalSummary {
  id: string;
  title?: string;
  description?: string;
  provider?: string;
}
interface AgentSummary {
  id: string;
  type?: string;
  description?: string;
}
interface JobSummary {
  id: string;
  title?: string;
  description?: string;
}

interface WorkspaceMeta {
  name?: string;
  description?: string;
  hasWorkspaceYml: boolean;
  signals: SignalSummary[];
  agents: AgentSummary[];
  jobs: JobSummary[];
}

interface DiscoverItem {
  slug: string;
  name: string;
  description: string;
  hasWorkspaceYml: boolean;
  counts: { signals: number; agents: number; jobs: number };
}

function rawUrl(repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
}

// TODO: replace with a real cache (TTL, invalidation, persistence). This is a
// process-lifetime in-memory map that exists purely so styling iterations
// don't burn through the unauthenticated GitHub rate limit (60 req/hr).
// Restart the dev server to invalidate.
const fetchCache = new Map<string, Promise<{ status: number; text: string }>>();

function cachedFetch(url: string): Promise<{ status: number; text: string }> {
  const existing = fetchCache.get(url);
  if (existing) return existing;
  const promise = (async () => {
    const res = await fetch(url, { headers: ghHeaders });
    return { status: res.status, text: await res.text() };
  })().catch((err) => {
    // Don't poison the cache on transient network failures.
    fetchCache.delete(url);
    throw err;
  });
  fetchCache.set(url, promise);
  return promise;
}

async function fetchText(url: string): Promise<string | null> {
  const { status, text } = await cachedFetch(url);
  return status >= 200 && status < 300 ? text : null;
}

// TODO: stub values for styling iteration. Returned for any folder that lacks
// a workspace.yml (e.g. when DISCOVER_REPO points at vercel/examples). Drop
// this once we point at a real catalog repo.
const STUB_SIGNALS: SignalSummary[] = [
  {
    id: "autopilot-tick",
    title: "Autopilot tick",
    provider: "http",
    description: "Manually fire one autopilot iteration.",
  },
  {
    id: "autopilot-tick-cron",
    title: "Autopilot tick (scheduled)",
    provider: "schedule",
    description: "Cron-driven autopilot iteration.",
  },
  {
    id: "review-target-workspace-run",
    title: "Review target workspace",
    provider: "http",
    description: "Trigger a reviewer agent against a target workspace.",
  },
  {
    id: "review-requested-cron",
    title: "Review target workspace (scheduled)",
    provider: "schedule",
    description: "Cron-driven workspace review every 15 minutes.",
  },
];

const STUB_AGENTS: AgentSummary[] = [
  {
    id: "planner",
    type: "user",
    description: "Picks the next eligible task from the backlog.",
  },
  {
    id: "workspace-reviewer",
    type: "atlas",
    description: "Reviews a target workspace for drift, prompt issues, and FSM smells.",
  },
  {
    id: "skill-planner",
    type: "llm",
    description: "Architect-role LLM that produces a skill plan from a request.",
  },
  {
    id: "reflector",
    type: "user",
    description: "Reads a completed session and proposes skill updates.",
  },
];

const STUB_JOBS: JobSummary[] = [
  {
    id: "autopilot-tick",
    title: "Supervise — pick next backlog task and dispatch",
    description: "Reads autopilot-backlog, picks next task, dispatches at target signal.",
  },
  {
    id: "review-target-workspace",
    title: "Supervise — review a target workspace",
    description: "Inspects workspace.yml drift, agent prompt issues, and FSM smells.",
  },
  {
    id: "author-skill",
    title: "Supervise — author a new skill",
    description: "Planner → scaffolder → reviewer → publisher pipeline.",
  },
];

function emptyMeta(hasWorkspaceYml: boolean): WorkspaceMeta {
  return {
    hasWorkspaceYml,
    signals: STUB_SIGNALS,
    agents: STUB_AGENTS,
    jobs: STUB_JOBS,
  };
}

async function fetchWorkspaceMeta(
  repo: string,
  ref: string,
  folderPath: string,
): Promise<WorkspaceMeta> {
  const text = await fetchText(rawUrl(repo, ref, `${folderPath}/workspace.yml`));
  if (!text) return emptyMeta(false);
  try {
    const parsed = WorkspaceYmlMetaSchema.parse(parseYaml(text));
    const signals: SignalSummary[] = Object.entries(parsed.signals ?? {}).map(([id, s]) => ({
      id,
      title: s.title,
      description: s.description,
      provider: s.provider,
    }));
    const agents: AgentSummary[] = Object.entries(parsed.agents ?? {}).map(([id, a]) => ({
      id,
      type: a.type,
      description: a.description,
    }));
    const jobs: JobSummary[] = Object.entries(parsed.jobs ?? {}).map(([id, j]) => ({
      id,
      title: j.title,
      description: j.description,
    }));
    return {
      name: parsed.workspace?.name,
      description: parsed.workspace?.description,
      hasWorkspaceYml: true,
      signals,
      agents,
      jobs,
    };
  } catch {
    return emptyMeta(true);
  }
}

const ItemQuerySchema = z.object({ slug: z.string().min(1) });

export const discoverRoute = new Hono()
  .get("/list", async (c) => {
    const apiUrl = `https://api.github.com/repos/${REPO}/contents/${PATH}?ref=${REF}`;
    const { status, text } = await cachedFetch(apiUrl);
    if (status < 200 || status >= 300) {
      return c.json(
        { error: `GitHub API ${status}: ${text}`, items: [] },
        status === 404 ? 404 : 502,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "GitHub returned non-JSON response", items: [] }, 502);
    }
    const parsed = ContentsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Unexpected GitHub response shape", items: [] }, 502);
    }

    const dirs = parsed.data.filter((e) => e.type === "dir");
    const items: DiscoverItem[] = await Promise.all(
      dirs.map(async (d) => {
        const meta = await fetchWorkspaceMeta(REPO, REF, d.path);
        return {
          slug: d.name,
          name: meta.name ?? d.name,
          description: meta.description ?? "",
          hasWorkspaceYml: meta.hasWorkspaceYml,
          counts: {
            signals: meta.signals.length,
            agents: meta.agents.length,
            jobs: meta.jobs.length,
          },
        };
      }),
    );

    return c.json({ source: { repo: REPO, path: PATH, ref: REF }, items });
  })
  .get("/item", zValidator("query", ItemQuerySchema), async (c) => {
    const { slug } = c.req.valid("query");
    const folderPath = `${PATH}/${slug}`;

    const [readme, meta] = await Promise.all([
      fetchText(rawUrl(REPO, REF, `${folderPath}/README.md`)),
      fetchWorkspaceMeta(REPO, REF, folderPath),
    ]);

    if (readme === null && !meta.hasWorkspaceYml) {
      return c.json({ error: `No README.md or workspace.yml in ${folderPath}` }, 404);
    }

    return c.json({
      slug,
      name: meta.name ?? slug,
      description: meta.description ?? "",
      hasWorkspaceYml: meta.hasWorkspaceYml,
      signals: meta.signals,
      agents: meta.agents,
      jobs: meta.jobs,
      readme: readme ?? "",
      source: {
        repo: REPO,
        ref: REF,
        path: folderPath,
        htmlUrl: `https://github.com/${REPO}/tree/${REF}/${folderPath}`,
      },
    });
  });
