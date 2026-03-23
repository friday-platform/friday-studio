import { Buffer } from "node:buffer";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import { create, extract, list } from "tar";

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
 * Lists file paths inside a gzipped tarball without extracting.
 * Filters out unsafe paths (absolute or containing `..`).
 */
export async function listArchiveFiles(archive: Uint8Array): Promise<string[]> {
  const tmpDir = makeTempDir({ prefix: "atlas-list-" });
  const tmpFile = join(tmpDir, "skill.tar.gz");
  await writeFile(tmpFile, archive);

  const files: string[] = [];
  await list({
    file: tmpFile,
    onReadEntry: (entry) => {
      const p = entry.path;
      const basename = p.split("/").pop() ?? "";
      if (
        p !== "./" &&
        p !== "." &&
        !p.startsWith("/") &&
        !p.includes("..") &&
        !basename.startsWith("._")
      ) {
        files.push(p.replace(/^\.\//, ""));
      }
    },
  });

  await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
    logger.debug("cleanup failed", { error: stringifyError(e) }),
  );
  return files;
}

/**
 * Reads a single file's content from a gzipped tarball.
 * Returns null if the file is not found in the archive.
 */
export async function readArchiveFile(
  archive: Uint8Array,
  filePath: string,
): Promise<string | null> {
  const tmpDir = makeTempDir({ prefix: "atlas-read-" });
  const tmpFile = join(tmpDir, "__archive.tar.gz");
  await writeFile(tmpFile, archive);

  const normalized = filePath.replace(/^\.\//, "");
  await extract({
    file: tmpFile,
    cwd: tmpDir,
    filter: (p) => {
      const clean = p.replace(/^\.\//, "");
      return clean === normalized;
    },
  });

  const targetPath = join(tmpDir, normalized);
  try {
    const content = await readFile(targetPath, "utf-8");
    return content;
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
      logger.debug("cleanup failed", { error: stringifyError(e) }),
    );
  }
}

/**
 * Replaces all occurrences of `$SKILL_DIR` in instructions with the actual path.
 */
export function injectSkillDir(instructions: string, skillDir: string): string {
  return instructions.replaceAll("$SKILL_DIR", skillDir);
}
