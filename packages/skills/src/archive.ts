import { Buffer } from "node:buffer";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { makeTempDir } from "@atlas/utils/temp.server";
import MarkdownIt from "markdown-it";
import { create, extract, list, type WriteEntry } from "tar";

const logger = createLogger({ name: "skill-archive" });

/**
 * Writes a list of skill files to a directory, creating parent directories
 * as needed. Rejects paths that escape the base directory (absolute paths or
 * containing `..`). Optionally rejects entries whose normalized path is
 * "SKILL.md" to prevent overwriting the canonical skill instructions file.
 *
 * @param dir Base directory to write into.
 * @param files Array of `{ path, content }` entries. Paths are relative.
 * @param options.allowSkillMd When true, permits a `SKILL.md` entry. Default false.
 */
export async function writeSkillFiles(
  dir: string,
  files: Array<{ path: string; content: string }>,
  options: { allowSkillMd?: boolean } = {},
): Promise<void> {
  const resolvedDir = resolve(dir);
  for (const entry of files) {
    const normalized = posix.normalize(entry.path);
    if (normalized === "." || normalized.startsWith("/") || entry.path.split("/").includes("..")) {
      throw new Error(`Invalid file path: ${entry.path}`);
    }
    const target = join(dir, normalized);
    const resolvedSkillMd = resolve(dir, "SKILL.md");
    if (!options.allowSkillMd && resolve(target) === resolvedSkillMd) {
      throw new Error("SKILL.md is reserved for the canonical skill instructions");
    }
    const resolvedTarget = resolve(target);
    if (!resolvedTarget.startsWith(resolvedDir + "/") && resolvedTarget !== resolvedDir) {
      throw new Error(`Path escapes base directory: ${entry.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.content);
  }
}

/**
 * Packs a skill directory into a gzipped tarball.
 * All files are stored relative to the directory root.
 *
 * `onWriteEntry` forces sane mode bits on every entry. When the skill
 * source lives inside the deno-compiled binary's virtual fs,
 * `fs.stat()` reports mode 0 for everything; without this normalization
 * the resulting archive has unusable `d---------` directories and
 * extraction fails with EACCES.
 */
export async function packSkillArchive(dirPath: string): Promise<Buffer> {
  const tmpDir = makeTempDir({ prefix: "atlas-archive-" });
  const tmpFile = join(tmpDir, "skill.tar.gz");
  await create(
    {
      gzip: true,
      file: tmpFile,
      cwd: dirPath,
      onWriteEntry: (entry: WriteEntry) => {
        // tar's [HEADER] step reads `this.stat.mode` to compute the archive
        // entry's mode (write-entry.js line ~188). Mutating `entry.stat.mode`
        // before [HEADER] runs is what actually overrides the bits.
        if (entry.stat) {
          entry.stat.mode = entry.type === "Directory" ? 0o755 : 0o644;
        }
      },
    },
    ["."],
  );
  const buf = await readFile(tmpFile);
  await rm(tmpDir, { recursive: true, force: true }).catch((e) =>
    logger.debug("cleanup failed", { error: stringifyError(e) }),
  );
  return Buffer.from(buf);
}

/**
 * Recursively chmod an extracted skill tree to sane defaults
 * (0755 dirs, 0644 files). Necessary because packSkillArchive runs
 * from inside the deno-compiled binary's virtual fs, which reports
 * mode 0 for every entry — without this fixup, extracted directories
 * come out as `d---------` and writes inside them fail with EACCES.
 */
async function fixExtractedModes(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmod(fullPath, 0o755);
      await fixExtractedModes(fullPath);
    } else if (entry.isFile()) {
      await chmod(fullPath, 0o644);
    }
  }
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
    dmode: 0o755,
    fmode: 0o644,
    filter: (path) => !path.startsWith("/") && !path.includes(".."),
  });
  await rm(tmpFile, { force: true }).catch((e) =>
    logger.debug("cleanup failed", { error: stringifyError(e) }),
  );
  await fixExtractedModes(dir);
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
    dmode: 0o755,
    fmode: 0o644,
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
