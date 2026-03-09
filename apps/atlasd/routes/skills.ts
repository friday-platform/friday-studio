import { NamespaceSchema, RESERVED_WORDS, SkillNameSchema } from "@atlas/config";
import { smallLLM } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { parseSkillMd, SkillStorage } from "@atlas/skills";
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

      // Auto-generate description when not manually set
      if (!input.descriptionManual && !input.instructions) {
        input.description = "";
      } else if (!input.descriptionManual && input.instructions) {
        try {
          const generated = await smallLLM({
            system:
              'Write a skill description under 1024 characters. Start with what it does (verb-led), then add "Use when..." with specific keywords that help agents match tasks to this skill. Never say "this skill" — that\'s assumed. Output only the description, nothing else.',
            prompt: input.instructions,
            maxOutputTokens: 250,
          });
          input.description = generated.trim();
        } catch {
          logger.warn("Auto-description generation failed, proceeding without");
        }
      }

      const result = await SkillStorage.publish(namespace, name, auth.userId, input);
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
