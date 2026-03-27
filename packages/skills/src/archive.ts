import { Buffer } from "node:buffer";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import MarkdownIt from "markdown-it";
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
 * Extracts all text files from a gzipped tarball into memory.
 * Returns a Record keyed by relative path (e.g. "references/review-criteria.md").
 *
 * Uses a single extraction pass (vs `readArchiveFile` which creates a temp dir per file).
 * Skips directories, macOS resource forks (`._*`), and the `__archive.tar.gz` temp file.
 */
export async function extractArchiveContents(archive: Uint8Array): Promise<Record<string, string>> {
  const dir = await extractSkillArchive(Buffer.from(archive), "atlas-ctx-skill-");
  try {
    return await readAllFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((e) =>
      logger.debug("archive contents cleanup failed", { error: stringifyError(e) }),
    );
  }
}

/** Recursively read all text files from a directory into a Record keyed by relative path.
 *  Detects binary files by checking for null bytes — text files never contain them. */
async function readAllFiles(dir: string, base?: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, await readAllFiles(fullPath, relPath));
    } else if (entry.isFile() && !entry.name.startsWith("._")) {
      const buf = await readFile(fullPath);
      if (buf.includes(0)) {
        logger.debug("Skipping binary file in skill archive", { path: relPath });
      } else {
        result[relPath] = buf.toString("utf-8");
      }
    }
  }
  return result;
}

/**
 * @deprecated New skills should use relative paths per agentskills.io spec.
 * Legacy compat: replaces `$SKILL_DIR` in instructions with the actual path.
 */
export function injectSkillDir(instructions: string, skillDir: string): string {
  return instructions.replaceAll("$SKILL_DIR", skillDir);
}

/**
 * Validate that file references in skill instructions resolve to files
 * that exist in the archive. Returns dead links (referenced but missing).
 *
 * Uses markdown-it to parse the instructions into an AST, then walks
 * all link tokens to extract local file targets. No regex.
 */
export function validateSkillReferences(instructions: string, archiveFiles: string[]): string[] {
  const available = new Set(archiveFiles);
  const normalized = instructions.replaceAll("$SKILL_DIR/", "");

  const md = new MarkdownIt();
  const tokens = md.parse(normalized, {});
  const deadLinks = new Set<string>();

  function checkHref(href: string | null): void {
    if (!href || href.startsWith("#") || href.includes(":")) return;
    const bare = href.split("#")[0]?.replace(/^\.\//, "");
    if (bare && !available.has(bare)) {
      deadLinks.add(bare);
    }
  }

  function walk(tokenList: ReturnType<typeof md.parse>): void {
    for (const token of tokenList) {
      if (token.type === "link_open") {
        checkHref(token.attrGet("href"));
      } else if (token.type === "image") {
        checkHref(token.attrGet("src"));
      }
      if (token.children) {
        walk(token.children);
      }
    }
  }

  walk(tokens);
  return [...deadLinks];
}
