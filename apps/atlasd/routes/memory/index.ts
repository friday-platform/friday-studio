import { randomUUID } from "node:crypto";
import {
  ensureMemoryIndexBucket,
  JetStreamMemoryAdapter,
  JetStreamNarrativeStore,
} from "@atlas/adapters-md";
import { NarrativeEntrySchema } from "@atlas/agent-sdk";
import { parseMemoryMountSource } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { validator } from "hono-openapi";
import type { NatsConnection } from "nats";
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

function resolveMemory(
  nc: NatsConnection,
  workspaceId: string,
  memoryName: string,
): JetStreamNarrativeStore {
  return new JetStreamNarrativeStore({ nc, workspaceId, name: memoryName });
}

const memoryNarrativeRoutes = daemonFactory.createApp();

// GET / — list workspace IDs that have any narrative memory in JetStream.
// Reads MEMORY_INDEX KV bucket and dedupes by workspaceId prefix. Respects
// FRIDAY_EXPOSE_KERNEL — hides the kernel workspace memory unless set.
memoryNarrativeRoutes.get("/", async (c) => {
  const nc = c.get("app").daemon.getNatsConnection();
  const exposeKernel = c.get("app").exposeKernel;
  const seen = new Set<string>();
  const kv = await ensureMemoryIndexBucket(nc);
  const it = await kv.keys();
  for await (const key of it) {
    const sep = key.indexOf("/");
    if (sep <= 0) continue;
    const wsId = key.slice(0, sep);
    if (!exposeKernel && wsId === KERNEL_WORKSPACE_ID) continue;
    seen.add(wsId);
  }
  return c.json([...seen]);
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

    // Fallback for workspaces without an explicit memory block: list whatever
    // narrative streams have been written via the KV index.
    const nc = c.get("app").daemon.getNatsConnection();
    const adapter = new JetStreamMemoryAdapter({ nc });
    const stores = await adapter.list(workspaceId);
    return c.json(stores.map((s) => ({ workspaceId: s.workspaceId, name: s.name, kind: s.kind })));
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
      const nc = c.get("app").daemon.getNatsConnection();
      const store = resolveMemory(nc, workspaceId, memoryName);
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
      const nc = c.get("app").daemon.getNatsConnection();
      const store = resolveMemory(nc, workspaceId, memoryName);
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
      const nc = c.get("app").daemon.getNatsConnection();
      const store = resolveMemory(nc, workspaceId, memoryName);
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
