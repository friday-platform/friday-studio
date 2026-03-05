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

/** Validates both workspaceId and slug on slug routes. */
const SlugWithWorkspaceParamSchema = WorkspaceIdParamSchema.merge(SlugParamSchema);

/** Coerces "true"/"false" query strings to boolean. */
const GetResourceQuerySchema = z.object({
  published: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/** Creates the Ledger resource routes. Mounted under /v1/resources. */
export function createResourceRoutes() {
  return factory
    .createApp()

    .post(
      "/:workspaceId/provision",
      zValidator("param", WorkspaceIdParamSchema),
      zValidator("json", ProvisionBodySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId } = c.req.valid("param");
        const body = c.req.valid("json");

        const { initialData, ...metadata } = body;
        const result = await adapter.provision(workspaceId, metadata, initialData);
        return c.json(result, 201);
      },
    )

    .post(
      "/:workspaceId/:slug/query",
      zValidator("param", SlugWithWorkspaceParamSchema),
      zValidator("json", SqlBodySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");
        const { sql, params } = c.req.valid("json");

        const result = await adapter.query(workspaceId, slug, sql, params);
        return c.json(result, 200);
      },
    )

    .post(
      "/:workspaceId/:slug/mutate",
      zValidator("param", SlugWithWorkspaceParamSchema),
      zValidator("json", SqlBodySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");
        const { sql, params } = c.req.valid("json");

        const result = await adapter.mutate(workspaceId, slug, sql, params);
        return c.json(result, 200);
      },
    )

    .post(
      "/:workspaceId/:slug/publish",
      zValidator("param", SlugWithWorkspaceParamSchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");

        const result = await adapter.publish(workspaceId, slug);
        return c.json(result, 200);
      },
    )

    .put(
      "/:workspaceId/:slug/version",
      zValidator("param", SlugWithWorkspaceParamSchema),
      zValidator("json", ReplaceVersionBodySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");
        const { data, schema } = c.req.valid("json");

        const result = await adapter.replaceVersion(workspaceId, slug, data, schema);
        return c.json(result, 201);
      },
    )

    .get("/:workspaceId", zValidator("param", WorkspaceIdParamSchema), async (c) => {
      const adapter = c.get("adapter");
      const { workspaceId } = c.req.valid("param");

      const result = await adapter.listResources(workspaceId);
      return c.json(result, 200);
    })

    .get(
      "/:workspaceId/:slug",
      zValidator("param", SlugWithWorkspaceParamSchema),
      zValidator("query", GetResourceQuerySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");
        const opts = c.req.valid("query");

        const result = await adapter.getResource(workspaceId, slug, opts);
        if (!result) {
          return c.json({ error: "not_found" }, 404);
        }
        return c.json(result, 200);
      },
    )

    .delete("/:workspaceId/:slug", zValidator("param", SlugWithWorkspaceParamSchema), async (c) => {
      const adapter = c.get("adapter");
      const { workspaceId, slug } = c.req.valid("param");

      await adapter.deleteResource(workspaceId, slug);
      return c.json({ deleted: true }, 200);
    })

    .post(
      "/:workspaceId/:slug/link-ref",
      zValidator("param", SlugWithWorkspaceParamSchema),
      zValidator("json", LinkRefBodySchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");
        const { ref } = c.req.valid("json");

        const result = await adapter.linkRef(workspaceId, slug, ref);
        return c.json(result, 201);
      },
    )

    .post(
      "/:workspaceId/:slug/reset-draft",
      zValidator("param", SlugWithWorkspaceParamSchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId, slug } = c.req.valid("param");

        await adapter.resetDraft(workspaceId, slug);
        return c.json({ reset: true }, 200);
      },
    )

    .post(
      "/:workspaceId/publish-all-dirty",
      zValidator("param", WorkspaceIdParamSchema),
      async (c) => {
        const adapter = c.get("adapter");
        const { workspaceId } = c.req.valid("param");

        const published = await adapter.publishAllDirty(workspaceId);
        return c.json({ published }, 200);
      },
    );
}
