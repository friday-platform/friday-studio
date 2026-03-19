import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import process from "node:process";
import type { UserActivityAction } from "@atlas/activity/titles";
import { generateUserActivityTitle } from "@atlas/activity/titles";
import { getValidatedMimeType } from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { createLogger, logger } from "@atlas/logger";
import { enrichCatalogEntries, toCatalogEntries } from "@atlas/resources";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import Papa from "papaparse";
import { z } from "zod";
import type { AppContext } from "../../src/factory.ts";
import { daemonFactory } from "../../src/factory.ts";
import { replaceArtifactFromFile, streamToFile } from "../artifacts.ts";
import { getCurrentUser } from "../me/adapter.ts";
import { classifyUpload, getTabularColumns, isProse, parseCsvToJsonb } from "./upload-strategy.ts";

/**
 * Fire-and-forget activity creation for user resource actions.
 * Resolves the current user internally — callers don't need to pass userId.
 * Failures are logged but never block the primary operation.
 */
async function createResourceActivity(
  ctx: AppContext,
  opts: {
    referenceId: string;
    workspaceId: string;
    action: UserActivityAction;
    resourceName: string;
  },
): Promise<void> {
  try {
    const userResult = await getCurrentUser();
    const userId = userResult.ok ? (userResult.data?.id ?? "local") : "local";

    await ctx
      .getActivityAdapter()
      .create({
        type: "resource",
        source: "user",
        referenceId: opts.referenceId,
        workspaceId: opts.workspaceId,
        jobId: null,
        userId,
        title: generateUserActivityTitle(opts.action, opts.resourceName),
      });
  } catch (err) {
    logger.warn("Failed to create resource activity", { action: opts.action, error: String(err) });
  }
}

const LinkBodySchema = z.object({
  url: z.string(),
  name: z.string(),
  provider: z.string(),
  description: z.string().optional(),
});

/**
 * Extract a required route parameter, throwing if missing.
 * Params inherited from the parent mount path (e.g. `:workspaceId`) are
 * typed `string | undefined` in Hono sub-routers — this narrows to `string`.
 */
function requireParam(
  c: { req: { param(name: string): string | undefined } },
  name: string,
): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`Missing required route parameter: ${name}`);
  return value;
}

/**
 * Resource management routes.
 *
 * Provides HTTP endpoints for listing, viewing, uploading, replacing,
 * and deleting workspace resources. Mounted at `/:workspaceId/resources`
 * relative to the workspaces router.
 */
