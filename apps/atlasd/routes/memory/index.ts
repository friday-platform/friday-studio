import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MdNarrativeStore } from "@atlas/adapters-md";
import { NarrativeEntrySchema } from "@atlas/agent-sdk";
import { parseMemoryMountSource } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory, KERNEL_WORKSPACE_ID } from "../../src/factory.ts";

/** Relaxed request body for POST — only text is required. */
const AppendBodySchema = z.object({
  text: z.string(),
  id: z.string().optional(),
  author: z.string().optional(),
  createdAt: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const NarrativeParamsSchema = z.object({ workspaceId: z.string(), memoryName: z.string() });

const ForgetParamsSchema = z.object({
  workspaceId: z.string(),
  memoryName: z.string(),
  entryId: z.string(),
});

function resolveMemory(workspaceId: string, memoryName: string): MdNarrativeStore {
  const memoryPath = path.join(getAtlasHome(), "memory", workspaceId, "narrative", memoryName);
  return new MdNarrativeStore({ workspaceRoot: memoryPath });
}

const memoryNarrativeRoutes = daemonFactory.createApp();

const KNOWN_KINDS = ["narrative", "retrieval", "dedup", "kv"] as const;

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// GET / — list workspace IDs that have any memory on disk.
// Backed by ~/.atlas/memory/ — every immediate subdirectory is treated as a
// workspaceId. Empty array if the memory root doesn't exist yet.
// Respects ATLAS_EXPOSE_KERNEL — hides the kernel workspace memory unless set.
memoryNarrativeRoutes.get("/", async (c) => {
  const root = path.join(getAtlasHome(), "memory");
  const entries = await safeReaddir(root);
  const exposeKernel = c.get("app").exposeKernel;
  const workspaces: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!exposeKernel && name === KERNEL_WORKSPACE_ID) continue;
    if (await isDir(path.join(root, name))) workspaces.push(name);
  }
  return c.json(workspaces);
});

// GET /:workspaceId — list memories for a workspace.
// Returns [{workspaceId, name, kind}] for every store declared in the
// workspace config (own + workspace-scoped mounts). For mounts, workspaceId
// is the SOURCE workspace so callers use the correct path when fetching
// entries. Falls back to filesystem scan for workspaces without memory config.
memoryNarrativeRoutes.get(
  "/:workspaceId",
  validator("param", z.object({ workspaceId: z.string() })),
  async (c) => {
    const { workspaceId } = c.req.valid("param");
    const manager = c.get("app").getWorkspaceManager();
    const config = await manager.getWorkspaceConfig(workspaceId);
    const memConfig = config?.workspace.memory;

    if (memConfig) {
      const memories: { workspaceId: string; name: string; kind: string }[] = [];

      for (const own of memConfig.own) {
        if (!own.strategy || own.strategy === "narrative") {
          memories.push({ workspaceId, name: own.name, kind: "narrative" });
        }
      }

      for (const mount of memConfig.mounts) {
        if (mount.scope === "workspace") {
          try {
            const parsed = parseMemoryMountSource(mount.source);
            if (parsed.kind === "narrative") {
              memories.push({
                workspaceId: parsed.workspaceId,
                name: parsed.memoryName,
                kind: "narrative",
              });
            }
          } catch {
            // Malformed mount source — skip
          }
        }
      }

      return c.json(memories);
    }

    // Fallback: filesystem scan for workspaces without explicit memory config.
    const wsRoot = path.join(getAtlasHome(), "memory", workspaceId);
    const memories: { workspaceId: string; name: string; kind: string }[] = [];
    for (const kind of KNOWN_KINDS) {
      const kindDir = path.join(wsRoot, kind);
      const names = await safeReaddir(kindDir);
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (await isDir(path.join(kindDir, name))) {
          memories.push({ workspaceId, name, kind });
        }
      }
    }
    return c.json(memories);
  },
);

// GET /:workspaceId/narrative/:memoryName — read narrative entries
memoryNarrativeRoutes.get(
  "/:workspaceId/narrative/:memoryName",
  validator("param", NarrativeParamsSchema),
  validator(
    "query",
    z.object({ since: z.string().optional(), limit: z.coerce.number().optional() }),
  ),
  async (c) => {
    const { workspaceId, memoryName } = c.req.valid("param");
    const { since, limit } = c.req.valid("query");

    try {
      const store = resolveMemory(workspaceId, memoryName);
      const entries = await store.read({ since, limit });
      return c.json(entries);
    } catch (error: unknown) {
      logger.warn("memory narrative read failed, returning empty", {
        workspaceId,
        memoryName,
        error,
      });
      return c.json([]);
    }
  },
);

// POST /:workspaceId/narrative/:memoryName — append entry
memoryNarrativeRoutes.post(
  "/:workspaceId/narrative/:memoryName",
  validator("param", NarrativeParamsSchema),
  validator("json", AppendBodySchema),
  async (c) => {
    const { workspaceId, memoryName } = c.req.valid("param");
    const body = c.req.valid("json");

    const entry = NarrativeEntrySchema.parse({
      id: body.id ?? randomUUID(),
      text: body.text,
      author: body.author,
      createdAt: body.createdAt ?? new Date().toISOString(),
      metadata: body.metadata,
    });

    try {
      const store = resolveMemory(workspaceId, memoryName);
      const appended = await store.append(entry);
      return c.json(appended);
    } catch (error: unknown) {
      logger.error("memory narrative append failed", { workspaceId, memoryName, error });
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// DELETE /:workspaceId/narrative/:memoryName/:entryId — forget entry
memoryNarrativeRoutes.delete(
  "/:workspaceId/narrative/:memoryName/:entryId",
  validator("param", ForgetParamsSchema),
  async (c) => {
    const { workspaceId, memoryName, entryId } = c.req.valid("param");

    try {
      const store = resolveMemory(workspaceId, memoryName);
      await store.forget(entryId);
      return c.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not implemented")) {
        return c.json({ error: "forget not implemented" }, 501);
      }
      logger.error("memory narrative forget failed", { workspaceId, memoryName, entryId, error });
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { memoryNarrativeRoutes };
export type MemoryRoutes = typeof memoryNarrativeRoutes;
