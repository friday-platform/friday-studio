import { CreateArtifactSchema, UpdateArtifactSchema } from "@atlas/core/artifacts";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const GetArtifactQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const ListArtifactsQuery = z.object({
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

const BatchGetBody = z.object({ ids: z.array(z.string()).min(1).max(1000) });

const artifactsApp = daemonFactory
  .createApp()
  /** Create new artifact */
  .post("/", zValidator("json", CreateArtifactSchema), async (c) => {
    const data = c.req.valid("json");
    const result = await ArtifactStorage.create(data);

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ artifact: result.data }, 200);
  })
  /** Update artifact (creates new revision) */
  .put(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", UpdateArtifactSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");
      const result = await ArtifactStorage.update({
        id,
        data: data.data,
        summary: data.summary,
        revisionMessage: data.revisionMessage,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ artifact: result.data }, 200);
    },
  )
  /** Batch get artifacts by IDs (latest revisions only) */
  .post("/batch-get", zValidator("json", BatchGetBody), async (c) => {
    const { ids } = c.req.valid("json");
    const result = await ArtifactStorage.getManyLatest({ ids });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ artifacts: result.data }, 200);
  })
  /** Get artifact by ID */
  .get(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("query", GetArtifactQuery.optional()),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const result = await ArtifactStorage.get({ id, revision: query?.revision });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      if (!result.data) {
        return c.json({ error: "Artifact not found" }, 404);
      }

      return c.json({ artifact: result.data }, 200);
    },
  )
  /** List all revisions of an artifact */
  .get("/:id/revisions", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const result = await ArtifactStorage.listRevisions({ id });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ revisions: result.data }, 200);
  })
  /** Read file contents for a file artifact */
  .get(
    "/:id/contents",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("query", GetArtifactQuery.optional()),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const result = await ArtifactStorage.readFileContents({ id, revision: query?.revision });

      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ contents: result.data }, 200);
    },
  )
  /** List artifacts - optionally filter by workspace or chat */
  .get("/", zValidator("query", ListArtifactsQuery), async (c) => {
    const query = c.req.valid("query");

    if (query.workspaceId && query.chatId) {
      return c.json({ error: "Cannot specify both workspaceId and chatId" }, 400);
    }

    if (query.workspaceId) {
      const result = await ArtifactStorage.listByWorkspace({
        workspaceId: query.workspaceId,
        limit: query.limit,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    if (query.chatId) {
      const result = await ArtifactStorage.listByChat({ chatId: query.chatId, limit: query.limit });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    // No filter - return all artifacts
    const result = await ArtifactStorage.listAll({ limit: query.limit });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ artifacts: result.data }, 200);
  })
  /** Soft delete artifact */
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const result = await ArtifactStorage.deleteArtifact({ id });

    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }

    return c.json({ success: true }, 200);
  });

export { artifactsApp };
export type ArtifactsRoutes = typeof artifactsApp;
