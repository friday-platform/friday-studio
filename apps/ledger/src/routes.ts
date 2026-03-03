/** Ledger HTTP routes. Maps adapter methods to REST endpoints with Zod validation. */
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { factory } from "./factory.ts";
import { ProvisionInputSchema } from "./types.ts";

const ProvisionBodySchema = ProvisionInputSchema.extend({ initialData: z.unknown().optional() });

const SqlBodySchema = z.object({
  sql: z.string().max(10_000),
  params: z.array(z.unknown()).max(100).optional(),
});

const ReplaceVersionBodySchema = z.object({ data: z.unknown(), schema: z.unknown().optional() });

const LinkRefBodySchema = z.object({ ref: z.string().max(2000) });

/** Validates workspace ID path parameter. */
const WorkspaceIdParamSchema = z.object({ workspaceId: z.string().min(1).max(200) });

/** Validates slug path parameter — same format as ProvisionInputSchema.slug. */
const SlugParamSchema = z.object({
  slug: z
    .string()
    .max(200)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
});

/** Coerces "true"/"false" query strings to boolean. */
const GetResourceQuerySchema = z.object({
  published: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/** Creates the Ledger resource routes. Mounted under /v1/resources. */
export function createResourceRoutes() {
  return (
    factory
      .createApp()

      // Validate workspaceId on all routes — it's always the first path segment
      .use("/:workspaceId/*", zValidator("param", WorkspaceIdParamSchema))
      .use("/:workspaceId", zValidator("param", WorkspaceIdParamSchema))

      // Validate slug format on all slug routes
      .use("/:workspaceId/:slug", zValidator("param", SlugParamSchema))
      .use("/:workspaceId/:slug/*", zValidator("param", SlugParamSchema))

      .post("/:workspaceId/provision", zValidator("json", ProvisionBodySchema), async (c) => {
        const adapter = c.get("adapter");
        const workspaceId = c.req.param("workspaceId");
        const body = c.req.valid("json");

        const { initialData, ...metadata } = body;
        const result = await adapter.provision(workspaceId, metadata, initialData);
        return c.json(result, 201);
      })

      .post("/:workspaceId/:slug/query", zValidator("json", SqlBodySchema), async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();
        const { sql, params } = c.req.valid("json");

        const result = await adapter.query(workspaceId, slug, sql, params);
        return c.json(result);
      })

      .post("/:workspaceId/:slug/mutate", zValidator("json", SqlBodySchema), async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();
        const { sql, params } = c.req.valid("json");

        const result = await adapter.mutate(workspaceId, slug, sql, params);
        return c.json(result);
      })

      .post("/:workspaceId/:slug/publish", async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();

        const result = await adapter.publish(workspaceId, slug);
        return c.json(result);
      })

      .put(
        "/:workspaceId/:slug/version",
        zValidator("json", ReplaceVersionBodySchema),
        async (c) => {
          const adapter = c.get("adapter");
          const { workspaceId, slug } = c.req.param();
          const { data, schema } = c.req.valid("json");

          const result = await adapter.replaceVersion(workspaceId, slug, data, schema);
          return c.json(result, 201);
        },
      )

      .get("/:workspaceId", async (c) => {
        const adapter = c.get("adapter");
        const workspaceId = c.req.param("workspaceId");

        const result = await adapter.listResources(workspaceId);
        return c.json(result);
      })

      .get("/:workspaceId/:slug", zValidator("query", GetResourceQuerySchema), async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();
        const opts = c.req.valid("query");

        const result = await adapter.getResource(workspaceId, slug, opts);
        if (!result) {
          return c.json({ error: "not_found" }, 404);
        }
        return c.json(result);
      })

      .delete("/:workspaceId/:slug", async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();

        await adapter.deleteResource(workspaceId, slug);
        return c.json({ deleted: true });
      })

      .post("/:workspaceId/:slug/link-ref", zValidator("json", LinkRefBodySchema), async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();
        const { ref } = c.req.valid("json");

        const result = await adapter.linkRef(workspaceId, slug, ref);
        return c.json(result, 201);
      })

      .post("/:workspaceId/:slug/reset-draft", async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.param();

        await adapter.resetDraft(workspaceId, slug);
        return c.json({ reset: true });
      })

      .post("/:workspaceId/publish-all-dirty", async (c) => {
        const adapter = c.get("adapter");
        const workspaceId = c.req.param("workspaceId");

        const published = await adapter.publishAllDirty(workspaceId);
        return c.json({ published });
      })
  );
}
