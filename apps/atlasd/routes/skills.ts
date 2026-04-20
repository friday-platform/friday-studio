import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NamespaceSchema, RESERVED_WORDS, SkillNameSchema } from "@atlas/config";
import {
  extractArchiveContents,
  extractSkillArchive,
  invalidateLintCache,
  lintSkill,
  listArchiveFiles,
  packSkillArchive,
  parseSkillMd,
  readArchiveFile,
  SkillStorage,
  validateSkillReferences,
} from "@atlas/skills";
import { PublishSkillInputSchema, SkillSortSchema } from "@atlas/skills/schemas";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUser } from "./me/adapter.ts";

// ==============================================================================
// Param / query schemas
// ==============================================================================

/**
 * Route params use /:namespace/:name where namespace arrives as "@atlas".
 * This schema strips the leading "@" and validates the remainder.
 */
const AtNamespaceParam = z
  .string()
  .regex(/^@[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Namespace must be @-prefixed kebab-case (e.g. @atlas)",
  })
  .refine((s) => !RESERVED_WORDS.some((w) => s.slice(1).includes(w)), {
    message: `Must not contain reserved words: ${RESERVED_WORDS.join(", ")}`,
  })
  .transform((s) => s.slice(1));

const NamespacedParams = z.object({ namespace: AtNamespaceParam, name: SkillNameSchema });

const VersionedParams = NamespacedParams.extend({ version: z.coerce.number().int().positive() });

const ListQuery = z.object({
  namespace: NamespaceSchema.optional(),
  query: z.string().optional(),
  includeAll: z.string().optional(),
  sort: SkillSortSchema,
});

const SkillIdParam = z.object({ skillId: z.string().min(1) });

const IncludeQuery = z.object({ include: z.literal("archive").optional() });

// ==============================================================================
// Auth helper
// ==============================================================================

async function requireUser(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const result = await getCurrentUser();
  if (!result.ok || !result.data) return { ok: false, error: "Unauthorized" };
  return { ok: true, userId: result.data.id };
}

// ==============================================================================
// Routes
// ==============================================================================

