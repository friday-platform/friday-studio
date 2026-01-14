import { mkdir, unlink, writeFile } from "node:fs/promises";
import {
  type ArtifactWithContents,
  CreateArtifactSchema,
  UpdateArtifactSchema,
} from "@atlas/core/artifacts";
import { EXTENSION_TO_MIME, MAX_FILE_SIZE } from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { dirname, extname, join } from "@std/path";
import { fileTypeFromBlob } from "file-type";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const logger = createLogger({ name: "artifacts-upload" });

type ValidationResult = { valid: true; mimeType: string } | { valid: false; error: string };

/**
 * Validate uploaded file by detecting binary content via magic bytes.
 *
 * Uses file-type package which detects 100+ binary formats. Returns undefined
 * for text files (CSV, JSON, TXT, MD) since they have no magic bytes.
 * This catches renamed binaries: malware.exe -> data.csv still detected as EXE.
 */
async function validateUpload(file: File): Promise<ValidationResult> {
  const detected = await fileTypeFromBlob(file);

  if (detected) {
    // Binary file detected (exe, zip, png, etc.) - reject
    logger.warn("Binary file rejected", {
      filename: file.name,
      detectedType: detected.mime,
      detectedExt: detected.ext,
    });
    return { valid: false, error: "Binary files not allowed. Supported: CSV, JSON, TXT, MD, YML" };
  }

  // No magic bytes = not a known binary format, trust extension
  const ext = `.${file.name.toLowerCase().split(".").pop()}`;
  const mimeType = EXTENSION_TO_MIME.get(ext);
  if (!mimeType) {
    return { valid: false, error: "File type not allowed. Supported: CSV, JSON, TXT, MD, YML" };
  }
  return { valid: true, mimeType };
}

const GetArtifactQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const ListArtifactsQuery = z.object({
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

const BatchGetBody = z.object({
  ids: z.array(z.string()).min(1).max(1000),
  includeContents: z.boolean().optional(),
});

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
    const { ids, includeContents } = c.req.valid("json");
    const result = await ArtifactStorage.getManyLatest({ ids });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    if (!includeContents) {
      return c.json({ artifacts: result.data }, 200);
    }

    // Fetch contents for file artifacts in parallel
    const artifactsWithContents: ArtifactWithContents[] = await Promise.all(
      result.data.map(async (artifact) => {
        if (artifact.data.type !== "file") {
          return artifact;
        }
        const contentsResult = await ArtifactStorage.readFileContents({ id: artifact.id });
        if (contentsResult.ok) {
          return { ...artifact, contents: contentsResult.data };
        }
        // If read fails (binary file, etc.), return artifact without contents
        return artifact;
      }),
    );

    return c.json({ artifacts: artifactsWithContents }, 200);
  })
  /** Get artifact by ID (includes file contents inline for file artifacts) */
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

      const artifact = result.data;
      let contents: string | undefined;

      // For file artifacts, include contents inline
      if (artifact.data.type === "file") {
        const contentsResult = await ArtifactStorage.readFileContents({
          id,
          revision: query?.revision,
        });
        if (contentsResult.ok) {
          contents = contentsResult.data;
        }
        // If read fails (binary file, etc.), still return artifact metadata
      }

      return c.json({ artifact, contents }, 200);
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
  })
  /** Upload file as artifact */
  .post("/upload", async (c) => {
    const contentType = c.req.header("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return c.json({ error: "file field is required and must be a File" }, 400);
    }

    const chatId = formData.get("chatId")?.toString() || undefined;

    // Path traversal defense
    if (chatId && (chatId.includes("..") || chatId.startsWith("/"))) {
      return c.json({ error: "Invalid chatId" }, 400);
    }

    // Size validation
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: "File too large (max 25MB)" }, 413);
    }

    // Validate file content via magic bytes detection
    const validation = await validateUpload(file);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 415);
    }

    // Generate storage path: ~/.atlas/uploads/{chatId || 'orphan'}/{uuid}.{ext}
    const atlasHome = getAtlasHome();
    const subdir = chatId || "orphan";
    const ext = extname(file.name) || ".bin";
    const uuid = crypto.randomUUID();
    const storagePath = join(atlasHome, "uploads", subdir, `${uuid}${ext}`);

    try {
      // Write file to persistent storage
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, new Uint8Array(await file.arrayBuffer()));

      // Create artifact pointing to stored file
      const result = await ArtifactStorage.create({
        title: file.name,
        summary: `Uploaded file: ${file.name}`,
        data: { type: "file", version: 1, data: { path: storagePath, originalName: file.name } },
        chatId,
      });

      if (!result.ok) {
        // Clean up orphaned file if artifact creation failed
        await unlink(storagePath).catch(() => {});
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifact: result.data }, 201);
    } catch (error) {
      // Clean up orphaned file if write succeeded but something else failed
      await unlink(storagePath).catch(() => {});

      logger.error("Failed to upload artifact", {
        filename: file.name,
        size: file.size,
        error: stringifyError(error),
      });

      return c.json({ error: "Upload failed" }, 500);
    }
  });

export { artifactsApp };
export type ArtifactsRoutes = typeof artifactsApp;
