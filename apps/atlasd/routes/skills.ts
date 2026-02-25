import { NamespaceSchema, RESERVED_WORDS, SkillNameSchema } from "@atlas/config";
import { parseSkillMd, SkillStorage } from "@atlas/skills";
import { PublishSkillInputSchema } from "@atlas/skills/schemas";
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

const ListQuery = z.object({ namespace: NamespaceSchema.optional(), query: z.string().optional() });

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
    const { namespace, query } = c.req.valid("query");
    const result = await SkillStorage.list(namespace, query);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ skills: result.data });
  })

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

  // ─── PUBLISH ───────────────────────────────────────────────────────────────
  .post("/:namespace/:name", zValidator("param", NamespacedParams), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { namespace, name } = c.req.valid("param");
    const contentType = c.req.header("content-type") ?? "";

    // Multipart: tarball upload with optional metadata
    if (contentType.includes("multipart/form-data")) {
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

      const input = PublishSkillInputSchema.safeParse({
        description,
        instructions,
        frontmatter,
        archive: archiveBytes,
      });
      if (!input.success) return c.json({ error: input.error.message }, 400);

      const result = await SkillStorage.publish(namespace, name, auth.userId, input.data);
      if (!result.ok) return c.json({ error: result.error }, 500);
      return c.json({ published: { namespace, name, version: result.data.version } }, 201);
    }

    // JSON body: text-only skill (no archive)
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Request body must be JSON or multipart/form-data" }, 400);

    const input = PublishSkillInputSchema.safeParse(body);
    if (!input.success) return c.json({ error: input.error.message }, 400);

    const result = await SkillStorage.publish(namespace, name, auth.userId, input.data);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ published: { namespace, name, version: result.data.version } }, 201);
  })

  // ─── DELETE VERSION ────────────────────────────────────────────────────────
  .delete("/:namespace/:name/:version", zValidator("param", VersionedParams), async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { namespace, name, version } = c.req.valid("param");
    const result = await SkillStorage.deleteVersion(namespace, name, version);
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
