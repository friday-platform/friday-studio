import { Buffer } from "node:buffer";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { NamespaceSchema, RESERVED_WORDS, SkillNameSchema } from "@atlas/config";
import {
  extractArchiveContents,
  extractSkillArchive,
  invalidateLintCache,
  isOfficialSource,
  lintSkill,
  listArchiveFiles,
  localAudit,
  packExportArchive,
  packSkillArchive,
  parseSkillMd,
  readArchiveFile,
  SkillStorage,
  SkillsShClient,
  validateSkillReferences,
} from "@atlas/skills";
import { PublishSkillInputSchema, SkillSortSchema } from "@atlas/skills/schemas";
import { makeTempDir } from "@atlas/utils/temp.server";
import { zValidator } from "@hono/zod-validator";
import { generateText } from "ai";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUser } from "./me/adapter.ts";

const skillsShClient = new SkillsShClient();

/** Opt-out flag. Install is enabled by default; set to "false" to kill. */
function remoteInstallEnabled(): boolean {
  return process.env.FRIDAY_ALLOW_REMOTE_SKILLS !== "false";
}

// ==============================================================================
// Param / query schemas
// ==============================================================================

/**
 * Route params use /:namespace/:name where namespace arrives as "@friday".
 * This schema strips the leading "@" and validates the remainder.
 */
const AtNamespaceParam = z
  .string()
  .regex(/^@[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Namespace must be @-prefixed kebab-case (e.g. @friday)",
  })
  .refine(
    (s) => {
      // Hyphen-segment match, same rule as packages/config/src/skills.ts.
      // Substring match falsely rejects legitimate namespaces like
      // `@anthropics-skills` because they contain `anthropic`.
      const segments = s.slice(1).split("-");
      return !RESERVED_WORDS.some((w) => segments.includes(w));
    },
    { message: `Must not contain reserved words: ${RESERVED_WORDS.join(", ")}` },
  )
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

/**
 * The `@friday/*` namespace is reserved for bundled system skills managed
 * by `ensureSystemSkills()` (Phase 6). Mutating them via HTTP requires
 * matching the bootstrap loader's sentinel user id — which interactive
 * callers never hold. Returns true when the caller should be rejected.
 */
