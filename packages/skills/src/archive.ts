import { Buffer } from "node:buffer";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import { create, extract } from "tar";

const logger = createLogger({ name: "skill-archive" });

/**
 * Packs a skill directory into a gzipped tarball.
 * All files are stored relative to the directory root.
 */
export async function packSkillArchive(dirPath: string): Promise<Buffer> {
  const tmpDir = makeTempDir({ prefix: "atlas-archive-" });
  const tmpFile = join(tmpDir, "skill.tar.gz");
  await create({ gzip: true, file: tmpFile, cwd: dirPath }, ["."]);
  const buf = await readFile(tmpFile);
  await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
    logger.debug("cleanup failed", { error: stringifyError(e) }),
  );
  return Buffer.from(buf);
}

/**
 * Extracts a gzipped tarball to a temporary directory.
 * Returns the absolute path of the extraction directory.
 */
export async function extractSkillArchive(archive: Buffer, prefix?: string): Promise<string> {
  const dir = makeTempDir({ prefix: prefix ?? "atlas-skill-" });
  const tmpFile = join(dir, "__archive.tar.gz");
  await writeFile(tmpFile, archive);
  await extract({
    file: tmpFile,
    cwd: dir,
    filter: (path) => !path.startsWith("/") && !path.includes(".."),
  });
  await rm(tmpFile, { force: true }).catch((e) =>
    logger.debug("cleanup failed", { error: stringifyError(e) }),
  );
  return dir;
}

/**
 * Replaces all occurrences of `$SKILL_DIR` in instructions with the actual path.
 */
export function injectSkillDir(instructions: string, skillDir: string): string {
  return instructions.replaceAll("$SKILL_DIR", skillDir);
}
