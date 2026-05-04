import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { packSkillArchive } from "@atlas/skills/archive";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import { tool } from "ai";
import { z } from "zod";

const PublishSkillInput = z.object({
  namespace: z.string().describe("kebab-case, no @ prefix; 'friday' is reserved"),
  name: z.string(),
  content: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
});

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
          for (const entry of files ?? []) {
            const target = join(tmpDir, entry.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, entry.content);
          }
          const archive = await packSkillArchive(tmpDir);

          const formData = new FormData();
          const archiveFile = new File([new Uint8Array(archive)], `${name}.tar.gz`, {
            type: "application/gzip",
          });
          formData.append("archive", archiveFile);
          formData.append("skillMd", content);

          const url = `${daemonUrl}/api/skills/@${namespace}/${name}/upload`;
          const res = await fetch(url, { method: "POST", body: formData });
          if (!res.ok) {
            const body = (await res.json()) as unknown;
            const error =
              typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
                ? (body as { error: string }).error
                : `publish_skill failed with status ${res.status}`;
            const rawDeadLinks =
              typeof body === "object" && body !== null
                ? (body as { deadLinks?: unknown }).deadLinks
                : undefined;
            const deadLinks =
              Array.isArray(rawDeadLinks) && rawDeadLinks.every((v) => typeof v === "string")
                ? (rawDeadLinks as string[])
                : undefined;
            logger.warn("publish_skill failed", { namespace, name, status: res.status, error });
            if (deadLinks && deadLinks.length > 0) {
              return { success: false as const, error, deadLinks };
            }
            return { success: false as const, error };
          }
          const json = (await res.json()) as { published: { skillId: string; version: number } };
          logger.info("publish_skill succeeded", { namespace, name });
          return {
            success: true as const,
            skill: {
              ref: `@${namespace}/${name}`,
              skillId: json.published.skillId,
              version: json.published.version,
            },
          };
        } catch (err) {
          logger.error("publish_skill threw", { namespace, name, error: stringifyError(err) });
          return {
            success: false as const,
            error: "publish_skill failed: network error",
          };
        } finally {
          await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
            logger.debug("publish_skill cleanup failed", { error: stringifyError(e) }),
          );
        }
      },
    }),
  };
}