const resourceRoutes = daemonFactory
  .createApp()
  // List all resources in a workspace (enriched with type-specific fields)
  .get("/", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    try {
      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();
      const metadata = await ledger.listResources(workspaceId);
      const catalogEntries = await toCatalogEntries(metadata, ledger, workspaceId);
      const resources = await enrichCatalogEntries(catalogEntries, ArtifactStorage);

      return c.json({ resources });
    } catch (error) {
      return c.json({ error: `Failed to list resources: ${stringifyError(error)}` }, 500);
    }
  })
  // Resource detail (document resources only — columns + rows)
  .get("/:slug", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    const slug = c.req.param("slug");
    try {
      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      const resource = await ledger.getResource(workspaceId, slug, { published: true });
      if (!resource) {
        return c.json({ error: `Resource "${slug}" not found` }, 404);
      }
      if (resource.metadata.type !== "document") {
        return c.json(
          {
            error: `Resource "${slug}" is a ${resource.metadata.type}, not a document — detail view is only available for document resources`,
          },
          404,
        );
      }

      const schema = resource.version.schema;

      const meta = {
        name: resource.metadata.name,
        description: resource.metadata.description,
        resourceType: resource.metadata.type,
        updatedAt: resource.metadata.updatedAt,
      };

      if (isProse(schema)) {
        const content = typeof resource.version.data === "string" ? resource.version.data : "";
        return c.json({ format: "prose" as const, content, readonly: false, ...meta });
      }

      const columns = getTabularColumns(schema);
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(Array.isArray(resource.version.data) ? resource.version.data : []);
      return c.json({
        format: "tabular" as const,
        columns,
        rows,
        rowCount: rows.length,
        totalRows: rows.length,
        truncated: false,
        readonly: false,
        ...meta,
      });
    } catch (error) {
      return c.json({ error: `Failed to get resource detail: ${stringifyError(error)}` }, 500);
    }
  })
  // CSV export (document resources only)
  .get("/:slug/export", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    const slug = c.req.param("slug");
    try {
      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      const resource = await ledger.getResource(workspaceId, slug, { published: true });
      if (!resource) {
        return c.json({ error: `Resource "${slug}" not found` }, 404);
      }
      if (resource.metadata.type !== "document") {
        return c.json(
          {
            error: `Resource "${slug}" is a ${resource.metadata.type}, not a document — CSV export is only available for document resources`,
          },
          404,
        );
      }

      const parsed = z.array(z.record(z.string(), z.unknown())).safeParse(resource.version.data);
      const rows = parsed.success ? parsed.data : [];
      const csv = Papa.unparse(rows);

      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${slug.replace(/[^a-z0-9_-]/g, "_")}.csv"`,
        },
      });
    } catch (error) {
      return c.json({ error: `Failed to export resource: ${stringifyError(error)}` }, 500);
    }
  })
  // Upload file to create a new resource (automatic storage strategy)
  .post("/upload", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    const uploadLogger = createLogger({ component: "resource-upload" });

    try {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
      }

      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "file field is required and must be a File" }, 400);
      }

      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      // Derive slug, name, description from filename
      const fileName = file.name;
      const baseName = fileName.replace(/\.[^.]+$/, "");
      const slug =
        baseName
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/__+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/^(\d)/, "d$1")
          .slice(0, 64) || "data";
      const name = baseName;
      const description = `Uploaded from ${fileName}`;

      // Check slug uniqueness via Ledger
      const existing = await ledger.getResource(workspaceId, slug);
      if (existing) {
        return c.json({ error: `Resource "${slug}" already exists` }, 409);
      }

      // Resolve userId for Ledger provision
      const userResult = await getCurrentUser();
      const userId = userResult.ok ? (userResult.data?.id ?? "local") : "local";

      const strategy = classifyUpload(fileName, file.size);

      if (strategy === "document") {
        // Small CSV → parse to JSONB, provision as document resource
        const csvText = await file.text();
        try {
          const { rows, schema } = parseCsvToJsonb(csvText);

          const metadata = await ledger.provision(
            workspaceId,
            { userId, slug, name, description, type: "document", schema },
            rows,
          );

          uploadLogger.info("CSV uploaded as document resource", {
            workspaceId,
            slug,
            rowCount: rows.length,
          });

          await createResourceActivity(ctx, {
            referenceId: metadata.id,
            workspaceId,
            action: "uploaded",
            resourceName: name,
          });

          return c.json({ resource: metadata }, 201);
        } catch (error) {
          uploadLogger.error("CSV resource upload failed", {
            filename: fileName,
            error: stringifyError(error),
          });
          return c.json({ error: "CSV parsing failed" }, 500);
        }
      }

      if (strategy === "prose") {
        // Small markdown → provision as document resource with prose schema
        const content = await file.text();
        try {
          const metadata = await ledger.provision(
            workspaceId,
            {
              userId,
              slug,
              name,
              description,
              type: "document",
              schema: { type: "string", format: "markdown" },
            },
            content,
          );

          uploadLogger.info("Markdown uploaded as prose resource", {
            workspaceId,
            slug,
            contentLength: content.length,
          });

          await createResourceActivity(ctx, {
            referenceId: metadata.id,
            workspaceId,
            action: "uploaded",
            resourceName: name,
          });

          return c.json({ resource: metadata }, 201);
        } catch (error) {
          uploadLogger.error("Markdown resource upload failed", {
            filename: fileName,
            error: stringifyError(error),
          });
          return c.json({ error: "Markdown upload failed" }, 500);
        }
      }

      // artifact_ref: large file → store as artifact, register reference via Ledger
      // Cortex adapter uploads to remote storage — local files are transient, use /tmp.
      const usingCortex = process.env.ARTIFACT_STORAGE_ADAPTER === "cortex";
      const artifactsDir = usingCortex
        ? join(tmpdir(), "atlas-artifacts")
        : join(getAtlasHome(), "uploads", "artifacts");
      await mkdir(artifactsDir, { recursive: true });

      const persistedPath = join(
        artifactsDir,
        `${crypto.randomUUID()}${extname(fileName) || ".txt"}`,
      );
      try {
        await streamToFile(file.stream(), persistedPath);

        const artifactResult = await ArtifactStorage.create({
          title: fileName,
          summary: `Uploaded file: ${fileName}`,
          data: { type: "file", version: 1, data: { path: persistedPath, originalName: fileName } },
          workspaceId,
          source: "resource_upload",
        });

        if (!artifactResult.ok) {
          await unlink(persistedPath).catch(() => {});
          return c.json({ error: artifactResult.error }, 500);
        }

        const metadata = await ledger.provision(
          workspaceId,
          {
            userId,
            slug,
            name,
            description,
            type: "artifact_ref",
            schema: { artifactId: artifactResult.data.id },
          },
          { artifactId: artifactResult.data.id },
        );

        uploadLogger.info("File uploaded as artifact_ref resource", {
          workspaceId,
          slug,
          artifactId: artifactResult.data.id,
        });

        await createResourceActivity(ctx, {
          referenceId: metadata.id,
          workspaceId,
          action: "uploaded",
          resourceName: name,
        });

        return c.json({ resource: metadata }, 201);
      } catch (error) {
        await unlink(persistedPath).catch(() => {});
        uploadLogger.error("File resource upload failed", {
          filename: fileName,
          error: stringifyError(error),
        });
        return c.json({ error: "Upload failed" }, 500);
      }
    } catch (error) {
      return c.json({ error: `Failed to upload resource: ${stringifyError(error)}` }, 500);
    }
  })
  // Create an external_ref resource from a URL
  .post("/link", zValidator("json", LinkBodySchema), async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    try {
      const { url, name, provider, description } = c.req.valid("json");
      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_")
          .replace(/__+/g, "_")
          .replace(/^_+|_+$/g, "")
          .replace(/^(\d)/, "d$1")
          .slice(0, 64) || "link";

      const existing = await ledger.getResource(workspaceId, slug);
      if (existing) {
        return c.json({ error: `Resource "${slug}" already exists` }, 409);
      }

      const userResult = await getCurrentUser();
      const userId = userResult.ok ? (userResult.data?.id ?? "local") : "local";

      const linkMetadata = await ledger.provision(
        workspaceId,
        { userId, slug, name, description: description ?? "", type: "external_ref", schema: {} },
        { provider, ref: url, metadata: {} },
      );

      await createResourceActivity(ctx, {
        referenceId: linkMetadata.id,
        workspaceId,
        action: "linked",
        resourceName: name,
      });

      return c.json({ slug, name, provider, ref: url }, 201);
    } catch (error) {
      return c.json({ error: `Failed to create link resource: ${stringifyError(error)}` }, 500);
    }
  })
  // Replace resource data via Ledger replaceVersion
  .put("/:slug", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    const slug = c.req.param("slug");
    try {
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
      }

      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      // Look up existing resource
      const existing = await ledger.getResource(workspaceId, slug);
      if (!existing) {
        return c.json({ error: `Resource "${slug}" not found` }, 404);
      }

      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "file field is required and must be a File" }, 400);
      }

      const mimeType = getValidatedMimeType(file.name);

      const createReplaceActivity = () =>
        createResourceActivity(ctx, {
          referenceId: existing.metadata.id,
          workspaceId,
          action: "replaced",
          resourceName: existing.metadata.name,
        });

      if (existing.metadata.type === "document") {
        if (isProse(existing.version.schema)) {
          if (mimeType !== "text/markdown") {
            return c.json({ error: "Prose resources require a markdown file" }, 422);
          }
          const content = await file.text();
          await ledger.replaceVersion(workspaceId, slug, content);

          await createReplaceActivity();
          const refreshed = await ledger.getResource(workspaceId, slug);
          return c.json({ resource: refreshed?.metadata ?? null });
        }

        // Tabular documents require CSV
        if (mimeType !== "text/csv") {
          return c.json({ error: "Table resources require a CSV file" }, 422);
        }
        const csvText = await file.text();
        const { rows, schema } = parseCsvToJsonb(csvText);
        await ledger.replaceVersion(workspaceId, slug, rows, schema);

        await createReplaceActivity();
        const refreshed = await ledger.getResource(workspaceId, slug);
        return c.json({ resource: refreshed?.metadata ?? null });
      }

      // For artifact_ref resources, replace the backing artifact
      const refData = z.object({ artifactId: z.string() }).safeParse(existing.version.data);
      if (!refData.success) {
        return c.json({ error: "Resource has no backing artifact" }, 500);
      }
      const { artifactId } = refData.data;

      // Stream file to temp
      const uploadTmpDir = join(tmpdir(), "atlas-upload");
      await mkdir(uploadTmpDir, { recursive: true });
      const ext = extname(file.name) || ".txt";
      const filePath = join(uploadTmpDir, `${crypto.randomUUID()}${ext}`);
      try {
        await streamToFile(file.stream(), filePath);

        const replaceResult = await replaceArtifactFromFile({
          artifactId,
          filePath,
          fileName: file.name,
        });

        if (!replaceResult.ok) {
          return c.json({ error: replaceResult.error }, 500);
        }

        await createReplaceActivity();
        // Return updated metadata
        const refreshed = await ledger.getResource(workspaceId, slug);
        return c.json({ resource: refreshed?.metadata ?? null });
      } finally {
        await unlink(filePath).catch(() => {});
      }
    } catch (error) {
      return c.json({ error: `Failed to replace resource: ${stringifyError(error)}` }, 500);
    }
  })
  // Delete resource (hard delete via Ledger + optional artifact cleanup)
  .delete("/:slug", async (c) => {
    const workspaceId = requireParam(c, "workspaceId");
    const slug = c.req.param("slug");
    try {
      const ctx = c.get("app");
      const ledger = ctx.getLedgerAdapter();

      // Look up resource to check existence and get artifact_id
      const existing = await ledger.getResource(workspaceId, slug);
      if (!existing) {
        return c.json({ error: `Resource "${slug}" not found` }, 404);
      }

      // Delete via Ledger (hard delete with CASCADE)
      await ledger.deleteResource(workspaceId, slug);

      // Delete backing artifact if this is an artifact_ref
      const refData = z.object({ artifactId: z.string() }).safeParse(existing.version.data);
      if (refData.success) {
        const { artifactId } = refData.data;
        const artifactResult = await ArtifactStorage.deleteArtifact({ id: artifactId });
        if (!artifactResult.ok) {
          logger.warn("Failed to delete backing artifact for resource", {
            slug,
            artifactId,
            error: artifactResult.error,
          });
        }
      }

      await createResourceActivity(ctx, {
        referenceId: existing.metadata.id,
        workspaceId,
        action: "deleted",
        resourceName: existing.metadata.name,
      });

      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: `Failed to delete resource: ${stringifyError(error)}` }, 500);
    }
  });

export { resourceRoutes };
