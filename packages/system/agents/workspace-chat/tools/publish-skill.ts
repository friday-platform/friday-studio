import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AtlasTools } from "@atlas/agent-sdk";
import { NamespaceSchema, SkillNameSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { packSkillArchive, writeSkillFiles } from "@atlas/skills/archive";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import { tool } from "ai";
import { z } from "zod";

const PublishSkillInput = z.object({
  namespace: NamespaceSchema.describe("kebab-case, no @ prefix; 'friday' is reserved"),
  name: SkillNameSchema.describe("skill name from SKILL.md frontmatter"),
  content: z.string().describe("full SKILL.md content, including frontmatter"),
  files: z
    .array(
      z.object({
        path: z.string().describe("relative support file path; must not be SKILL.md"),
        content: z.string(),
      }),
    )
    .optional(),
});

const PublishSkillErrorResponse = z.object({
  error: z.string().optional(),
  deadLinks: z.array(z.string()).optional(),
});

const PublishSkillSuccessResponse = z.object({
  published: z.object({ skillId: z.string(), version: z.number().int().positive() }),
});

async function readResponseBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text();
  if (!text.trim()) return { text, json: undefined };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/**
 * Publishes a skill to the daemon's skill upload endpoint.
 *
 * Builds a SKILL.md-only tarball in a tmpdir, packs it via `packSkillArchive`,
 * and POSTs a multipart form (`archive` + `skillMd`) to
 * `/api/skills/@{namespace}/{name}/upload`. Returns a structured success result
 * on 201.
 */
export function createPublishSkillTool(logger: Logger): AtlasTools {
  const daemonUrl = getAtlasDaemonUrl();

  return {
    publish_skill: tool({
      description:
        "Publish a new skill (or new version of an existing skill) to the global catalog. " +
        "Auto-bumps version on existing names. " +
        "After publishing, call assign_workspace_skill to make it visible in this workspace.",
      inputSchema: PublishSkillInput,
      execute: async ({ namespace, name, content, files }) => {
        const tmpDir = makeTempDir({ prefix: "atlas-publish-skill-" });
        try {
          await writeFile(join(tmpDir, "SKILL.md"), content);
          await writeSkillFiles(tmpDir, files ?? []);
          const archive = await packSkillArchive(tmpDir);

          const formData = new FormData();
          const archiveFile = new File([new Uint8Array(archive)], `${name}.tar.gz`, {
            type: "application/gzip",
          });
          formData.append("archive", archiveFile);
          formData.append("skillMd", content);

          const url = `${daemonUrl}/api/skills/@${namespace}/${name}/upload`;
          let res: Response;
          try {
            res = await fetch(url, { method: "POST", body: formData });
          } catch (err) {
            logger.error("publish_skill fetch failed", {
              namespace,
              name,
              error: stringifyError(err),
            });
            return { success: false as const, error: "publish_skill failed: network error" };
          }

          const { text, json } = await readResponseBody(res);
          if (!res.ok) {
            const body = PublishSkillErrorResponse.safeParse(json);
            const error =
              body.data?.error ??
              `publish_skill failed with status ${res.status}${text ? `: ${text}` : ""}`;
            logger.warn("publish_skill failed", { namespace, name, status: res.status, error });
            if (body.success && body.data.deadLinks && body.data.deadLinks.length > 0) {
              return { success: false as const, error, deadLinks: body.data.deadLinks };
            }
            return { success: false as const, error };
          }

          const body = PublishSkillSuccessResponse.safeParse(json);
          if (!body.success) {
            const error = `publish_skill returned invalid response: ${body.error.message}`;
            logger.warn("publish_skill returned invalid response", { namespace, name, error });
            return { success: false as const, error };
          }

          logger.info("publish_skill succeeded", { namespace, name });
          return {
            success: true as const,
            skill: {
              ref: `@${namespace}/${name}`,
              skillId: body.data.published.skillId,
              version: body.data.published.version,
            },
          };
        } catch (err) {
          const error = `publish_skill failed: ${stringifyError(err)}`;
          logger.error("publish_skill failed before upload", { namespace, name, error });
          return { success: false as const, error };
        } finally {
          await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
            logger.debug("publish_skill cleanup failed", { error: stringifyError(e) }),
          );
        }
      },
    }),
  };
}