// GET routes are intentionally unauthenticated — agents resolve skills during
// execution without user tokens. Writes (POST/DELETE) require auth.
export const skillsRoutes = daemonFactory
  .createApp()
  // ─── LIST ───────────────────────────────────────────────────────────────────
  .get("/", zValidator("query", ListQuery), async (c) => {
    const { namespace, query, includeAll, sort } = c.req.valid("query");
    const result = await SkillStorage.list(namespace, query, includeAll === "true", sort);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ skills: result.data });
  })
  // ─── CREATE BLANK SKILL ────────────────────────────────────────────────────
  .post("/", async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const result = await SkillStorage.create("friday", auth.userId);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ skillId: result.data.skillId }, 201);
  })
  // ─── SCOPING: WORKSPACE ASSIGNMENTS ────────────────────────────────────────
  // These must be registered before /:namespace/:name routes to avoid
  // Hono matching "scoping" as a namespace param.
  .get("/scoping/:skillId/assignments", zValidator("param", SkillIdParam), async (c) => {
    const { skillId } = c.req.valid("param");
    const result = await SkillStorage.listAssignments(skillId);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ workspaceIds: result.data });
  })
  .post(
    "/scoping/:skillId/assignments",
    zValidator("param", SkillIdParam),
    zValidator("json", z.object({ workspaceIds: z.array(z.string().min(1)) })),
    async (c) => {
      const { skillId } = c.req.valid("param");
      const { workspaceIds } = c.req.valid("json");

      // Try every workspace independently. The caller learns exactly which
      // assignments succeeded and which failed instead of stopping at the
      // first error and leaving partial state with no signal.
      const results = await Promise.all(
        workspaceIds.map(async (workspaceId) => {
          const result = await SkillStorage.assignSkill(skillId, workspaceId);
          return result.ok
            ? { workspaceId, ok: true as const }
            : { workspaceId, ok: false as const, error: result.error };
        }),
      );

      const assigned: string[] = [];
      const failed: { workspaceId: string; error: string }[] = [];
      for (const r of results) {
        if (r.ok) assigned.push(r.workspaceId);
        else failed.push({ workspaceId: r.workspaceId, error: r.error });
      }

      // 200 all succeeded; 207 partial; 500 nothing succeeded
      const status = failed.length === 0 ? 200 : assigned.length === 0 ? 500 : 207;
      return c.json({ assigned, failed }, status);
    },
  )
  .delete(
    "/scoping/:skillId/assignments/:workspaceId",
    zValidator("param", z.object({ skillId: z.string().min(1), workspaceId: z.string().min(1) })),
    async (c) => {
      const { skillId, workspaceId } = c.req.valid("param");
      const result = await SkillStorage.unassignSkill(skillId, workspaceId);
      if (!result.ok) return c.json({ error: result.error }, 500);
      return c.body(null, 204);
    },
  )
  // ─── GET LATEST ─────────────────────────────────────────────────────────────
  .get(
    "/:namespace/:name",
    zValidator("param", NamespacedParams),
    zValidator("query", IncludeQuery),
    async (c) => {
      const { namespace, name } = c.req.valid("param");
      const { include } = c.req.valid("query");
      const result = await SkillStorage.get(namespace, name);
      if (!result.ok) return c.json({ error: result.error }, 500);
      if (!result.data) return c.json({ error: "Skill not found" }, 404);

      if (include === "archive") {
        return serveArchive(result.data.archive, namespace, name, result.data.version);
      }

      const { archive: _, ...skill } = result.data;
      return c.json({ skill });
    },
  )
  // ─── LIST VERSIONS (must be before /:version to avoid conflict) ─────────────
  .get("/:namespace/:name/versions", zValidator("param", NamespacedParams), async (c) => {
    const { namespace, name } = c.req.valid("param");
    const result = await SkillStorage.listVersions(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ versions: result.data });
  })
  // ─── LIST ARCHIVE FILES ────────────────────────────────────────────────────
  .get("/:namespace/:name/files", zValidator("param", NamespacedParams), async (c) => {
    const { namespace, name } = c.req.valid("param");
    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);

    if (!result.data.archive) return c.json({ files: [] });

    const files = await listArchiveFiles(result.data.archive);
    return c.json({ files });
  })
  // ─── GET ARCHIVE FILE CONTENT ─────────────────────────────────────────────
  .get("/:namespace/:name/files/*", async (c) => {
    const params = NamespacedParams.safeParse({
      namespace: c.req.param("namespace"),
      name: c.req.param("name"),
    });
    if (!params.success) return c.json({ error: params.error.message }, 400);
    const { namespace, name } = params.data;

    // Wildcard params aren't accessible via c.req.param() in Hono v4 —
    // extract file path from URL after the /files/ segment.
    const urlPath = new URL(c.req.url).pathname;
    const marker = "/files/";
    const markerIdx = urlPath.indexOf(marker);
    const filePath = markerIdx >= 0 ? urlPath.slice(markerIdx + marker.length) : "";
    if (!filePath || filePath.startsWith("/") || filePath.includes("..")) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);
    if (!result.data.archive) return c.json({ error: "No archive available" }, 404);

    const content = await readArchiveFile(result.data.archive, filePath);
    if (content === null) return c.json({ error: "File not found in archive" }, 404);

    return c.json({ path: filePath, content });
  })
  // ─── UPDATE ARCHIVE FILE CONTENT ───────────────────────────────────────────
  .put("/:namespace/:name/files/*", async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const params = NamespacedParams.safeParse({
      namespace: c.req.param("namespace"),
      name: c.req.param("name"),
    });
    if (!params.success) return c.json({ error: params.error.message }, 400);
    const { namespace, name } = params.data;

    const urlPath = new URL(c.req.url).pathname;
    const marker = "/files/";
    const markerIdx = urlPath.indexOf(marker);
    const filePath = markerIdx >= 0 ? urlPath.slice(markerIdx + marker.length) : "";
    if (!filePath || filePath.startsWith("/") || filePath.includes("..")) {
      return c.json({ error: "Invalid file path" }, 400);
    }

    const body = await c.req.json<{ content: string }>();
    if (typeof body.content !== "string") {
      return c.json({ error: "content field is required" }, 400);
    }

    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);
    if (!result.data.archive) return c.json({ error: "No archive available" }, 404);

    // Extract archive, update file, repack
    const { Buffer } = await import("node:buffer");
    const extractDir = await extractSkillArchive(Buffer.from(result.data.archive));
    try {
      const targetPath = join(extractDir, filePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, body.content, "utf-8");
      const newArchive = await packSkillArchive(extractDir);

      const publishResult = await SkillStorage.publish(namespace, name, auth.userId, {
        description: result.data.description,
        instructions: result.data.instructions,
        frontmatter: result.data.frontmatter,
        archive: new Uint8Array(newArchive),
        skillId: result.data.skillId,
        descriptionManual: result.data.descriptionManual,
      });

      if (!publishResult.ok) return c.json({ error: publishResult.error }, 500);
      invalidateLintCache(publishResult.data.skillId);
      return c.json({ path: filePath, version: publishResult.data.version });
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  })
  // ─── GET SPECIFIC VERSION ──────────────────────────────────────────────────
  .get(
    "/:namespace/:name/:version",
    zValidator("param", VersionedParams),
    zValidator("query", IncludeQuery),
    async (c) => {
      const { namespace, name, version } = c.req.valid("param");
      const { include } = c.req.valid("query");
      const result = await SkillStorage.get(namespace, name, version);
      if (!result.ok) return c.json({ error: result.error }, 500);
      if (!result.data) return c.json({ error: "Skill not found" }, 404);

      if (include === "archive") {
        return serveArchive(result.data.archive, namespace, name, result.data.version);
      }

      const { archive: _, ...skill } = result.data;
      return c.json({ skill });
    },
  )
  // ─── PUBLISH (JSON) ──────────────────────────────────────────────────────
  .post(
    "/:namespace/:name",
    zValidator("param", NamespacedParams),
    zValidator("json", PublishSkillInputSchema),
    async (c) => {
      const auth = await requireUser();
      if (!auth.ok) return c.json({ error: auth.error }, 401);

      const { namespace, name } = c.req.valid("param");
      const input = c.req.valid("json");

      // Validate references against the text files that will actually be
      // extracted to the sandbox — not the full archive (which includes binaries
      // that won't be available at runtime).
      if (input.instructions) {
        const existing = await SkillStorage.get(namespace, name);
        if (existing.ok && existing.data?.archive) {
          const extractedFiles = await extractArchiveContents(
            new Uint8Array(existing.data.archive),
          );
          const deadLinks = validateSkillReferences(
            input.instructions,
            Object.keys(extractedFiles),
          );
          if (deadLinks.length > 0) {
            return c.json(
              {
                error: `Skill instructions reference files not found in archive: ${deadLinks.join(", ")}`,
                deadLinks,
              },
              400,
            );
          }
        }
      }

      // Full-pass lint before persisting — returns warnings (non-blocking)
      // and errors (blocking) based on agentskills.io + Anthropic rules.
      // Reference-depth and broken-link checks need the extracted archive;
      // re-use the just-extracted map if we have it, else skip depth checks.
      let archiveContents: Record<string, string> | undefined;
      if (input.instructions) {
        const existing = await SkillStorage.get(namespace, name);
        if (existing.ok && existing.data?.archive) {
          archiveContents = await extractArchiveContents(new Uint8Array(existing.data.archive));
        }
      }
      const lint = lintSkill(
        {
          name,
          frontmatter: input.frontmatter ?? {},
          instructions: input.instructions,
          archiveFiles: archiveContents ? Object.keys(archiveContents) : undefined,
          archiveContents,
        },
        "publish",
      );
      if (lint.errors.length > 0) {
        return c.json({ error: "Skill failed lint", lintErrors: lint.errors }, 400);
      }

      const result = await SkillStorage.publish(namespace, name, auth.userId, input);
      if (!result.ok) return c.json({ error: result.error }, 500);
      invalidateLintCache(result.data.skillId);
      return c.json(
        {
          published: {
            id: result.data.id,
            skillId: result.data.skillId,
            namespace,
            name: result.data.name,
            version: result.data.version,
          },
          lintWarnings: lint.warnings,
        },
        201,
      );
    },
  )
  // ─── PUBLISH (multipart) ────────────────────────────────────────────────
  .post("/:namespace/:name/upload", zValidator("param", NamespacedParams), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { namespace, name } = c.req.valid("param");
    const formData = await c.req.formData();
    const file = formData.get("archive");
    const descriptionField = formData.get("description")?.toString();

    if (!(file instanceof File)) {
      return c.json({ error: "archive field is required and must be a File" }, 400);
    }

    const archiveBytes = new Uint8Array(await file.arrayBuffer());

    // Parse SKILL.md from archive if present, or use metadata fields
    let description = descriptionField ?? "";
    let instructions = formData.get("instructions")?.toString() ?? "";
    let frontmatter: Record<string, unknown> = {};

    // If a skillMd field is provided, parse it for frontmatter + instructions
    const skillMdField = formData.get("skillMd")?.toString();
    if (skillMdField) {
      const parsed = parseSkillMd(skillMdField);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      frontmatter = parsed.data.frontmatter;
      instructions = parsed.data.instructions;
      if (parsed.data.frontmatter.name && parsed.data.frontmatter.name !== name) {
        return c.json(
          {
            error: `Skill name "${parsed.data.frontmatter.name}" in SKILL.md frontmatter does not match URL name "${name}"`,
          },
          400,
        );
      }
      if (!description && parsed.data.frontmatter.description) {
        description = String(parsed.data.frontmatter.description);
      }
    }

    if (!description) {
      return c.json(
        { error: "description is required (via form field or SKILL.md frontmatter)" },
        400,
      );
    }
    if (!instructions) {
      return c.json(
        { error: "instructions is required (via form field or SKILL.md skillMd field)" },
        400,
      );
    }

    // Validate against text files that will actually be extracted to the sandbox
    // (not the full archive — binaries won't be available at runtime)
    const extractedFiles = await extractArchiveContents(archiveBytes);
    const deadLinks = validateSkillReferences(instructions, Object.keys(extractedFiles));
    if (deadLinks.length > 0) {
      return c.json(
        {
          error: `Skill instructions reference files not found in archive: ${deadLinks.join(", ")}`,
          deadLinks,
        },
        400,
      );
    }

    const input = PublishSkillInputSchema.safeParse({
      description,
      instructions,
      frontmatter,
      archive: archiveBytes,
    });
    if (!input.success) return c.json({ error: input.error.message }, 400);

    const result = await SkillStorage.publish(namespace, name, auth.userId, input.data);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json(
      {
        published: {
          id: result.data.id,
          skillId: result.data.skillId,
          namespace,
          name: result.data.name,
          version: result.data.version,
        },
      },
      201,
    );
  })
  // ─── DELETE VERSION ────────────────────────────────────────────────────────
  .delete("/:namespace/:name/:version", zValidator("param", VersionedParams), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { namespace, name, version } = c.req.valid("param");
    const result = await SkillStorage.deleteVersion(namespace, name, version);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ success: true });
  })
  // ─── GET BY SKILL ID ────────────────────────────────────────────────────────
  .get("/:skillId", zValidator("param", SkillIdParam), async (c) => {
    const { skillId } = c.req.valid("param");
    const result = await SkillStorage.getBySkillId(skillId);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);

    const { archive: _, ...skill } = result.data;
    return c.json({ skill });
  })
  // ─── DISABLE / ENABLE ──────────────────────────────────────────────────────
  .patch(
    "/:skillId/disable",
    zValidator("param", SkillIdParam),
    zValidator("json", z.object({ disabled: z.boolean() })),
    async (c) => {
      // Single-tenant: auth check is sufficient. Add createdBy ownership check if multi-tenant.
      const auth = await requireUser();
      if (!auth.ok) return c.json({ error: auth.error }, 401);

      const { skillId } = c.req.valid("param");
      const { disabled } = c.req.valid("json");
      const result = await SkillStorage.setDisabled(skillId, disabled);
      if (!result.ok) return c.json({ error: result.error }, 500);
      invalidateLintCache(skillId);
      return c.json({ success: true });
    },
  )
  // ─── DELETE SKILL (all versions) ─────────────────────────────────────────
  .delete("/:skillId", zValidator("param", SkillIdParam), async (c) => {
    // Single-tenant: auth check is sufficient. Add createdBy ownership check if multi-tenant.
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { skillId } = c.req.valid("param");
    const result = await SkillStorage.deleteSkill(skillId);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ success: true });
  });

// ==============================================================================
// Helpers
// ==============================================================================

function serveArchive(
  archive: Uint8Array | null,
  namespace: string,
  name: string,
  version: number,
): Response {
  if (!archive) {
    return Response.json({ error: "No archive available for this skill" }, { status: 404 });
  }
  const body = new Uint8Array(archive);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="@${namespace}-${name}-v${version}.tar.gz"`,
      "Content-Length": String(body.byteLength),
    },
  });
}

export type SkillsRoutes = typeof skillsRoutes;
