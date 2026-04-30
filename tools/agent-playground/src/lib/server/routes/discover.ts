import process from "node:process";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import JSZip from "jszip";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const REPO = process.env.DISCOVER_REPO ?? "friday-platform/friday-studio-examples";
const PATH = process.env.DISCOVER_PATH ?? "";
const REF = process.env.DISCOVER_REF ?? "main";
const DAEMON_URL = process.env.FRIDAYD_URL ?? "http://localhost:8080";

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

function emptyMeta(hasWorkspaceYml: boolean): WorkspaceMeta {
  return {
    hasWorkspaceYml,
    signals: [],
    agents: [],
    jobs: [],
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

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function fetchFolderListing(
  repo: string,
  ref: string,
  path: string,
): Promise<string[] | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`;
  const { status, text } = await cachedFetch(url);
  if (status < 200 || status >= 300) return null;
  try {
    const parsed = ContentsResponseSchema.parse(JSON.parse(text));
    return parsed.filter((e) => e.type === "dir").map((e) => e.name);
  } catch {
    return null;
  }
}

const TreeEntrySchema = z.object({
  path: z.string(),
  type: z.string(),
});
const TreeResponseSchema = z.object({
  tree: z.array(TreeEntrySchema),
  truncated: z.boolean(),
});

async function fetchTreeBlobs(
  repo: string,
  ref: string,
  folderPath: string,
): Promise<string[] | null> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`;
  const { status, text } = await cachedFetch(url);
  if (status < 200 || status >= 300) return null;
  try {
    const parsed = TreeResponseSchema.parse(JSON.parse(text));
    if (parsed.truncated) return null;
    const prefix = folderPath ? `${folderPath}/` : "";
    return parsed.tree
      .filter((e) => e.type === "blob" && (prefix === "" || e.path.startsWith(prefix)))
      .map((e) => e.path);
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, { headers: ghHeaders });
  if (res.status < 200 || res.status >= 300) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export const discoverRoute = new Hono()
  .get("/list", async (c) => {
    const folders = await fetchFolderListing(REPO, REF, PATH);
    if (!folders) {
      return c.json({ error: `Failed to list folders at ${REPO}/${REF}/${PATH}` }, 502);
    }
    const checks = await Promise.all(
      folders.map(async (folder) => {
        const folderPath = PATH ? `${PATH}/${folder}` : folder;
        const [meta, lock] = await Promise.all([
          fetchWorkspaceMeta(REPO, REF, folderPath),
          fetchText(rawUrl(REPO, REF, `${folderPath}/workspace.lock`)),
        ]);
        return meta.hasWorkspaceYml && lock !== null ? { folder, meta } : null;
      }),
    );
    const items: DiscoverItem[] = checks
      .filter((entry): entry is { folder: string; meta: WorkspaceMeta } => entry !== null)
      .map(({ folder, meta }) => ({
        slug: folder,
        name: meta.name ?? humanizeSlug(folder),
        description: meta.description ?? "",
        hasWorkspaceYml: true,
        counts: {
          signals: meta.signals.length,
          agents: meta.agents.length,
          jobs: meta.jobs.length,
        },
      }));
    return c.json({ source: { repo: REPO, path: PATH, ref: REF }, items });
  })
  .get("/item", zValidator("query", ItemQuerySchema), async (c) => {
    const { slug } = c.req.valid("query");
    const folderPath = PATH ? `${PATH}/${slug}` : slug;

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
  })
  .post("/import", zValidator("query", ItemQuerySchema), async (c) => {
    const { slug } = c.req.valid("query");
    const folderPath = PATH ? `${PATH}/${slug}` : slug;

    const blobs = await fetchTreeBlobs(REPO, REF, folderPath);
    if (!blobs || blobs.length === 0) {
      return c.json({ error: `Failed to list files at ${folderPath}` }, 502);
    }

    const zip = new JSZip();
    const files = await Promise.all(
      blobs.map(async (path) => {
        const bytes = await fetchBytes(rawUrl(REPO, REF, path));
        return { path, bytes };
      }),
    );
    for (const { path, bytes } of files) {
      if (!bytes) {
        return c.json({ error: `Failed to fetch ${path}` }, 502);
      }
      const relPath = folderPath ? path.slice(folderPath.length + 1) : path;
      zip.file(relPath, bytes);
    }

    const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

    const formData = new FormData();
    formData.append(
      "bundle",
      new Blob([new Uint8Array(zipBytes)], { type: "application/zip" }),
      `${slug}.zip`,
    );

    const res = await fetch(`${DAEMON_URL}/api/workspaces/import-bundle`, {
      method: "POST",
      body: formData,
    });
    const body: unknown = await res.json().catch(() => ({}));
    return c.json(body as Record<string, unknown>, res.status as 200 | 400 | 422 | 500);
  });