async function listFilesRecursively(dir: string, base = ""): Promise<string[]> {
  const currentDir = base ? join(dir, base) : dir;
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(dir, relPath)));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function isFridayNamespaceBlockedForUser(namespace: string, userId: string): boolean {
  return namespace === "friday" && userId !== "system";
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
  // ─── SKILLS.SH SEARCH PROXY ────────────────────────────────────────────
  // Thin wrapper over SkillsShClient.search that stamps each entry with a
  // `tier` flag ("official" | "community") derived from the curated
  // OFFICIAL_ORGS set. Kept unauthenticated so the Browse modal can run
  // without token plumbing.
  .get(
    "/search",
    zValidator(
      "query",
      z.object({
        q: z.string().min(1),
        limit: z.coerce.number().int().positive().max(50).optional(),
      }),
    ),
    async (c) => {
      if (!remoteInstallEnabled()) {
        return c.json({ error: "Remote skill install is disabled" }, 403);
      }
      const { q, limit } = c.req.valid("query");
      try {
        const result = await skillsShClient.search(q, limit ?? 10);
        return c.json({
          query: result.query,
          count: result.count,
          durationMs: result.duration_ms,
          skills: result.skills.map((s) => ({
            ...s,
            tier: isOfficialSource(s.source) ? ("official" as const) : ("community" as const),
          })),
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    },
  )
  // ─── SKILLS.SH INSTALL ─────────────────────────────────────────────────
  // Downloads a skill from skills.sh, runs local-audit + publish-time
  // linter, and publishes under `@remote/<skillName>` (or a caller-chosen
  // namespace). Critical audit findings and lint errors block install;
  // warnings are returned in the response for the preview UI.
  .post(
    "/install",
    zValidator(
      "json",
      z.object({
        /** `owner/repo/slug` as accepted by skills.sh. */
        source: z.string().min(3),
        /** Optional workspace to auto-assign to after install. */
        workspaceId: z.string().optional(),
        /** Override the target namespace. Defaults to `<owner>-<repo>`. */
        targetNamespace: z.string().optional(),
      }),
    ),
    async (c) => {
      if (!remoteInstallEnabled()) {
        return c.json({ error: "Remote skill install is disabled" }, 403);
      }
      const auth = await requireUser();
      if (!auth.ok) return c.json({ error: auth.error }, 401);

      const { source, workspaceId, targetNamespace } = c.req.valid("json");
      const parts = source.split("/").filter((p) => p.length > 0);
      if (parts.length < 3) {
        return c.json({ error: "source must be owner/repo/slug" }, 400);
      }
      const [owner, repo, ...slugParts] = parts;
      if (!owner || !repo || slugParts.length === 0) {
        return c.json({ error: "source must be owner/repo/slug" }, 400);
      }
      const slug = slugParts.join("/");

      let downloaded: Awaited<ReturnType<typeof skillsShClient.download>>;
      try {
        downloaded = await skillsShClient.download(owner, repo, slug);
      } catch (err) {
        return c.json(
          {
            error: `skills.sh download failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          502,
        );
      }

      const skillMdFile = downloaded.files.find(
        (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
      );
      if (!skillMdFile) {
        return c.json({ error: "SKILL.md not found in downloaded archive" }, 400);
      }
      const parsed = parseSkillMd(skillMdFile.contents);
      if (!parsed.ok) {
        return c.json({ error: `SKILL.md parse failed: ${parsed.error}` }, 400);
      }

      const archiveMap: Record<string, string> = {};
      for (const f of downloaded.files) {
        if (f.path === "SKILL.md") continue;
        archiveMap[f.path] = f.contents;
      }
      const audit = localAudit({ skillMd: skillMdFile.contents, archiveFiles: archiveMap });
      if (audit.critical.length > 0) {
        return c.json(
          {
            error: "Local audit blocked install",
            auditCritical: audit.critical,
            auditWarn: audit.warn,
          },
          400,
        );
      }
      const sourceOfficial = isOfficialSource(`${owner}/${repo}`);

      const skillName = skillNameFromFrontmatter(parsed.data.frontmatter, slug);
      const description =
        typeof parsed.data.frontmatter.description === "string"
          ? parsed.data.frontmatter.description
          : "";
      // Default namespace encodes the skills.sh source as `<owner>-<repo>`
      // (kebab-case, the only format `NamespaceSchema` accepts). This makes
      // the skill's detail URL (`/skills/@ljagiello-ctf-skills/ctf-reverse`)
      // self-documenting — you can see the origin without opening
      // frontmatter. Callers can still override with `targetNamespace`.
      const defaultNs = `${owner}-${repo}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const namespace = targetNamespace ?? defaultNs;

      // Refuse to silently overwrite an already-installed skill. Without
      // this guard, `SkillStorage.publish` would reuse the existing
      // skill_id and bump the version — users expect a fresh import
      // starts at v1, and if they want the newest upstream content the
      // "Check for updates" flow on the detail page already handles
      // that and preserves history properly.
      {
        const existing = await SkillStorage.get(
          namespace,
          skillNameFromFrontmatter(parsed.data.frontmatter, slug),
        );
        if (existing.ok && existing.data) {
          return c.json(
            {
              error: `Skill @${namespace}/${existing.data.name} is already installed (v${String(existing.data.version)}). Use "Check for updates" on the skill page to pull a newer version, or delete it first to re-import fresh.`,
              alreadyInstalled: {
                namespace,
                name: existing.data.name,
                version: existing.data.version,
              },
            },
            409,
          );
        }
      }

      const tmpDir = makeTempDir({ prefix: "atlas-install-" });
      try {
        for (const file of downloaded.files) {
          if (file.path === "SKILL.md") continue;
          const fullPath = join(tmpDir, file.path);
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, file.contents, "utf-8");
        }
        const hasOtherFiles = downloaded.files.some((f) => f.path !== "SKILL.md");
        const archive = hasOtherFiles ? new Uint8Array(await packSkillArchive(tmpDir)) : undefined;

        const archiveFiles = downloaded.files.map((f) => f.path).filter((p) => p !== "SKILL.md");
        const lint = lintSkill(
          {
            name: skillName,
            frontmatter: parsed.data.frontmatter,
            instructions: parsed.data.instructions,
            archiveFiles,
            archiveContents: archiveMap,
          },
          "publish",
        );
        // Lint findings — including errors — no longer block install. The
        // user can review them on the skill detail page (via the lint
        // viewer) and fix them explicitly. The linter still runs so the
        // errors/warnings surface in the install response for clients
        // that want to show a summary.

        const frontmatter = {
          ...parsed.data.frontmatter,
          source: `skills.sh/${owner}/${repo}/${slug}`,
          "source-hash": downloaded.hash,
        };

        const published = await SkillStorage.publish(namespace, skillName, auth.userId, {
          description,
          instructions: parsed.data.instructions,
          frontmatter,
          archive,
        });
        if (!published.ok) return c.json({ error: published.error }, 500);
        invalidateLintCache(published.data.skillId);

        if (workspaceId !== undefined) {
          await SkillStorage.assignSkill(published.data.skillId, workspaceId);
        }

        return c.json(
          {
            published: {
              skillId: published.data.skillId,
              namespace,
              name: published.data.name,
              version: published.data.version,
            },
            tier: sourceOfficial ? "official" : "community",
            lintWarnings: lint.warnings,
            auditWarn: audit.warn,
            assignedTo: workspaceId ?? null,
          },
          201,
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  )
  // ─── FORK A @friday SKILL ───────────────────────────────────────────────
  // Users can't mutate `@friday/*` directly (guarded above), but they can
  // fork one into their own namespace and edit that copy. When the caller
  // passes `workspaceId` we atomically swap the assignment from the
  // original to the fork so the workspace doesn't end up loading both.
  .post(
    "/fork",
    zValidator(
      "json",
      z.object({
        namespace: z.string().min(1),
        name: z.string().min(1),
        /** Defaults to `user-forks`. Not validated beyond length because we
         *  hand it straight to `SkillStorage.publish` which re-validates. */
        targetNamespace: z.string().min(1).optional(),
        /** Optional new name. Defaults to the original name. */
        targetName: z.string().min(1).optional(),
        /** When provided, reassigns this workspace from the source to the fork. */
        workspaceId: z.string().min(1).optional(),
      }),
    ),
    async (c) => {
      const auth = await requireUser();
      if (!auth.ok) return c.json({ error: auth.error }, 401);

      const { namespace, name, targetNamespace, targetName, workspaceId } = c.req.valid("json");
      const source = await SkillStorage.get(namespace, name);
      if (!source.ok) return c.json({ error: source.error }, 500);
      if (!source.data) return c.json({ error: "Source skill not found" }, 404);

      const newNs = targetNamespace ?? "user-forks";
      const newName = targetName ?? name;
      if (isFridayNamespaceBlockedForUser(newNs, auth.userId)) {
        return c.json({ error: "Cannot fork into the @friday namespace" }, 403);
      }

      // Strip `source-hash` so the fork doesn't look like it came from a
      // repo-checked-in skill (which would confuse `ensureSystemSkills`
      // if the fork ever lands under @friday later).
      const { "source-hash": _sourceHash, ...forkedFrontmatter } = source.data.frontmatter;
      const forkedFrontmatterWithSource = {
        ...forkedFrontmatter,
        "forked-from": `@${namespace}/${name}@v${String(source.data.version)}`,
      };

      const published = await SkillStorage.publish(newNs, newName, auth.userId, {
        description: source.data.description,
        instructions: source.data.instructions,
        frontmatter: forkedFrontmatterWithSource,
        archive: source.data.archive ? new Uint8Array(source.data.archive) : undefined,
      });
      if (!published.ok) return c.json({ error: published.error }, 500);

      // Atomic-ish reassignment. If either step fails the caller sees the
      // partial outcome in the response (we don't auto-rollback the publish
      // — an orphan fork is less harmful than a partially-assigned skill).
      const reassignment: {
        unassignedFrom: string | null;
        assignedTo: string | null;
        error?: string;
      } = { unassignedFrom: null, assignedTo: null };
      if (workspaceId) {
        const unassignResult = await SkillStorage.unassignSkill(source.data.skillId, workspaceId);
        if (!unassignResult.ok) {
          reassignment.error = `Unassign from source failed: ${unassignResult.error}`;
        } else {
          reassignment.unassignedFrom = source.data.skillId;
        }
        const assignResult = await SkillStorage.assignSkill(published.data.skillId, workspaceId);
        if (!assignResult.ok) {
          reassignment.error =
            (reassignment.error ?? "") + ` Assign to fork failed: ${assignResult.error}`;
        } else {
          reassignment.assignedTo = published.data.skillId;
        }
      }
      invalidateLintCache(published.data.skillId);

      return c.json(
        {
          fork: {
            skillId: published.data.skillId,
            namespace: newNs,
            name: published.data.name,
            version: published.data.version,
            forkedFrom: {
              namespace,
              name,
              skillId: source.data.skillId,
              version: source.data.version,
            },
          },
          reassignment,
        },
        201,
      );
    },
  )
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
    // `workspaceIds` is DISTINCT across layers — the same workspace can have
    // both a workspace-level row and one or more job-level rows. Callers that
    // need the per-job breakdown should hit the job detail endpoint.
    return c.json({ workspaceIds: result.data });
  })
  .post(
    "/scoping/:skillId/assignments",
    zValidator("param", SkillIdParam),
    zValidator(
      "json",
      z.object({
        // Additive shape: each assignment targets either a workspace
        // (workspace-level, `jobName` absent) or a specific job inside it
        // (`jobName` present). Writes are idempotent at both layers.
        assignments: z
          .array(
            z.object({ workspaceId: z.string().min(1), jobName: z.string().min(1).optional() }),
          )
          .min(1),
      }),
    ),
    async (c) => {
      const { skillId } = c.req.valid("param");
      const { assignments } = c.req.valid("json");

      // Try every assignment independently. The caller learns exactly which
      // succeeded and which failed instead of stopping at the first error and
      // leaving partial state with no signal.
      const results = await Promise.all(
        assignments.map(async ({ workspaceId, jobName }) => {
          const result = jobName
            ? await SkillStorage.assignToJob(skillId, workspaceId, jobName)
            : await SkillStorage.assignSkill(skillId, workspaceId);
          return result.ok
            ? { workspaceId, jobName, ok: true as const }
            : { workspaceId, jobName, ok: false as const, error: result.error };
        }),
      );

      const assigned: { workspaceId: string; jobName?: string }[] = [];
      const failed: { workspaceId: string; jobName?: string; error: string }[] = [];
      for (const r of results) {
        if (r.ok) assigned.push({ workspaceId: r.workspaceId, jobName: r.jobName });
        else failed.push({ workspaceId: r.workspaceId, jobName: r.jobName, error: r.error });
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
  .delete(
    "/scoping/:skillId/assignments/:workspaceId/:jobName",
    zValidator(
      "param",
      z.object({
        skillId: z.string().min(1),
        workspaceId: z.string().min(1),
        jobName: z.string().min(1),
      }),
    ),
    async (c) => {
      const { skillId, workspaceId, jobName } = c.req.valid("param");
      const result = await SkillStorage.unassignFromJob(skillId, workspaceId, jobName);
      if (!result.ok) return c.json({ error: result.error }, 500);
      return c.body(null, 204);
    },
  )
  // ─── IMPORT FROM EXPORTED TAR.GZ ────────────────────────────────────────────
  // Inverse of GET /:namespace/:name/export. Accepts a self-contained tar.gz
  // (SKILL.md at root + reference files) and publishes it. Namespace comes
  // from `?namespace=` if provided, otherwise the `@<ns>/<name>` prefix in
  // SKILL.md frontmatter. When neither yields a namespace, returns 400 with
  // `needsNamespace: true` so the caller can prompt and re-POST.
  // Must be registered before /:namespace/... so Hono doesn't match
  // "import-archive" as a namespace param.
  .post("/import-archive", async (c) => {
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const formData = await c.req.formData();
    const file = formData.get("archive");
    if (!(file instanceof File)) {
      return c.json({ error: "archive field is required and must be a File" }, 400);
    }

    const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_IMPORT_SIZE) {
      return c.json({ error: "Archive exceeds 50 MB limit" }, 413);
    }

    const archiveBytes = new Uint8Array(await file.arrayBuffer());

    // Extract to temp dir — preserves binary fidelity and filters unsafe paths.
    const extractedDir = await extractSkillArchive(Buffer.from(archiveBytes), "atlas-import-");
    try {
      const skillMdPath = join(extractedDir, "SKILL.md");
      let skillMdContent: string;
      try {
        skillMdContent = await readFile(skillMdPath, "utf-8");
      } catch {
        return c.json({ error: "Archive must contain SKILL.md at root" }, 400);
      }

      const parsed = parseSkillMd(skillMdContent);
      if (!parsed.ok) return c.json({ error: `SKILL.md parse failed: ${parsed.error}` }, 400);
      const { frontmatter, instructions } = parsed.data;

      // Derive (namespace, name). Query params win; otherwise split `@ns/name`
      // from frontmatter. The bare name (after the slash, or whole string when
      // no slash) is always taken from frontmatter.
      const fmName = typeof frontmatter.name === "string" ? frontmatter.name : "";
      const queryNs = c.req.query("namespace");
      const queryName = c.req.query("name");
      let namespace: string | undefined;
      let name: string;
      if (fmName.startsWith("@") && fmName.includes("/")) {
        const slash = fmName.indexOf("/");
        namespace = fmName.slice(1, slash);
        name = fmName.slice(slash + 1);
      } else {
        name = fmName;
      }
      if (queryNs) namespace = queryNs;
      if (queryName) name = queryName;

      if (!name) {
        return c.json({ error: "SKILL.md frontmatter must include a `name` field" }, 400);
      }
      if (!namespace) {
        return c.json(
          {
            error:
              "SKILL.md frontmatter has no namespace. Re-upload with ?namespace=<ns> to choose one.",
            needsNamespace: true,
            defaultName: name,
          },
          400,
        );
      }

      const nsCheck = NamespaceSchema.safeParse(namespace);
      if (!nsCheck.success) {
        return c.json({ error: `Invalid namespace: ${nsCheck.error.message}` }, 400);
      }
      const nameCheck = SkillNameSchema.safeParse(name);
      if (!nameCheck.success) {
        return c.json({ error: `Invalid skill name: ${nameCheck.error.message}` }, 400);
      }

      if (isFridayNamespaceBlockedForUser(namespace, auth.userId)) {
        return c.json({ error: "The @friday namespace is reserved for bundled system skills" }, 403);
      }

      // Collect file paths (excluding SKILL.md) for dead-link validation.
      const archiveFiles = (await listFilesRecursively(extractedDir)).filter(
        (p) => p !== "SKILL.md",
      );
      const deadLinks = validateSkillReferences(instructions, archiveFiles);
      if (deadLinks.length > 0) {
        return c.json(
          {
            error: `Skill instructions reference files not found in archive: ${deadLinks.join(", ")}`,
            deadLinks,
          },
          400,
        );
      }

      // Remove SKILL.md before packing the rest into a storage-format archive.
      await rm(skillMdPath, { force: true });

      let storageArchive: Uint8Array | undefined;
      if (archiveFiles.length > 0) {
        storageArchive = new Uint8Array(await packSkillArchive(extractedDir));
      }

      const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

      const input = PublishSkillInputSchema.safeParse({
        description,
        instructions,
        frontmatter,
        archive: storageArchive,
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
    } finally {
      await rm(extractedDir, { recursive: true, force: true }).catch(() => {});
    }
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
  // ─── EXPORT AS SELF-CONTAINED TAR.GZ ───────────────────────────────────────
  // Reconstructs SKILL.md from frontmatter + instructions and packs it
  // alongside any reference files from the stored archive. The result is a
  // single tar.gz the user can download, share, or re-import.
  // Must be registered before /:version to avoid Hono matching "export" as a version.
  .get("/:namespace/:name/export", zValidator("param", NamespacedParams), async (c) => {
    const { namespace, name } = c.req.valid("param");
    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);

    const bytes = await packExportArchive({
      instructions: result.data.instructions,
      frontmatter: result.data.frontmatter,
      archive: result.data.archive,
    });
    const body = new Uint8Array(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="@${namespace.replace(/["\r\n\0]/g, "")}-${name.replace(/["\r\n\0]/g, "")}-v${String(result.data.version)}.tar.gz"`,
        "Content-Length": String(body.byteLength),
      },
    });
  })
  // ─── AUTO-FIX A LINT FINDING ───────────────────────────────────────────────
  // Applies a one-shot fix for a single lint rule. Deterministic rules
  // (path-style, backslash-to-forward) run as plain string transforms.
  // Judgment-heavy rules (description wording, missing trigger clause) go
  // through the platform `classifier` LLM with a strict prompt that only
  // asks for the minimal rewrite of the affected field. The returned body
  // is published as a new version — history is never rewound.
  .post(
    "/:namespace/:name/autofix",
    zValidator("param", NamespacedParams),
    zValidator(
      "json",
      z.object({
        rule: z.string().min(1),
        /** When true, compute the fix but don't publish. UI can preview. */
        dryRun: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const auth = await requireUser();
      if (!auth.ok) return c.json({ error: auth.error }, 401);
      const { namespace, name } = c.req.valid("param");
      const { rule, dryRun } = c.req.valid("json");
      const existing = await SkillStorage.get(namespace, name);
      if (!existing.ok) return c.json({ error: existing.error }, 500);
      if (!existing.data) return c.json({ error: "Skill not found" }, 404);
      const skill = existing.data;

      const fix = await computeAutofix({
        rule,
        skill: {
          name,
          description: skill.description,
          instructions: skill.instructions,
          frontmatter: skill.frontmatter,
        },
        platformModels: c.get("app").platformModels,
      });
      if (!fix.ok) return c.json({ error: fix.error }, fix.status ?? 400);

      if (dryRun) {
        return c.json({
          rule,
          before: { description: skill.description, instructions: skill.instructions },
          after: { description: fix.description, instructions: fix.instructions },
          fixedBy: fix.fixedBy,
        });
      }

      const frontmatter = { ...skill.frontmatter, description: fix.description };
      const published = await SkillStorage.publish(namespace, name, auth.userId, {
        description: fix.description,
        instructions: fix.instructions,
        frontmatter,
        archive: skill.archive ?? undefined,
        skillId: skill.skillId,
        descriptionManual: skill.descriptionManual,
      });
      if (!published.ok) return c.json({ error: published.error }, 500);
      invalidateLintCache(published.data.skillId);

      return c.json({
        rule,
        fixedBy: fix.fixedBy,
        published: {
          skillId: published.data.skillId,
          namespace,
          name: published.data.name,
          version: published.data.version,
        },
      });
    },
  )
  // ─── LINT A PUBLISHED SKILL ────────────────────────────────────────────────
  // Re-runs the publish-time linter against the current stored version so
  // the UI can surface warnings/errors without re-uploading. Kept GET so the
  // detail page can issue it alongside the catalog query.
  .get("/:namespace/:name/lint", zValidator("param", NamespacedParams), async (c) => {
    const { namespace, name } = c.req.valid("param");
    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);
    const skill = result.data;
    const archiveMap: Record<string, string> = {};
    const archiveFiles: string[] = [];
    if (skill.archive) {
      const extracted = await extractArchiveContents(skill.archive);
      for (const [path, contents] of Object.entries(extracted)) {
        if (path === "SKILL.md") continue;
        archiveFiles.push(path);
        archiveMap[path] = contents;
      }
    }
    const lint = lintSkill(
      {
        name,
        frontmatter: skill.frontmatter,
        instructions: skill.instructions,
        archiveFiles,
        archiveContents: archiveMap,
      },
      "publish",
    );
    return c.json(lint);
  })
  // ─── CHECK UPSTREAM FOR UPDATE ─────────────────────────────────────────────
  // Probes skills.sh for a newer archive of a remotely-installed skill by
  // re-downloading and comparing the SHA-256 to the stored `source-hash`.
  // Returns 200 with `hasUpdate=false` for locally-authored skills so the
  // client can render a consistent "up to date" state without branching.
  .get("/:namespace/:name/check-update", zValidator("param", NamespacedParams), async (c) => {
    const { namespace, name } = c.req.valid("param");
    const result = await SkillStorage.get(namespace, name);
    if (!result.ok) return c.json({ error: result.error }, 500);
    if (!result.data) return c.json({ error: "Skill not found" }, 404);
    const fm = result.data.frontmatter as Record<string, unknown>;
    const source = typeof fm.source === "string" ? fm.source : undefined;
    const localHash = typeof fm["source-hash"] === "string" ? fm["source-hash"] : undefined;
    if (!source || !source.startsWith("skills.sh/")) {
      return c.json({ hasUpdate: false, remote: null, source: source ?? null, localHash: null });
    }
    const parts = source
      .slice("skills.sh/".length)
      .split("/")
      .filter((p) => p.length > 0);
    if (parts.length < 3) {
      return c.json({ error: "Malformed skills.sh source in frontmatter" }, 400);
    }
    const [owner, repo, ...slugParts] = parts;
    if (!owner || !repo || slugParts.length === 0) {
      return c.json({ error: "Malformed skills.sh source in frontmatter" }, 400);
    }
    const slug = slugParts.join("/");
    let downloaded: Awaited<ReturnType<typeof skillsShClient.download>>;
    try {
      downloaded = await skillsShClient.download(owner, repo, slug);
    } catch (err) {
      return c.json(
        { error: `skills.sh download failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }
    return c.json({
      hasUpdate: downloaded.hash !== localHash,
      source,
      localHash: localHash ?? null,
      remote: { hash: downloaded.hash },
    });
  })
  // ─── PULL UPDATE FROM UPSTREAM ─────────────────────────────────────────────
  // Re-downloads the skill from skills.sh and publishes it under the existing
  // namespace/name, bumping the version. Only valid for remotely-installed
  // skills; locally-authored skills have no upstream to pull from.
  .post("/:namespace/:name/update", zValidator("param", NamespacedParams), async (c) => {
    if (!remoteInstallEnabled()) {
      return c.json({ error: "Remote skill install is disabled" }, 403);
    }
    const auth = await requireUser();
    if (!auth.ok) return c.json({ error: auth.error }, 401);

    const { namespace, name } = c.req.valid("param");
    const existing = await SkillStorage.get(namespace, name);
    if (!existing.ok) return c.json({ error: existing.error }, 500);
    if (!existing.data) return c.json({ error: "Skill not found" }, 404);

    const fm = existing.data.frontmatter as Record<string, unknown>;
    const source = typeof fm.source === "string" ? fm.source : undefined;
    if (!source || !source.startsWith("skills.sh/")) {
      return c.json({ error: "Skill has no skills.sh source — nothing to update" }, 400);
    }
    const parts = source
      .slice("skills.sh/".length)
      .split("/")
      .filter((p) => p.length > 0);
    const [owner, repo, ...slugParts] = parts;
    if (!owner || !repo || slugParts.length === 0) {
      return c.json({ error: "Malformed skills.sh source in frontmatter" }, 400);
    }
    const slug = slugParts.join("/");

    let downloaded: Awaited<ReturnType<typeof skillsShClient.download>>;
    try {
      downloaded = await skillsShClient.download(owner, repo, slug);
    } catch (err) {
      return c.json(
        { error: `skills.sh download failed: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }

    const skillMdFile = downloaded.files.find(
      (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
    );
    if (!skillMdFile) {
      return c.json({ error: "SKILL.md not found in downloaded archive" }, 400);
    }
    const parsed = parseSkillMd(skillMdFile.contents);
    if (!parsed.ok) {
      return c.json({ error: `SKILL.md parse failed: ${parsed.error}` }, 400);
    }

    const tmpDir = makeTempDir({ prefix: "atlas-update-" });
    try {
      for (const file of downloaded.files) {
        if (file.path === "SKILL.md") continue;
        const fullPath = join(tmpDir, file.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.contents, "utf-8");
      }
      const hasOtherFiles = downloaded.files.some((f) => f.path !== "SKILL.md");
      const archive = hasOtherFiles ? new Uint8Array(await packSkillArchive(tmpDir)) : undefined;

      const frontmatter = { ...parsed.data.frontmatter, source, "source-hash": downloaded.hash };
      const description =
        typeof parsed.data.frontmatter.description === "string"
          ? parsed.data.frontmatter.description
          : existing.data.description;

      const published = await SkillStorage.publish(namespace, name, auth.userId, {
        description,
        instructions: parsed.data.instructions,
        frontmatter,
        archive,
        skillId: existing.data.skillId,
      });
      if (!published.ok) return c.json({ error: published.error }, 500);
      invalidateLintCache(published.data.skillId);

      return c.json({
        updated: {
          skillId: published.data.skillId,
          namespace,
          name: published.data.name,
          version: published.data.version,
          sourceHash: downloaded.hash,
        },
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
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
    if (params.success && isFridayNamespaceBlockedForUser(params.data.namespace, auth.userId)) {
      return c.json({ error: "The @friday namespace is reserved for bundled system skills" }, 403);
    }
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
      if (isFridayNamespaceBlockedForUser(namespace, auth.userId)) {
        return c.json(
          { error: "The @friday namespace is reserved for bundled system skills" },
          403,
        );
      }
      const rawInput = c.req.valid("json");

      // Storage invariant: `instructions` is body-only, `frontmatter` is the
      // parsed YAML. Callers (the editor's Save button, the SKILL.md drop in
      // SkillLoader) often POST `instructions` containing an embedded
      // frontmatter block — split it here so the column gets populated and
      // the body stored without the YAML preamble. Explicit `input.frontmatter`
      // wins on key conflicts (it's the caller's deliberate signal).
      const parsedSkillMd = parseSkillMd(rawInput.instructions);
      const input = parsedSkillMd.ok
        ? {
            ...rawInput,
            instructions: parsedSkillMd.data.instructions,
            frontmatter: { ...parsedSkillMd.data.frontmatter, ...(rawInput.frontmatter ?? {}) },
          }
        : rawInput;

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
      // The linter reads `description` from frontmatter, but the publish API
      // accepts it as a sibling field — surface it so `description-missing`
      // doesn't fire when the caller provides one out-of-band.
      const lintFrontmatter = {
        ...(input.frontmatter ?? {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      const lint = lintSkill(
        {
          name,
          frontmatter: lintFrontmatter,
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
    if (isFridayNamespaceBlockedForUser(namespace, auth.userId)) {
      return c.json({ error: "The @friday namespace is reserved for bundled system skills" }, 403);
    }
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
    if (isFridayNamespaceBlockedForUser(namespace, auth.userId)) {
      return c.json({ error: "The @friday namespace is reserved for bundled system skills" }, 403);
    }
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

/**
 * Resolve the canonical skill `name` for a skills.sh install — prefers the
 * `name` field from SKILL.md frontmatter, otherwise derives from the URL
 * slug by replacing slashes with hyphens so it remains kebab-case-valid.
 */
function skillNameFromFrontmatter(frontmatter: Record<string, unknown>, slug: string): string {
  return typeof frontmatter.name === "string" ? frontmatter.name : slug.replace(/\//g, "-");
}

/** Rules fully resolvable by a local string transform — no LLM needed. */
const DETERMINISTIC_RULES = new Set(["path-style", "description-length"]);

interface AutofixInput {
  rule: string;
  skill: {
    name: string;
    description: string;
    instructions: string;
    frontmatter: Record<string, unknown>;
  };
  platformModels: import("@atlas/llm").PlatformModels;
}

type AutofixResult =
  | {
      ok: true;
      description: string;
      instructions: string;
      /** "deterministic" for string transforms, "llm" for model-driven rewrites. */
      fixedBy: "deterministic" | "llm";
    }
  | { ok: false; error: string; status?: 400 | 500 };

/**
 * Dispatch a lint finding to the right fix strategy. Deterministic fixes
 * run in-process (fast + predictable); everything else hits the platform
 * `classifier` model with a narrowly-scoped prompt.
 */
function computeAutofix(input: AutofixInput): Promise<AutofixResult> {
  if (DETERMINISTIC_RULES.has(input.rule)) {
    return Promise.resolve(deterministicFix(input));
  }
  return llmFix(input);
}

function deterministicFix(input: AutofixInput): AutofixResult {
  const { rule, skill } = input;
  switch (rule) {
    case "path-style": {
      // Replace Windows-style backslash paths with forward slashes, but
      // only outside fenced code blocks (anti-examples must stay intact).
      const fixed = replaceOutsideCode(skill.instructions, /\\/g, "/");
      return {
        ok: true,
        description: skill.description,
        instructions: fixed,
        fixedBy: "deterministic",
      };
    }
    case "description-length": {
      // Trim to 1024 chars on a word boundary, add ellipsis if truncated.
      const max = 1024;
      if (skill.description.length <= max) {
        return { ok: false, error: "Description is already within the limit", status: 400 };
      }
      const trimmed = skill.description.slice(0, max - 1).replace(/\s+\S*$/, "");
      return {
        ok: true,
        description: `${trimmed}…`,
        instructions: skill.instructions,
        fixedBy: "deterministic",
      };
    }
  }
  return { ok: false, error: `No deterministic fix registered for rule "${rule}"`, status: 400 };
}

/** Replace `pattern` in text, skipping fenced ``` code blocks. */
function replaceOutsideCode(text: string, pattern: RegExp, replacement: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((p) => (p.startsWith("```") ? p : p.replace(pattern, replacement))).join("");
}

/**
 * Cached instructions from `@friday/authoring-skills`. Prepended to every
 * LLM fix prompt so the model sees the agentskills.io + platform.claude.com
 * best-practices spec when it rewrites. Cached for the daemon's lifetime
 * since the skill's content rarely changes and the hot path is the lint
 * panel in the UI.
 */
let authoringSkillCache: { instructions: string; version: number } | null = null;

async function loadAuthoringSkillInstructions(): Promise<string | null> {
  if (authoringSkillCache !== null) return authoringSkillCache.instructions;
  const res = await SkillStorage.get("friday", "authoring-skills");
  if (!res.ok || !res.data) return null;
  authoringSkillCache = { instructions: res.data.instructions, version: res.data.version };
  return authoringSkillCache.instructions;
}

async function llmFix(input: AutofixInput): Promise<AutofixResult> {
  const { rule, skill, platformModels } = input;
  const authoringGuide = await loadAuthoringSkillInstructions();
  const prompt = buildFixPrompt(rule, skill, authoringGuide);
  try {
    const { text } = await generateText({
      model: platformModels.get("classifier"),
      prompt,
      maxOutputTokens: 600,
      abortSignal: AbortSignal.timeout(15_000),
    });
    const parsed = parseFixResponse(text);
    if (!parsed) {
      return {
        ok: false,
        error: "LLM returned an unparseable response — no fix applied.",
        status: 400,
      };
    }
    return {
      ok: true,
      description: parsed.description ?? skill.description,
      instructions: parsed.instructions ?? skill.instructions,
      fixedBy: "llm",
    };
  } catch (err) {
    return {
      ok: false,
      error: `LLM fix failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 500,
    };
  }
}

const FIX_PROMPTS: Record<string, string> = {
  "description-person":
    "Rewrite the DESCRIPTION in third person (no 'I', 'you', 'this skill'). Keep meaning and length similar. Return ONLY the rewritten description, nothing else.",
  "description-trigger":
    "Rewrite the DESCRIPTION to include a clear 'Use when …' trigger clause so an agent knows when to invoke this skill. Return ONLY the rewritten description.",
  "description-missing":
    "Write a concise third-person description for this skill in <= 1024 chars, including a 'Use when …' clause. Return ONLY the description text.",
  "first-person":
    "Rewrite the INSTRUCTIONS body to remove first/second-person phrasing. Preserve structure, code blocks, and examples verbatim. Return ONLY the rewritten instructions, inside <instructions>…</instructions> tags.",
  "time-sensitive":
    "Rewrite the INSTRUCTIONS body to remove time-sensitive phrasing ('before August 2025', etc.) — wrap any superseded content in a <details>Old patterns</details> block. Return ONLY the rewritten instructions, inside <instructions>…</instructions> tags.",
};

function buildFixPrompt(
  rule: string,
  skill: AutofixInput["skill"],
  authoringGuide: string | null,
): string {
  const ruleInstruction =
    FIX_PROMPTS[rule] ??
    `The lint rule is "${rule}". Rewrite the minimum content needed to satisfy it. Return either the new description (plain text) or the new instructions wrapped in <instructions>…</instructions> tags.`;
  const guideSection = authoringGuide
    ? [
        `=== BEGIN AGENT-SKILLS AUTHORING GUIDE ===`,
        `Follow these rules. The current skill must end up conforming to them.`,
        ``,
        authoringGuide,
        `=== END AGENT-SKILLS AUTHORING GUIDE ===`,
        ``,
      ]
    : [];
  return [
    ...guideSection,
    `You are fixing a single lint issue in an Agent Skill.`,
    `Rule to fix: ${rule}`,
    ``,
    `Current description:`,
    skill.description || "(empty)",
    ``,
    `Current instructions (first 2000 chars):`,
    skill.instructions.slice(0, 2000),
    ``,
    `Task:`,
    ruleInstruction,
  ].join("\n");
}

/**
 * The model returns either:
 *   - a plain line of text (description fix), or
 *   - `<instructions>…</instructions>` block (body fix).
 * Anything else yields `null` so the caller can error out safely.
 */
function parseFixResponse(text: string): { description?: string; instructions?: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/<instructions>([\s\S]*?)<\/instructions>/);
  if (match) return { instructions: match[1]?.trim() ?? "" };
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  return { description: trimmed };
}

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
